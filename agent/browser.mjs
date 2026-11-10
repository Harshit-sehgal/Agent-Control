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
 *   never signed in to anything. Setting AGENT_BROWSER_PROFILE points it at a
 *   directory to keep instead — the explicit opt-in for signed-in journeys,
 *   where the operator signs in once and the profile (and its cookies) persist;
 * - it navigates and reads. Click and type exist for allowlisted hosts that
 *   are not X or Twitter; those two stay refused. There is no upload or download.
 */
import {spawn} from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {isPrivateAddress} from './net-guard.mjs';
import {hostAllowed, isPostingHost} from '../shared/bot-browser.js';

// The allowlist rule lives with the rest of the browser-block rules in
// `shared/bot-browser.js`, so the server runtime and this device read the same
// `AGENT_BROWSER_ALLOWLIST` identically. Re-exported because the device process
// and its tests read it here.
export {hostAllowed};

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

/** Actions a `browser.action` task may run, and the hard cap per task. Every
 * click, typed value and navigation is still gated by the same allowlist and
 * proxy as a read: this adds interaction, not a way around the boundary. */
export const ACTION_OPS = ['navigate', 'click', 'type', 'waitFor', 'read', 'scroll'];
export const MAX_ACTIONS = 25;
/** How many interactive elements a snapshot reports. A long page can have
 * hundreds of links; the first screenful is what a model can use, and the rest
 * would only pad the chat record. */
export const MAX_ELEMENTS = 60;
const jsLiteral = value => JSON.stringify(String(value ?? ''));
const postingPage = `(()=>{try{const host=new URL(location.href).hostname.toLowerCase().replace(/\\.+$/,'');return host==='x.com'||host.endsWith('.x.com')||host==='twitter.com'||host.endsWith('.twitter.com');}catch{return false;}})()`;
const postingRefusal = `Bots may read X and Twitter pages but never click or type there.`;
/** The elements a person could interact with, filtered the way a person sees
 * them: not disabled, with a real box on the page. Shared by the snapshot and
 * by every index-based step, so "index 3" means the same element in both. */
const PICKABLE = `(function(){var sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],[contenteditable="true"]';return Array.prototype.filter.call(document.querySelectorAll(sel),function(e){if(e.disabled)return false;var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;var s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none';});})()`;
/** Number the interactive elements and report them. Indices let the model act
 * without inventing a CSS selector, which is what makes an agent's second step
 * reliable on a page it has never seen; the attributes make the step cheap.
 * Both lists come from the same `PICKABLE` expression in the same page load. */
const SNAPSHOT = `(function(){var els=${PICKABLE};els.forEach(function(e,i){e.setAttribute('data-agent-index',String(i+1));});return {count:els.length,elements:els.slice(0,${MAX_ELEMENTS}).map(function(e,i){var t=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.name||'');return {index:i+1,tag:e.tagName.toLowerCase(),text:String(t).replace(/\\s+/g,' ').trim().slice(0,80)};})};})()`;
/** A step targets an element by the index from the last snapshot, or by a CSS
 * selector when the model prefers one. */
const targetOf = step => step.index ? jsLiteral(`[data-agent-index="${Math.round(step.index)}"]`) : jsLiteral(step.selector);
function actionExpression(step) {
  const sel = targetOf(step);
  switch (step.op) {
    case 'click': return `(()=>{const blocked=()=>${postingPage};if(blocked())return{ok:false,reason:${jsLiteral(postingRefusal)}};const el=document.querySelector(${sel});if(!el)return{ok:false,reason:'selector not found'};el.scrollIntoView();if(blocked())return{ok:false,reason:${jsLiteral(postingRefusal)}};el.click();return{ok:true};})()`;
    case 'type': return `(()=>{const blocked=()=>${postingPage};if(blocked())return{ok:false,reason:${jsLiteral(postingRefusal)}};const el=document.querySelector(${sel});if(!el)return{ok:false,reason:'selector not found'};const v=${jsLiteral(step.text)};if(blocked())return{ok:false,reason:${jsLiteral(postingRefusal)}};if('value' in el){el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}else{el.textContent=v;}return{ok:true};})()`;
    case 'waitFor': return `new Promise(res=>{const sel=${sel};const end=Date.now()+${Number(step.timeoutMs) > 0 ? Math.min(Number(step.timeoutMs), 15000) : 5000};const tick=()=>{if(document.querySelector(sel))return res({ok:true});if(Date.now()>end)return res({ok:false,reason:'timed out'});setTimeout(tick,100);};tick();})`;
    case 'read': return `(()=>{const el=document.querySelector(${sel});return{ok:Boolean(el),text:el?String(el.textContent).slice(0,4000):null};})()`;
    case 'snapshot': return SNAPSHOT;
    case 'scroll': {
      const times = Math.min(4, Math.max(1, Number(step.times) || 2));
      return `new Promise(async res=>{for(let i=0;i<${times};i++){window.scrollBy(0, Math.max(400, window.innerHeight||800));await new Promise(r=>setTimeout(r,400));}res({ok:true,times:${times}});})`;
    }
    default: return null;
  }
}

/** Why this step must not run on `pageUrl`, or '' when it may.
 * Click and type stay refused on X and Twitter even after a redirect or a
 * trailing-dot host. Reading and scrolling those pages is allowed. */
export function refusePostingAction(op, pageUrl) {
  return (op === 'click' || op === 'type') && isPostingHost(pageUrl) ? 'Bots may read X and Twitter pages but never click or type there.' : '';
}

/** Decide one request the page being read wants to make. The page itself
 * (and any frame in it) must be on the allowlist; where a request may connect
 * to is the proxy's decision. */
export function requestVerdict({url, isDocument, method = 'GET', resourceType}, {allow}) {
  if (/^(data|blob|about):/i.test(url)) return {allow: true};
  if (!/^https?:/i.test(url)) return {allow: false, reason: 'Only http(s) is loaded.'};
  if (isDocument && !hostAllowed(url, allow)) return {allow: false, reason: `${new URL(url).host} is not in AGENT_BROWSER_ALLOWLIST.`};
  // A WebSocket upgrade rides in as a GET, so check it by resource type
  // before the writable-method check would let it through.
  if (isPostingHost(url) && (resourceType === 'WebSocket' || !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase()))) {
    return {allow: false, reason: 'Writes to X and Twitter are not allowed.'};
  }
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
  // A container normally has no user namespaces, so Chrome's own sandbox cannot
  // start. The opt-in flag trades renderer isolation for a browser that runs;
  // the egress proxy, the allowlist and the fresh context still apply.
  const noSandbox = /^(1|true|on|yes)$/i.test(String(process.env.BROWSER_NO_SANDBOX || ''));
  const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-gpu', '--mute-audio',
    ...(noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
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
    for (const listener of listeners.get(message.method) || []) listener({...message.params, sessionId: message.sessionId});
  };
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params, sessionId})); }),
    // `on` returns the unsubscribe, so a page's listener does not outlive the
    // page: a reused connection would otherwise deliver the closed target's
    // requests to the next capture's handler.
    on: (method, listener) => {
      const existing = listeners.get(method) || [];
      listeners.set(method, [...existing, listener]);
      return () => listeners.set(method, (listeners.get(method) || []).filter(entry => entry !== listener));
    },
    close: () => socket.close(),
  };
}

/** One browser process and one egress proxy, reused across captures.
 *
 * Each capture gets its own browser context, so a warm process is not a
 * signed-in one: cookies, storage and cache are per capture, exactly what a
 * fresh profile gave. A caller that reads several pages pays the launch cost
 * (about a second) once, which is what makes a server-side browser practical.
 */
export async function startBrowserSession({binary = findBrowser(), permit = publicOnly, profile = process.env.AGENT_BROWSER_PROFILE || null, extraArgs = String(process.env.AGENT_BROWSER_ARGS || '').split(' ').filter(Boolean)} = {}) {
  if (!binary) throw new Error('No Chrome, Chromium or Edge was found on this device. Install one, or set AGENT_BROWSER_PATH.');
  // A throwaway profile by default; a kept one only when the operator opts in.
  const keepProfile = profile;
  if (keepProfile) fs.mkdirSync(keepProfile, {recursive: true});
  const dir = keepProfile || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  const refused = [];
  const proxy = await startProxy({permit, refused});
  const {child, address} = launch(binary, dir, proxy.port, extraArgs);
  let cdp;
  try { cdp = await connect(await address); }
  catch (error) {
    // A process that never answered is still a process holding a port and a
    // profile directory; close both before the caller sees the error.
    proxy.close();
    child.kill('SIGKILL');
    throw error;
  }

  /** Open `url` in a fresh context and return what a reader would see. */
  async function capture(url, {allow, steps = [], timeoutMs = 20000} = {}) {
    if (!hostAllowed(url, allow)) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
    const blockedBefore = refused.length, blocked = [];
    let deadlineTimer = null, contextId = null, targetId = null;
    const deadline = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error(`The page did not finish loading within ${timeoutMs / 1000}s.`)), timeoutMs); deadlineTimer.unref(); });
    try {
      return await Promise.race([deadline, (async () => {
        ({browserContextId: contextId} = await cdp.send('Target.createBrowserContext'));
        ({targetId} = await cdp.send('Target.createTarget', {url: 'about:blank', browserContextId: contextId}));
        const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
        // One DevTools connection carries events for every attached target, so a
        // listener has to know which page it is for: a second context (a person's
        // takeover while a capture runs) would otherwise consume this page's
        // events and answer its paused requests.
        const pageOn = (method, fn) => cdp.on(method, params => { if (params.sessionId && params.sessionId !== sessionId) return; fn(params); });
        // The page's own requests pause here first, so it cannot be sent to a
        // page nobody allowed.
        const offPaused = pageOn('Fetch.requestPaused', ({requestId, request, resourceType}) => {
          const verdict = requestVerdict({url: request.url, isDocument: resourceType === 'Document', method: request.method, resourceType}, {allow});
          if (!verdict.allow) blocked.push(`${request.url.slice(0, 120)}: ${verdict.reason}`);
          cdp.send(verdict.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', verdict.allow ? {requestId} : {requestId, errorReason: 'BlockedByClient'}, sessionId).catch(() => {});
        });
        try {
          await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]}, sessionId);
          await cdp.send('Page.enable', {}, sessionId);
          const loaded = new Promise(resolve => { const off = pageOn('Page.loadEventFired', () => { off(); resolve(); }); });
          const navigation = await cdp.send('Page.navigate', {url}, sessionId);
          // The proxy's own refusal is the useful sentence: "it is on a private
          // or local network" says what happened, where ERR_HTTP_RESPONSE_CODE_
          // FAILURE says only that something did.
          const lastRefusal = refused.length > blockedBefore ? refused[refused.length - 1] : '';
          if (navigation.errorText) throw new Error(blocked[0] ? `The page was not opened. ${blocked[0]}`
            : lastRefusal ? `The page was not opened. ${lastRefusal}`
            : `The page could not be opened: ${navigation.errorText}.`);
          await loaded;
          // Give scripts a moment to render what they fetched.
          await new Promise(resolve => setTimeout(resolve, 600));
          // Number the interactive elements once, before the steps, so an
          // `index` step and the list the model was shown agree.
          await cdp.send('Runtime.evaluate', {expression: SNAPSHOT, returnByValue: true}, sessionId);
          // Optional interaction steps (a `browser.action` task). Each is bounded and
          // still gated by the allowlist + proxy; a `navigate` is checked here too.
          const actions = [];
          const plannedPages = [url, ...steps.filter(step => step?.op === 'navigate').map(step => step.url)];
          const touchesPosting = plannedPages.some(page => isPostingHost(page));
          const currentUrl = async () => {
            const {result} = await cdp.send('Runtime.evaluate', {expression: 'location.href', returnByValue: true}, sessionId);
            return typeof result?.value === 'string' ? result.value : '';
          };
          for (const step of steps.slice(0, MAX_ACTIONS)) {
            if (step?.op === 'click' || step?.op === 'type') {
              // The planned URL can be a trailing-dot spelling of X, or the page
              // can land there by redirect after validation only saw another host.
              const reason = refusePostingAction(step.op, await currentUrl()) || (touchesPosting ? 'Bots may read X and Twitter pages but never click or type there.' : '');
              if (reason) { actions.push({op: step.op, ok: false, reason}); continue; }
            }
            if (step?.op === 'navigate') {
              const target = String(step.url || '');
              if (!hostAllowed(target, allow)) { actions.push({op: 'navigate', ok: false, reason: 'host not in AGENT_BROWSER_ALLOWLIST'}); continue; }
              const nav = await cdp.send('Page.navigate', {url: target}, sessionId);
              if (nav.errorText) { actions.push({op: 'navigate', ok: false, reason: nav.errorText}); continue; }
              await new Promise(resolve => setTimeout(resolve, 500));
              actions.push({op: 'navigate', ok: true, url: target});
              continue;
            }
            const expression = actionExpression(step || {});
            if (!expression) { actions.push({op: String(step?.op || 'unknown'), ok: false, reason: 'unsupported action'}); continue; }
            const {result} = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
            actions.push({op: step.op, ...(result?.value && typeof result.value === 'object' ? result.value : {ok: false})});
          }
          const {result} = await cdp.send('Runtime.evaluate', {returnByValue: true, expression: `JSON.stringify({url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 20000), snapshot: ${SNAPSHOT}})`}, sessionId);
          const page = JSON.parse(result.value);
          if (!hostAllowed(page.url, allow)) throw new Error(`The page ended up on ${new URL(page.url).host}, which is not in AGENT_BROWSER_ALLOWLIST.`);
          const text = page.text.replace(/\s+/g, ' ').trim();
          const snapshot = page.snapshot && typeof page.snapshot === 'object' ? page.snapshot : {count: 0, elements: []};
          return {
            url, finalUrl: page.url, title: page.title || null,
            excerpt: text.slice(0, 600), text: text.slice(0, 4000),
            // What the model can act on next: a short, numbered list of the
            // controls a person would see, not the raw HTML.
            elements: Array.isArray(snapshot.elements) ? snapshot.elements : [],
            elementCount: Number(snapshot.count) || 0,
            blockedRequests: blocked.length + (refused.length - blockedBefore),
            engine: 'browser', capturedAt: new Date().toISOString(),
            ...(steps.length ? {actions} : {}),
          };
        } finally { offPaused(); }
      })()]);
    } finally {
      // The deadline only matters while loading; clear it so a successful capture
      // does not leave a timer holding a closure until it fires.
      clearTimeout(deadlineTimer);
      // Close the page and throw the whole cookie jar away: the next capture
      // starts signed out even though the process is reused.
      if (targetId) await cdp.send('Target.closeTarget', {targetId}).catch(() => {});
      if (contextId) await cdp.send('Target.disposeBrowserContext', {browserContextId: contextId}).catch(() => {});
    }
  }

  async function close() {
    try { cdp.close(); } catch { /* Already closed. */ }
    proxy.close();
    child.kill('SIGKILL');
    await new Promise(resolve => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));
    // A kept profile (AGENT_BROWSER_PROFILE) survives so its sign-in does; a
    // throwaway one is removed. Chromium child processes can still be flushing
    // the directory for a moment after the parent exits (maxRetries only helps
    // on Windows), so retry and never let a cleanup race mask the real result.
    if (!keepProfile) for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(dir, {recursive: true, force: true}); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 120)); }
    }
  }

  /** Open one page and keep it open, so a person can act on it between calls.
   *
   * This is the one thing a fresh context per page cannot do: a sign-in, a 2FA
   * prompt or a challenge that only a person can answer. The context here is
   * deliberately not disposed until `close()`, so the cookies earned in it
   * survive from one call to the next — and die with it, so no bot inherits a
   * signed-in browser: handing the page back is a read of what the person
   * reached, not a session the next capture can reuse.
   *
   * The rules that bound a capture still bound this: the page and every
   * navigation must be on the allowlist, the egress proxy still refuses private
   * and local addresses, and click and type on X and Twitter is still refused.
   * Signing in is the point; publishing from here is not. */
  async function open(url, {allow, timeoutMs = 25000} = {}) {
    if (!hostAllowed(url, allow)) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
    const blockedBefore = refused.length, blocked = [];
    const {browserContextId: contextId} = await cdp.send('Target.createBrowserContext');
    let targetId = null;
    try {
      ({targetId} = await cdp.send('Target.createTarget', {url: 'about:blank', browserContextId: contextId}));
      const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
      const pageOn = (method, fn) => cdp.on(method, params => { if (params.sessionId && params.sessionId !== sessionId) return; fn(params); });
      const offPaused = pageOn('Fetch.requestPaused', ({requestId, request, resourceType}) => {
        const verdict = requestVerdict({url: request.url, isDocument: resourceType === 'Document', method: request.method, resourceType}, {allow});
        if (!verdict.allow) blocked.push(`${request.url.slice(0, 120)}: ${verdict.reason}`);
        cdp.send(verdict.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', verdict.allow ? {requestId} : {requestId, errorReason: 'BlockedByClient'}, sessionId).catch(() => {});
      });
      await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      // A desktop viewport, because the person is looking at a phone: a page
      // laid out for a desktop is the page they meant to open.
      await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1024, height: 768, deviceScaleFactor: 1, mobile: false}, sessionId).catch(() => {});
      const evaluate = expression => cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);

      async function read() {
        const {result} = await evaluate(`JSON.stringify({url: location.href, title: document.title, ready: document.readyState, text: (document.body ? document.body.innerText : "").slice(0, 20000), snapshot: ${SNAPSHOT}})`);
        const page = JSON.parse(result.value);
        const snap = page.snapshot && typeof page.snapshot === 'object' ? page.snapshot : {count: 0, elements: []};
        return {
          url: page.url, title: page.title || null,
          text: String(page.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
          elements: Array.isArray(snap.elements) ? snap.elements : [], elementCount: Number(snap.count) || 0,
          blockedRequests: blocked.length + (refused.length - blockedBefore),
        };
      }
      const done = () => evaluate('document.readyState').then(({result}) => result?.value === 'complete').catch(() => false);
      /** An action may start a navigation, and the app is being read by a person
       * who expects the result to be the page they land on. Wait, bounded, for
       * the document to be complete and to stop moving; a slow site must not
       * hold the request open forever. */
      async function settled(previous) {
        const deadline = Date.now() + 8000;
        let last = previous || '';
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 200));
          if (!await done()) continue;
          const here = await read().catch(() => null);
          if (here && here.url === last) return here;
          last = here?.url || last;
        }
        return read();
      }
      /** What the person sees: the page, and a picture of it. JPEG, because the
       * whole picture rides in one JSON reply to a phone. */
      async function view(withImage = true) {
        // A page can be mid-navigation when the person asks for it; an empty
        // frame with the address they are heading to is more useful than a 500.
        const page = await read().catch(() => ({url, title: null, text: '', elements: [], elementCount: 0, blockedRequests: blocked.length + (refused.length - blockedBefore)}));
        if (!withImage) return page;
        const {data} = await cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 70, captureBeyondViewport: false}, sessionId).catch(() => ({data: null}));
        return {...page, image: data ? `data:image/jpeg;base64,${data}` : null};
      }

      const navigation = await cdp.send('Page.navigate', {url}, sessionId);
      const lastRefusal = refused.length > blockedBefore ? refused[refused.length - 1] : '';
      if (navigation.errorText) throw new Error(blocked[0] ? `The page was not opened. ${blocked[0]}`
        : lastRefusal ? `The page was not opened. ${lastRefusal}`
        : `The page could not be opened: ${navigation.errorText}.`);
      const current = await settled(url);

      return {
        url,
        /** One action, then the page as it is now. */
        async act(step) {
          const op = String(step?.op || '');
          if (op === 'navigate') {
            const target = String(step.url || '');
            if (!hostAllowed(target, allow)) return {ok: false, reason: 'That host is not in AGENT_BROWSER_ALLOWLIST.', ...await view()};
            const blockedBefore = blocked.length, refusedBefore = refused.length;
            const nav = await cdp.send('Page.navigate', {url: target}, sessionId).catch(error => ({errorText: error.message}));
            const page = await settled(target);
            // A refusal during this navigation names the reason: the allowlist
            // says which host was not allowed, and the proxy says when the
            // address is on a private or local network. A bare Chrome error code
            // says only that something did not work.
            const refusal = blocked.length > blockedBefore ? blocked[blocked.length - 1]
              : refused.length > refusedBefore ? refused[refused.length - 1] : '';
            return {ok: !nav.errorText && !refusal, reason: nav.errorText || refusal ? `The page was not opened. ${refusal || nav.errorText}` : '', ...page};
          }
          const here = await read().catch(() => ({url: ''}));
          const refusal = refusePostingAction(op, here.url);
          if (refusal) return {ok: false, reason: refusal, ...here};
          const expression = actionExpression(step || {});
          if (!expression) return {ok: false, reason: 'That action is not supported.', ...here};
          const {result} = await evaluate(expression).catch(error => ({result: {value: {ok: false, reason: error.message}}}));
          const value = result?.value && typeof result.value === 'object' ? result.value : {ok: false, reason: 'The page did not answer.'};
          const page = await settled(here.url);
          // `read` returns an element's text; keep it next to the page instead of
          // letting the page's own text win the spread.
          return {ok: Boolean(value.ok), reason: String(value.reason || ''), readText: typeof value.text === 'string' ? value.text : null, ...page};
        },
        /** The page as the person left it: what the bot is handed back. */
        view: () => view(),
        page: () => view(false),
        snapshot: () => view(false),
        close: async () => {
          offPaused();
          await cdp.send('Target.closeTarget', {targetId}).catch(() => {});
          await cdp.send('Target.disposeBrowserContext', {browserContextId: contextId}).catch(() => {});
        },
      };
    } catch (error) {
      // A page that never opened must not leave a context behind: the next
      // takeover would inherit its cookies.
      if (targetId) await cdp.send('Target.closeTarget', {targetId}).catch(() => {});
      await cdp.send('Target.disposeBrowserContext', {browserContextId: contextId}).catch(() => {});
      throw error;
    }
  }

  return {capture, open, close};
}

/** One page in a browser that lives only for that page. The device process and
 * a one-shot server read both use this; a caller with several pages starts a
 * session instead. */
export async function captureWithBrowser(url, opts = {}) {
  // Refuse before launching: a host nobody allowed must not cost a process.
  if (!hostAllowed(url, opts.allow)) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
  const session = await startBrowserSession(opts);
  try { return await session.capture(url, opts); }
  finally { await session.close(); }
}
