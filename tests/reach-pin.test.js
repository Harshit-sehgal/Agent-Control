/* A provider, MCP or sign-in address is resolved once, checked, and the connection is made to that same address:
 * a name rebound to a private one after the check never gets the request (src/reach-guard.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {guardedFetch} from '../src/reach-guard.js';

const answers = (...lists) => { let n = 0; const fn = async (host, opts) => { fn.calls.push(host); const list = lists[Math.min(n++, lists.length - 1)]; return opts?.all ? list.map(address => ({address, family: address.includes(':') ? 6 : 4})) : list[0]; }; fn.calls = []; return fn; };

async function server(handler) {
  const seen = [];
  const s = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({method: req.method, url: req.url, host: req.headers.host, type: req.headers['content-type'], body});
    handler(req, res, body);
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return {port: s.address().port, seen, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); })};
}

test('a name that resolves to a metadata or private address is refused before anything is sent', async () => {
  for (const address of ['169.254.169.254', '10.0.0.7', 'fd00::1', '::ffff:10.0.0.1']) {
    await assert.rejects(guardedFetch('https://provider.test/v1/models', {}, {lookup: answers([address]), allowPrivate: false}),
      e => e.status === 400 && /private or local network/.test(e.message), address);
  }
  // One bad address among good ones is enough to refuse.
  await assert.rejects(guardedFetch('https://provider.test/', {}, {lookup: answers(['93.184.216.34', '169.254.169.254']), allowPrivate: false}), e => e.status === 400);
  // A literal address is checked as well.
  await assert.rejects(guardedFetch('http://169.254.169.254/latest/meta-data/', {}, {allowPrivate: false}), e => e.status === 400);
});

test('the connection goes to the address that passed the check, with the real name as Host', async () => {
  const up = await server((req, res) => { res.writeHead(200, {'content-type': 'application/json', 'x-id': 'one'}); res.end('{"ok":true}'); });
  try {
    // The second answer would be a rebind to a metadata address; it is never asked for.
    const lookup = answers(['127.0.0.1'], ['169.254.169.254']);
    const res = await guardedFetch(`http://provider.test:${up.port}/v1/chat?x=1`, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer k'}, body: '{"a":1}'}, {lookup, allowPrivate: false});
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('x-id'), 'one');
    assert.deepEqual(await res.json(), {ok: true});
    assert.deepEqual(lookup.calls, ['provider.test'], 'resolved once');
    assert.equal(up.seen[0].host, `provider.test:${up.port}`);
    assert.equal(up.seen[0].url, '/v1/chat?x=1');
    assert.equal(up.seen[0].body, '{"a":1}');
  } finally { await up.close(); }
});

test('loopback is allowed, redirects are not followed, and bodies read like fetch', async () => {
  const up = await server((req, res, body) => {
    if (req.url === '/moved') { res.writeHead(302, {location: 'http://169.254.169.254/'}); return res.end(); }
    if (req.url === '/empty') { res.writeHead(204); return res.end(); }
    if (req.url === '/gzip') { res.writeHead(200, {'content-encoding': 'gzip', 'content-type': 'text/plain'}); return res.end(zlib.gzipSync('squeezed')); }
    if (req.url === '/stream') { res.writeHead(200, {'content-type': 'text/event-stream'}); res.write('data: 1\n\n'); setTimeout(() => res.end('data: 2\n\n'), 20); return; }
    res.writeHead(200, {'content-type': 'text/plain'}); res.end(`${req.headers['content-type']}|${body}`);
  });
  const base = `http://127.0.0.1:${up.port}`;
  try {
    const moved = await guardedFetch(`${base}/moved`, {redirect: 'manual'}, {allowPrivate: false});
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get('location'), 'http://169.254.169.254/');
    assert.equal((await guardedFetch(`${base}/empty`, {}, {allowPrivate: false})).status, 204);
    assert.equal(await (await guardedFetch(`${base}/gzip`, {}, {allowPrivate: false})).text(), 'squeezed');
    const form = await guardedFetch(`${base}/form`, {method: 'POST', body: new URLSearchParams({grant_type: 'code', code: 'a b'})}, {allowPrivate: false});
    assert.equal(await form.text(), 'application/x-www-form-urlencoded;charset=UTF-8|grant_type=code&code=a+b');
    const stream = await guardedFetch(`${base}/stream`, {}, {allowPrivate: false});
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    let all = ''; for (;;) { const {done, value} = await reader.read(); if (done) break; all += decoder.decode(value); }
    assert.equal(all, 'data: 1\n\ndata: 2\n\n');
    // localhost by name is this machine too.
    assert.equal((await guardedFetch(`http://localhost.test:${up.port}/x`, {}, {lookup: answers(['127.0.0.1']), allowPrivate: false})).status, 200);
  } finally { await up.close(); }
});

test('AGENT_ALLOW_PRIVATE lets a LAN address through, still pinned; a name that does not resolve fails like fetch', async () => {
  const up = await server((req, res) => { res.writeHead(200); res.end('lan'); });
  try {
    const lookup = answers(['127.0.0.1']);
    assert.equal(await (await guardedFetch(`http://nas.test:${up.port}/`, {}, {lookup, allowPrivate: true})).text(), 'lan');
    const gone = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.test'), {code: 'ENOTFOUND'}); };
    await assert.rejects(guardedFetch('https://nope.test/', {}, {lookup: gone, allowPrivate: false}), e => e instanceof TypeError && e.cause?.code === 'ENOTFOUND');
    const aborted = AbortSignal.abort();
    await assert.rejects(guardedFetch(`http://127.0.0.1:${up.port}/`, {signal: aborted}, {allowPrivate: false}), e => e.name === 'AbortError');
  } finally { await up.close(); }
});

test('a saved provider and an MCP sign-in server go through the guard on every call, not only when saved', async () => {
  const before = process.env.AGENT_ALLOW_PRIVATE;
  delete process.env.AGENT_ALLOW_PRIVATE;
  try {
    const {discoverModels} = await import('../src/ai.js');
    await assert.rejects(discoverModels({baseUrl: 'http://169.254.169.254/v1', apiKey: 'k', protocol: 'openai-chat'}), e => e.status === 400 && /private or local network/.test(e.message));
    const {discoverMcpAuth} = await import('../src/mcp-oauth.js');
    await assert.rejects(discoverMcpAuth('https://10.0.0.7/mcp'), e => e.status === 400 && /private or local network/.test(e.message));
  } finally { if (before === undefined) delete process.env.AGENT_ALLOW_PRIVATE; else process.env.AGENT_ALLOW_PRIVATE = before; }
});
