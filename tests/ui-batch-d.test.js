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

// ---- browser globals for the modules below -----------------------------------

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

const [appJs, conversation, actions, css, indexHtml] = await Promise.all(['app.js', 'ui-conversation.js', 'ui-actions.js', 'app.css', 'index.html'].map(shared));

test('a chat header names its own back button and the profile it opens', () => {
  // The shell replaced the details button and the inspector panel: the header's
  // face opens the bot's profile, and the back button names where it goes.
  assert.match(conversation, /data-action="open-profile" data-id="\$\{esc\(bot\.id\)\}"[^>]*aria-label="\$\{esc\(bot\.name\)\}'s profile"/);
  assert.match(conversation, /data-action="back-to-list" aria-label="Back to \$\{label\}"/);
  assert.doesNotMatch(indexHtml, /id="inspector"/, 'the inspector panel is gone with the old info routes');
});

test('a chat that no longer exists falls back to the list instead of a blank thread', () => {
  // renderConversation bails out when conversation() is null; without this the
  // main pane kept the previous chat's markup under a route for a deleted one.
  assert.match(appJs, /if \(\(route\.bot \|\| route\.thread\) && !conversation\(\)\) return go\(\{\}, \{replace: true\}\)/);
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

test('a bot removed in another tab says so instead of crashing', async () => {
  assert.match(await shared('ui-profile.js'), /if \(!group\) throw new Error\('That bot is no longer in the company\.'\)/);
});

test('a starter chip on the new thread page starts a thread, not a group message', () => {
  assert.match(conversation, /'quick-thread': b => startThread\(b\.dataset\.text\)/);
  assert.match(conversation, /data-action="quick-thread" data-text="\$\{esc\(text\)\}"/);
});

test('long titles wrap instead of overflowing, and the retired list and thread rules stay deleted', async () => {
  assert.match(await shared('profile.css'), /\.pr-hero h1\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.row-title\{font-size:15px;overflow-wrap:anywhere\}/);
  // The old frame, chat list, thread and avatar rules went with the shell rebuild.
  assert.doesNotMatch(css, /\.chat-row|\.thread-head|\.pane-|\.avatar|\.hero\b|\.home-mark/);
});
