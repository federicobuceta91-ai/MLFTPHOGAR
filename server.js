require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const { migrate } = require('./src/db');
const ml = require('./src/ml');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'cambiar-esto',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);

function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  return res.redirect('/login');
}

// Login aparte para el "Panel SPL" (el futuro esclavo que usaría SPL Distribuidora).
function requireSplLogin(req, res, next) {
  if (req.session.splLoggedIn) return next();
  return res.redirect('/spl/login');
}

// Para el remito: lo puede ver tanto Federico como alguien logueado en el Panel SPL.
function requireAlgunLogin(req, res, next) {
  if (req.session.loggedIn || req.session.splLoggedIn) return next();
  return res.redirect('/login');
}

// ---------- Login de la app (compartido para Federico y su hija) ----------

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { usuario, clave } = req.body;
  if (usuario === process.env.APP_LOGIN_USER && clave === process.env.APP_LOGIN_PASS) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Usuario o clave incorrectos' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Login aparte del Panel SPL (prototipo del "esclavo" para SPL Distribuidora) ----------

app.get('/spl/login', (req, res) => {
  res.render('spl-login', { error: null });
});

app.post('/spl/login', async (req, res) => {
  const { usuario, clave } = req.body;
  const ok = await ml.verificarSplLogin(usuario, clave);
  if (ok) {
    req.session.splLoggedIn = true;
    return res.redirect('/spl');
  }
  res.render('spl-login', { error: 'Usuario o clave incorrectos' });
});

app.post('/spl/logout', (req, res) => {
  req.session.splLoggedIn = false;
  res.redirect('/spl/login');
});

// ---------- Conexión OAuth con MercadoLibre ----------

app.get('/connect-ml', requireLogin, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.mlState = state;
  res.render('connect', { authorizeUrl: ml.authorizeUrl(state) });
});

app.get('/callback', requireLogin, async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Falta el parámetro code en la respuesta de MercadoLibre.');
  if (!state || state !== req.session.mlState) {
    return res.status(400).send('El parámetro state no coincide, probá conectar de nuevo desde /connect-ml.');
  }
  try {
    await ml.exchangeCodeForToken(code);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error conectando con MercadoLibre: ' + err.message);
  }
});

// ---------- Helper: exige que ya esté conectada la cuenta de ML ----------

async function requireMlConnected(req, res, next) {
  const tokens = await ml.getStoredTokens();
  if (!tokens) return res.redirect('/connect-ml');
  req.mlUserId = tokens.ml_user_id;
  next();
}

// ---------- Dashboard principal: KPIs ----------

app.get('/', requireLogin, requireMlConnected, async (req, res) => {
  let ventas = { ventas: 0, cmv: 0, margenPct: null, cmvIncompleto: false, dias: 30, cantidadOrdenes: 0 };
  let ventasError = null;
  try {
    ventas = await ml.getVentasYCMV(req.mlUserId, 30);
  } catch (err) {
    console.error('Error calculando ventas/CMV:', err);
    ventasError = err.message;
  }

  try {
    const items = await ml.getItemsWithCostos(req.mlUserId);
    const activas = items.filter((it) => it.estado === 'active').length;
    const pausadas = items.filter((it) => it.estado === 'paused').length;
    res.render('inicio', {
      ventas,
      ventasError,
      totalPublicaciones: items.length,
      activas,
      pausadas,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error consultando MercadoLibre: ' + err.message);
  }
});

// ---------- Publicaciones: rentabilidad y stock ----------

const STOCK_BAJO_UMBRAL = 3; // a partir de este número (inclusive) se considera "stock bajo"

app.get('/publicaciones', requireLogin, requireMlConnected, async (req, res) => {
  try {
    const items = await ml.getItemsWithCostos(req.mlUserId);

    const filtro = req.query.estado || 'todas';
    const costoFiltro = req.query.costo || 'todos';
    const stockFiltro = req.query.stock || 'todos';
    const q = (req.query.q || '').trim().toLowerCase();
    const sort = req.query.sort || '';
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc';

    let filtrados = items.filter((it) => {
      if (filtro === 'activas' && it.estado !== 'active') return false;
      if (filtro === 'pausadas' && it.estado !== 'paused') return false;
      if (filtro === 'inactivas' && (it.estado === 'active' || it.estado === 'paused')) return false;
      if (costoFiltro === 'sin' && it.costo != null) return false;
      if (stockFiltro === 'bajo' && it.stock > STOCK_BAJO_UMBRAL) return false;
      if (q && !it.titulo.toLowerCase().includes(q)) return false;
      return true;
    });

    const claves = { precio: 'precio', margen: 'margen', stock: 'stock', titulo: 'titulo' };
    if (claves[sort]) {
      const key = claves[sort];
      filtrados = filtrados.slice().sort((a, b) => {
        const va = a[key];
        const vb = b[key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // los que no tienen dato quedan al final
        if (vb == null) return -1;
        if (typeof va === 'string') return dir === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
        return dir === 'desc' ? vb - va : va - vb;
      });
    }

    res.render('publicaciones', {
      items: filtrados,
      filtro,
      costoFiltro,
      stockFiltro,
      q: req.query.q || '',
      sort,
      dir,
      stockBajoUmbral: STOCK_BAJO_UMBRAL,
      total: items.length,
      errorAccion: req.query.errorAccion || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error consultando MercadoLibre: ' + err.message);
  }
});

// ---------- Drop Shipping (prototipo: todavía simulado, sin conexión real a Odoo/SPL) ----------

app.post('/productos/:id/tipo', requireLogin, async (req, res) => {
  const { tipo, proveedor } = req.body;
  await ml.setTipo(req.params.id, tipo, proveedor);
  res.redirect(req.get('Referer') || '/publicaciones');
});

app.get('/drop-shipping', requireLogin, requireMlConnected, async (req, res) => {
  try {
    const items = await ml.getItemsWithCostos(req.mlUserId);
    const productosDrop = items.filter((it) => it.tipo === 'drop');
    const ordenes = await ml.getOrdenesDrop();
    res.render('drop-shipping', { productosDrop, ordenes });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error consultando MercadoLibre: ' + err.message);
  }
});

app.post('/drop-shipping/simular', requireLogin, async (req, res) => {
  const { itemId, titulo, proveedor, cantidad, comprador, direccionEnvio } = req.body;
  await ml.crearOrdenDrop({
    itemId,
    titulo,
    proveedor,
    cantidad: Number(cantidad) || 1,
    comprador,
    direccionEnvio,
  });
  res.redirect('/drop-shipping');
});

app.post('/drop-shipping/:id/facturar', requireLogin, async (req, res) => {
  await ml.marcarOrdenFacturada(req.params.id);
  res.redirect('/drop-shipping');
});

app.get('/drop-shipping/:id/remito', requireAlgunLogin, async (req, res) => {
  const orden = await ml.getOrdenDropById(req.params.id);
  if (!orden) return res.status(404).send('Orden no encontrada.');
  res.render('remito', { orden });
});

// ---------- Panel SPL (vista de prueba de lo que vería SPL Distribuidora) ----------

app.get('/spl', requireSplLogin, async (req, res) => {
  const pendientes = await ml.getOrdenesDropPendientes();
  res.render('spl-panel', { pendientes });
});

app.post('/spl/:id/facturar', requireSplLogin, async (req, res) => {
  await ml.marcarOrdenFacturada(req.params.id);
  res.redirect('/spl');
});

// ---------- Secciones todavía en construcción ----------

const SECCIONES_PROXIMAS = {
  ventas: 'Ventas reales',
  envios: 'Envíos',
  metricas: 'Métricas',
  comparativa: 'Comparativa con la competencia',
};

app.get('/proximamente', requireLogin, (req, res) => {
  const seccion = req.query.s;
  const nombre = SECCIONES_PROXIMAS[seccion] || 'Próximamente';
  res.render('proximamente', { seccion, nombre });
});

app.post('/productos/:id/costo', requireLogin, async (req, res) => {
  const { costo, notas } = req.body;
  const valor = costo === '' || costo === undefined ? null : Number(costo);
  await ml.setCosto(req.params.id, valor, notas);
  res.redirect(req.get('Referer') || '/');
});

// Si MercadoLibre rechaza el cambio (por ejemplo, no te deja reactivar una
// publicación sin stock o con algún problema de calidad), antes esto fallaba
// en silencio: redirigía como si nada y el usuario nunca se enteraba. Ahora
// agregamos el motivo como parámetro en la URL para poder mostrarlo.
function redirectConError(req, res, mensaje) {
  const referer = req.get('Referer') || '/publicaciones';
  let url;
  try {
    url = new URL(referer, `${req.protocol}://${req.get('host')}`);
  } catch (e) {
    return res.redirect('/publicaciones');
  }
  url.searchParams.set('errorAccion', mensaje);
  res.redirect(url.pathname + url.search);
}

app.post('/productos/:id/estado', requireLogin, requireMlConnected, async (req, res) => {
  try {
    await ml.setItemStatus(req.params.id, req.body.estado);
    res.redirect(req.get('Referer') || '/');
  } catch (err) {
    console.error(err);
    redirectConError(req, res, 'MercadoLibre no permitió cambiar el estado: ' + err.message);
  }
});

app.post('/productos/:id/stock', requireLogin, requireMlConnected, async (req, res) => {
  try {
    await ml.setItemStock(req.params.id, Number(req.body.stock));
    res.redirect(req.get('Referer') || '/');
  } catch (err) {
    console.error(err);
    redirectConError(req, res, 'MercadoLibre no permitió actualizar el stock: ' + err.message);
  }
});

// ---------- Configuración (impuestos, etc.) ----------

app.get('/configuracion', requireLogin, async (req, res) => {
  const config = await ml.getConfig();
  const spl = await ml.getSplCredenciales();
  res.render('configuracion', {
    config,
    spl,
    guardado: req.query.guardado === '1',
    splGuardado: req.query.splGuardado === '1',
    splError: req.query.splError || null,
  });
});

app.post('/configuracion', requireLogin, async (req, res) => {
  const pct = Number(req.body.impuestos_pct) || 0;
  await ml.setConfig(pct);
  res.redirect('/configuracion?guardado=1');
});

app.post('/configuracion/spl-login', requireLogin, async (req, res) => {
  const { usuario, clave, clave2 } = req.body;
  if (!usuario || !usuario.trim()) {
    return res.redirect('/configuracion?splError=' + encodeURIComponent('Ingresá un usuario.'));
  }
  if (clave && clave !== clave2) {
    return res.redirect('/configuracion?splError=' + encodeURIComponent('Las claves no coinciden.'));
  }
  await ml.setSplCredenciales(usuario.trim(), clave || null);
  res.redirect('/configuracion?splGuardado=1');
});

// ---------- Preguntas ----------

app.get('/preguntas', requireLogin, requireMlConnected, async (req, res) => {
  try {
    const preguntas = await ml.getUnansweredQuestions(req.mlUserId);
    res.render('preguntas', { preguntas });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error consultando preguntas: ' + err.message);
  }
});

app.post('/preguntas/:id/responder', requireLogin, requireMlConnected, async (req, res) => {
  try {
    await ml.answerQuestion(req.params.id, req.body.respuesta);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/preguntas');
});

// ---------- Reputación ----------

app.get('/reputacion', requireLogin, requireMlConnected, async (req, res) => {
  try {
    const rep = await ml.getReputation(req.mlUserId);
    const reclamos = await ml.getReclamos(req.mlUserId);
    res.render('reputacion', { rep, reclamos });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error consultando reputación: ' + err.message);
  }
});

// ---------- Arranque ----------

migrate()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`ML con More corriendo en 0.0.0.0:${port}`);
    });
  })
  .catch((err) => {
    console.error('Error migrando la base de datos:', err);
    process.exit(1);
  });
