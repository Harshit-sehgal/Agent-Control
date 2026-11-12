/** Service worker: keeps the installed app usable without a network, shows push
 * notifications, and lands a tap on the screen the message is about.
 *
 * The shell is discovered by walking the module graph from index.html rather
 * than listed here. A hand-kept list goes stale the moment a shared/ module is
 * added, and the installed app then dies on one missing file with no network to
 * fetch it from.
 */
const CACHE = 'agent-control-shell-v2';
// Other apps on the same origin (a Pages site shares a host) are not ours to
// delete, so activation only removes names under this prefix.
const CACHE_PREFIX = 'agent-control-';
const DEFAULT_ROUTE = '#you/notifications';
// Both caps are here so a bug cannot hang install forever: a cycle in the
// import graph, or a request that never settles on a dead network.
const SHELL_LIMIT = 80;
const SHELL_TIMEOUT = 4000;

/** The workspace the worker lives in. registration.scope is set for every real
 * event; location is the fallback so a stripped-down environment still works. */
const scope = () => self.registration?.scope || self.location.href.replace(/[^/]*$/, '');
const absolute = path => new URL(path, scope()).href;

/** Same-origin URLs a document or module points at: script tags, stylesheets,
 * and the modules it imports. Anything absolute or outside the scope is not part
 * of this app's shell and is left alone. */
function referenced(text, url) {
  const out = [];
  const push = spec => {
    if (!spec || /^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('//')) return;
    try {
      const next = new URL(spec, url).href;
      if (next.startsWith(scope())) out.push(next);
    } catch { /* A malformed reference is skipped, not fatal. */ }
  };
  if (/\.html?$/i.test(new URL(url).pathname)) {
    for (const [, src] of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) push(src);
    for (const [tag] of text.matchAll(/<link\b[^>]*>/gi)) {
      if (/\brel\s*=\s*["'][^"']*\bstylesheet\b/i.test(tag)) push(/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
    }
  } else if (/\.m?js$/i.test(new URL(url).pathname)) {
    // `from '…'` covers named, default and re-exported modules; a side-effect
    // import (`import './x.js?v=99c330d626'`) has no from-clause and needs its own pattern.
    for (const [, spec] of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) push(spec);
    for (const [, spec] of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) push(spec);
  }
  return out;
}

/** Fetch one shell file, giving up instead of hanging on a dead network. */
async function grab(url) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), SHELL_TIMEOUT);
  try { return await fetch(url, {cache: 'reload', signal: abort.signal}); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

/** Fetch and store the whole shell. Nothing here may fail the install: an
 * offline first run still installs and picks the shell up on a later visit. */
async function cacheShell() {
  const cache = await caches.open(CACHE);
  const seen = new Set(), queue = ['index.html'];
  while (queue.length && seen.size < SHELL_LIMIT) {
    const url = absolute(queue.shift());
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await grab(url);
    // cache.addAll() is all-or-nothing, so one 404 would ship an app with an
    // empty cache. Individual failures are skipped and the rest still install.
    if (!response?.ok) continue;
    let text = '';
    try { text = await response.clone().text(); } catch { /* Binary or opaque: stored as fetched. */ }
    await cache.put(url, response).catch(() => {});
    queue.push(...referenced(text, url));
  }
}

self.addEventListener('install', event => event.waitUntil((async () => {
  try { await cacheShell(); }
  catch (error) { console.warn('Service worker: the app shell could not be cached.', error?.message); }
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  // Bumping CACHE is what retires a stale shell; without this the old entries
  // would keep being served after a deploy.
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE).map(name => caches.delete(name)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // The API is live data owned by the server: an intercepted or cached answer
  // would be a stale draft, or worse, a replay of someone else's session.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (!url.href.startsWith(scope())) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      // Only a complete, successful response is worth serving later.
      if (response?.ok) await cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const cached = await cache.match(request) || (request.mode === 'navigate' ? await cache.match(absolute('index.html')) : null);
      if (cached) return cached;
      // Nothing cached and no network: the page has to see the failure.
      throw error;
    }
  })());
});

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* Not ours: show the default text. */ }
  if (!message || typeof message !== 'object' || Array.isArray(message)) message = {};
  // A declarative payload nests the visible text under `notification`.
  if (typeof message.notification === 'object' && message.notification && !Array.isArray(message.notification)) message = {...message, ...message.notification};
  // One shared tag made every push replace the previous notification, so of a
  // burst only the last message was ever visible. Each push gets its own tag
  // unless the sender asked for one to be collapsed.
  const tag = typeof message.tag === 'string' && message.tag ? message.tag : `agent-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const route = typeof message.route === 'string' && message.route ? message.route : DEFAULT_ROUTE;
  const data = {...(message.data && typeof message.data === 'object' && !Array.isArray(message.data) ? message.data : {}), route};
  event.waitUntil(self.registration.showNotification(String(message.title || 'Agent Control'), {
    body: String(message.body || ''), icon: './icon-192.png', badge: './icon-192.png', tag, data,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data;
  const route = data && typeof data.route === 'string' && data.route ? data.route : DEFAULT_ROUTE;
  const target = absolute(route);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const app = windows.find(client => client.url.startsWith(scope()));
    // Focusing a window without navigating drops the user wherever they were,
    // so 'draft 3 is waiting' opened the app on the wrong screen.
    if (!app) return self.clients.openWindow(target);
    if (typeof app.navigate === 'function') {
      try {
        const navigated = await app.navigate(target);
        return await (navigated || app).focus();
      } catch { /* A client that refuses navigation is still worth focusing. */ }
    }
    return app.focus();
  })());
});

// The browser can rotate a subscription on its own. Without telling the
// server, the old endpoint 404s and this device silently stops receiving.
// Only a replacement the browser already created is stored. Subscribing here
// would turn push back on after the user switched it off.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const subscriptions = absolute('/api/push/subscriptions');
    const subscription = event.newSubscription || null;
    const oldEndpoint = event.oldSubscription?.endpoint;
    // A failed POST must not skip the DELETE: an early return left the server
    // sending to a dead endpoint while the live one was never registered.
    if (subscription) {
      try {
        const posted = await fetch(subscriptions, {
          method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(subscription.toJSON()),
        });
        if (!posted.ok) console.error(`Service worker: the replacement subscription was refused (${posted.status}).`);
      } catch (error) {
        // An offline rotation is retried by the browser on a later event; the
        // log is what makes a silent loss of push visible before that happens.
        console.error('Service worker: could not register the new subscription.', error?.message);
      }
    }
    if (!oldEndpoint || oldEndpoint === subscription?.endpoint) return;
    try {
      const removed = await fetch(subscriptions, {
        method: 'DELETE', credentials: 'include', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({endpoint: oldEndpoint}),
      });
      if (!removed.ok) console.error(`Service worker: the old subscription was not removed (${removed.status}).`);
    } catch (error) {
      console.error('Service worker: could not remove the old subscription.', error?.message);
    }
  })());
});
