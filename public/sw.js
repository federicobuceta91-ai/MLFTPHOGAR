// Service worker mínimo: solo existe para que el navegador considere la app
// "instalable" (requisito técnico de Chrome/Android). Por ahora no guarda nada
// para usar sin conexión — si no hay internet, la app simplemente no va a
// cargar, igual que antes.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// Notificaciones push (venta nueva, pregunta nueva). El servidor manda un
// JSON con { title, body, url } — ver src/push.js.
self.addEventListener('push', (event) => {
  let datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch (err) {
    datos = {};
  }
  const titulo = datos.title || 'SymL × FTP Hogar';
  const opciones = {
    body: datos.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    data: { url: datos.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

// Al tocar la notificación, lleva directo a la pantalla correspondiente
// (Publicaciones para ventas, Preguntas para preguntas) en vez de abrir una
// pestaña nueva en blanco si ya hay una abierta.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if ('focus' in cliente) {
          cliente.navigate(url);
          return cliente.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
