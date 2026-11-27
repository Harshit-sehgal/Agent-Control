#!/usr/bin/env node
/** Agent Control local agent.
 *
 * A companion process that runs on a machine the user controls. It never
 * listens; it dials the control plane outbound only:
 *
 *   node agent/agent.mjs pair --server https://your-host --code ABCD-1234
 *   node agent/agent.mjs run            # heartbeat loop, execute, report
 *   node agent/agent.mjs status         # show saved pairing + last heartbeat
 *
 * The pairing secret is only ever written to this machine's config file
 * (mode 0600). Every request is HMAC-signed with method, path, timestamp and
 * a hash of the body, and the server rejects replays and stale clocks.
 *
 * The agent executes only the task kinds its server-side permissions allow.
 * "model.run" runs the owner's own `claude` or `codex` CLI (agent/cli-model.mjs),
 * signed in on this machine, so a bot can use their subscription. The app never
 * sees that login.
 * "mcp.call" starts a stdio MCP server named in this machine's config (`mcpServers`, see agent/mcp-stdio.mjs)
 * and lists its tools or calls one. A task names the server; it never carries a command.
 * "browser.capture" reads a page on a host the operator explicitly allowlists
 * (AGENT_BROWSER_ALLOWLIST). By default that is a plain HTTP read. With
 * AGENT_BROWSER=1 the page is opened in the Chrome, Chromium or Edge installed
 * on this device (see agent/browser.mjs), in one browser that every bot shares
 * and that keeps its sign-ins in `browser-profile` next to this config
 * (agent/shared-browser.mjs): each bot has its own tab, one bot drives at a
 * time. "browser.action" may click, type, scroll and read there; a click on a
 * Send, Post, Delete or Pay control runs only when the owner allowed it.
 *
 * Browser accounts (the "browser-accounts-v1" feature): a task may name an account, a separate sign-in of one site
 * whose cookies live only on this computer, encrypted under the pairing secret in `browser-accounts/` beside this
 * config (agent/account-jars.mjs). The heartbeat reports each account's state, never a cookie, and hears which accounts
 * this computer holds; a jar the list omits is wiped, and a beat with no list wipes nothing. A task for an account runs
 * only when it names this computer and the account is on that list, and only in the real browser: it is never read by
 * the plain fetch, which has no cookies. A re-pair that proves the old secret keeps the jars (they are re-encrypted
 * under the new one; the config holds both secrets until that is done). The housekeeping sweep (idle tabs, jar saves,
 * keepers, the optional idle quit AGENT_BROWSER_QUIT_IDLE=1) runs every minute (agent/browser-host.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {createBrowserHost} from './browser-host.mjs';
import {browserAccountsDir, rekeyJars, rePairProof, wipeAllJars} from './account-jars.mjs';
import {createLiveChannel} from './live-channel.mjs';
import {runModelTask} from './cli-model.mjs';
import {cliStatusReporter} from './cli-status.mjs';
import {DEVICE_FEATURES} from '../shared/device-features.js';
import {runMcpTask} from './mcp-stdio.mjs';
import {reportResult, skipExpired} from './report-result.mjs';
import {hostAllowed, hostOf, parseAllowlist} from '../shared/bot-browser.js';
import {resolvePublicAddress, pinnedRequest} from './net-guard.mjs';
import {findBrowser} from './browser.mjs';
import {readableHtml, PLAIN_AGENT} from './page-fetch.mjs';
import {createTaskPool, concurrencyOf} from './task-pool.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.AGENT_CONFIG ? path.resolve(process.env.AGENT_CONFIG) : path.join(HERE, 'agent.config.json');
// Kinds the control plane can grant. Asking for every one, when the operator
// does not narrow the list, is the only way to receive the admin's full scope:
// the server intersects the request with the code and treats an empty list as
// "grant nothing".
const TASK_KINDS = ['http.check', 'browser.capture', 'browser.action', 'model.run', 'mcp.call'];
// `Number('15s')` is NaN, `Number('')` is 0, and `Math.max(2000, NaN)` is NaN,
// which `setTimeout` turns into a 1 ms loop: an unpaced heartbeat storm. A value
// that is not a positive number is the default, not a spin.
const POLL_MS = (() => { const n = Number(process.env.AGENT_POLL_MS); return Number.isFinite(n) && n > 0 ? n : 15000; })();
const TIMEOUT_MS = 15000;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch { fail('No agent config found. Run `node agent/agent.mjs pair --server <url> --code <code>` first.'); }
}
function saveConfig(config) {
  const fd = fs.openSync(CONFIG, 'w', 0o600);
  try {
    // open's mode only applies to a new file; repair permissions before the
    // pairing secret is written when an older config already exists.
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function fail(message) { console.error(`agent: ${message}`); process.exit(1); }

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function sign(secret, {method, requestPath, timestamp, body}) {
  const payload = [String(method).toUpperCase(), String(requestPath), String(timestamp), sha256(body)].join('\n');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** One outbound POST. Redirects are not followed: a 307 from the control plane
 * would otherwise deliver the body (a pairing code, or a signed poll) to
 * whatever host the Location names, including a metadata address. */
async function post(url, {headers, body, timeoutMs = TIMEOUT_MS, signal} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A caller's own signal (the live view stopping) ends the request too.
  signal?.addEventListener('abort', () => controller.abort(), {once: true});
  try {
    const res = await fetch(url, {method: 'POST', headers, body, signal: controller.signal, redirect: 'manual'});
    if (res.status >= 300 && res.status < 400) throw new Error(`Refusing to follow a redirect (${res.status}) from ${new URL(url).host}.`);
    return res;
  } catch (e) {
    if (e.name === 'AbortError' && signal?.aborted) throw e;
    if (e.name === 'AbortError') throw new Error(`request to ${new URL(url).host} timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally { clearTimeout(timer); }
}

/** Outbound-only signed request. Returns parsed JSON or throws with the
 * server's message; never retries silently on 4xx. */
async function call(config, requestPath, body = null, {timeoutMs, signal} = {}) {
  const url = new URL(config.server.replace(/\/+$/, '') + requestPath);
  const raw = body === null ? '' : JSON.stringify(body);
  const timestamp = Date.now();
  const headers = {'Content-Type': 'application/json', 'X-Agent-Id': config.agentId, 'X-Agent-Ts': String(timestamp), 'X-Agent-Sig': sign(config.secret, {method: 'POST', requestPath, timestamp, body: raw})};
  const res = await post(url, {headers, body: body === null ? undefined : raw, ...(timeoutMs ? {timeoutMs} : {}), signal});
  const text = await res.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`server responded ${res.status}: ${value?.error || text.slice(0, 200) || 'unknown error'}`);
  return value;
}

async function pair(argv) {
  const server = argValue(argv, '--server');
  const code = argValue(argv, '--code');
  if (!server || !code) fail('pair requires --server and --code.');
  // `--permissions ""` asks for nothing; only an absent flag asks for the full
  // scope. Reading both as "absent" meant a typo granted browser.action.
  const requested = argv.includes('--permissions') ? (argValue(argv, '--permissions') || '') : null;
  const permissions = requested === null ? TASK_KINDS : requested.split(',').map(s => s.trim()).filter(Boolean);
  const name = argValue(argv, '--name') || `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'device'}-agent`;
  const url = new URL(server.replace(/\/+$/, '') + '/api/agent/pair');
  // A computer that holds a working pairing with this same server proves it by the old secret, so the server moves its
  // accounts to the new id and this computer keeps their jars.
  const old = readableConfig();
  const sameServer = old && old.server.replace(/\/+$/, '') === server.replace(/\/+$/, '');
  if (sameServer) finishRekey(old);
  const body = JSON.stringify({code, name, permissions, features: DEVICE_FEATURES, ...(sameServer ? {previous: {agentId: old.agentId, proof: rePairProof(old.secret, code)}} : {})});
  let res;
  try { res = await post(url, {headers: {'Content-Type': 'application/json'}, body}); }
  catch (e) { fail(e.message); }
  const value = await res.json().catch(() => null);
  if (!res.ok) fail(`pairing failed: ${value?.error || res.status}`);
  // A 2xx from something that is not the control plane (a proxy error page, a
  // captive portal) parses to null. Saving that would overwrite a working
  // pairing with empty credentials and then crash on `permissions.join`.
  if (!value || typeof value.agentId !== 'string' || typeof value.secret !== 'string') fail('the server did not return an agent credential; nothing was saved.');
  const granted = Array.isArray(value.permissions) ? value.permissions : [];
  const next = {server: server.replace(/\/+$/, ''), agentId: value.agentId, secret: value.secret, workspaceId: value.workspaceId, permissions: granted, pollIntervalMs: value.pollIntervalMs, name};
  if (sameServer) {
    // Both secrets are in the saved config until the jars are re-encrypted, so a stop in between strands nothing: the
    // next start finishes the job.
    saveConfig({...next, rekeyFrom: old.secret});
    if (finishRekey({...next, rekeyFrom: old.secret}, next)) saveConfig(next);
  } else {
    // No pairing this computer can prove: no secret it holds opens the jars that are here.
    try { wipeAllJars(browserAccountsDir(process.env, CONFIG)); } catch { console.error('agent: could not remove the old browser sign-ins.'); }
    saveConfig(next);
  }
  console.log(`Paired as "${name}". Credentials saved to ${CONFIG} (mode 0600).`);
  console.log('Granted permissions:', granted.join(', ') || '(none)');
  console.log('Start the loop with: node agent/agent.mjs run');
}

/** The saved config when it is a usable pairing, else null (nothing is reported or exited). */
function readableConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return c && typeof c.server === 'string' && typeof c.agentId === 'string' && typeof c.secret === 'string' && c.secret ? c : null;
  } catch { return null; }
}

/** Finish a re-key a stop left half done: a config carrying `rekeyFrom` (the secret before a re-pair) has its jars
 * re-encrypted under `secret`, then the field goes. `clean` is the config to save without it (default: this one without
 * the field). False when it could not be done: the field stays, and the next start tries again. Nothing printed names a
 * secret or a cookie. */
function finishRekey(config, clean = null) {
  if (typeof config.rekeyFrom !== 'string' || !config.rekeyFrom) return true;
  try {
    const {kept, wiped} = rekeyJars({dir: browserAccountsDir(process.env, CONFIG), oldSecret: config.rekeyFrom, newSecret: config.secret});
    if (kept.length || wiped.length) console.log(`Kept ${kept.length} browser account(s); ${wiped.length} need signing in again.`);
    if (!clean) { delete config.rekeyFrom; saveConfig(config); }
    return true;
  } catch {
    console.error('agent: could not re-encrypt the saved browser sign-ins. They will be tried again when the agent starts.');
    return false;
  }
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

/** The device's browser wiring (agent/browser-host.mjs), made once `run` knows this computer's id and secret. */
let host = null;
const shared = () => host.shared();

/** Local, permission-gated execution. Returns a JSON-serializable result. */
async function execute(task, config) {
  if (!(config.permissions || []).includes(task.kind)) {
    throw new Error(`This agent lacks the "${task.kind}" permission. Grant it from the dashboard.`);
  }
  if (task.kind === 'http.check') {
    const target = String(task.payload?.url || '');
    if (!/^https?:\/\//.test(target)) throw new Error('http.check needs a valid http(s) url.');
    const {address} = await resolvePublicAddress(target);
    const started = Date.now();
    // Connect to the address that was just vetted, and report (do not follow)
    // redirects. There is no second DNS lookup, so a rebind cannot slip through.
    const res = await pinnedRequest(target, {address, timeoutMs: 10000});
    const latencyMs = Date.now() - started;
    return {url: target, httpStatus: res.status, ok: res.status >= 200 && res.status < 300, latencyMs, checkedAt: new Date().toISOString()};
  }
  if (task.kind === 'browser.capture') {
    const target = String(task.payload?.url || '');
    const allow = parseAllowlist(process.env.AGENT_BROWSER_ALLOWLIST);
    if (!hostAllowed(target, allow)) {
      throw new Error(`Refusing to read ${hostOf(target) || target}: it is not in AGENT_BROWSER_ALLOWLIST. Only explicitly allowed pages are read.`);
    }
    // A real browser when this computer has one. Without Chrome, Chromium or Edge the page is still read, by a plain
    // fetch, but never a page of a browser account (the plain read has no cookies). The host decides.
    return host.capture(task, {browser: process.env.AGENT_BROWSER === '1' && Boolean(findBrowser()), readPlain});
  }
  if (task.kind === 'browser.action') return host.run(task);
  if (task.kind === 'model.run') {
    // Runs the owner's own signed-in `claude` or `codex` CLI. A failure the CLI
    // reports (not signed in, a usage limit) is an answer, not an agent error, so
    // it is reported as a finished task and the server shows it in the chat.
    return runModelTask(task.payload);
  }
  // A stdio MCP server named in this machine's config (`mcpServers`); the task never carries a command.
  if (task.kind === 'mcp.call') return runMcpTask(task.payload, config.mcpServers);
  throw new Error(`Unknown task kind "${task.kind}".`);
}

/** Read a page without a browser: vetted like http.check and pinned to the vetted address (so it is never a way
 * onto the local network), redirects reported rather than followed, and named honestly (PLAIN_AGENT). */
async function readPlain(target) {
  const {address} = await resolvePublicAddress(target);
  const res = await pinnedRequest(target, {address, timeoutMs: 15000, maxBytes: 2_000_000, headers: {'user-agent': PLAIN_AGENT, accept: 'text/html,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br'}});
  const page = readableHtml(res.body, target);
  const moved = res.status >= 300 && res.status < 400 && res.headers?.location;
  return {url: target, finalUrl: target, httpStatus: res.status, title: page.title, excerpt: page.text.slice(0, 600), text: moved ? `This page moved to ${new URL(res.headers.location, target).href}. Open that address instead.` : page.text,
    links: page.links, elements: [], elementCount: 0, engine: 'fetch', capturedAt: new Date().toISOString()};
}

let stopping = false;
async function run() {
  const config = loadConfig();
  if (!Array.isArray(config.permissions)) config.permissions = [];
  // A re-pair that stopped before it re-encrypted the jars is finished before anything opens one.
  finishRekey(config);
  host = createBrowserHost({agentId: config.agentId, secret: config.secret, configPath: CONFIG});
  host.startSweeps();
  const configured = Number(config.pollIntervalMs);
  const interval = Math.max(2000, Number.isFinite(configured) && configured > 0 ? configured : POLL_MS);
  console.log(`Agent ${config.agentId} polling ${config.server} every ${interval / 1000}s. Ctrl+C to stop.`);
  /** Resolves the wait between polls; a signal wakes it so Ctrl+C does not take
   * up to a full interval to take effect. */
  let wake = null;
  // The worker pool and the tasks it holds, set below; `stop` reaches them before they exist only through these.
  let pool = null;
  let drained = Promise.resolve();
  const sleep = ms => new Promise(resolve => {
    const done = () => { clearTimeout(timer); wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    wake = done;
  });
  // Only a flag, never `process.exit` from the handler: exiting there skips the
  // `finally` that clears the keepalive timer and the cleanup of a browser that
  // is mid-task, leaving an orphan Chrome and a throwaway profile in tmp.
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    console.log(`\nagent: ${signal} received, stopping after the running tasks.`);
    // At once, not in the `finally`: a running task that ends from here on must not start a queued one.
    drained = pool ? pool.drain() : Promise.resolve();
    handBackQueued();
    wake?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // Started by the server (src/local-agent.js): when that server is gone, even killed without a drain,
  // this agent stops too instead of polling a port nobody answers.
  const parent = Number(process.env.AGENT_PARENT_PID);
  if (Number.isInteger(parent) && parent > 1) {
    const watch = setInterval(() => { try { process.kill(parent, 0); } catch { clearInterval(watch); stop('server gone'); } }, 5000);
    watch.unref();
  }

  const cliStatus = cliStatusReporter();
  // The owner's live view of the shared browser: only on a device that runs the
  // real browser and may use it. Started once, the first time that is true.
  let live = null;
  const startLive = () => {
    if (live || process.env.AGENT_BROWSER !== '1' || !['browser.capture', 'browser.action'].some(kind => (config.permissions || []).includes(kind))) return;
    // A task queued on the server answers the live poll at once; ending the sleep
    // between heartbeats picks it up now instead of up to a poll interval later.
    live = createLiveChannel({call: (requestPath, body, options) => call(config, requestPath, body, options), shared: shared(), onTasks: () => wake?.()});
    live.start();
  };
  startLive();
  // Every task a heartbeat handed over that has not finished, and which of those have started.
  const claimed = new Map();
  const started = new Set();
  // Reports and heartbeats still in flight when the device stops: the `finally` waits for them.
  const inflight = new Set();
  const track = promise => { inflight.add(promise); const done = () => inflight.delete(promise); promise.then(done, done); return promise; };
  let beatSeq = 0;
  let lastBeatAt = 0;

  /** A task this device will not start: reported failed, as an expired one is, so the server does not hold it
   * until its lease lapses. A kind that may be retried goes back to the queue; one that may not is failed. */
  const handBack = task => {
    console.error(`agent: ${task.kind} ${task.id} was not started: the device is stopping.`);
    track(call(config, `/api/agent/tasks/${task.id}/result`, {status: 'failed', error: 'The device stopped before it started this task.', attempts: task.attempts})
      .catch(error => console.error(`agent: ${task.kind} ${task.id} could not be handed back: ${error.message}`)));
  };
  /** Everything claimed and still waiting in the pool. After the pool has been told to drain none of it can start. */
  function handBackQueued() {
    for (const [id, task] of claimed) {
      if (started.has(id)) continue;
      claimed.delete(id);
      handBack(task);
    }
  }

  /** One heartbeat. `beat` rides in the signed body because two heartbeats in
   * the same millisecond would otherwise be identical bytes, which the server
   * rejects as a replayed signature. */
  const heartbeat = async () => {
    // Whether the owner's CLIs are signed in, from their own status commands (cached
    // ten minutes, no model call). Only a device allowed to run models looks.
    const cli = (config.permissions || []).includes('model.run') ? cliStatus.snapshot() : undefined;
    lastBeatAt = Date.now();
    const seq = ++beatSeq;
    const beat = await call(config, '/api/agent/heartbeat', {version: '1', os: process.platform, node: process.version, beat: seq, at: Date.now(), features: DEVICE_FEATURES, accounts: host.accountReport(), ...(stopping ? {stopping: true} : {}), ...(cli ? {cli} : {})});
    config.lastSeenAt = new Date().toISOString();
    // The accounts this computer holds, before any task of this beat runs: a jar the list omits is wiped, and a task for
    // an account is served only when it is on the list. An answer with no list (an older server) changes nothing.
    await host.applyAccounts(beat.accounts, seq);
    if (Array.isArray(beat.agent?.permissions)) { config.permissions = beat.agent.permissions; startLive(); }
    for (const task of beat.tasks || []) {
      if (!task || !task.id || claimed.has(task.id)) continue;
      // The server has handed this over, but a stopping device starts nothing new.
      if (stopping) { handBack(task); continue; }
      claimed.set(task.id, task);
      try { pool.add(task); } catch { claimed.delete(task.id); handBack(task); }
    }
  };

  // The heartbeat has to keep going while tasks run. A task can outlive
  // its 120s server lease easily (25 browser steps at up to 15s each), and a
  // device that only heartbeats between tasks looks disconnected: the server
  // then fails a browser.action whose click did land and reports a failure the
  // person reads as "The agent disconnected", while the honest result that comes
  // later is refused as already completed. This timer renews the running leases
  // (the server renews every running row on a beat) while the pool works, unless
  // the main loop beat within the last half interval.
  const keepalive = setInterval(() => {
    if (!pool || pool.running() === 0 || Date.now() - lastBeatAt < interval / 2) return;
    track(heartbeat()).catch(error => console.error(`agent: keepalive heartbeat failed (${error.message}).`));
  }, interval);
  keepalive.unref();

  /** Execute one delivered task and report it. The result carries the attempt
   * the task was claimed with so the server can tell this run's outcome from a
   * later attempt's if the lease lapsed meanwhile. A throw anywhere in here still
   * ends with the task reported, never held until its lease lapses. */
  const runTask = async task => {
    started.add(task.id);
    try {
      if (await skipExpired(call, config, task)) return;
      console.log(`agent: running ${task.kind} ${task.id}`);
      const result = await execute(task, config);
      // A model run that found the CLI signed out or missing: look again soon, the owner is about to fix it.
      if (task.kind === 'model.run' && result?.ok === false && ['not-signed-in', 'cli-missing'].includes(result.code)) cliStatus.invalidate();
      // Reporting is separate from executing (see report-result.mjs).
      await reportResult(call, config, task, result);
    } catch (e) {
      console.error(`agent: ${task.kind} ${task.id} failed: ${e.message}`);
      await call(config, `/api/agent/tasks/${task.id}/result`, {status: 'failed', error: e.message, attempts: task.attempts}).catch(() => {});
    } finally { claimed.delete(task.id); started.delete(task.id); }
  };
  pool = createTaskPool({concurrency: concurrencyOf(process.env), run: runTask});

  let failures = 0;
  try {
    while (!stopping) {
      let wait = interval;
      try {
        // Tasks waiting for a free slot need no new poll; poll when nothing waits. The loop never waits for a
        // task: the pool runs them, and the keepalive renews their leases.
        if (pool.queued() === 0) await heartbeat();
        failures = 0;
        // Reported separately: an unwritable config file is not a network
        // problem, and saying "heartbeat failed" sends the operator to the wrong
        // subsystem while the heartbeat is fine.
        try { saveConfig({...config, lastSeenAt: config.lastSeenAt}); }
        catch (e) { console.error(`agent: could not save agent config (${e.message}). The heartbeat itself is working.`); }
      } catch (e) {
        failures += 1;
        // 401/403/409 mean the grant was revoked, the device deleted or a newer
        // pairing replaced it. Retrying that forever is a log flood, not a
        // recovery: say so once and stop. Anything else backs off, so a control
        // plane that is down is not hammered once per interval.
        const permanent = /server responded (401|403|409)\b/.test(e.message);
        if (permanent && failures >= 5) fail(`the server keeps refusing this device (${e.message}). Re-pair it with \`node agent/agent.mjs pair\`.`);
        wait = permanent ? interval : Math.min(interval * 2 ** Math.min(failures - 1, 4), 300000);
        console.error(`agent: heartbeat failed (${e.message}). Retrying in ${Math.round(wait / 1000)}s.`);
      }
      if (stopping) break;
      await sleep(wait);
    }
  } finally {
    // The running tasks finish and report first, and the keepalive goes on until then: their leases hold.
    // Queued ones were handed back when the device began to stop (`stop`); this is for any other way out.
    drained = pool.drain();
    handBackQueued();
    await drained;
    clearInterval(keepalive);
    // A beat or a hand-back still on its way; a beat that lands now hands its tasks back too.
    while (inflight.size) await Promise.allSettled([...inflight]);
    // The sweep first (a pass left running could start the browser again), then the live view, then the browser.
    await host.stopSweeps();
    await live?.stop(); await host.close(); console.log('agent: stopped.');
  }
}

function status() {
  const config = loadConfig();
  console.log(`server:      ${config.server}`);
  console.log(`agent id:    ${config.agentId}`);
  console.log(`permissions: ${(Array.isArray(config.permissions) ? config.permissions : []).join(', ') || '(none)'}`);
  console.log(`last seen:   ${config.lastSeenAt || 'never (no successful heartbeat)'}`);
}

const [command, ...argv] = process.argv.slice(2);
if (command === 'pair') await pair(argv);
else if (command === 'run') await run();
else if (command === 'status') status();
else {
  console.log('Agent Control local agent\n\n  node agent/agent.mjs pair --server <url> --code <pairing-code>\n  node agent/agent.mjs run\n  node agent/agent.mjs status');
}
