/** The service worker is the one file no test can import into a browser, so it
 * is loaded the way the browser loads it: a classic script given `self`. The
 * listener registry is real, so deleting a handler fails a test here instead of
 * being grepped for and quietly surviving. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../shared/sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://dash.example/';

/** A CacheStorage stand-in with the semantics that matter: put() consumes the
 * body, match() hands back a fresh Response the way the real Cache does. */
function cacheStorage() {
  const stores = new Map();
  const entries = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    stores,
    entries,
    open: async name => ({
      put: async (key, response) => { entries(name).set(typeof key === 'string' ? key : key.url, {status: response.status, text: await response.text()}); },
      match: async key => {
        const found = entries(name).get(typeof key === 'string' ? key : key.url);
        return found ? new Response(found.text, {status: found.status}) : undefined;
      },
    }),
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
  };
}

/** Load shared/sw.js against a stub `self` and a stub network.
 * `shell` is path → body; an absent path answers 404 and a path in `broken`
 * throws the way a dropped connection does. `api` answers `/api/*` per method,
 * so a refused POST and an offline DELETE are both expressible. */
function worker({shell = {}, broken = new Set(), api = {}, windows = []} = {}) {
  const listeners = new Map();
  const state = {shell, broken, api, windows, claimed: 0, subscribed: 0, fetches: [], shown: [], opened: []};
  const cache = cacheStorage();
  const applicationServerKey = {bytes: 'k'};

  const fetch = async (url, init = {}) => {
    // A fetch event hands the handler a Request, which is also a valid fetch input.
    const href = typeof url === 'string' ? url : url.url, method = init.method || url.method || 'GET', path = new URL(href).pathname;
    state.fetches.push({href, method, body: init.body});
    if (path.startsWith('/api/')) {
      const answer = state.api[method] || {};
      if (answer.throw) throw new TypeError('Failed to fetch');
      return new Response('', {status: answer.status ?? 200});
    }
    if (state.broken.has(path)) throw new TypeError('Failed to fetch');
    if (!(path in state.shell)) return new Response('not found', {status: 404});
    return new Response(state.shell[path], {status: 200});
  };

  const self = {
    location: {href: `${SCOPE}sw.js`, origin: 'https://dash.example'},
    registration: {
      scope: SCOPE,
      showNotification: async (title, options) => { state.shown.push({title, options}); },
      // The worker must never create a subscription: that would switch push
      // back on after the user turned it off.
      pushManager: {subscribe: async () => { state.subscribed++; return {applicationServerKey}; }},
    },
    clients: {
      claim: async () => { state.claimed++; },
      matchAll: async () => state.windows,
      openWindow: async url => { state.opened.push(url); return null; },
    },
    skipWaiting: async () => {},
    addEventListener(type, fn) { listeners.set(type, fn); },
  };

  const previous = {caches: globalThis.caches, fetch: globalThis.fetch};
  globalThis.caches = cache;
  globalThis.fetch = fetch;
  new Function('self', source)(self);  // eslint-disable-line no-new-func

  /** Dispatch a listener the way the browser does and wait for its waitUntil()
   * work, which is where every behaviour of this worker lives. */
  const run = (type, event = {}) => {
    const listener = listeners.get(type);
    assert.equal(typeof listener, 'function', `no ${type} listener is registered`);
    const work = [];
    listener({...event, waitUntil: promise => work.push(promise)});
    return Promise.all(work);
  };

  return {
    state, run,
    listener: type => listeners.get(type),
    caches: cache,
    cached: () => cache.entries([...cache.stores.keys()][0] || ''),
    restore() {
      if (previous.caches === undefined) delete globalThis.caches; else globalThis.caches = previous.caches;
      globalThis.fetch = previous.fetch;
    },
  };
}

const html = body => `<!doctype html><html><head><link rel="stylesheet" href="./app.css"></head><body>${body}</body></html>`;

test('install caches the app shell by walking the module graph, and survives a missing or offline file', async () => {
  const w = worker({
    shell: {
      '/index.html': html(`<script type="module" src="./app.js"></script><script defer src="./transport.js"></script>`),
      '/app.js': `import {a} from './a.js';\nimport './style-side.js';\nexport {a};`,
      '/a.js': `import {b} from './b.js';\nexport const a = b;`,
      '/b.js': `export const b = 1;`,
    },
    // app.css is a 404 (absent) and transport.js drops the connection: neither
    // may fail the install, or one stale file leaves the app with no cache.
    broken: new Set(['/transport.js']),
  });
  try {
    await w.run('install');

    const names = [...w.caches.stores.keys()];
    assert.equal(names.length, 1);
    assert.match(names[0], /^agent-control-.+-v\d+$/, 'the cache name must be versioned so activation can retire it');
    assert.deepEqual([...w.cached().keys()].sort(), [
      `${SCOPE}a.js`, `${SCOPE}app.js`, `${SCOPE}b.js`, `${SCOPE}index.html`,
    ], 'the walk must follow <script src>, stylesheet href and `from …` imports');
    for (const {href} of w.state.fetches) assert.ok(!href.includes('/api/'), `/api/ must never be fetched by install (${href})`);
  } finally { w.restore(); }
});

test('activate deletes older shells and keeps caches that are not ours', async () => {
  const w = worker();
  try {
    w.caches.stores.set('agent-control-shell-v1', new Map());
    w.caches.stores.set('some-other-app', new Map());
    await w.run('activate');
    assert.equal(w.caches.stores.has('agent-control-shell-v1'), false, 'a bumped cache name must retire the old shell');
    assert.equal(w.caches.stores.has('some-other-app'), true, 'another app on the same origin is not ours to delete');
    assert.equal(w.caches.stores.size, 1);
    assert.equal(w.state.claimed, 1);
  } finally { w.restore(); }
});

test('the fetch handler is network-first, fills the cache, and only falls back on a failure', async () => {
  const w = worker({shell: {'/app.js': 'export const x = 1;', '/index.html': html(''), '/': html('')}});
  try {
    await w.run('install');
    assert.equal(typeof w.listener('fetch'), 'function', 'an installed app with no fetch handler is a blank error page offline');

    const respond = async request => {
      let answered = null;
      await w.run('fetch', {request, respondWith: promise => { answered = promise; }});
      return answered && await answered.catch(error => ({failed: error.message}));
    };

    // Never intercept the API: a cached answer is a stale draft or a replay.
    for (const request of [
      {method: 'GET', url: `${SCOPE}api/state`, mode: 'cors'},
      {method: 'GET', url: `${SCOPE}api`, mode: 'cors'},
      {method: 'POST', url: `${SCOPE}app.js`, mode: 'cors'},
      {method: 'GET', url: 'https://push.example.com/send/abc', mode: 'cors'},
    ]) {
      let intercepted = false;
      await w.run('fetch', {request, respondWith: () => { intercepted = true; }});
      assert.equal(intercepted, false, `${request.method} ${request.url} must be left to the network`);
    }

    const before = w.state.fetches.length;
    const live = await respond({method: 'GET', url: `${SCOPE}app.js`, mode: 'cors'});
    assert.equal(await live.text(), 'export const x = 1;');
    assert.equal(w.state.fetches.length, before + 1, 'a GET is fetched from the network first');
    assert.ok(w.cached().has(`${SCOPE}app.js`), 'a successful response fills the cache');

    w.state.broken.add('/app.js');
    const offline = await respond({method: 'GET', url: `${SCOPE}app.js`, mode: 'cors'});
    assert.equal(await offline.text(), 'export const x = 1;', 'a network failure falls back to the cache');

    // A navigation to the start URL has to reach the cached shell offline: the
    // manifest starts the installed app at the scope root, and the cache holds
    // index.html, so a plain lookup by URL would miss.
    w.state.broken.add('/');
    const start = await respond({method: 'GET', url: SCOPE, mode: 'navigate'});
    assert.match(await start.text(), /<!doctype html>/, 'an offline launch must open the cached shell');

    w.state.broken.add('/never.js');
    const missing = await respond({method: 'GET', url: `${SCOPE}never.js`, mode: 'cors'});
    assert.match(missing.failed, /Failed to fetch/, 'nothing cached and no network must surface the failure');
  } finally { w.restore(); }
});

test('each push gets its own tag, unless the payload names one, and carries its route', async () => {
  const w = worker();
  try {
    await w.run('push', {data: {json: () => ({title: 'Draft 1', body: 'ready', route: '#you/queue'})}});
    await w.run('push', {data: {json: () => ({title: 'Draft 2', body: 'ready'})}});
    await w.run('push', {data: {json: () => ({web_push: 8030, notification: {title: 'Nested', body: 'Inside'}})}});
    await w.run('push', {data: {json: () => ({title: 'Collapsed', tag: 'drafts'})}});

    assert.deepEqual(w.state.shown.map(s => s.title), ['Draft 1', 'Draft 2', 'Nested', 'Collapsed']);
    const [first, second] = w.state.shown;
    assert.ok(first.options.tag && second.options.tag);
    assert.notEqual(first.options.tag, second.options.tag, 'one shared tag made each push replace the last one');
    assert.equal(w.state.shown[3].options.tag, 'drafts', 'a sender that names a tag still gets it');
    assert.equal(first.options.data.route, '#you/queue', 'the route travels with the notification');
    assert.equal(second.options.data.route, '#you/notifications', 'and defaults to where the messages are listed');
    assert.equal(w.state.shown[2].options.body, 'Inside', 'a declarative payload nests its text');
  } finally { w.restore(); }
});

test('clicking a notification navigates the focused window to that route', async () => {
  let navigated = null, focused = 0, closed = 0;
  const client = {
    url: `${SCOPE}#chat/writer`,
    focus: async () => { focused++; },
    navigate: async url => { navigated = url; return {focus: async () => { focused++; }}; },
  };
  const w = worker({windows: [client]});
  try {
    await w.run('notificationclick', {notification: {close: () => { closed++; }, data: {route: '#you/queue'}}});
    assert.equal(closed, 1);
    assert.equal(navigated, `${SCOPE}#you/queue`, 'focusing without navigating dropped the user on the wrong screen');
    assert.ok(focused >= 1, 'the window is brought forward after navigating');
    assert.deepEqual(w.state.opened, [], 'an existing window is reused, not replaced');

    // The default route, and a window that refuses to navigate, still focuses.
    navigated = null;
    const refuses = {url: `${SCOPE}#chat/writer`, focus: async () => { focused++; }, navigate: async () => { throw new Error('blocked'); }};
    w.state.windows = [refuses];
    await w.run('notificationclick', {notification: {close() {}, data: {}}});
    assert.equal(focused >= 2, true);
    assert.equal(w.state.opened.length, 0);

    // No window at all opens a new one at the route.
    w.state.windows = [];
    await w.run('notificationclick', {notification: {close() {}, data: {route: '#you/queue'}}});
    assert.deepEqual(w.state.opened, [`${SCOPE}#you/queue`]);
  } finally { w.restore(); }
});

test('a rotated subscription registers the replacement, then always drops the old endpoint', async () => {
  const w = worker();
  // A rotation that fails has to be visible somewhere; silence is how a device
  // stops receiving push without anyone noticing.
  const logged = [], originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const next = {endpoint: 'https://push.example.com/send/new', toJSON: () => ({endpoint: 'https://push.example.com/send/new', keys: {p256dh: 'p', auth: 'a'}})};
    const old = {endpoint: 'https://push.example.com/send/old'};

    // A refused POST must not skip the DELETE: an early return left the server
    // sending to the endpoint the browser had just replaced.
    w.state.api.POST = {status: 500};
    await w.run('pushsubscriptionchange', {newSubscription: next, oldSubscription: old});
    assert.deepEqual(w.state.fetches.map(f => f.method), ['POST', 'DELETE'], 'the old endpoint is dropped even when the new one was refused');
    assert.equal(JSON.parse(w.state.fetches[1].body).endpoint, old.endpoint);

    // A POST that rejects outright is logged, not left to kill the event.
    w.state.fetches.length = 0;
    w.state.api.POST = {throw: true};
    await w.run('pushsubscriptionchange', {newSubscription: next, oldSubscription: old});
    assert.deepEqual(w.state.fetches.map(f => f.method), ['POST', 'DELETE'], 'an offline POST still drops the old endpoint');

    // A DELETE that rejects must not reject the event either.
    w.state.fetches.length = 0;
    w.state.api = {DELETE: {throw: true}};
    await w.run('pushsubscriptionchange', {newSubscription: null, oldSubscription: old});
    assert.deepEqual(w.state.fetches.map(f => f.method), ['DELETE']);

    // A replacement is never created here: the user may have switched push off.
    assert.equal(w.state.subscribed, 0, 'the worker must never subscribe on its own');
    assert.match(logged.join('\n'), /replacement subscription was refused/, 'a refused POST is logged');
    assert.match(logged.join('\n'), /could not remove the old subscription/, 'a failed DELETE is logged');
    assert.match(logged.join('\n'), /could not register the new subscription/, 'an offline POST is logged');
  } finally { console.error = originalError; w.restore(); }
});
