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
 * "browser.capture" reads a page on a host the operator explicitly allowlists
 * (AGENT_BROWSER_ALLOWLIST). By default that is a plain HTTP read. With
 * AGENT_BROWSER=1 the page is opened in the Chrome, Chromium or Edge installed
 * on this device (see agent/browser.mjs), in one browser that every bot shares
 * and that keeps its sign-ins in `browser-profile` next to this config
 * (agent/shared-browser.mjs): each bot has its own tab, one bot drives at a
 * time. "browser.action" may click, type, scroll and read there, except on X
 * and Twitter, where click and type stay refused. Posting is never this
 * process's job.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {createSharedBrowser, browserProfileDir, runBrowserTask} from './shared-browser.mjs';
import {runModelTask} from './cli-model.mjs';
import {cliStatusReporter} from './cli-status.mjs';
import {hostAllowed, hostOf, parseAllowlist} from '../shared/bot-browser.js';
import {resolvePublicAddress, pinnedRequest} from './net-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.AGENT_CONFIG ? path.resolve(process.env.AGENT_CONFIG) : path.join(HERE, 'agent.config.json');
// Kinds the control plane can grant. Asking for every one, when the operator
// does not narrow the list, is the only way to receive the admin's full scope:
// the server intersects the request with the code and treats an empty list as
// "grant nothing".
const TASK_KINDS = ['http.check', 'browser.capture', 'browser.action', 'model.run'];
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
async function post(url, {headers, body, timeoutMs = TIMEOUT_MS} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {method: 'POST', headers, body, signal: controller.signal, redirect: 'manual'});
    if (res.status >= 300 && res.status < 400) throw new Error(`Refusing to follow a redirect (${res.status}) from ${new URL(url).host}.`);
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`request to ${new URL(url).host} timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally { clearTimeout(timer); }
}

/** Outbound-only signed request. Returns parsed JSON or throws with the
 * server's message; never retries silently on 4xx. */
async function call(config, requestPath, body = null) {
  const url = new URL(config.server.replace(/\/+$/, '') + requestPath);
  const raw = body === null ? '' : JSON.stringify(body);
  const timestamp = Date.now();
  const headers = {'Content-Type': 'application/json', 'X-Agent-Id': config.agentId, 'X-Agent-Ts': String(timestamp), 'X-Agent-Sig': sign(config.secret, {method: 'POST', requestPath, timestamp, body: raw})};
  const res = await post(url, {headers, body: body === null ? undefined : raw});
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
  const body = JSON.stringify({code, name, permissions});
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
  saveConfig({server: server.replace(/\/+$/, ''), agentId: value.agentId, secret: value.secret, workspaceId: value.workspaceId, permissions: granted, pollIntervalMs: value.pollIntervalMs, name});
  console.log(`Paired as "${name}". Credentials saved to ${CONFIG} (mode 0600).`);
  console.log('Granted permissions:', granted.join(', ') || '(none)');
  console.log('Start the loop with: node agent/agent.mjs run');
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

/** The browser every bot shares, started on first use and kept between tasks. */
let sharedBrowser = null;
const shared = () => sharedBrowser ??= createSharedBrowser({allow: () => parseAllowlist(process.env.AGENT_BROWSER_ALLOWLIST), profile: browserProfileDir(process.env, CONFIG)});

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
    if (process.env.AGENT_BROWSER === '1') return runBrowserTask(task, {shared: shared(), allow});
    // The fetch fallback must not become a second way onto the local network: it
    // is vetted like http.check and pinned to the vetted address, and redirects
    // are reported rather than followed.
    const {address} = await resolvePublicAddress(target);
    const res = await pinnedRequest(target, {address, timeoutMs: 15000, maxBytes: 200000});
    const html = res.body.slice(0, 200000);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || null;
    const excerpt = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    return {url: target, httpStatus: res.status, title, excerpt, capturedAt: new Date().toISOString()};
  }
  if (task.kind === 'browser.action') return runBrowserTask(task, {shared: shared(), allow: parseAllowlist(process.env.AGENT_BROWSER_ALLOWLIST)});
  if (task.kind === 'model.run') {
    // Runs the owner's own signed-in `claude` or `codex` CLI. A failure the CLI
    // reports (not signed in, a usage limit) is an answer, not an agent error, so
    // it is reported as a finished task and the server shows it in the chat.
    return runModelTask(task.payload);
  }
  throw new Error(`Unknown task kind "${task.kind}".`);
}

let stopping = false;
async function run() {
  const config = loadConfig();
  if (!Array.isArray(config.permissions)) config.permissions = [];
  const configured = Number(config.pollIntervalMs);
  const interval = Math.max(2000, Number.isFinite(configured) && configured > 0 ? configured : POLL_MS);
  console.log(`Agent ${config.agentId} polling ${config.server} every ${interval / 1000}s. Ctrl+C to stop.`);
  /** Resolves the wait between polls; a signal wakes it so Ctrl+C does not take
   * up to a full interval to take effect. */
  let wake = null;
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
    console.log(`\nagent: ${signal} received, stopping after the current task.`);
    wake?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const cliStatus = cliStatusReporter();
  // Tasks handed over by a heartbeat that arrived while a task was executing.
  const inbox = new Map();
  let busy = false;
  let beatSeq = 0;

  /** One heartbeat. `beat` rides in the signed body because two heartbeats in
   * the same millisecond would otherwise be identical bytes, which the server
   * rejects as a replayed signature. */
  const heartbeat = async () => {
    // Whether the owner's CLIs are signed in, from their own status commands (cached
    // ten minutes, no model call). Only a device allowed to run models looks.
    const cli = (config.permissions || []).includes('model.run') ? cliStatus.snapshot() : undefined;
    const beat = await call(config, '/api/agent/heartbeat', {version: '1', os: process.platform, node: process.version, beat: ++beatSeq, at: Date.now(), ...(cli ? {cli} : {})});
    config.lastSeenAt = new Date().toISOString();
    if (Array.isArray(beat.agent?.permissions)) config.permissions = beat.agent.permissions;
    for (const task of beat.tasks || []) if (task && task.id && !inbox.has(task.id)) inbox.set(task.id, task);
  };

  // The heartbeat has to keep going while `execute()` blocks. A task can outlive
  // its 120s server lease easily (25 browser steps at up to 15s each), and a
  // device that only heartbeats between tasks looks disconnected: the server
  // then fails a browser.action whose click did land and reports a failure the
  // person reads as "The agent disconnected", while the honest result that comes
  // later is refused as already completed. This timer renews the running lease
  // from inside the block.
  const keepalive = setInterval(() => {
    if (!busy) return;
    heartbeat().catch(error => console.error(`agent: keepalive heartbeat failed (${error.message}).`));
  }, interval);
  keepalive.unref();

  /** Execute one delivered task and report it. The result carries the attempt
   * the task was claimed with so the server can tell this run's outcome from a
   * later attempt's if the lease lapsed meanwhile. */
  const runTask = async task => {
    console.log(`agent: running ${task.kind} ${task.id}`);
    try {
      const result = await execute(task, config);
      // A model run that found the CLI signed out or missing: look again soon, the owner is about to fix it.
      if (task.kind === 'model.run' && result?.ok === false && ['not-signed-in', 'cli-missing'].includes(result.code)) cliStatus.invalidate();
      // Reporting is separate from executing: a refused report (409, a superseded
      // attempt) is not a local failure and must not be re-reported as one.
      try {
        await call(config, `/api/agent/tasks/${task.id}/result`, {status: 'done', result, attempts: task.attempts});
        console.log(`agent: ${task.kind} ${task.id} done`);
      } catch (error) {
        console.error(`agent: ${task.kind} ${task.id} result was refused: ${error.message}`);
      }
    } catch (e) {
      console.error(`agent: ${task.kind} ${task.id} failed: ${e.message}`);
      await call(config, `/api/agent/tasks/${task.id}/result`, {status: 'failed', error: e.message, attempts: task.attempts}).catch(() => {});
    }
  };

  let failures = 0;
  try {
    while (!stopping) {
      let wait = interval;
      try {
        // A pending task needs no new poll; poll only when there is nothing to do.
        if (!inbox.size) await heartbeat();
        while (!stopping && inbox.size) {
          const [id, task] = inbox.entries().next().value;
          inbox.delete(id);
          busy = true;
          try { await runTask(task); } finally { busy = false; }
        }
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
  } finally { clearInterval(keepalive); await sharedBrowser?.close(); console.log('agent: stopped.'); }
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
