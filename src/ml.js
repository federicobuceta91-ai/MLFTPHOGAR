const crypto = require('crypto');
const { pool } = require('./db');
const push = require('./push');

const API = 'https://api.mercadolibre.com';

// A partir de este número de unidades (inclusive) se considera "stock bajo".
// Usado tanto en el filtro de Publicaciones como en las sugerencias del Agente.
const STOCK_BAJO_UMBRAL = 3;
const AUTH_BASE = 'https://auth.mercadolibre.com.ar';

function authorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_APP_ID,
    redirect_uri: process.env.ML_REDIRECT_URI,
    state,
  });
  return `${AUTH_BASE}/authorization?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code,
      redirect_uri: process.env.ML_REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Error al intercambiar el code: ' + JSON.stringify(data));
  await saveTokens(data);
  return data;
}

async function saveTokens(data) {
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  await pool.query(
    `INSERT INTO ml_tokens (id, ml_user_id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       ml_user_id = EXCLUDED.ml_user_id,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [String(data.user_id), data.access_token, data.refresh_token, expiresAt]
  );
}

async function getStoredTokens() {
  const { rows } = await pool.query('SELECT * FROM ml_tokens WHERE id = 1');
  return rows[0] || null;
}

async function refreshIfNeeded() {
  const row = await getStoredTokens();
  if (!row) return null;
  if (new Date(row.expires_at) > new Date()) return row;

  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: row.refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('No se pudo refrescar el token: ' + JSON.stringify(data));
  }
  await saveTokens(data);
  return getStoredTokens();
}

async function mlFetch(path, options = {}) {
  const tokens = await refreshIfNeeded();
  if (!tokens) throw new Error('NOT_CONNECTED');
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Error ${res.status} en ${path}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getAllItemIds(userId) {
  let offset = 0;
  const limit = 50;
  const ids = [];
  // La tienda tiene pocos productos (<50), pero paginamos igual por si crece.
  while (true) {
    const data = await mlFetch(`/users/${userId}/items/search?limit=${limit}&offset=${offset}`);
    ids.push(...(data.results || []));
    const total = data.paging ? data.paging.total : ids.length;
    offset += limit;
    if (offset >= total || !data.results || data.results.length === 0) break;
  }
  return ids;
}

async function getItemsDetails(ids) {
  if (ids.length === 0) return [];
  const groups = chunk(ids, 20);
  const all = [];
  for (const group of groups) {
    const data = await mlFetch(`/items?ids=${group.join(',')}`);
    for (const entry of data) {
      if (entry.code === 200) all.push(entry.body);
    }
  }
  return all;
}

async function getComisionML(item) {
  try {
    const siteMatch = item.id.match(/^[A-Z]+/);
    const siteId = siteMatch ? siteMatch[0] : 'MLA';
    const params = new URLSearchParams({
      price: item.price,
      category_id: item.category_id,
    });
    const data = await mlFetch(`/sites/${siteId}/listing_prices?${params.toString()}`);
    const opciones = Array.isArray(data) ? data : [];
    const match =
      opciones.find((o) => o.listing_type_id === item.listing_type_id) || opciones[0];
    if (!match) return null;
    // `sale_fee_amount` es el monto total que informa ML para esta venta. Según
    // la documentación de la API (no se pudo confirmar en vivo porque este
    // entorno no tiene salida de red hacia api.mercadolibre.com), este monto ya
    // vendría con el costo fijo por unidad vendida (el que aplica a productos
    // de menos de $33.000, ver Calculadora) sumado junto con el % de comisión
    // — no por separado. Si ML alguna vez lo manda separado en
    // `sale_fee_details` (percentage_fee + fixed_fee), lo sumamos acá para no
    // perder ese costo fijo.
    if (typeof match.sale_fee_amount === 'number') return match.sale_fee_amount;
    if (match.sale_fee_details && typeof match.sale_fee_details.percentage_fee === 'number') {
      const comisionPorcentual = (item.price * match.sale_fee_details.percentage_fee) / 100;
      const costoFijo =
        typeof match.sale_fee_details.fixed_fee === 'number' ? match.sale_fee_details.fixed_fee : 0;
      return comisionPorcentual + costoFijo;
    }
    return null;
  } catch (err) {
    console.error('No se pudo obtener la comisión de ML para', item.id, err.message);
    return null;
  }
}

async function getEnvioCost(item) {
  try {
    const envioGratis = !!(item.shipping && item.shipping.free_shipping);
    if (!envioGratis) return 0; // el comprador paga el envío, no es costo del vendedor

    const data = await mlFetch(`/items/${item.id}/shipping_options`);
    const opciones = (data && data.options) || [];
    const principal = opciones.find((o) => typeof o.list_cost === 'number') || opciones[0];
    if (!principal || typeof principal.list_cost !== 'number') return null;
    return principal.list_cost;
  } catch (err) {
    console.error('No se pudo obtener el costo de envío para', item.id, err.message);
    return null;
  }
}

// Sugerencia de precio / "mejor oferta" (Buy Box). Esto solo aplica a
// publicaciones que participan de una ficha de catálogo compartida con otros
// vendedores — para el resto es normal y esperable que no haya datos.
// EXPERIMENTAL: no se pudo confirmar en vivo el endpoint ni la forma exacta
// de la respuesta durante el desarrollo.
async function getPrecioAGanar(item) {
  try {
    const data = await mlFetch(`/items/${item.id}/price_to_win?channel=marketplace`);
    if (!data || !data.status) return null;
    return {
      status: data.status,
      precioParaGanar:
        data.price_to_win && typeof data.price_to_win.amount === 'number'
          ? data.price_to_win.amount
          : null,
    };
  } catch (err) {
    return null;
  }
}

async function getConfig() {
  const { rows } = await pool.query('SELECT * FROM config WHERE id = 1');
  return rows[0] || { impuestos_pct: 0 };
}

async function setConfig(impuestosPct) {
  await pool.query(
    `INSERT INTO config (id, impuestos_pct, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET impuestos_pct = EXCLUDED.impuestos_pct, updated_at = now()`,
    [impuestosPct]
  );
}

// ---------- Usuario del Panel SPL (login del "depósito"), manejado desde Configuración ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, 'hex');
  const testHash = crypto.scryptSync(password, salt, 64);
  if (hashBuffer.length !== testHash.length) return false;
  return crypto.timingSafeEqual(hashBuffer, testHash);
}

async function getSplCredenciales() {
  const config = await getConfig();
  return {
    usuario: config.spl_usuario || null,
    configurado: !!(config.spl_usuario && config.spl_clave_hash),
  };
}

async function setSplCredenciales(usuario, clave) {
  if (clave) {
    const claveHash = hashPassword(clave);
    await pool.query(
      `UPDATE config SET spl_usuario = $1, spl_clave_hash = $2, updated_at = now() WHERE id = 1`,
      [usuario, claveHash]
    );
  } else {
    // Dejaron la clave en blanco: solo actualizamos el usuario, la clave queda igual.
    await pool.query(
      `UPDATE config SET spl_usuario = $1, updated_at = now() WHERE id = 1`,
      [usuario]
    );
  }
}

async function verificarSplLogin(usuario, clave) {
  const config = await getConfig();
  if (!config.spl_usuario || !config.spl_clave_hash) return false;
  if (usuario !== config.spl_usuario) return false;
  return verifyPassword(clave, config.spl_clave_hash);
}

// ---------- Usuarios de la app (Configuración → Usuarios) ----------
// Reemplaza el usuario/clave único compartido que vivía en las Environment
// Variables de Render. Por ahora todos los usuarios tienen el mismo nivel de
// acceso — no hay roles/permisos distintos todavía (se puede sumar más
// adelante si hace falta).

// Si todavía no se creó ningún usuario y existen las variables de entorno del
// login viejo (APP_LOGIN_USER / APP_LOGIN_PASS), se crea un usuario inicial a
// partir de ellas la primera vez que arranca el server con esta versión —
// así nadie queda afuera de su propia app el día del deploy. Una vez adentro,
// desde Configuración se puede crear el usuario "de verdad" (con el email
// real) y, si se quiere, desactivar este usuario inicial.
async function bootstrapUsuarioInicial() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
  if (rows[0].total > 0) return;
  const usuarioViejo = process.env.APP_LOGIN_USER;
  const claveVieja = process.env.APP_LOGIN_PASS;
  if (!usuarioViejo || !claveVieja) return;
  const claveHash = hashPassword(claveVieja);
  await pool.query(
    `INSERT INTO usuarios (email, nombre, clave_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [usuarioViejo, usuarioViejo, claveHash]
  );
}

async function getUsuarios() {
  const { rows } = await pool.query(
    'SELECT id, email, nombre, activo, creado_en FROM usuarios ORDER BY creado_en ASC'
  );
  return rows;
}

async function crearUsuario(email, nombre, clave) {
  const claveHash = hashPassword(clave);
  await pool.query(
    `INSERT INTO usuarios (email, nombre, clave_hash) VALUES ($1, $2, $3)`,
    [email, nombre || null, claveHash]
  );
}

async function cambiarClaveUsuario(id, claveNueva) {
  const claveHash = hashPassword(claveNueva);
  await pool.query('UPDATE usuarios SET clave_hash = $1 WHERE id = $2', [claveHash, id]);
}

async function setUsuarioActivo(id, activo) {
  await pool.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [activo, id]);
}

// Cuántos usuarios activos hay, para no permitir desactivar al último (nadie
// podría volver a entrar a la app).
async function contarUsuariosActivos() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios WHERE activo = true');
  return rows[0].total;
}

async function verificarLogin(email, clave) {
  const { rows } = await pool.query(
    'SELECT * FROM usuarios WHERE email = $1 AND activo = true',
    [email]
  );
  const usuario = rows[0];
  if (!usuario) return null;
  const ok = verifyPassword(clave, usuario.clave_hash);
  if (!ok) return null;
  return { id: usuario.id, email: usuario.email, nombre: usuario.nombre };
}

// Arma el objeto "ítem con costos" que usan tanto la tabla de Publicaciones
// como la pantalla de detalle de una publicación puntual — para no duplicar
// la cuenta de margen en dos lugares.
function construirItemConCostos(it, costoRow, impuestosPct, comisionML, envioCost, precioAGanar) {
  const costo = costoRow ? Number(costoRow.costo) : null;
  const precio = it.price;
  const impuestoMonto = (precio * impuestosPct) / 100;
  const margenBruto = costo != null ? precio - costo : null;
  const margen =
    costo != null
      ? precio - costo - (comisionML || 0) - (envioCost || 0) - impuestoMonto
      : null;
  const margenPct = costo != null && costo > 0 ? ((margen / costo) * 100) : null;
  return {
    id: it.id,
    titulo: it.title,
    precio,
    stock: it.available_quantity,
    estado: it.status,
    subEstado: Array.isArray(it.sub_status) ? it.sub_status : [],
    permalink: it.permalink,
    thumbnail: it.thumbnail,
    costo,
    comisionML,
    envioCost,
    envioGratis: !!(it.shipping && it.shipping.free_shipping),
    impuestosPct,
    impuestoMonto,
    margenBruto,
    margen,
    margenPct,
    health: typeof it.health === 'number' ? it.health : null,
    notas: costoRow ? costoRow.notas : null,
    tipo: costoRow ? costoRow.tipo : 'propio',
    proveedor: costoRow ? costoRow.proveedor : null,
    precioAGanar,
    tieneVariantes: Array.isArray(it.variations) && it.variations.length > 0,
    categoryId: it.category_id || null,
    fotos: Array.isArray(it.pictures) ? it.pictures.length : null,
  };
}

async function getItemsWithCostos(userId) {
  const ids = await getAllItemIds(userId);
  const items = await getItemsDetails(ids);
  const { rows } = await pool.query('SELECT * FROM productos');
  const costos = Object.fromEntries(rows.map((r) => [r.ml_item_id, r]));
  const config = await getConfig();
  const impuestosPct = Number(config.impuestos_pct) || 0;

  const [comisiones, envios, preciosAGanar] = await Promise.all([
    Promise.all(items.map((it) => getComisionML(it))),
    Promise.all(items.map((it) => getEnvioCost(it))),
    Promise.all(items.map((it) => getPrecioAGanar(it))),
  ]);

  return items.map((it, idx) =>
    construirItemConCostos(it, costos[it.id], impuestosPct, comisiones[idx], envios[idx], preciosAGanar[idx])
  );
}

// Lo mismo que getItemsWithCostos pero para UN solo ítem puntual (pantalla de
// detalle de una publicación) — no hace falta traer y procesar todas las
// publicaciones de la cuenta para mostrar el análisis de una sola.
async function getItemConCostos(itemId) {
  const it = await mlFetch(`/items/${itemId}`);
  const { rows } = await pool.query('SELECT * FROM productos WHERE ml_item_id = $1', [itemId]);
  const config = await getConfig();
  const impuestosPct = Number(config.impuestos_pct) || 0;
  const [comisionML, envioCost, precioAGanar] = await Promise.all([
    getComisionML(it),
    getEnvioCost(it),
    getPrecioAGanar(it),
  ]);
  return construirItemConCostos(it, rows[0], impuestosPct, comisionML, envioCost, precioAGanar);
}

async function getVentasYCMV(userId, dias = 30) {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query('SELECT * FROM productos');
  const costos = Object.fromEntries(
    rows.map((r) => [r.ml_item_id, r.costo != null ? Number(r.costo) : null])
  );

  let ventas = 0;
  let cmv = 0;
  let cmvIncompleto = false;
  let cantidadOrdenes = 0;
  let offset = 0;
  const limit = 50;

  while (true) {
    const params = new URLSearchParams({
      seller: userId,
      'order.status': 'paid',
      'order.date_created.from': desde.toISOString(),
      'order.date_created.to': hasta.toISOString(),
      limit: String(limit),
      offset: String(offset),
    });
    const data = await mlFetch(`/orders/search?${params.toString()}`);
    const results = data.results || [];
    cantidadOrdenes += results.length;

    for (const order of results) {
      ventas += order.total_amount || 0;
      for (const oi of order.order_items || []) {
        const itemId = oi.item && oi.item.id;
        const costo = itemId ? costos[itemId] : null;
        if (costo != null) {
          cmv += costo * (oi.quantity || 1);
        } else {
          cmvIncompleto = true;
        }
      }
    }

    const total = data.paging ? data.paging.total : results.length;
    offset += limit;
    if (results.length === 0 || offset >= total) break;
  }

  const margenPct = ventas > 0 ? ((ventas - cmv) / ventas) * 100 : null;
  return { ventas, cmv, margenPct, cmvIncompleto, dias, cantidadOrdenes };
}

async function setCosto(itemId, costo, notas) {
  await pool.query(
    `INSERT INTO productos (ml_item_id, costo, notas, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (ml_item_id) DO UPDATE SET costo = EXCLUDED.costo, notas = EXCLUDED.notas, updated_at = now()`,
    [itemId, costo, notas || null]
  );
}

async function setTipo(itemId, tipo, proveedor) {
  await pool.query(
    `INSERT INTO productos (ml_item_id, tipo, proveedor, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (ml_item_id) DO UPDATE SET tipo = EXCLUDED.tipo, proveedor = EXCLUDED.proveedor, updated_at = now()`,
    [itemId, tipo === 'drop' ? 'drop' : 'propio', tipo === 'drop' ? (proveedor || null) : null]
  );
}

// ---------- Drop Shipping (prototipo con datos simulados, todavía sin Odoo real) ----------

async function crearOrdenDrop({ itemId, titulo, proveedor, cantidad, comprador, direccionEnvio }) {
  const { rows } = await pool.query(
    `INSERT INTO ordenes_drop (ml_item_id, titulo, proveedor, cantidad, comprador, direccion_envio)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [itemId, titulo, proveedor || null, cantidad || 1, comprador || null, direccionEnvio || null]
  );
  return rows[0];
}

async function getOrdenesDrop() {
  const { rows } = await pool.query('SELECT * FROM ordenes_drop ORDER BY creado_en DESC');
  return rows;
}

async function getOrdenesDropPendientes() {
  const { rows } = await pool.query(
    `SELECT * FROM ordenes_drop WHERE estado = 'lista_para_facturar' ORDER BY creado_en ASC`
  );
  return rows;
}

async function getOrdenDropById(id) {
  const { rows } = await pool.query('SELECT * FROM ordenes_drop WHERE id = $1', [id]);
  return rows[0] || null;
}

async function marcarOrdenFacturada(id) {
  await pool.query(
    `UPDATE ordenes_drop SET estado = 'facturada', facturada_en = now() WHERE id = $1`,
    [id]
  );
}

async function setItemStatus(itemId, status) {
  return mlFetch(`/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

async function setItemStock(itemId, quantity) {
  return mlFetch(`/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ available_quantity: quantity }),
  });
}

async function setItemPrice(itemId, price) {
  return mlFetch(`/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price }),
  });
}

async function getUnansweredQuestions(userId) {
  const data = await mlFetch(`/questions/search?seller_id=${userId}&status=UNANSWERED&sort_fields=date_created&sort_types=DESC`);
  return data.questions || [];
}

// ---------- Notificaciones push: aviso de venta nueva y pregunta nueva ----------
// MercadoLibre llama a nuestro webhook (POST /ml/notificaciones, en server.js)
// cada vez que pasa algo en la cuenta conectada. Acá solo nos interesan dos
// "topics": `orders_v2` (una orden se creó o cambió de estado) y `questions`
// (una pregunta se creó o se respondió). Por cada evento real que ya
// avisamos, lo guardamos en `ml_eventos_notificados` para no mandar el mismo
// aviso dos veces si ML reintenta el webhook, o si una misma orden pasa por
// varios estados antes de quedar pagada.
async function yaNotificado(tipo, recursoId) {
  const { rows } = await pool.query(
    `INSERT INTO ml_eventos_notificados (tipo, recurso_id) VALUES ($1, $2)
     ON CONFLICT (tipo, recurso_id) DO NOTHING
     RETURNING id`,
    [tipo, recursoId]
  );
  return rows.length === 0; // true si ya existía (no se insertó una fila nueva)
}

async function procesarNotificacionVenta(resource) {
  const orden = await mlFetch(resource);
  if (orden.status !== 'paid') return; // todavía no es una venta confirmada
  if (await yaNotificado('venta', String(orden.id))) return;

  const items = (orden.order_items || [])
    .map((oi) => `${oi.quantity || 1}x ${(oi.item && oi.item.title) || 'producto'}`)
    .join(', ');
  const monto = orden.total_amount != null ? `$${Number(orden.total_amount).toLocaleString('es-AR')}` : '';

  await push.enviarATodos({
    title: '🛒 ¡Venta nueva!',
    body: [items, monto].filter(Boolean).join(' · ') || 'Revisá Publicaciones para los detalles.',
    url: '/publicaciones',
  });
}

async function procesarNotificacionPregunta(resource) {
  const pregunta = await mlFetch(resource);
  if (await yaNotificado('pregunta', String(pregunta.id))) return;

  const texto = pregunta.text || 'Pregunta nueva de un comprador.';
  await push.enviarATodos({
    title: '💬 Pregunta nueva',
    body: texto.length > 120 ? texto.slice(0, 117) + '...' : texto,
    url: '/preguntas',
  });
}

// Punto de entrada único llamado desde el webhook de server.js. No tira error
// hacia afuera: cualquier problema queda en el log, nunca hace que ML vea un
// error (ya respondimos 200 antes de llamar a esto).
async function procesarNotificacionML(body) {
  const { resource, topic, user_id } = body || {};
  if (!resource || !topic) return;

  const tokens = await getStoredTokens();
  if (!tokens || String(user_id) !== String(tokens.ml_user_id)) return; // no es nuestra cuenta conectada

  if (topic === 'orders_v2' || topic === 'orders') {
    await procesarNotificacionVenta(resource);
  } else if (topic === 'questions') {
    await procesarNotificacionPregunta(resource);
  }
}

async function answerQuestion(questionId, text) {
  return mlFetch('/answers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question_id: questionId, text }),
  });
}

// Mapeo del "semáforo" de reputación de ML (color + posición 1-5) a partir de
// level_id. Si ML cambia estos valores, conviene ajustarlo acá.
const NIVELES_REPUTACION = {
  '5_green': { posicion: 5, color: '#00a650', label: 'Verde' },
  '4_light_green': { posicion: 4, color: '#8bc34a', label: 'Verde claro' },
  '3_yellow': { posicion: 3, color: '#fff159', label: 'Amarillo' },
  '2_orange': { posicion: 2, color: '#f2994a', label: 'Naranja' },
  '1_red': { posicion: 1, color: '#f23d4f', label: 'Rojo' },
};

function getNivelReputacion(levelId) {
  return NIVELES_REPUTACION[levelId] || { posicion: 0, color: '#ccc', label: 'Sin reputación (nuevo o sin ventas recientes)' };
}

// Reclamos / Posventa. EXPERIMENTAL: no se pudo confirmar en vivo el endpoint
// exacto ni la forma de la respuesta durante el desarrollo (solo lo armamos
// según la documentación). Si falla, devolvemos una lista vacía en vez de
// romper toda la pantalla de Reputación.
async function getReclamos(userId) {
  try {
    const data = await mlFetch(`/post-purchase/v1/claims/search?player_role=respondent&player_id=${userId}`);
    const lista = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
    return lista.map((c) => ({
      id: c.id,
      tipo: c.type || null,
      etapa: c.stage || null,
      estado: c.status || null,
      recurso: c.resource_id || c.resource || null,
      fecha: c.date_created || null,
    }));
  } catch (err) {
    console.error('No se pudo obtener reclamos/posventa (experimental):', err.message);
    return [];
  }
}

async function getReputation(userId) {
  const data = await mlFetch(`/users/${userId}`);
  const sr = data.seller_reputation || {};
  const levelId = sr.level_id || null;
  return {
    nickname: data.nickname,
    levelId,
    nivel: getNivelReputacion(levelId),
    powerSellerStatus: sr.power_seller_status || null,
    transactions: sr.transactions || {},
    metrics: sr.metrics || {},
  };
}

// ---------- Nueva publicación (duplicando una existente como "plantilla") ----------
// A diferencia de price_to_win o post-purchase/claims, POST /items es un
// endpoint central y estable de la API de ML (no experimental), pero tampoco
// se pudo probar en vivo durante el desarrollo (sin salida de red a
// api.mercadolibre.com). Lo armamos reusando la categoría, condición,
// atributos, forma de envío y tipo de publicación de una publicación
// existente, para no tener que resolver nosotros el árbol de categorías ni
// los atributos obligatorios de cada rubro.

async function getItemFull(itemId) {
  return mlFetch(`/items/${itemId}`);
}

async function getItemDescription(itemId) {
  try {
    const data = await mlFetch(`/items/${itemId}/description`);
    return (data && data.plain_text) || '';
  } catch (err) {
    return '';
  }
}

// ML devuelve los errores de validación (atributos faltantes, etc.) en
// "cause". Si están, los mostramos en vez del mensaje genérico.
function formatMlError(err) {
  const causas = err.data && Array.isArray(err.data.cause) ? err.data.cause : [];
  if (causas.length > 0) {
    return causas.map((c) => c.message || c.code).join(' / ');
  }
  return err.message;
}

async function crearPublicacionDesdeTemplate(templateId, datos) {
  // datos: { titulo, precio, stock, fotos, descripcion, costo, tipo, proveedor }
  const template = await getItemFull(templateId);

  if (Array.isArray(template.variations) && template.variations.length > 0) {
    throw new Error(
      'Esa publicación tiene variantes (talles/colores): por ahora no se pueden duplicar como plantilla, hay que cargarla a mano en MercadoLibre.'
    );
  }

  const urls = (datos.fotos || '')
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
  const pictures = urls.length > 0
    ? urls.map((source) => ({ source }))
    : (template.pictures || []).map((p) => ({ id: p.id }));

  const payload = {
    title: datos.titulo,
    category_id: template.category_id,
    price: Number(datos.precio),
    currency_id: template.currency_id,
    available_quantity: Number(datos.stock),
    buying_mode: template.buying_mode,
    listing_type_id: template.listing_type_id,
    condition: template.condition,
    pictures,
    attributes: template.attributes || [],
  };
  if (template.sale_terms && template.sale_terms.length > 0) {
    payload.sale_terms = template.sale_terms;
  }
  if (template.shipping) {
    payload.shipping = {
      mode: template.shipping.mode,
      local_pick_up: !!template.shipping.local_pick_up,
      free_shipping: !!template.shipping.free_shipping,
    };
  }

  let nuevo;
  try {
    nuevo = await mlFetch('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    err.message = formatMlError(err);
    throw err;
  }

  if (datos.descripcion) {
    try {
      await mlFetch(`/items/${nuevo.id}/description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plain_text: datos.descripcion }),
      });
    } catch (err) {
      // La publicación ya se creó en ML; si solo falla la descripción no
      // tiene sentido perderla, lo dejamos registrado para revisar a mano.
      console.error('La publicación se creó pero no se pudo guardar la descripción:', err.message);
    }
  }

  if (datos.costo !== undefined && datos.costo !== '') {
    await setCosto(nuevo.id, Number(datos.costo), null);
  }
  if (datos.tipo) {
    await setTipo(nuevo.id, datos.tipo, datos.proveedor);
  }

  return nuevo;
}

// ---------- Envíos ----------
// Endpoint de etiquetas (/shipment_labels) y /shipments/{id} son parte
// central y estable de la API de ML (muy usados por integradores hace años),
// así que van con buena confianza, aunque -como el resto- no se pudieron
// probar en vivo durante el desarrollo.

async function getEnvios(userId, dias = 30) {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);
  let offset = 0;
  const limit = 50;
  const ordenes = [];

  while (true) {
    const params = new URLSearchParams({
      seller: userId,
      'order.status': 'paid',
      'order.date_created.from': desde.toISOString(),
      'order.date_created.to': hasta.toISOString(),
      limit: String(limit),
      offset: String(offset),
    });
    const data = await mlFetch(`/orders/search?${params.toString()}`);
    const results = data.results || [];
    ordenes.push(...results);
    const total = data.paging ? data.paging.total : results.length;
    offset += limit;
    if (results.length === 0 || offset >= total) break;
  }

  const shipmentIds = [...new Set(ordenes.map((o) => o.shipping && o.shipping.id).filter(Boolean))];
  const shipmentsEntries = await Promise.all(
    shipmentIds.map(async (id) => {
      try {
        return [id, await mlFetch(`/shipments/${id}`)];
      } catch (err) {
        return [id, null];
      }
    })
  );
  const shipmentsMap = Object.fromEntries(shipmentsEntries);

  return ordenes
    .filter((o) => o.shipping && o.shipping.id)
    .map((o) => {
      const shipment = shipmentsMap[o.shipping.id];
      const primerItem = o.order_items && o.order_items[0] && o.order_items[0].item;
      return {
        shipmentId: o.shipping.id,
        orderId: o.id,
        fecha: o.date_created,
        producto: (primerItem && primerItem.title) || '—',
        comprador: o.buyer ? o.buyer.nickname || null : null,
        estado: shipment ? shipment.status : null,
        subEstado: shipment ? shipment.substatus : null,
        tracking: shipment ? shipment.tracking_number : null,
      };
    })
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

async function getShipmentLabelPdf(shipmentId) {
  const tokens = await refreshIfNeeded();
  if (!tokens) throw new Error('NOT_CONNECTED');
  const res = await fetch(`${API}/shipment_labels?shipment_ids=${shipmentId}&response_type=pdf`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || `Error ${res.status} obteniendo la etiqueta`);
    err.status = res.status;
    throw err;
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------- Métricas ----------

// Agrupa las órdenes pagas de los últimos `dias` días por publicación.
// Reusa el mismo patrón de paginado que getVentasYCMV.
async function ventasPorProductoMap(userId, dias) {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 24 * 60 * 60 * 1000);
  let offset = 0;
  const limit = 50;
  const stats = {};

  while (true) {
    const params = new URLSearchParams({
      seller: userId,
      'order.status': 'paid',
      'order.date_created.from': desde.toISOString(),
      'order.date_created.to': hasta.toISOString(),
      limit: String(limit),
      offset: String(offset),
    });
    const data = await mlFetch(`/orders/search?${params.toString()}`);
    const results = data.results || [];
    for (const order of results) {
      for (const oi of order.order_items || []) {
        const id = oi.item && oi.item.id;
        if (!id) continue;
        if (!stats[id]) stats[id] = { id, titulo: oi.item.title || id, cantidad: 0, monto: 0 };
        stats[id].cantidad += oi.quantity || 1;
        stats[id].monto += (oi.unit_price || 0) * (oi.quantity || 1);
      }
    }
    const total = data.paging ? data.paging.total : results.length;
    offset += limit;
    if (results.length === 0 || offset >= total) break;
  }
  return stats;
}

async function getTopProductos(userId, dias = 30, limite = 10) {
  const stats = await ventasPorProductoMap(userId, dias);
  return Object.values(stats)
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, limite);
}

async function getVentasPorSemana(userId, semanas = 8) {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - semanas * 7 * 24 * 60 * 60 * 1000);
  const msPorSemana = 7 * 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = 0; i < semanas; i++) {
    buckets.push({ inicio: new Date(desde.getTime() + i * msPorSemana), ventas: 0, ordenes: 0 });
  }

  let offset = 0;
  const limit = 50;
  while (true) {
    const params = new URLSearchParams({
      seller: userId,
      'order.status': 'paid',
      'order.date_created.from': desde.toISOString(),
      'order.date_created.to': hasta.toISOString(),
      limit: String(limit),
      offset: String(offset),
    });
    const data = await mlFetch(`/orders/search?${params.toString()}`);
    const results = data.results || [];
    for (const order of results) {
      const fecha = new Date(order.date_created);
      let idx = Math.floor((fecha - desde) / msPorSemana);
      if (idx < 0) idx = 0;
      if (idx >= semanas) idx = semanas - 1;
      buckets[idx].ventas += order.total_amount || 0;
      buckets[idx].ordenes += 1;
    }
    const total = data.paging ? data.paging.total : results.length;
    offset += limit;
    if (results.length === 0 || offset >= total) break;
  }
  return buckets;
}

// Lo mismo que getVentasPorSemana, pero filtrado a UN solo ítem — para la
// pantalla de detalle de una publicación puntual (historial de ventas de ese
// producto, no de toda la cuenta).
async function getVentasPorSemanaItem(userId, itemId, semanas = 8) {
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - semanas * 7 * 24 * 60 * 60 * 1000);
  const msPorSemana = 7 * 24 * 60 * 60 * 1000;
  const buckets = [];
  for (let i = 0; i < semanas; i++) {
    buckets.push({ inicio: new Date(desde.getTime() + i * msPorSemana), cantidad: 0, monto: 0 });
  }

  let offset = 0;
  const limit = 50;
  while (true) {
    const params = new URLSearchParams({
      seller: userId,
      'order.status': 'paid',
      'order.date_created.from': desde.toISOString(),
      'order.date_created.to': hasta.toISOString(),
      limit: String(limit),
      offset: String(offset),
    });
    const data = await mlFetch(`/orders/search?${params.toString()}`);
    const results = data.results || [];
    for (const order of results) {
      const fecha = new Date(order.date_created);
      let idx = Math.floor((fecha - desde) / msPorSemana);
      if (idx < 0) idx = 0;
      if (idx >= semanas) idx = semanas - 1;
      for (const oi of order.order_items || []) {
        if (oi.item && oi.item.id === itemId) {
          buckets[idx].cantidad += oi.quantity || 1;
          buckets[idx].monto += (oi.unit_price || 0) * (oi.quantity || 1);
        }
      }
    }
    const total = data.paging ? data.paging.total : results.length;
    offset += limit;
    if (results.length === 0 || offset >= total) break;
  }
  return buckets;
}

// Visitas por publicación. EXPERIMENTAL: a diferencia de /shipments o
// /orders/search (muy probados), este endpoint lo conocemos con menos
// seguridad y no se pudo confirmar en vivo durante el desarrollo. Si falla,
// devolvemos null en vez de romper la página (igual que price_to_win).
async function getVisitasItem(itemId, dias) {
  try {
    const data = await mlFetch(`/items/${itemId}/visits/time_window?last=${dias}&unit=day`);
    return typeof data.total_visits === 'number' ? data.total_visits : null;
  } catch (err) {
    return null;
  }
}

async function getVisitasYConversion(userId, dias = 30) {
  const items = await getItemsWithCostos(userId);
  const activos = items.filter((it) => it.estado === 'active' || it.estado === 'paused');
  const stats = await ventasPorProductoMap(userId, dias);
  const resultados = await Promise.all(
    activos.map(async (it) => {
      const visitas = await getVisitasItem(it.id, dias);
      const vendidos = stats[it.id] ? stats[it.id].cantidad : 0;
      const conversion = visitas != null && visitas > 0 ? (vendidos / visitas) * 100 : null;
      return { id: it.id, titulo: it.titulo, thumbnail: it.thumbnail, visitas, vendidos, conversion };
    })
  );
  return resultados.sort((a, b) => (b.visitas || 0) - (a.visitas || 0));
}

// ---------- Detalle / análisis de una publicación puntual ----------
// Junta todo lo que ya calculamos por separado para otras pantallas (costos y
// margen, visitas y conversión, ventas por semana, competencia/Buy Box, precio
// de la categoría) pero referido a UN solo ítem, para la pantalla "Ver
// detalle" de Publicaciones.
async function getPublicacionDetalle(userId, itemId) {
  const [item, visitas, ventasMap, ventasPorSemana] = await Promise.all([
    getItemConCostos(itemId),
    getVisitasItem(itemId, 30),
    ventasPorProductoMap(userId, 30),
    getVentasPorSemanaItem(userId, itemId, 8),
  ]);

  const ventas30 = ventasMap[itemId] || { cantidad: 0, monto: 0 };
  const conversion = visitas != null && visitas > 0 ? (ventas30.cantidad / visitas) * 100 : null;

  let precioCategoria = null;
  if (item.categoryId) {
    const siteMatch = itemId.match(/^[A-Z]+/);
    const siteId = siteMatch ? siteMatch[0] : 'MLA';
    precioCategoria = await getPrecioPromedioCategoria(item.categoryId, siteId);
  }

  return { item, visitas, ventas30, conversion, ventasPorSemana, precioCategoria };
}

// ---------- Comparativa con la competencia ----------
// El precio promedio/mínimo de la categoría sale del buscador PÚBLICO de ML
// (no hace falta estar autenticado), así que no usamos mlFetch acá.
async function getPrecioPromedioCategoria(categoryId, siteId) {
  try {
    const res = await fetch(`${API}/sites/${siteId}/search?category=${categoryId}&limit=50`);
    if (!res.ok) return null;
    const data = await res.json();
    const precios = (data.results || []).map((r) => r.price).filter((p) => typeof p === 'number');
    if (precios.length === 0) return null;
    const promedio = precios.reduce((a, b) => a + b, 0) / precios.length;
    return { promedio, minimo: Math.min(...precios), cantidad: precios.length };
  } catch (err) {
    return null;
  }
}

// ---------- Agente de mejoras ----------
// Motor de REGLAS FIJAS (no IA): revisa el estado actual de la cuenta cada vez
// que se entra a /agente (no corre solo en segundo plano, al menos en esta
// versión) y arma una lista de sugerencias. Nunca aplica nada solo: cada
// sugerencia "accionable" necesita que Federico apriete un botón para
// ejecutar el cambio real en MercadoLibre, igual que el resto de la app.

const AGENTE_OBJETIVO_MARGEN_PCT = 15; // margen mínimo deseado sobre el costo, ajustable más adelante
const AGENTE_FOTOS_MINIMAS = 3;

async function getDescartes() {
  const { rows } = await pool.query('SELECT ml_item_id, tipo FROM agente_descartes');
  return new Set(rows.map((r) => `${r.ml_item_id}|${r.tipo}`));
}

async function getDescartesDetalle() {
  const { rows } = await pool.query('SELECT * FROM agente_descartes ORDER BY creado_en DESC');
  return rows;
}

async function descartarPropuesta(itemId, tipo) {
  await pool.query(
    `INSERT INTO agente_descartes (ml_item_id, tipo) VALUES ($1, $2)
     ON CONFLICT (ml_item_id, tipo) DO NOTHING`,
    [itemId, tipo]
  );
}

async function reactivarDescarte(id) {
  await pool.query('DELETE FROM agente_descartes WHERE id = $1', [id]);
}

async function getPropuestas(userId) {
  const items = await getItemsWithCostos(userId);
  const descartadas = await getDescartes();
  const activos = items.filter((it) => it.estado === 'active');
  const propuestas = [];

  for (const it of activos) {
    const descartada = (tipo) => descartadas.has(`${it.id}|${tipo}`);

    // 1. Margen bajo o negativo: solo si tenemos costo cargado. Calcula el
    // precio mínimo para llegar a un margen objetivo sobre el costo.
    if (it.costo != null && !descartada('margen_bajo')) {
      const comision = it.comisionML || 0;
      const envio = it.envioCost || 0;
      const impuestosFrac = (it.impuestosPct || 0) / 100;
      const divisor = 1 - impuestosFrac;
      if (divisor > 0) {
        const objetivo = it.costo * (AGENTE_OBJETIVO_MARGEN_PCT / 100);
        const precioSugerido = Math.ceil((objetivo + it.costo + comision + envio) / divisor);
        if (precioSugerido > it.precio + 1) {
          const vendeConPerdida = it.margen != null && it.margen < 0;
          propuestas.push({
            tipo: 'margen_bajo',
            prioridad: vendeConPerdida ? 'alta' : 'media',
            itemId: it.id,
            titulo: it.titulo,
            thumbnail: it.thumbnail,
            permalink: it.permalink,
            descripcion: vendeConPerdida
              ? `Vende con pérdida (margen $${it.margen.toFixed(2)}).`
              : `Margen bajo (${it.margenPct != null ? it.margenPct.toFixed(0) : '?'}% sobre el costo, objetivo ${AGENTE_OBJETIVO_MARGEN_PCT}%).`,
            valorActual: it.precio,
            valorSugerido: precioSugerido,
            accionable: true,
          });
        }
      }
    }

    // 2. Pocas fotos.
    if (it.fotos != null && it.fotos < AGENTE_FOTOS_MINIMAS && !descartada('pocas_fotos')) {
      propuestas.push({
        tipo: 'pocas_fotos',
        prioridad: 'media',
        itemId: it.id,
        titulo: it.titulo,
        thumbnail: it.thumbnail,
        permalink: it.permalink,
        descripcion: `Tiene ${it.fotos} foto(s) cargada(s). MercadoLibre recomienda al menos ${AGENTE_FOTOS_MINIMAS}.`,
        valorActual: it.fotos,
        valorSugerido: null,
        accionable: false,
      });
    }

    // 3. Precio vs. Buy Box (experimental: ver advertencia en price_to_win).
    if (
      it.precioAGanar &&
      it.precioAGanar.status &&
      it.precioAGanar.status !== 'winning' &&
      it.precioAGanar.precioParaGanar != null &&
      it.precioAGanar.precioParaGanar < it.precio &&
      !descartada('precio_buybox')
    ) {
      propuestas.push({
        tipo: 'precio_buybox',
        prioridad: 'media',
        itemId: it.id,
        titulo: it.titulo,
        thumbnail: it.thumbnail,
        permalink: it.permalink,
        descripcion: `No tiene la mejor oferta (experimental). Bajando el precio la ganarías.`,
        valorActual: it.precio,
        valorSugerido: it.precioAGanar.precioParaGanar,
        accionable: true,
      });
    }

    // 4. Stock bajo.
    if (it.stock <= STOCK_BAJO_UMBRAL && !descartada('stock_bajo')) {
      propuestas.push({
        tipo: 'stock_bajo',
        prioridad: it.stock === 0 ? 'alta' : 'media',
        itemId: it.id,
        titulo: it.titulo,
        thumbnail: it.thumbnail,
        permalink: it.permalink,
        descripcion: `Quedan ${it.stock} unidad(es).`,
        valorActual: it.stock,
        valorSugerido: null,
        accionable: false,
      });
    }
  }

  const ordenPrioridad = { alta: 0, media: 1, baja: 2 };
  propuestas.sort((a, b) => (ordenPrioridad[a.prioridad] ?? 1) - (ordenPrioridad[b.prioridad] ?? 1));
  return propuestas;
}

module.exports = {
  authorizeUrl,
  exchangeCodeForToken,
  getStoredTokens,
  getItemsWithCostos,
  getPublicacionDetalle,
  getVentasYCMV,
  getConfig,
  setConfig,
  getSplCredenciales,
  setSplCredenciales,
  verificarSplLogin,
  setCosto,
  setTipo,
  crearOrdenDrop,
  getOrdenesDrop,
  getOrdenesDropPendientes,
  getOrdenDropById,
  marcarOrdenFacturada,
  setItemStatus,
  setItemStock,
  setItemPrice,
  STOCK_BAJO_UMBRAL,
  getUnansweredQuestions,
  answerQuestion,
  getReputation,
  getReclamos,
  getItemFull,
  getItemDescription,
  crearPublicacionDesdeTemplate,
  getEnvios,
  getShipmentLabelPdf,
  getTopProductos,
  getVentasPorSemana,
  getVisitasYConversion,
  getPrecioPromedioCategoria,
  getPropuestas,
  descartarPropuesta,
  getDescartesDetalle,
  reactivarDescarte,
  bootstrapUsuarioInicial,
  getUsuarios,
  crearUsuario,
  cambiarClaveUsuario,
  setUsuarioActivo,
  contarUsuariosActivos,
  verificarLogin,
  procesarNotificacionML,
};
