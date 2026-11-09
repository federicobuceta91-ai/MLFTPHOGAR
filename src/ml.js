const crypto = require('crypto');
const { pool } = require('./db');

const API = 'https://api.mercadolibre.com';
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
    if (typeof match.sale_fee_amount === 'number') return match.sale_fee_amount;
    if (match.sale_fee_details && typeof match.sale_fee_details.percentage_fee === 'number') {
      return (item.price * match.sale_fee_details.percentage_fee) / 100;
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

  return items.map((it, idx) => {
    const costoRow = costos[it.id];
    const costo = costoRow ? Number(costoRow.costo) : null;
    const precio = it.price;
    const comisionML = comisiones[idx];
    const envioCost = envios[idx];
    const precioAGanar = preciosAGanar[idx];
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
    };
  });
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

async function getUnansweredQuestions(userId) {
  const data = await mlFetch(`/questions/search?seller_id=${userId}&status=UNANSWERED&sort_fields=date_created&sort_types=DESC`);
  return data.questions || [];
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

module.exports = {
  authorizeUrl,
  exchangeCodeForToken,
  getStoredTokens,
  getItemsWithCostos,
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
  getUnansweredQuestions,
  answerQuestion,
  getReputation,
  getReclamos,
};
