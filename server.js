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

app.get('/publicaciones', requireLogin, requireMlConnected, async (req, res) => {
  try {
    const items = await ml.getItemsWithCostos(req.mlUserId);
    const filtro = req.query.estado || 'todas';
    const filtrados = items.filter((it) => {
      if (filtro === 'activas') return it.estado === 'active';
      if (filtro === 'pausadas') return it.estado === 'paused';
      return true;
    });
    res.render('publicaciones', { items: filtrados, filtro, total: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error consultando MercadoLibre: ' + err.message);
  }
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

app.post('/productos/:id/estado', requireLogin, requireMlConnected, async (req, res) => {
  try {
    await ml.setItemStatus(req.params.id, req.body.estado);
  } catch (err) {
    console.error(err);
  }
  res.redirect(req.get('Referer') || '/');
});

app.post('/productos/:id/stock', requireLogin, requireMlConnected, async (req, res) => {
  try {
    await ml.setItemStock(req.params.id, Number(req.body.stock));
  } catch (err) {
    console.error(err);
  }
  res.redirect(req.get('Referer') || '/');
});

// ---------- Configuración (impuestos, etc.) ----------

app.get('/configuracion', requireLogin, async (req, res) => {
  const config = await ml.getConfig();
  res.render('configuracion', { config, guardado: req.query.guardado === '1' });
});

app.post('/configuracion', requireLogin, async (req, res) => {
  const pct = Number(req.body.impuestos_pct) || 0;
  await ml.setConfig(pct);
  res.redirect('/configuracion?guardado=1');
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
    res.render('reputacion', { rep });
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
