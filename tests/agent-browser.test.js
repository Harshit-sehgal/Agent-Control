import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import {findBrowser, hostAllowed, requestVerdict, startProxy, captureWithBrowser, startBrowserSession} from '../agent/browser.mjs';
import {parseAllowlist} from '../shared/bot-browser.js';

test('an allowlist entry and a URL are compared on the host, not the spelling', () => {
  const allow = ['docs.example.com'];
  assert.equal(hostAllowed('https://docs.example.com/a', allow), true);
  assert.equal(hostAllowed('https://DOCS.example.com/a', allow), true);
  assert.equal(hostAllowed('https://evil.example.com/docs.example.com', allow), false);
  assert.equal(hostAllowed('not a url', allow), false);
  // A port is not part of the host: the same page is allowed with or without it.
  assert.equal(hostAllowed('https://docs.example.com:8443/a', allow), true);
  assert.equal(hostAllowed('https://docs.example.com./a', ['docs.example.com.']), true);
  assert.equal(hostAllowed('https://docs.example.com', ['https://Docs.Example.com:8443/docs']), true, 'A whole URL in the list names its host.');
  assert.equal(hostAllowed('https://docs.example.com.evil.test/a', allow), false);
  assert.equal(hostAllowed('https://[::1]:8080/a', parseAllowlist('[::1]')), true);
  assert.deepEqual(parseAllowlist(' X.com. , docs.example.com:8443 ,, '), ['x.com', 'docs.example.com']);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test('a page must be on the allowlist, and only http(s) is loaded', () => {
  const allow = ['docs.example.com'];
  assert.deepEqual(requestVerdict({url: 'https://docs.example.com/a', isDocument: true}, {allow}), {allow: true});
  // A redirect or a frame to another site is a document on a host nobody allowed.
  assert.equal(requestVerdict({url: 'https://x.com/home', isDocument: true}, {allow}).allow, false);
  assert.equal(requestVerdict({url: 'https://cdn.example.net/a.js', isDocument: false}, {allow}).allow, true);
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'ftp://example.com/x']) assert.equal(requestVerdict({url, isDocument: true}, {allow}).allow, false, url);
  assert.equal(requestVerdict({url: 'data:image/png;base64,AAAA', isDocument: false}, {allow}).allow, true);
  // A WebSocket tunnel hides inside GET: posting hosts refuse it too.
  assert.equal(requestVerdict({url: 'https://x.com/stream', isDocument: false, method: 'GET', resourceType: 'WebSocket'}, {allow: ['x.com', 'docs.example.com']}).allow, false);
  assert.equal(requestVerdict({url: 'https://example.com/stream', isDocument: false, method: 'GET', resourceType: 'WebSocket'}, {allow: ['example.com']}).allow, true);
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
    // CONNECT is not parsed as a URL, so a non-canonical spelling must still be refused.
    assert.equal((await viaProxy(strict.port, {method: 'CONNECT', path: '0:0:0:0:0:ffff:7f00:1:443'})).status, 403);
    assert.equal((await viaProxy(strict.port, {method: 'CONNECT', path: '[0064:ff9b::a00:1]:443'})).status, 403);
    assert.equal((await viaProxy(strict.port, {path: 'http://[64:ff9b:1:a9fe:a9:fe00:808:808]/'})).status, 403);
    assert.equal((await viaProxy(strict.port, {path: 'http://[ff02::1]/'})).status, 403);
    assert.equal((await viaProxy(strict.port, {path: 'ftp://example.com/'})).status, 400);
    assert.equal(strict.refused.length, 7);
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

test('browser.action types, clicks and reads, and refuses off-allowlist navigations', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/form') return res.writeHead(200, {'Content-Type': 'text/html'}).end(
      `<title>Form</title><input id="name"><button id="go">Go</button><p id="out"></p>` +
      `<script>document.getElementById('go').addEventListener('click',()=>{document.getElementById('out').textContent='Hello '+document.getElementById('name').value;});</script>`);
    res.writeHead(200, {'Content-Type': 'text/plain'}).end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`, permit = h => h !== 'localhost';
  try {
    const page = await captureWithBrowser(`http://${host}/form`, {allow: [host], binary: browser, permit, steps: [
      {op: 'type', selector: '#name', text: 'Ada'},
      {op: 'click', selector: '#go'},
      {op: 'read', selector: '#out'},
      {op: 'navigate', url: 'https://evil.example.com/'},
      {op: 'launchMissiles'},
      {},
    ]});
    const [type, click, read, nav, bad, missing] = page.actions;
    assert.equal(type.ok, true, 'typing into the input succeeds');
    assert.equal(click.ok, true, 'clicking the button succeeds');
    assert.equal(read.text, 'Hello Ada', 'the click handler saw the typed value, so the page really interacted');
    assert.equal(nav.ok, false, 'a navigation off the allowlist is refused');
    assert.match(nav.reason, /allowlist/i);
    assert.equal(bad.ok, false, 'an unknown op is refused');
    assert.match(bad.reason, /unsupported/);
    assert.equal(missing.ok, false, 'a step without an op is refused');
  } finally { server.close(); }
});

test('a session reuses one browser, numbers the controls, and signs nothing in', {skip: !browser && 'no browser installed', timeout: 60000}, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(req.url === '/one'
      ? `<title>One</title><input id="q" placeholder="Search box"><button id="go" onclick="document.getElementById('out').textContent='clicked'">Press me</button><button disabled>Off</button><p id="out">fresh</p><script>document.cookie='seen=1; path=/';</script>`
      : `<title>Two</title><p id="out">none</p><script>document.getElementById('out').textContent='cookie:'+document.cookie;</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, allow = ['127.0.0.1'];
  const session = await startBrowserSession({binary: browser, permit: () => true});
  try {
    const first = await session.capture(`${base}/one`, {allow});
    assert.equal(first.title, 'One');
    const pressMe = first.elements.find(e => e.text === 'Press me');
    assert.ok(pressMe, `the snapshot numbered the controls: ${JSON.stringify(first.elements)}`);
    assert.equal(first.elements.some(e => e.text === 'Off'), false, 'A disabled control is not offered.');
    assert.equal(first.elementCount, first.elements.length);
    // Act on the element by the number the snapshot gave it, not a selector.
    const acted = await session.capture(`${base}/one`, {allow, steps: [{op: 'click', index: pressMe.index}, {op: 'read', selector: '#out'}]});
    assert.equal(acted.actions[0].ok, true, `click by index: ${JSON.stringify(acted.actions)}`);
    assert.equal(acted.actions[1].text, 'clicked', 'the index named the button the snapshot numbered');
    // The process is warm, but each page starts in a new, empty context.
    const second = await session.capture(`${base}/two`, {allow, steps: [{op: 'read', selector: '#out'}]});
    assert.equal(second.actions[0].text, 'cookie:', 'a reused browser is not a signed-in one');
    // The allowlist is per request: the previous capture does not authorise this one.
    await assert.rejects(session.capture(`${base}/one`, {allow: ['other.example.com']}), /not in AGENT_BROWSER_ALLOWLIST/);
  } finally { await session.close(); server.close(); }
});
