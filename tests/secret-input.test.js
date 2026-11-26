/* Passwords and codes typed during a takeover travel only over HTTPS, or from the
 * computer that runs the app. Both takeover paths refuse them otherwise, before
 * anything is queued or typed. */
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {secureRequest} from '../src/http.js';
import {createRouter} from '../src/router.js';
import {liveRoutes} from '../src/routes-live.js';
import {groupRoutes} from '../src/routes-groups.js';
import {browserLive} from '../src/browser-live.js';
import http from 'node:http';
import {findBrowser, startBrowserSession} from '../agent/browser.mjs';

const MESSAGE = 'Passwords and codes are only sent over HTTPS or from this computer.';

async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('secureRequest: TLS, a trusted proxy that says https, or loopback', async () => {
  assert.equal(secureRequest({headers: {}, socket: {encrypted: true, remoteAddress: '203.0.113.5'}}), true);
  const local = {origin: 'http://localhost:4173'};
  assert.equal(secureRequest({headers: local, socket: {remoteAddress: '127.0.0.1'}}), true);
  assert.equal(secureRequest({headers: {origin: 'http://127.0.0.1:4173'}, socket: {remoteAddress: '::1'}}), true);
  assert.equal(secureRequest({headers: {origin: 'http://[::1]:4173'}, socket: {remoteAddress: '::ffff:127.0.0.1'}}), true);
  // A proxy that adds no headers: loopback peer, the phone's own origin, or none at all.
  assert.equal(secureRequest({headers: {origin: 'http://192.168.1.20:8080'}, socket: {remoteAddress: '127.0.0.1'}}), false);
  assert.equal(secureRequest({headers: {origin: 'http://localhost.evil.test'}, socket: {remoteAddress: '127.0.0.1'}}), false);
  assert.equal(secureRequest({headers: {origin: 'not a url'}, socket: {remoteAddress: '127.0.0.1'}}), false);
  assert.equal(secureRequest({headers: {}, socket: {remoteAddress: '127.0.0.1'}}), false);
  assert.equal(secureRequest({headers: local, socket: {remoteAddress: '192.168.1.20'}}), false);
  assert.equal(secureRequest({headers: {}, socket: {}}), false);
  // A local proxy relaying a phone over plain HTTP arrives from loopback but says so in its headers.
  for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
    assert.equal(secureRequest({headers: {...local, [h]: '192.168.1.20'}, socket: {remoteAddress: '127.0.0.1'}}), false, h);
  }
  await withEnv({TRUST_PROXY: '1'}, () => {
    assert.equal(secureRequest({headers: {'x-forwarded-proto': 'https'}, socket: {remoteAddress: '127.0.0.1'}}), true);
    assert.equal(secureRequest({headers: {'x-forwarded-proto': 'http'}, socket: {remoteAddress: '127.0.0.1'}}), false);
    assert.equal(secureRequest({headers: {}, socket: {remoteAddress: '127.0.0.1'}}), false);
    // With a trusted proxy, loopback alone proves nothing: the proxy is the loopback peer.
    assert.equal(secureRequest({headers: local, socket: {remoteAddress: '127.0.0.1'}}), false);
  });
  // Without a trusted proxy a client cannot claim https for itself.
  assert.equal(secureRequest({headers: {'x-forwarded-proto': 'https'}, socket: {remoteAddress: '192.168.1.20'}}), false);
});

const WS = 'default';
const BOT = 'bot-1';
const state = {groups: [{id: 'g', bots: [{id: BOT, name: 'Bot'}]}]};
const actor = {email: 'owner@example.test', workspaceId: WS};

function call(register, method, pattern, body, {ip = '192.168.1.20', headers = {}, params = {}, encrypted = false} = {}) {
  const router = createRouter();
  register(router, {workspaces: {}});
  const found = router.find(method, pattern.replace(/:(\w+)/g, (_, k) => params[k] ?? k));
  return found.route.handler({
    req: {headers, socket: {remoteAddress: ip, encrypted}},
    path: pattern, params: found.params, actor, store: {read: () => state},
    body: async () => body,
  });
}
const rejected = async promise => { try { await promise; return null; } catch (e) { return e; } };

test('secret input over plain HTTP from the network is refused on the device path, plain input is not', async () => {
  const input = mock.method(browserLive, 'input', () => {});
  try {
    const secret = {type: 'type', text: '482913', secret: true};
    const e = await rejected(call(liveRoutes, 'POST', '/api/browser-live/:botId/input', secret, {params: {botId: BOT}}));
    assert.equal(e?.status, 403);
    assert.equal(e.message, MESSAGE);
    assert.ok(!e.message.includes('482913'));
    assert.equal(input.mock.callCount(), 0, 'nothing was queued for the device');
    // The same text without the flag is ordinary input.
    assert.deepEqual(await call(liveRoutes, 'POST', '/api/browser-live/:botId/input', {type: 'type', text: '482913'}, {params: {botId: BOT}}), {ok: true});
    assert.equal(input.mock.callCount(), 1);
    // From this computer, on its own origin, a secret goes through.
    await call(liveRoutes, 'POST', '/api/browser-live/:botId/input', secret, {params: {botId: BOT}, ip: '127.0.0.1', headers: {origin: 'http://localhost:4173'}});
    assert.equal(input.mock.callCount(), 2);
    // Only an exact `true` marks a secret.
    await call(liveRoutes, 'POST', '/api/browser-live/:botId/input', {...secret, secret: 'yes'}, {params: {botId: BOT}});
    assert.equal(input.mock.callCount(), 3);
  } finally { input.mock.restore(); }
});

test('secret input over plain HTTP from the network is refused on the server-runtime path, before anything runs', async () => {
  const act = {op: 'type', index: 1, text: '482913'};
  const params = {session: 'no-such-session'};
  const e = await rejected(call(groupRoutes, 'POST', '/api/browser-sessions/:session/act', {...act, secret: true}, {params}));
  assert.equal(e?.status, 403);
  assert.equal(e.message, MESSAGE);
  assert.ok(!e.message.includes('482913'));
  // Without the flag it gets past the check and meets the missing session instead.
  const plain = await rejected(call(groupRoutes, 'POST', '/api/browser-sessions/:session/act', act, {params}));
  assert.notEqual(plain?.status, 403);
  // Over HTTPS the secret gets past the check too.
  const tls = await rejected(call(groupRoutes, 'POST', '/api/browser-sessions/:session/act', {...act, secret: true}, {params, ip: '203.0.113.5', encrypted: true}));
  assert.notEqual(tls?.status, 403);
});

const browser = findBrowser();
test('a field the owner typed into in secret is tagged in the page, and a plain one is not', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<title>Sign in</title><input id="u" placeholder="Email"><input id="p" type="password" placeholder="Password">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  const session = await startBrowserSession({binary: browser, permit: h => h !== 'localhost'});
  try {
    const live = await session.open(`http://${host}/`, {allow: [host]});
    const start = await live.view();
    const at = text => start.elements.find(e => e.text === text).index;
    assert.equal((await live.act({op: 'type', index: at('Email'), text: 'ada@example.com'})).ok, true);
    assert.equal((await live.act({op: 'waitFor', selector: '[data-agent-secret]', timeoutMs: 300})).ok, false, 'a plain field is not tagged');
    assert.equal((await live.act({op: 'type', index: at('Password'), text: '482913', secret: true})).ok, true);
    assert.equal((await live.act({op: 'waitFor', selector: '#p[data-agent-secret]'})).ok, true, 'the secret field is tagged');
    assert.equal((await live.act({op: 'waitFor', selector: '#u[data-agent-secret]', timeoutMs: 300})).ok, false);
    await live.close();
  } finally { await session.close(); server.close(); }
});
