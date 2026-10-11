import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import {findBrowser, hostAllowed, requestVerdict, startProxy, captureWithBrowser} from '../agent/browser.mjs';

test('a page must be on the allowlist, and only http(s) is loaded', () => {
  const allow = ['docs.example.com'];
  assert.equal(hostAllowed('https://docs.example.com/a', allow), true);
  assert.equal(hostAllowed('https://DOCS.example.com/a', allow), true);
  assert.equal(hostAllowed('https://evil.example.com/docs.example.com', allow), false);
  assert.equal(hostAllowed('not a url', allow), false);
  assert.deepEqual(requestVerdict({url: 'https://docs.example.com/a', isDocument: true}, {allow}), {allow: true});
  // A redirect or a frame to another site is a document on a host nobody allowed.
  assert.equal(requestVerdict({url: 'https://x.com/home', isDocument: true}, {allow}).allow, false);
  assert.equal(requestVerdict({url: 'https://cdn.example.net/a.js', isDocument: false}, {allow}).allow, true);
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'ftp://example.com/x']) assert.equal(requestVerdict({url, isDocument: true}, {allow}).allow, false, url);
  assert.equal(requestVerdict({url: 'data:image/png;base64,AAAA', isDocument: false}, {allow}).allow, true);
});

/** One request through the proxy, as a browser would send it. */
const viaProxy = (port, {method = 'GET', path}) => new Promise((resolve, reject) => {
  const req = http.request({host: '127.0.0.1', port, method, path});
  req.on('response', res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({status: res.statusCode, body})); });
  req.on('connect', (res, socket) => { socket.destroy(); resolve({status: res.statusCode}); });
  req.on('error', reject); req.end();
});

test('the proxy refuses private addresses and connects to the address it checked', async () => {
  const site = http.createServer((req, res) => res.end(`host=${req.headers.host}`));
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const sitePort = site.address().port, lookups = [];
  // By default nothing on this machine or its network is reachable.
  const strict = await startProxy();
  try {
    assert.equal((await viaProxy(strict.port, {path: `http://127.0.0.1:${sitePort}/`})).status, 403);
    assert.equal((await viaProxy(strict.port, {method: 'CONNECT', path: '10.0.0.5:443'})).status, 403);
    assert.equal((await viaProxy(strict.port, {method: 'CONNECT', path: '[::1]:443'})).status, 403);
    assert.equal((await viaProxy(strict.port, {path: 'ftp://example.com/'})).status, 400);
    assert.equal(strict.refused.length, 3);
  } finally { strict.close(); }
  // A name is resolved once, by the proxy, and that answer is what gets connected to.
  const lookup = async name => { lookups.push(name); return {address: name === 'docs.test' ? '127.0.0.1' : '192.168.1.1'}; };
  const open = await startProxy({lookup, permit: (host, address) => address === '127.0.0.1'});
  try {
    assert.deepEqual(await viaProxy(open.port, {path: `http://docs.test:${sitePort}/`}), {status: 200, body: `host=docs.test:${sitePort}`});
    assert.equal((await viaProxy(open.port, {method: 'CONNECT', path: `docs.test:${sitePort}`})).status, 200);
    assert.equal((await viaProxy(open.port, {path: 'http://router.test/'})).status, 403);
    assert.match(open.refused[0], /router\.test: Refusing to reach router\.test/);
    assert.deepEqual(lookups, ['docs.test', 'docs.test', 'router.test']);
  } finally { open.close(); site.close(); }
});

test('the browser is found from AGENT_BROWSER_PATH or the PATH, and its absence is reported', async () => {
  assert.equal(findBrowser({AGENT_BROWSER_PATH: '/opt/chrome', PATH: ''}), '/opt/chrome');
  await assert.rejects(captureWithBrowser('https://docs.example.com/', {allow: ['docs.example.com'], binary: null}), /No Chrome, Chromium or Edge/);
  await assert.rejects(captureWithBrowser('https://x.com/', {allow: ['docs.example.com'], binary: '/opt/chrome'}), /not in AGENT_BROWSER_ALLOWLIST/);
});

// Needs a browser on the machine. Hosted CI runners restrict Chrome's sandbox,
// so there this is covered by the policy and proxy tests above.
const browser = process.env.CI ? null : findBrowser();
test('a real browser reads a script-rendered page and blocks what the policy refuses', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    if (req.url === '/page') return res.writeHead(200, {'Content-Type': 'text/html'}).end(`<title>Docs</title><p id="p">loading</p><img src="http://localhost:${server.address().port}/pixel"><script>document.getElementById('p').textContent='Rendered by script';</script>`);
    if (req.url === '/away') return res.writeHead(302, {Location: `http://localhost:${server.address().port}/page`}).end();
    res.writeHead(200, {'Content-Type': 'text/plain'}).end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`, profiles = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('agent-browser-')).length, before = profiles();
  // The page's own host is reachable; `localhost` stands in for a private address.
  const permit = host => host !== 'localhost';
  try {
    const page = await captureWithBrowser(`http://${host}/page`, {allow: [host], binary: browser, permit});
    assert.deepEqual([page.title, page.excerpt, page.engine, page.finalUrl], ['Docs', 'Rendered by script', 'browser', `http://${host}/page`]);
    assert.equal(page.blockedRequests, 1, 'The image on the refused host is blocked.');
    assert.equal(hits.some(h => h.startsWith('localhost')), false, 'A blocked request never leaves the browser.');
    await assert.rejects(captureWithBrowser(`http://${host}/away`, {allow: [host], binary: browser, permit}), /not opened|not in AGENT_BROWSER_ALLOWLIST/, 'A redirect off the allowlist is refused.');
    assert.equal(profiles(), before, 'The temporary browser profile is deleted.');
  } finally { server.close(); }
});
