/** The dispatcher can be exercised in-process.
 *
 * `src/server.js` used to do everything at import time, so importing it opened a
 * port. The dispatcher that guards every route therefore had no in-process test:
 * the anonymous-then-role check, the 405-for-a-known-path and the static file
 * server were only ever reached by a real socket. `src/app.js` now owns that
 * work, and this test drives the same handler the running server uses — through
 * fake request and response objects — with no listener and no child process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';

/** A response recorder with the methods `send` and the HEAD branch use. */
function recorder() {
  return {
    status: null, headers: null, body: null, ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body) { this.ended = true; if (body !== undefined) this.body = body; },
  };
}

/** A request just real enough for `URL`, `checkOrigin` and the dispatcher. */
function request(method, pathname, {cookie = '', host = '127.0.0.1:4173'} = {}) {
  return {method, url: pathname, headers: {host, ...(cookie ? {cookie} : {})}};
}

function seam({session = null, role = 'viewer'} = {}) {
  const workspace = {id: 'w1'};
  const app = createApp({
    store: {read: () => ({})},
    auth: {session: () => (session ? {email: session, role, workspaceId: 'w1'} : null)},
    workspaces: {get: id => (id === 'w1' ? workspace : null)},
    push: {},
    version: '9.9.9',
  });
  const call = async (req) => { const res = recorder(); await app.handler(req, res); return res; };
  return {app, call};
}

test('a public route answers without a session, and the version is the one passed in', async () => {
  const {call} = seam();
  const res = await call(request('GET', '/api/health'));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {ok: true, version: '9.9.9'});
});

test('an anonymous caller learns nothing: a protected route is a 401, not a 404 or a 403', async () => {
  const {call} = seam();
  const res = await call(request('GET', '/api/me'));
  assert.equal(res.status, 401);
  assert.match(JSON.parse(res.body).error, /Sign in first/);
});

test('a signed-in caller is checked against the route role, not just for a session', async () => {
  const {call} = seam({session: 'viewer@example.test', role: 'viewer'});
  const me = await call(request('GET', '/api/me', {cookie: 'agent_session=abc'}));
  assert.equal(me.status, 200);
  assert.deepEqual(JSON.parse(me.body), {email: 'viewer@example.test', role: 'viewer'});
  // A member-only route refuses a viewer by role.
  const write = await call(request('POST', '/api/groups', {cookie: 'agent_session=abc'}));
  assert.equal(write.status, 403);
  assert.match(JSON.parse(write.body).error, /member role or higher/);
});

test('a known path with the wrong verb answers 405 and names the verbs it takes', async () => {
  const {call} = seam({session: 'viewer@example.test'});
  const res = await call(request('DELETE', '/api/health', {cookie: 'agent_session=abc'}));
  assert.equal(res.status, 405);
  assert.match(res.headers.Allow, /GET/);
});

test('the handler is a branch, not a server: a non-api GET serves an asset, everything else is 405', async () => {
  const {call} = seam();
  const asset = await call(request('GET', '/core.js'));
  assert.equal(asset.status, 200);
  assert.match(asset.headers['Content-Type'], /javascript/);
  const missing = await call(request('GET', '/definitely-not-an-asset.js'));
  assert.equal(missing.status, 404);
  const badVerb = await call(request('POST', '/index.html'));
  assert.equal(badVerb.status, 405);
});