/** Read a page with a real browser, without a browser-automation library.
 *
 * Starts the Chrome, Chromium or Edge already installed on this device in
 * headless mode and speaks the DevTools protocol to it over Node's built-in
 * WebSocket. That gets pages that only render with JavaScript, which a plain
 * HTTP read cannot.
 *
 * What it will not do, by construction:
 * - it only opens pages on hosts in AGENT_BROWSER_ALLOWLIST, including after a
 *   redirect;
 * - the browser can reach the network only through a proxy this process runs,
 *   which refuses private and local addresses and connects to the address it
 *   checked. That holds for everything the browser does (frames, workers,
 *   popups, WebSockets), not only for the page being read;
 * - it uses a new, empty profile each time and deletes it afterwards, so it is
 *   never signed in to anything;
 * - it navigates and reads. There is no click, type, upload or download.
 */
import {spawn} from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {isPrivateAddress} from './net-guard.mjs';

/** May the browser connect to `address`, which `host` resolved to? */
const publicOnly = (host, address) => process.env.AGENT_ALLOW_PRIVATE === '1' || !isPrivateAddress(address);

const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
const FIXED = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** The browser to run: AGENT_BROWSER_PATH, or the first one found installed. */
export function findBrowser(env = process.env) {
  if (env.AGENT_BROWSER_PATH) return env.AGENT_BROWSER_PATH;
  const onPath = String(env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => NAMES.map(name => path.join(dir, name)));
  return [...onPath, ...FIXED].find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || null;
}

export const hostAllowed = (url, allow) => { try { return allow.includes(new URL(url).host.toLowerCase()); } catch { return false; } };

/** Decide one request the page being read wants to make. The page itself
 * (and any frame in it) must be on the allowlist; where a request may connect
 * to is the proxy's decision. */
export function requestVerdict({url, isDocument}, {allow}) {
  if (/^(data|blob|about):/i.test(url)) return {allow: true};
  if (!/^https?:/i.test(url)) return {allow: false, reason: 'Only http(s) is loaded.'};
  if (isDocument && !hostAllowed(url, allow)) return {allow: false, reason: `${new URL(url).host} is not in AGENT_BROWSER_ALLOWLIST.`};
  return {allow: true};
}

/** The only way out for the browser. Each host is resolved here, refused if
 * the address is not permitted, and then connected to by that same address, so
 * a name cannot point somewhere else between the check and the connection. */
export async function startProxy({permit = publicOnly, lookup = dns.lookup, refused = []} = {}) {
  async function resolve(host) {
    const name = host.replace(/^\[|\]$/g, '');
    const address = net.isIP(name) ? name : (await lookup(name)).address;
    if (!permit(name, address)) throw new Error(`Refusing to reach ${name}: it is on a private or local network.`);
    return address;
  }
  const deny = (target, error) => { refused.push(`${target}: ${error.message}`); };
  // Outgoing connections, so closing the proxy leaves nothing half-open.
  const outgoing = new Set();
  const track = connection => { outgoing.add(connection); connection.once('close', () => outgoing.delete(connection)); return connection; };
  const server = http.createServer(async (req, res) => {
    // Plain http arrives as a full URL to forward.
    let url;
    try { url = new URL(req.url); if (url.protocol !== 'http:') throw new Error('Only http(s) is loaded.'); }
    catch { res.writeHead(400).end(); return; }
    try {
      const address = await resolve(url.hostname);
      const upstream = track(http.request({agent: false, host: address, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers: {...req.headers, host: url.host}}, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); }));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (e) { deny(url.host, e); res.writeHead(403).end(); }
  });
  // https and WebSockets arrive as a request to open a tunnel.
  server.on('connect', async (req, socket) => {
    const [host, port = '443'] = req.url.split(/:(?=\d+$)/);
    socket.on('error', () => {});
    try {
      const upstream = track(net.connect(Number(port), await resolve(host), () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(socket); socket.pipe(upstream); }));
      track(socket);
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    } catch (e) { deny(req.url, e); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {port: server.address().port, refused, close: () => { for (const connection of outgoing) connection.destroy(); server.closeAllConnections(); server.close(); }};
}

/** Start the browser and resolve its DevTools address. */
function launch(binary, profile, proxyPort, extraArgs) {
  const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-gpu', '--mute-audio',
    // Everything goes through the proxy, loopback included, and nothing may
    // leave another way (WebRTC would otherwise send UDP directly).
    `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic',
    '--block-new-web-contents', ...extraArgs, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  const address = new Promise((resolve, reject) => {
    let log = '';
    child.stderr.on('data', chunk => { log += chunk; const found = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (found) resolve(found[1]); });
    child.once('error', e => reject(new Error(`The browser at ${binary} could not be started: ${e.message}`)));
    child.once('exit', code => reject(new Error(`The browser exited before it was ready (code ${code}). ${log.trim().split('\n').pop() || ''}`.trim())));
  });
  return {child, address};
}

/** A DevTools connection: `send` resolves with the reply, `on` hears events. */
async function connect(address) {
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Could not connect to the browser.')); });
  let next = 0;
  const waiting = new Map(), listeners = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const {resolve, reject} = waiting.get(message.id); waiting.delete(message.id);
      return message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  };
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params, sessionId})); }),
    on: (method, listener) => { listeners.set(method, [...(listeners.get(method) || []), listener]); },
    close: () => socket.close(),
  };
}

/** Open `url` in a headless browser and return what a reader would see. */
export async function captureWithBrowser(url, {allow, binary = findBrowser(), permit = publicOnly, timeoutMs = 20000, extraArgs = String(process.env.AGENT_BROWSER_ARGS || '').split(' ').filter(Boolean)} = {}) {
  if (!binary) throw new Error('No Chrome, Chromium or Edge was found on this device. Install one, or set AGENT_BROWSER_PATH.');
  if (!hostAllowed(url, allow)) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  const blocked = [];
  const proxy = await startProxy({permit, refused: blocked});
  const {child, address} = launch(binary, profile, proxy.port, extraArgs);
  let cdp = null;
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error(`The page did not finish loading within ${timeoutMs / 1000}s.`)), timeoutMs).unref());
  try {
    return await Promise.race([deadline, (async () => {
      cdp = await connect(await address);
      const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank'});
      const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
      // The page's own requests pause here first, so it cannot be sent to a
      // page nobody allowed.
      cdp.on('Fetch.requestPaused', ({requestId, request, resourceType}) => {
        const verdict = requestVerdict({url: request.url, isDocument: resourceType === 'Document'}, {allow});
        if (!verdict.allow) blocked.push(`${request.url.slice(0, 120)}: ${verdict.reason}`);
        cdp.send(verdict.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', verdict.allow ? {requestId} : {requestId, errorReason: 'BlockedByClient'}, sessionId).catch(() => {});
      });
      await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
      const navigation = await cdp.send('Page.navigate', {url}, sessionId);
      if (navigation.errorText) throw new Error(blocked[0] ? `The page was not opened. ${blocked[0]}` : `The page could not be opened: ${navigation.errorText}.`);
      await loaded;
      // Give scripts a moment to render what they fetched.
      await new Promise(resolve => setTimeout(resolve, 600));
      const {result} = await cdp.send('Runtime.evaluate', {returnByValue: true, expression: 'JSON.stringify({url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 20000)})'}, sessionId);
      const page = JSON.parse(result.value);
      if (!hostAllowed(page.url, allow)) throw new Error(`The page ended up on ${new URL(page.url).host}, which is not in AGENT_BROWSER_ALLOWLIST.`);
      const text = page.text.replace(/\s+/g, ' ').trim();
      return {url, finalUrl: page.url, title: page.title || null, excerpt: text.slice(0, 600), text: text.slice(0, 4000), blockedRequests: blocked.length, engine: 'browser', capturedAt: new Date().toISOString()};
    })()]);
  } finally {
    address.catch(() => {});
    try { cdp?.close(); } catch { /* Already closed. */ }
    proxy.close();
    child.kill('SIGKILL');
    await new Promise(resolve => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));
    // Chromium child processes can still be flushing the profile directory for
    // a moment after the parent exits (maxRetries only helps on Windows), so
    // retry and never let a cleanup race mask the real capture result.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(profile, {recursive: true, force: true}); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 120)); }
    }
  }
}
