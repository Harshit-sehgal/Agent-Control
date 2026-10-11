/** Service worker: shows push notifications and reopens the app when one is
 * tapped. It caches nothing, so the app always loads from the server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* Not ours: show the default text. */ }
  event.waitUntil(self.registration.showNotification(String(message.title || 'Agent Control'), {
    body: String(message.body || ''), icon: './icon-192.png', badge: './icon-192.png', tag: 'agent-control',
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(open => {
    const app = open.find(client => client.url.startsWith(self.registration.scope));
    return app ? app.focus() : self.clients.openWindow(`${self.registration.scope}#you/notifications`);
  }));
});
