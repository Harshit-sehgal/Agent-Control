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
 * - it navigates and reads, and clicks and types on allowlisted hosts; a Send,
 *   Post, Delete or Pay control is clicked only when the owner allowed it.
 *   There is no upload or download.
 */
import {spawn} from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {isPrivateAddress} from './net-guard.mjs';
import {PAGE_SECRETS_JS, SECRET_FIELDS_JS as SECRET_FIELDS, scrubTyped, rememberTyped} from './page-secrets.mjs';
import {hostAllowed, RISKS, PATH_RISKS, ACTION_KEYS, CHECKOUT_PATH, foldLabel, botCheck, searchAlternates} from '../shared/bot-browser.js';

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
/** The elements a person could interact with, filtered the way a person sees
 * them: not disabled, with a real box on the page. Shared by the snapshot and
 * by every index-based step, so "index 3" means the same element in both. */
const PICKABLE = `(function(){var sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],[contenteditable="true"]';return Array.prototype.filter.call(document.querySelectorAll(sel),function(e){if(e.disabled)return false;var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;var s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none';});})()`;
/** Number the interactive elements and report them (an input also says its `type`, so the takeover can tell a field
 * from a button). Indices let the model act
 * without inventing a CSS selector, which is what makes an agent's second step
 * reliable on a page it has never seen; the attributes make the step cheap.
 * Both lists come from the same `PICKABLE` expression in the same page load. */
/** A page's words for the bot: the main article when the page marks one (menus and sidebars left out), else the whole body. */
/** The words a bot gets as the page's text. A secret field's content is hidden wherever it appears, so a page that
 * prints back what was typed ("Code 482913 sent") shows `[hidden]`. Hidden before the cut, so no part of a secret is left. */
const MAIN_TEXT = `(function(){${PAGE_SECRETS_JS};var b=document.body;if(!b)return "";var m=document.querySelector('main, article, [role=main], #content');var t=m?m.innerText:"";return hideSecrets(t&&t.length>400?t:b.innerText,${SECRET_FIELDS}).slice(0,60000);})()`;
/** The page's links with their addresses: text alone drops where a search result leads. A secret field's content is
 * hidden in the text and in the address (a reset link can carry a code), before the cut. */
const LINKS = `(function(){${PAGE_SECRETS_JS};var secrets=${SECRET_FIELDS};var m=document.querySelector('main, article, [role=main], #content, #b_results, #links')||document.body;if(!m)return [];var seen={},out=[];m.querySelectorAll('a[href]').forEach(function(a){var t=(a.innerText||'').replace(/\\s+/g,' ').trim();var h=a.href;if(out.length>=40||t.length<4||!/^https?:/.test(h)||seen[h])return;seen[h]=1;out.push({text:hideSecrets(t,secrets).slice(0,100),url:hideSecrets(h,secrets).slice(0,300)});});return out;})()`;
/** One read of the page, as JSON. Everything a model is handed is hidden in the page, where the secret fields are:
 * `shown` (the address), `title`, `text`, `links` and the control names. `url` stays the real address, for the
 * device's own decisions (the allowlist, a search alternate) and is never sent on. */
const pageRead = ({links = false, ready = false} = {}) => `JSON.stringify((function(){${PAGE_SECRETS_JS};var s=${SECRET_FIELDS};var h=function(t){return hideSecrets(t,s)};return {url:location.href,shown:h(location.href),title:h(document.title),${ready ? 'ready:document.readyState,' : ''}text:${MAIN_TEXT},${links ? `links:${LINKS},` : ''}snapshot:${SNAPSHOT}};})())`;
/** A control that submits its form: at least a Send, whatever it says. */
const SUBMIT = 'button[type=submit],button:not([type]),input[type=submit],input[type=image]';
const SNAPSHOT = `(function(){var els=${PICKABLE};${PAGE_SECRETS_JS};var secrets=${SECRET_FIELDS};els.forEach(function(e,i){e.setAttribute('data-agent-index',String(i+1));});return {count:els.length,elements:els.slice(0,${MAX_ELEMENTS}).map(function(e,i){var t=hideSecrets(labelOf(e),secrets);var f=e.form||e.closest('form');var r={index:i+1,tag:e.tagName.toLowerCase(),text:t.slice(0,80),submit:Boolean(f)&&e.matches(${jsLiteral(SUBMIT)})};if(r.tag==='input')r.type=String(e.type||'text').toLowerCase();return r;})};})()`;
/** A step targets an element by the index from the last snapshot, or by a CSS
 * selector when the model prefers one. */
const targetOf = step => step.index ? jsLiteral(`[data-agent-index="${Math.round(step.index)}"]`) : jsLiteral(step.selector);
/** What a bot is told when it tries to type into a password, code or card field. */
const SECRET_REFUSAL = 'This is a password or code field. The owner signs in; a bot never types there.';
/** The owner's typing, before the value is written. A secret goes only into a text-entry field (never into a
 * button, whose label would then name the password). A secret, or a field that already counts as secret, is tagged
 * `data-agent-secret` in this same evaluation, ahead of the write, so the tag lands or nothing is typed. */
const ownerTyping = step => `${PAGE_SECRETS_JS};${step.secret === true ? `if(!isTextEntry(el))return{ok:false,reason:${jsLiteral(NEEDS_FIELD)}};` : ''}if(${step.secret === true}||isSecretField(el))el.setAttribute('data-agent-secret','1');`;
/** What the owner is told when a secret is aimed at something that is not a text field. Fixed words: never the text. */
const NEEDS_FIELD = 'Choose a text field first.';
const RISK_WORDS = {spend: 'a payment', delete: 'a delete', post: 'a post', send: 'a send'};
/** What a click lands on: `el.click()` bubbles, so a click on an icon inside Pay now is a click on Pay now. */
const CONTROL = 'button,a[href],input,[role=button],[role=link],summary,label,[onclick]';
/** In the page, at the moment of a bot's click or typed field: read the control's visible text, value,
 * aria-label, placeholder, title and alt, from the node itself and from the control it sits in (and, for a
 * click, from the submit control of its form), and refuse it when they name a risky class the owner did not
 * approve (`approved`, from the server; the model cannot set it). A click on a checkout page is a payment
 * unless one was approved. The check and the click are one evaluation, so the page cannot swap the label in
 * between. `person` is the owner's own click or typing: no check. */
function riskGuard(approved, verb, click = false, typing = false, person = false) {
  if (person) return '';
  // Each entry is "class@origin" (shared/bot-browser.js approvedFor): a class is cleared only on the origin the
  // page is on at this click, so a Send approved for one site is refused after a navigate to another.
  const cleared = approved.filter(a => typeof a === 'string' && a.includes('@'));
  const risks = RISKS.map(([action, pattern]) => [action, pattern.source, pattern.flags, RISK_WORDS[action]]);
  const paths = PATH_RISKS.map(([action, pattern]) => [action, pattern.source, pattern.flags, RISK_WORDS[action]]);
  const checkout = click
    ? `if(open.some(r=>r[0]==='spend')&&new RegExp(${jsLiteral(CHECKOUT_PATH.source)},${jsLiteral(CHECKOUT_PATH.flags)}).test(location.pathname))return{ok:false,risk:'spend',reason:'This is a checkout page and nobody approved a payment, so it was not ${verb}. A payment needs the owner to answer a payment ask.'};`
    : '';
  // The words are folded as the server folds them (shared/bot-browser.js foldLabel), so a look-alike letter, a
  // zero-width character or a full-width form does not hide a risky label. A link's address is read as a GET
  // that may act ("/unsubscribe"); a form submit is at least a Send; a control with no words at all is refused
  // unless something risky was approved on this origin, since nobody can tell what it does.
  // A bot never types into a secret field (the owner signs in), and that is checked before anything else, so the
  // refusal is the same whatever was approved. The page's secret fields are read once: they are also hidden from
  // every label this guard shows, since a label from aria-label, placeholder or name can hold the secret itself.
  const secrets = `${PAGE_SECRETS_JS};const secrets=${SECRET_FIELDS};`
    + (typing ? `if(isSecretField(el))return{ok:false,reason:${jsLiteral(SECRET_REFUSAL)}};` : '');
  return secrets + `const fold=${foldLabel.toString()};const here='@'+location.origin;const ok=${JSON.stringify(cleared)};const open=${JSON.stringify(risks)}.filter(r=>!ok.includes(r[0]+here));`
    + `const ctl=el.closest(${jsLiteral(CONTROL)})||el;`
    + (click ? `const form=ctl.form||ctl.closest('form');const sub=form&&form.querySelector(${jsLiteral(SUBMIT)});const submits=Boolean(form)&&ctl.matches(${jsLiteral(SUBMIT)});` : 'const sub=null;const submits=false;')
    + `const words=n=>n?[...(isSecretField(n)?[]:[n.innerText,n.value]),n.getAttribute('aria-label'),n.getAttribute('placeholder'),n.getAttribute('title'),n.getAttribute('alt'),n.getAttribute('name')]:[];`
    // The risk is read from the words as the page wrote them; only the label the reason shows is hidden, so a
    // page cannot hide a "Pay" by filling a secret field with that word.
    + `const said=[...words(el),...(ctl!==el?words(ctl):[]),...(sub&&sub!==ctl&&sub!==el?words(sub):[])].filter(t=>typeof t==='string'&&t.trim()).join(' ');`
    + `const full=fold(said).replace(/\\s+/g,' ').trim().slice(0,2000);const label=fold(hideSecrets(said,secrets)).replace(/\\s+/g,' ').trim().slice(0,120);`
    + `const risky=open.find(r=>new RegExp(r[1],r[2]).test(full));`
    + `if(risky)return{ok:false,risk:risky[0],reason:'This control says "'+label.slice(0,60)+'", which is '+risky[3]+' nobody approved, so it was not ${verb}.'+(risky[0]==='spend'?' A payment needs the owner to answer a payment ask.':'')};`
    + (click ? `const link=el.closest('a[href]');let path='';if(link){try{const u=new URL(link.href);let p=u.pathname;try{p=decodeURIComponent(p);}catch(e){}const keys=new RegExp(${jsLiteral(ACTION_KEYS.source)},${jsLiteral(ACTION_KEYS.flags)});path=fold([p,...[...u.searchParams].flatMap(([k,v])=>keys.test(k)?[k,v]:[k])].join(' ')).replace(/[/_\\-.+=&?]+/g,' ');}catch(e){}}`
      + `const acts=path&&${JSON.stringify(paths)}.filter(r=>!ok.includes(r[0]+here)).find(r=>new RegExp(r[1],r[2]).test(path));`
      + `if(acts)return{ok:false,risk:acts[0],reason:'This link goes to "'+hideSecrets(link.getAttribute('href'),secrets).slice(0,60)+'", which is '+acts[3]+' nobody approved, so it was not ${verb}.'};` : '')
    + `if(submits&&!['send','post','spend'].some(c=>ok.includes(c+here)))return{ok:false,risk:'send',reason:'This control submits a form, which is a send nobody approved, so it was not ${verb}.'};`
    + `if(!full&&!ok.some(a=>a.endsWith(here)))return{ok:false,risk:'send',reason:'This control has no words, so nobody can tell what it does, and nothing was approved on this site, so it was not ${verb}.'};`
    + checkout;
}
/** The page expression for one step. `approved` is what the server cleared for a bot (a missing or malformed one
 * clears nothing); `{person: true}` is the owner's own click or typing during a takeover, which no rule judges.
 * Leaving the flag out is a bot's step, so a caller that forgets it gets the stricter rules. */
function actionExpression(step, approved = [], {person = false} = {}) {
  const sel = targetOf(step);
  const bot = person === true ? [] : (Array.isArray(approved) ? approved : []);
  const owner = person === true;
  switch (step.op) {
    case 'click': return `(()=>{const el=document.querySelector(${sel});if(!el)return{ok:false,reason:'selector not found'};${riskGuard(bot, 'clicked', true, false, owner)}el.scrollIntoView();const a=el.closest('a[target]');if(a)a.removeAttribute('target');el.click();return{ok:true};})()`;
    case 'type': return `(()=>{const el=document.querySelector(${sel});if(!el)return{ok:false,reason:'selector not found'};${riskGuard(bot, 'typed into', false, true, owner)}${owner ? ownerTyping(step) : ''}const v=${jsLiteral(step.text)};if('value' in el){el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}else{el.textContent=v;}return{ok:true${owner ? ',secret:isSecretField(el)' : ''}};})()`;
    case 'waitFor': return `new Promise(res=>{const sel=${sel};const end=Date.now()+${Number(step.timeoutMs) > 0 ? Math.min(Number(step.timeoutMs), 15000) : 5000};const tick=()=>{if(document.querySelector(sel))return res({ok:true});if(Date.now()>end)return res({ok:false,reason:'timed out'});setTimeout(tick,100);};tick();})`;
    case 'read': return `(()=>{${PAGE_SECRETS_JS};const el=document.querySelector(${sel});return{ok:Boolean(el),text:el?hideSecrets(String(el.textContent),${SECRET_FIELDS}).slice(0,4000):null};})()`;
    case 'snapshot': return SNAPSHOT;
    case 'scroll': {
      const times = Math.min(4, Math.max(1, Number(step.times) || 2));
      return `new Promise(async res=>{for(let i=0;i<${times};i++){window.scrollBy(0, Math.max(400, window.innerHeight||800));await new Promise(r=>setTimeout(r,400));}res({ok:true,times:${times}});})`;
    }
    default: return null;
  }
}

// For tests only: the page scripts are strings that run in Chrome, so a test runs them against a fake page.
export {SNAPSHOT, MAIN_TEXT, actionExpression};
export const LOOK = pageRead({links: true});

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

/** The Chrome command line. `profile` is the user-data-dir: a directory that is
 * kept (the shared browser's) or a throwaway one. Pure, so a test can read it. */
export function browserArgs({profile, proxyPort, extraArgs = [], noSandbox = false}) {
  return ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-gpu', '--mute-audio',
    // Several bots' tabs share one headless window: a tab that is not in front must not have its timers and rendering slowed.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    // Everything goes through the proxy, loopback included, and nothing may
    // leave another way (WebRTC would otherwise send UDP directly).
    `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic',
    '--block-new-web-contents', ...extraArgs, 'about:blank'];
}

/** Start the browser and resolve its DevTools address. */
function launch(binary, profile, proxyPort, extraArgs) {
  // A container normally has no user namespaces, so Chrome's own sandbox cannot
  // start. The opt-in flag trades renderer isolation for a browser that runs;
  // the egress proxy, the allowlist and the fresh context still apply.
  const noSandbox = /^(1|true|on|yes)$/i.test(String(process.env.BROWSER_NO_SANDBOX || ''));
  const child = spawn(binary, browserArgs({profile, proxyPort, extraArgs, noSandbox}), {stdio: ['ignore', 'ignore', 'pipe']});
  const address = new Promise((resolve, reject) => {
    let log = '';
    child.stderr.on('data', chunk => { log += chunk; const found = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (found) resolve(found[1]); });
    child.once('error', e => reject(new Error(`The browser at ${binary} could not be started: ${e.message}`)));
    child.once('exit', code => reject(new Error(`The browser exited before it was ready (code ${code}). ${log.trim().split('\n').pop() || ''}`.trim())));
  });
  return {child, address};
}

/** The newest refusal since index `from` that is for `url`'s own host, or ''.
 * Pages in different tabs share one `refused` list, so the newest entry may
 * belong to another tab; an entry reads `${host}: message` and the host of a
 * tunnel is `name:443`, so the match is the hostname followed by a colon. */
export function ownRefusal(refused, from, url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return ''; }
  const mine = `${hostname}:`;
  for (let i = refused.length - 1; i >= from; i--) if (refused[i].startsWith(mine)) return refused[i];
  return '';
}

/** A DevTools connection: `send` resolves with the reply, `on` hears events
 * (the listener gets the params with the flat session id, and the browser's
 * own params as a second argument: a screencast frame's ack id is a field
 * named `sessionId` too), `onClose` hears the browser go away. */
export async function connect(address) {
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Could not connect to the browser.')); });
  let next = 0;
  const waiting = new Map(), listeners = new Map(), closers = [];
  // A browser that exits must not leave a command waiting for a reply that never comes.
  socket.onclose = () => {
    for (const {reject} of waiting.values()) reject(new Error('The browser connection closed.'));
    waiting.clear();
    for (const closer of closers) closer();
  };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const {resolve, reject} = waiting.get(message.id); waiting.delete(message.id);
      return message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
    for (const listener of listeners.get(message.method) || []) listener({...message.params, sessionId: message.sessionId}, message.params);
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
    onClose: listener => { closers.push(listener); },
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
export async function startBrowserSession({binary = findBrowser(), permit = publicOnly, profile = process.env.AGENT_BROWSER_PROFILE || null, extraArgs = String(process.env.AGENT_BROWSER_ARGS || '').split(' ').filter(Boolean), connection = null} = {}) {
  // `connection` is a DevTools connection that already exists (a test's scripted
  // one): nothing is launched and no proxy is started.
  if (!binary && !connection) throw new Error('No Chrome, Chromium or Edge was found on this device. Install one, or set AGENT_BROWSER_PATH.');
  // A throwaway profile by default; a kept one only when the operator opts in.
  const keepProfile = profile;
  // A kept profile holds cookies: private to this user, repaired if it was not.
  if (keepProfile) { fs.mkdirSync(keepProfile, {recursive: true, mode: 0o700}); fs.chmodSync(keepProfile, 0o700); }
  const dir = connection ? keepProfile : keepProfile || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  const refused = [];
  let proxy = null, child = null, cdp;
  if (connection) cdp = connection.cdp;
  else {
    proxy = await startProxy({permit, refused});
    const started = launch(binary, dir, proxy.port, extraArgs);
    child = started.child;
    try { cdp = await connect(await started.address); }
    catch (error) {
      // A process that never answered is still a process holding a port and a
      // profile directory; close both before the caller sees the error.
      proxy.close();
      child.kill('SIGKILL');
      throw error;
    }
  }
  // A browser that exited on its own is dead for good: whoever keeps this
  // session across tasks asks `dead` before reusing it.
  let dead = false;
  cdp.onClose?.(() => { dead = true; });

  /** Open `url` in a fresh context and return what a reader would see.
   *
   * With `tab` (from `newTab`) it uses that page in the default context instead,
   * the one the kept profile belongs to, and leaves it open afterwards: the
   * shared browser's way. `onPage({url, title})` hears each page the tab shows.
   * `settleMs` is how long scripts get to render after a load.
   *
   * `gate`, when given, is asked before each step. It resolves true to go on, or
   * false once the owner has taken the browser: the step in flight when they
   * did has finished (a click is never cut in half or applied twice), every
   * remaining step is reported as not run instead of being applied to a page
   * someone else changed, and the result says `tookOver`. The gate may wait, so
   * the load deadline is paused for as long as it does. */
  async function capture(url, {allow, steps = [], approved = [], timeoutMs = 60000, tab = null, onPage = null, settleMs = 600, gate = null} = {}) {
    if (!hostAllowed(url, allow)) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
    const blockedBefore = refused.length, blocked = [];
    let deadlineTimer = null, contextId = null, targetId = tab ? tab.targetId : null, left = timeoutMs, armedAt = 0, fail;
    const arm = () => { armedAt = Date.now(); deadlineTimer = setTimeout(() => fail(new Error(`The page did not finish loading within ${timeoutMs / 1000}s.`)), Math.max(1, left)); deadlineTimer.unref(); };
    const disarm = () => { clearTimeout(deadlineTimer); left -= Date.now() - armedAt; };
    const deadline = new Promise((_, reject) => { fail = reject; arm(); });
    // The tab's own guard answers its paused requests; this capture only listens to what it blocks.
    if (tab) tab.sink = blocked;
    try {
      return await Promise.race([deadline, (async () => {
        if (!tab) {
          ({browserContextId: contextId} = await cdp.send('Target.createBrowserContext'));
          ({targetId} = await cdp.send('Target.createTarget', {url: 'about:blank', browserContextId: contextId}));
        }
        const {sessionId} = tab ? tab : await cdp.send('Target.attachToTarget', {targetId, flatten: true});
        // One DevTools connection carries events for every attached target, so a
        // listener has to know which page it is for: a second context (a person's
        // takeover while a capture runs) would otherwise consume this page's
        // events and answer its paused requests.
        const pageOn = (method, fn) => cdp.on(method, params => { if (params.sessionId && params.sessionId !== sessionId) return; fn(params); });
        // The page's own requests pause here first, so it cannot be sent to a
        // page nobody allowed.
        const offPaused = tab ? () => {} : pageOn('Fetch.requestPaused', ({requestId, request, resourceType}) => {
          const verdict = requestVerdict({url: request.url, isDocument: resourceType === 'Document', method: request.method, resourceType}, {allow});
          if (!verdict.allow) blocked.push(`${request.url.slice(0, 120)}: ${verdict.reason}`);
          cdp.send(verdict.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', verdict.allow ? {requestId} : {requestId, errorReason: 'BlockedByClient'}, sessionId).catch(() => {});
        });
        try {
          if (!tab) {
            await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]}, sessionId);
            await cdp.send('Page.enable', {}, sessionId);
          }
          const loaded = new Promise(resolve => { const off = pageOn('Page.loadEventFired', () => { off(); resolve(); }); });
          const navigation = await cdp.send('Page.navigate', {url}, sessionId);
          // The proxy's own refusal is the useful sentence: "it is on a private
          // or local network" says what happened, where ERR_HTTP_RESPONSE_CODE_
          // FAILURE says only that something did.
          const lastRefusal = ownRefusal(refused, blockedBefore, url);
          if (navigation.errorText) throw new Error(blocked[0] ? `The page was not opened. ${blocked[0]}`
            : lastRefusal ? `The page was not opened. ${lastRefusal}`
            : `The page could not be opened: ${navigation.errorText}.`);
          await loaded;
          onPage?.({url, title: null});
          // Give scripts a moment to render what they fetched.
          await new Promise(resolve => setTimeout(resolve, settleMs));
          // Number the interactive elements once, before the steps, so an
          // `index` step and the list the model was shown agree.
          await cdp.send('Runtime.evaluate', {expression: SNAPSHOT, returnByValue: true}, sessionId);
          // Optional interaction steps (a `browser.action` task). Each is bounded and
          // still gated by the allowlist + proxy; a `navigate` is checked here too.
          const actions = [];
          const currentUrl = async () => {
            const {result} = await cdp.send('Runtime.evaluate', {expression: 'location.href', returnByValue: true}, sessionId);
            return typeof result?.value === 'string' ? result.value : '';
          };
          let taken = false;
          for (const step of steps.slice(0, MAX_ACTIONS)) {
            if (gate && !taken) {
              disarm();
              try { taken = !(await gate()); } finally { arm(); }
            }
            if (taken) { actions.push({op: String(step?.op || 'unknown'), ok: false, reason: 'You took over the browser, so this step was not run.'}); continue; }
            if (step?.op === 'navigate') {
              const target = String(step.url || '');
              if (!hostAllowed(target, allow)) { actions.push({op: 'navigate', ok: false, reason: 'host not in AGENT_BROWSER_ALLOWLIST'}); continue; }
              const nav = await cdp.send('Page.navigate', {url: target}, sessionId);
              if (nav.errorText) { actions.push({op: 'navigate', ok: false, reason: nav.errorText}); continue; }
              await new Promise(resolve => setTimeout(resolve, Math.min(500, settleMs)));
              actions.push({op: 'navigate', ok: true, url: target});
              onPage?.({url: target, title: null});
              continue;
            }
            const expression = actionExpression(step || {}, approved);
            if (!expression) { actions.push({op: String(step?.op || 'unknown'), ok: false, reason: 'unsupported action'}); continue; }
            const before = step.op === 'click' ? await currentUrl() : '';
            const {result} = await cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
            actions.push({op: step.op, ...(result?.value && typeof result.value === 'object' ? result.value : {ok: false})});
            // A click often opens a page a moment later (a card, a script link): wait for the address to change, then
            // for it to load, so the bot reads the page it opened rather than the one it left.
            if (step.op === 'click' && result?.value?.ok) {
              // 3 seconds at most, and a small share of a short deadline.
              const beat = Math.min(200, timeoutMs / 40);
              let moved = false;
              for (let t = 0; t < 15 && !moved; t++) { await new Promise(resolve => setTimeout(resolve, beat)); moved = (await currentUrl()) !== before; }
              if (moved) {
                for (let t = 0; t < 25; t++) {
                  const {result: ready} = await cdp.send('Runtime.evaluate', {expression: 'document.readyState', returnByValue: true}, sessionId);
                  if (ready?.value === 'complete') break;
                  await new Promise(resolve => setTimeout(resolve, beat));
                }
                await new Promise(resolve => setTimeout(resolve, settleMs));
              }
            }
          }
          const look = async () => JSON.parse((await cdp.send('Runtime.evaluate', {returnByValue: true, expression: LOOK}, sessionId)).result.value);
          let page = await look();
          // A "checking your browser" wall often clears itself in a few seconds; wait for it rather than hand the bot the wall.
          for (let i = 0; i < 8 && botCheck(page.title, page.text); i++) { await new Promise(resolve => setTimeout(resolve, 1000)); page = await look(); }
          // A search engine that still shows a human check: the same search on another engine. Nobody solves the check.
          if (!steps.length && botCheck(page.title, page.text)) for (const other of searchAlternates(page.url || url)) {
            if (!hostAllowed(other, allow)) continue;
            const next = new Promise(resolve => { const off = pageOn('Page.loadEventFired', () => { off(); resolve(); }); });
            const nav = await cdp.send('Page.navigate', {url: other}, sessionId);
            if (nav.errorText) continue;
            await next; await new Promise(resolve => setTimeout(resolve, settleMs));
            page = await look();
            onPage?.({url: page.shown, title: page.title || null});
            if (!botCheck(page.title, page.text)) break;
          }
          onPage?.({url: page.shown, title: page.title || null});
          if (!hostAllowed(page.url, allow)) throw new Error(`The page ended up on ${new URL(page.url).host}, which is not in AGENT_BROWSER_ALLOWLIST.`);
          const text = page.text.replace(/\s+/g, ' ').trim();
          const snapshot = page.snapshot && typeof page.snapshot === 'object' ? page.snapshot : {count: 0, elements: []};
          return {
            url, finalUrl: page.shown, title: page.title || null,
            excerpt: text.slice(0, 600), text: text.slice(0, 60000),
            links: Array.isArray(page.links) ? page.links : [],
            ...(botCheck(page.title, text) ? {botCheck: true} : {}),
            // What the model can act on next: a short, numbered list of the
            // controls a person would see, not the raw HTML.
            elements: Array.isArray(snapshot.elements) ? snapshot.elements : [],
            elementCount: Number(snapshot.count) || 0,
            blockedRequests: blocked.length + (refused.length - blockedBefore),
            engine: 'browser', capturedAt: new Date().toISOString(),
            ...(steps.length ? {actions} : {}),
            ...(taken ? {tookOver: true} : {}),
          };
        } finally { offPaused(); }
      })()]);
    } finally {
      // The deadline only matters while loading; clear it so a successful capture
      // does not leave a timer holding a closure until it fires.
      clearTimeout(deadlineTimer);
      if (tab) tab.sink = null;
      // Close the page and throw the whole cookie jar away: the next capture
      // starts signed out even though the process is reused. A tab from
      // `newTab` is the shared browser's: it stays, with the profile's cookies.
      if (targetId && !tab) await cdp.send('Target.closeTarget', {targetId}).catch(() => {});
      if (contextId) await cdp.send('Target.disposeBrowserContext', {browserContextId: contextId}).catch(() => {});
    }
  }

  async function close() {
    const exited = () => !child || child.exitCode !== null || child.signalCode;
    // A kept profile holds sign-ins that Chrome writes out lazily: ask it to quit
    // (which flushes them) and give it a moment before the kill below.
    if (keepProfile && child && !exited()) {
      await Promise.race([cdp.send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
      await Promise.race([new Promise(resolve => (exited() ? resolve() : child.once('exit', resolve))), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    try { cdp.close(); } catch { /* Already closed. */ }
    proxy?.close();
    child?.kill('SIGKILL');
    if (child) await new Promise(resolve => (exited() ? resolve() : child.once('exit', resolve)));
    // A kept profile (AGENT_BROWSER_PROFILE) survives so its sign-in does; a
    // throwaway one is removed. Chromium child processes can still be flushing
    // the directory for a moment after the parent exits (maxRetries only helps
    // on Windows), and one can write a file back after a removal that succeeded, so retry until the directory is
    // really gone (up to three seconds on a busy machine) and never let a cleanup race mask the real result.
    if (!keepProfile && !connection) for (const until = Date.now() + 3000; ;) {
      try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* Still in use; try again. */ }
      if (!fs.existsSync(dir) || Date.now() > until) break;
      await new Promise(resolve => setTimeout(resolve, 120));
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
   * and local addresses.
   * Signing in is the point; publishing from here is not. */
  async function open(url, {allow, timeoutMs = 60000} = {}) {
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
      // What the owner typed in secret during this takeover, for the life of this page and in memory only. Every
      // result that leaves (`act`, `view`, `page`, `snapshot`, and what `read` returns to them) is scrubbed of it,
      // since a site may echo it in an address, a title or a field it draws again.
      const typed = new Set();
      const scrub = result => scrubTyped(result, typed);

      async function read() {
        const {result} = await evaluate(pageRead({ready: true}));
        const page = JSON.parse(result.value);
        const snap = page.snapshot && typeof page.snapshot === 'object' ? page.snapshot : {count: 0, elements: []};
        return scrub({
          url: page.shown, title: page.title || null,
          text: String(page.text || '').replace(/\s+/g, ' ').trim().slice(0, 60000),
          elements: Array.isArray(snap.elements) ? snap.elements : [], elementCount: Number(snap.count) || 0,
          blockedRequests: blocked.length + (refused.length - blockedBefore),
        });
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
        const page = await read().catch(() => scrub({url, title: null, text: '', elements: [], elementCount: 0, blockedRequests: blocked.length + (refused.length - blockedBefore)}));
        if (!withImage) return page;
        const {data} = await cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 70, captureBeyondViewport: false}, sessionId).catch(() => ({data: null}));
        return {...page, image: data ? `data:image/jpeg;base64,${data}` : null};
      }

      const navigation = await cdp.send('Page.navigate', {url}, sessionId);
      const lastRefusal = ownRefusal(refused, blockedBefore, url);
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
            const refusal = blocked.length > blockedBefore ? blocked[blocked.length - 1] : ownRefusal(refused, refusedBefore, target);
            return scrub({ok: !nav.errorText && !refusal, reason: nav.errorText || refusal ? `The page was not opened. ${refusal || nav.errorText}` : '', ...page});
          }
          const here = await read().catch(() => ({url: ''}));
          const expression = actionExpression(step || {}, [], {person: true});
          if (!expression) return scrub({ok: false, reason: 'That action is not supported.', ...here});
          // Remembered before the text is written, so nothing the page does with it can come back unhidden.
          const secretText = op === 'type' && typeof step.text === 'string';
          if (secretText && step.secret === true) rememberTyped(typed, step.text);
          const {result} = await evaluate(expression).catch(error => ({result: {value: {ok: false, reason: error.message}}}));
          const value = result?.value && typeof result.value === 'object' ? result.value : {ok: false, reason: 'The page did not answer.'};
          // A plain type into a field the page counts as secret is remembered too.
          if (secretText && value.secret === true) rememberTyped(typed, step.text);
          const page = await settled(here.url);
          // `read` returns an element's text; keep it next to the page instead of
          // letting the page's own text win the spread.
          return scrub({ok: Boolean(value.ok), reason: String(value.reason || ''), readText: typeof value.text === 'string' ? value.text : null, ...page});
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

  /** A page in the default context (the kept profile), or in `browserContextId`
   * when one is given (a browser account's own context): what a bot's tab in the
   * shared browser is. Its own guard stays on for the tab's lifetime, so
   * a bot's step and a person's click are held to the same allowlist. */
  async function newTab({allow, viewport = {width: 1280, height: 800}, browserContextId = null} = {}) {
    const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank', ...(browserContextId ? {browserContextId} : {})});
    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
    const tab = {targetId, sessionId, blocked: [], sink: null, viewport, browserContextId, off: () => {}};
    tab.off = cdp.on('Fetch.requestPaused', ({requestId, request, resourceType, sessionId: from}) => {
      if (from && from !== sessionId) return;
      const verdict = requestVerdict({url: request.url, isDocument: resourceType === 'Document', method: request.method, resourceType}, {allow});
      if (!verdict.allow) {
        const sink = tab.sink || tab.blocked;
        sink.push(`${request.url.slice(0, 120)}: ${verdict.reason}`);
        if (sink.length > 50) sink.shift();
      }
      cdp.send(verdict.allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', verdict.allow ? {requestId} : {requestId, errorReason: 'BlockedByClient'}, sessionId).catch(() => {});
    });
    try {
      await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', {...viewport, deviceScaleFactor: 1, mobile: false}, sessionId).catch(() => {});
    } catch (error) {
      tab.off();
      await cdp.send('Target.closeTarget', {targetId}).catch(() => {});
      throw error;
    }
    return tab;
  }
  /** The page ids the browser has now: a tab id that is not here is gone. */
  const liveTargets = async () => (await cdp.send('Target.getTargets')).targetInfos || [];
  const closeTab = async tab => { tab.off(); await cdp.send('Target.closeTarget', {targetId: tab.targetId}).catch(() => {}); };

  /** A browser context of its own: cookies and storage shared with no other. A
   * browser account lives in one. Its tabs are made with `newTab({browserContextId})`. */
  const createContext = async () => (await cdp.send('Target.createBrowserContext')).browserContextId;
  /** Closes the context and every tab in it. */
  const disposeContext = async id => { await cdp.send('Target.disposeBrowserContext', {browserContextId: id}); };
  /** Every cookie the context holds, as Chrome reports them. These are secrets:
   * they go to the device's own jar and nowhere else. */
  const getCookies = async id => (await cdp.send('Storage.getCookies', {browserContextId: id})).cookies || [];
  const setCookies = async (id, cookies) => { await cdp.send('Storage.setCookies', {browserContextId: id, cookies: cookieParams(cookies)}); };

  return {capture, open, close, newTab, closeTab, liveTargets, createContext, disposeContext, getCookies, setCookies, cdp, get dead() { return dead; }};
}

/** The fields of a cookie `Storage.setCookies` takes (a CookieParam). What
 * `Storage.getCookies` reports has more (`size`, `session`), and a session
 * cookie's `expires` is -1, which a CookieParam must leave out. An entry without
 * a string name and value is dropped. Nothing here logs or returns a value
 * outside the array it is given. */
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'];
export function cookieParams(cookies) {
  const out = [];
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    const param = {};
    for (const key of COOKIE_FIELDS) if (cookie[key] !== undefined && cookie[key] !== null) param[key] = cookie[key];
    if (!(Number(param.expires) > 0)) delete param.expires;
    out.push(param);
  }
  return out;
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
