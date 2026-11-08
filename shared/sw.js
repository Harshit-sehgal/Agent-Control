/** Service worker: shows push notifications and reopens the app when one is
 * tapped. It caches nothing, so the app always loads from the server. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* Not ours: show the default text. */ }
  if (!message || typeof message !== 'object' || Array.isArray(message)) message = {};
  // A declarative payload nests the visible text, or hands it over as
  // event.notification with no data. Either way the text has to be shown.
  if (typeof message.notification === 'object' && message.notification && !Array.isArray(message.notification)) message = {...message, ...message.notification};
  if (!message.title && event.notification) message = {title: event.notification.title, body: event.notification.body};
  event.waitUntil(self.registration.showNotification(String(message.title || 'Agent Control'), {
    body: String(message.body || ''), icon: './icon-192.png', badge: './icon-192.png', tag: 'agent-control',
  }));
});

// The browser can rotate a subscription on its own. Without telling the
// server, the old endpoint 404s and this device silently stops receiving.
// Only a replacement the browser already created is stored. Subscribing here
// would turn push back on after the user switched it off.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const endpoint = path => new URL(path, self.registration.scope);
    const subscription = event.newSubscription || null;
    if (subscription) {
      const posted = await fetch(endpoint('/api/push/subscriptions'), {
        method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!posted.ok) return;
    }
    const oldEndpoint = event.oldSubscription?.endpoint;
    if (!oldEndpoint || oldEndpoint === subscription?.endpoint) return;
    await fetch(endpoint('/api/push/subscriptions'), {
      method: 'DELETE', credentials: 'include', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({endpoint: oldEndpoint}),
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(open => {
    const app = open.find(client => client.url.startsWith(self.registration.scope));
    return app ? app.focus() : self.clients.openWindow(`${self.registration.scope}#you/notifications`);
  }));
});
