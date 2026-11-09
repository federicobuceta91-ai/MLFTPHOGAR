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

async function getItemsWithCostos(userId) {
  const ids = await getAllItemIds(userId);
  const items = await getItemsDetails(ids);
  const { rows } = await pool.query('SELECT * FROM productos');
  const costos = Object.fromEntries(rows.map((r) => [r.ml_item_id, r]));

  return items.map((it) => {
    const costoRow = costos[it.id];
    const costo = costoRow ? Number(costoRow.costo) : null;
    const precio = it.price;
    const margen = costo != null ? precio - costo : null;
    const margenPct = costo != null && costo > 0 ? ((margen / costo) * 100) : null;
    return {
      id: it.id,
      titulo: it.title,
      precio,
      stock: it.available_quantity,
      estado: it.status,
      permalink: it.permalink,
      thumbnail: it.thumbnail,
      costo,
      margen,
      margenPct,
      notas: costoRow ? costoRow.notas : null,
    };
  });
}

async function setCosto(itemId, costo, notas) {
  await pool.query(
    `INSERT INTO productos (ml_item_id, costo, notas, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (ml_item_id) DO UPDATE SET costo = EXCLUDED.costo, notas = EXCLUDED.notas, updated_at = now()`,
    [itemId, costo, notas || null]
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

async function getReputation(userId) {
  const data = await mlFetch(`/users/${userId}`);
  return {
    nickname: data.nickname,
    levelId: data.seller_reputation ? data.seller_reputation.level_id : null,
    powerSellerStatus: data.seller_reputation ? data.seller_reputation.power_seller_status : null,
    transactions: data.seller_reputation ? data.seller_reputation.transactions : {},
    metrics: data.seller_reputation ? data.seller_reputation.metrics : {},
  };
}

module.exports = {
  authorizeUrl,
  exchangeCodeForToken,
  getStoredTokens,
  getItemsWithCostos,
  setCosto,
  setItemStatus,
  setItemStock,
  getUnansweredQuestions,
  answerQuestion,
  getReputation,
};
