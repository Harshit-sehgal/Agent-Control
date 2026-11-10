import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext, runInContext} from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = file => readFile(path.join(root, 'shared', file), 'utf8');
const transportSource = await shared('transport.js');

// ---- transport: a body that is not JSON, and a request that never settles -----

// Load shared/transport.js in a vm with browser stubs. `fetch` and the reply are
// injectable so a broken body and a timeout can be replayed exactly.
function load({response, fetch, globals = {}} = {}) {
  const calls = [];
  const reply = response || {ok: true, status: 200, json: async () => ({ok: true})};
  const fakeFetch = fetch || ((url, options) => { calls.push({url, options}); return Promise.resolve(reply); });
  const meta = {getAttribute: () => 'server'};
  const document = {querySelector: selector => (selector.includes('agent-backend') ? meta : null)};
  const context = {window: {AGENT_LOCAL_API: () => Promise.resolve({})}, location: {protocol: 'https:'}, document, fetch: fakeFetch, console, ...globals};
  context.window.window = context.window;
  runInContext(transportSource, createContext(context));
  return {api: context.window.AGENT_API, calls};
}

const brokenBody = text => ({ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => text});

test('a 200 whose body is not JSON is an error, not a stored snapshot', async () => {
  const {api} = load({response: brokenBody('<html>sign in to the proxy</html>')});
  // Before, this resolved `{error: 'Invalid server response'}` and loadState()
  // stored it as the workspace, blanking every pane with no error at all.
  await assert.rejects(api('/api/state'), /not JSON/);
});

test('an empty successful body is still an empty success', async () => {
  const {api} = load({response: brokenBody('')});
  // A route that returns nothing writes no JSON. That is a no-content reply, not
  // a broken one, so it must not turn a working DELETE into a thrown error.
  assert.equal(JSON.stringify(await api('/api/groups/g1', 'DELETE')), '{}');
});

test('a failed request with an unreadable body still reports its status', async () => {
  const {api} = load({response: {ok: false, status: 502, json: async () => { throw new SyntaxError('bad'); }, text: async () => '<html>bad gateway</html>'}});
  const error = await api('/api/state').then(() => null, e => e);
  assert.equal(error.status, 502, 'sign-in and permission handling key on the status');
  assert.match(error.message, /HTTP 502/);
});

test('a request the server never answers surfaces as an ordinary error', async () => {
  const timeout = Object.assign(new Error('timed out'), {name: 'TimeoutError'});
  const {api} = load({fetch: () => Promise.reject(timeout)});
  const error = await api('/api/state').then(() => null, e => e);
  // The error is created inside the vm, so it has that realm's Error prototype.
  assert.equal(error?.name, 'Error');
  assert.match(error.message, /took too long/);
  assert.equal(error.timeout, true);
});

test('a request carries an abort timeout where the browser has one', async () => {
  const {api, calls} = load({globals: {AbortSignal: {timeout: ms => ({abortedAfter: ms})}}});
  await api('/api/state');
  assert.equal(calls[0].options.signal.abortedAfter, 20000);
});

// ---- ui-store: what a chat change resets -------------------------------------

const META = {agentBackend: 'server'};
globalThis.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
globalThis.document = {
  querySelector: selector => (selector.includes('agent-backend') ? {getAttribute: () => META.agentBackend} : null),
  getElementById: () => null,
  addEventListener() {},
  documentElement: {dataset: {}}
};
globalThis.location = {hash: ''};
globalThis.history = {replaceState() {}, pushState() {}};
globalThis.window = globalThis;
globalThis.matchMedia = () => ({matches: false, addEventListener() {}});

const {store, go, resetChatState} = await import('../shared/ui-store.js');

test('leaving a chat clears its draft, its open sources and its post search', () => {
  store.route = {chat: 'team-a', page: null, info: 'home'};
  store.editDraft = 'd1'; store.editText = 'half written'; store.postQuery = 'launch';
  store.openEvidence.add('ev1');
  go({chat: 'team-b'});
  assert.equal(store.editDraft, null);
  assert.equal(store.editText, null);
  assert.equal(store.postQuery, '', 'a Posts search must not follow the reader into another chat');
  assert.equal(store.openEvidence.size, 0);
});

test('opening a panel in the same chat keeps the draft and the search', () => {
  store.route = {chat: 'team-a', page: null, info: null};
  store.editDraft = 'd1'; store.editText = 'half written'; store.postQuery = 'launch';
  store.openEvidence.add('ev1');
  go({chat: 'team-a', info: 'home'});
  assert.equal(store.editDraft, 'd1');
  assert.equal(store.editText, 'half written');
  assert.equal(store.postQuery, 'launch');
  assert.ok(store.openEvidence.has('ev1'));
  resetChatState();
});

// ---- ui-push: a reply without the endpoint list ------------------------------

test('a push status reply with no endpoint list reads as no devices', async () => {
  const api = async path => (path === '/api/push' ? {publicKey: 'k', endpoints: null} : {});
  const fakeWindow = {isSecureContext: true, PushManager: function () {}, Notification: function () {}};
  globalThis.window = Object.assign(fakeWindow, {AGENT_API: api});
  globalThis.window.window = globalThis.window;
  globalThis.Notification = {permission: 'granted'};
  Object.defineProperty(globalThis, 'navigator', {value: {serviceWorker: {getRegistration: async () => null}}, configurable: true, writable: true});
  const {pushStatus} = await import('../shared/ui-push.js');
  // `server.endpoints.length` on a reply without the list threw and blanked the
  // whole Notifications page it was loading for.
  assert.deepEqual(await pushStatus(), {state: 'off', devices: 0, endpoints: [], mine: ''});
});

// ---- markup, guards and CSS that only a browser would notice -----------------

const [appJs, views, actions, css, indexHtml, panel] = await Promise.all(['app.js', 'ui-views.js', 'ui-actions.js', 'app.css', 'index.html', 'ui-panel.js'].map(shared));

test('the details button announces what it opens', () => {
  assert.match(views, /class="thread-title" data-action="open-info" aria-expanded="\$\{Boolean\(store\.route\.info\)\}" aria-controls="inspector"/);
  assert.match(indexHtml, /id="inspector"/, 'aria-controls must name the panel that actually exists');
});

test('a chat that no longer exists falls back to the list instead of a blank thread', () => {
  // renderThread bails out when conversation() is null; without this the main
  // pane kept the previous chat's markup under a route for a deleted one.
  assert.match(appJs, /if \(chat && !conversation\(\)\) return go\(\{\}, \{replace: true\}\)/);
});

test('one press of an action sends one request, even across a repaint', () => {
  // The guard used to live on the button node, which a repaint replaces.
  assert.match(appJs, /const running = new Set\(\)/);
  assert.match(appJs, /if \(running\.has\(key\)\) return;/);
  assert.match(appJs, /running\.delete\(key\)/);
});

test('a background refresh failure is reported once and the loop keeps going', () => {
  assert.match(appJs, /const syncFailures = new Set\(\)/);
  assert.match(appJs, /if \(syncFailures\.has\(message\)\) return;\s*\n\s*syncFailures\.add\(message\);\s*\n\s*toast\(/);
  assert.match(appJs, /if \(store\.state\) scheduleSync\(\)/, 'a failed poll must re-arm itself');
});

test('a theme change repaints without losing focus', () => {
  assert.match(appJs, /FOCUS_KEYS = \[[^\]]*'theme'/);
});

test('a bot removed in another tab says so instead of crashing', () => {
  assert.match(actions, /if \(!group\) throw new Error\('That bot is no longer in a group\.'\)/);
});

test('a landing chip asks the group it belongs to', () => {
  assert.match(actions, /'home-ask': b => startGroupChat\(b\.dataset\.text, b\.dataset\.id\)/);
  assert.match(actions, /const group = \(groupId \? findGroup\(groupId\) : null\) \|\| groups\(\)\[0\]/);
  assert.match(views, /function homePrompts\(group\)/);
  assert.match(views, /data-action="home-ask" data-id="\$\{esc\(group\?\.id \|\| ''\)\}"/);
});

test('a control is offered to the role the route behind it accepts', () => {
  // Replacing the capture token is admin-only at the route, and `canWrite()`
  // includes members: a member saw the row, confirmed a consequence ("every
  // browser needs the new one") that would not happen, and got a 403.
  assert.match(panel, /isAdmin\(\) \? row\(\{title: 'Replace capture token'/);
  assert.doesNotMatch(panel, /canWrite\(\) \? row\(\{title: 'Replace capture token'/);
});

test('long titles wrap instead of overflowing, and dead hover rules stay deleted', () => {
  assert.match(css, /\.hero h2\{margin-top:8px;font-size:22px;font-weight:700;overflow-wrap:anywhere\}/);
  assert.match(css, /\.row-title\{font-size:15px;overflow-wrap:anywhere\}/);
  // `.chat-row:hover{background:var(--surface)}` was always overridden by the
  // `:not(.current)` rule below it, and `.home-mark` had no markup left at all.
  assert.doesNotMatch(css, /\.chat-row:hover\{/);
  assert.doesNotMatch(css, /\.home-mark\{/);
});
