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
