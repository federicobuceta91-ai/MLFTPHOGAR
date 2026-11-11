const webpush = require('web-push');
const { pool } = require('./db');

// ---------- Notificaciones push (navegador/app instalada) ----------
// Para que esto funcione hace falta cargar en las Environment Variables de
// Render un par de claves VAPID (se generan una sola vez, no dependen de
// ninguna cuenta externa): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y, opcional,
// VAPID_SUBJECT (un mailto: de contacto). Si no están cargadas, las funciones
// de acá simplemente no hacen nada (no rompen el resto de la app).

let configurado = false;

function configurar() {
  if (configurado) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:soporte@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configurado = true;
}

function habilitado() {
  configurar();
  return configurado;
}

async function guardarSuscripcion(usuarioId, sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Suscripción inválida.');
  }
  await pool.query(
    `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET
       usuario_id = EXCLUDED.usuario_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth`,
    [usuarioId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
}

async function eliminarSuscripcion(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function contarSuscripcionesDeUsuario(usuarioId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM push_subscriptions WHERE usuario_id = $1',
    [usuarioId]
  );
  return rows[0].total;
}

// Manda el mismo aviso a TODOS los dispositivos suscriptos (de cualquier
// usuario) — para algo como "hubo una venta" tiene sentido que se entere
// cualquiera de la familia, no solo quien esté mirando la app en ese momento.
async function enviarATodos(payload) {
  configurar();
  if (!configurado) {
    console.error('Notificaciones push: faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en las variables de entorno, no se pudo avisar.');
    return;
  }
  const { rows } = await pool.query('SELECT * FROM push_subscriptions');
  const texto = JSON.stringify(payload);
  await Promise.all(
    rows.map(async (row) => {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(sub, texto);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // El navegador invalidó esta suscripción (desinstalaron la app,
          // revocaron el permiso, etc.) — la borramos para no reintentar.
          await eliminarSuscripcion(row.endpoint).catch(() => {});
        } else {
          console.error('Error enviando notificación push:', err.message);
        }
      }
    })
  );
}

module.exports = {
  habilitado,
  guardarSuscripcion,
  eliminarSuscripcion,
  contarSuscripcionesDeUsuario,
  enviarATodos,
};
