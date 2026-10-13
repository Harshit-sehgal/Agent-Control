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
 * "browser.capture" reads a page on a host the operator explicitly allowlists
 * (AGENT_BROWSER_ALLOWLIST). By default that is a plain HTTP read. With
 * AGENT_BROWSER=1 the page is opened in the Chrome, Chromium or Edge installed
 * on this device (see agent/browser.mjs), which also reads pages that need
 * JavaScript. Either way it only reads: nothing is clicked, typed or posted,
 * and automating X is outside the product's rules regardless.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {assertPublicUrl} from './net-guard.mjs';
import {captureWithBrowser, ACTION_OPS, MAX_ACTIONS} from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'agent.config.json');
const POLL_MS = Number(process.env.AGENT_POLL_MS || 15000);
const TIMEOUT_MS = 15000;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch { fail('No agent config found. Run `node agent/agent.mjs pair --server <url> --code <code>` first.'); }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), {mode: 0o600});
}
function fail(message) { console.error(`agent: ${message}`); process.exit(1); }

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function sign(secret, {method, requestPath, timestamp, body}) {
  const payload = [String(method).toUpperCase(), String(requestPath), String(timestamp), sha256(body)].join('\n');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Outbound-only signed request. Returns parsed JSON or throws with the
 * server's message; never retries silently on 4xx. */
async function call(config, requestPath, body = null) {
  const url = new URL(config.server.replace(/\/+$/, '') + requestPath);
  const raw = body === null ? '' : JSON.stringify(body);
  const timestamp = Date.now();
  const headers = {'Content-Type': 'application/json', 'X-Agent-Id': config.agentId, 'X-Agent-Ts': String(timestamp), 'X-Agent-Sig': sign(config.secret, {method: 'POST', requestPath, timestamp, body: raw})};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {method: 'POST', headers, body: body === null ? undefined : raw, signal: controller.signal});
    const text = await res.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(`server responded ${res.status}: ${value?.error || text.slice(0, 200) || 'unknown error'}`);
    return value;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`request to ${url.host} timed out after ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally { clearTimeout(timer); }
}

async function pair(argv) {
  const server = argValue(argv, '--server');
  const code = argValue(argv, '--code');
  if (!server || !code) fail('pair requires --server and --code.');
  const permissions = (argValue(argv, '--permissions') || '').split(',').map(s => s.trim()).filter(Boolean);
  const name = argValue(argv, '--name') || `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'device'}-agent`;
  const url = new URL(server.replace(/\/+$/, '') + '/api/agent/pair');
  const body = JSON.stringify({code, name, permissions});
  const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
  const value = await res.json().catch(() => null);
  if (!res.ok) fail(`pairing failed: ${value?.error || res.status}`);
  saveConfig({server: server.replace(/\/+$/, ''), agentId: value.agentId, secret: value.secret, workspaceId: value.workspaceId, permissions: value.permissions, pollIntervalMs: value.pollIntervalMs, name});
  console.log(`Paired as "${name}". Credentials saved to ${CONFIG} (mode 0600).`);
  console.log('Granted permissions:', value.permissions.join(', ') || '(none)');
  console.log('Start the loop with: node agent/agent.mjs run');
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

/** Local, permission-gated execution. Returns a JSON-serializable result. */
async function execute(task, config) {
  if (!config.permissions.includes(task.kind)) {
    throw new Error(`This agent lacks the "${task.kind}" permission. Grant it from the dashboard.`);
  }
  if (task.kind === 'http.check') {
    const target = String(task.payload?.url || '');
    if (!/^https?:\/\//.test(target)) throw new Error('http.check needs a valid http(s) url.');
    const started = Date.now();
    await assertPublicUrl(target);
    // Redirects are reported, not followed: following one could land on an
    // address the check above would have refused.
    const res = await fetch(target, {method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000)});
    const latencyMs = Date.now() - started;
    return {url: target, httpStatus: res.status, ok: res.ok, latencyMs, checkedAt: new Date().toISOString()};
  }
  if (task.kind === 'browser.capture') {
    const target = String(task.payload?.url || '');
    const allow = (process.env.AGENT_BROWSER_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const host = new URL(target).host.toLowerCase();
    if (!allow.includes(host)) {
      throw new Error(`Refusing to read ${host}: it is not in AGENT_BROWSER_ALLOWLIST. Only explicitly allowed pages are read.`);
    }
    if (process.env.AGENT_BROWSER === '1') return captureWithBrowser(target, {allow});
    const res = await fetch(target, {method: 'GET', signal: AbortSignal.timeout(15000)});
    const html = (await res.text()).slice(0, 200000);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || null;
    const excerpt = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    return {url: target, httpStatus: res.status, title, excerpt, capturedAt: new Date().toISOString()};
  }
  if (task.kind === 'browser.action') {
    const target = String(task.payload?.url || '');
    const allow = (process.env.AGENT_BROWSER_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const host = new URL(target).host.toLowerCase();
    if (!allow.includes(host)) throw new Error(`Refusing to act on ${host}: it is not in AGENT_BROWSER_ALLOWLIST. Only explicitly allowed pages are driven.`);
    const steps = Array.isArray(task.payload?.steps) ? task.payload.steps.slice(0, MAX_ACTIONS) : [];
    if (!steps.length) throw new Error('browser.action needs at least one step.');
    const bad = steps.find(step => !step || !ACTION_OPS.includes(step.op));
    if (bad) throw new Error(`Unsupported action "${String(bad?.op)}". Allowed: ${ACTION_OPS.join(', ')}.`);
    // Interaction needs the real browser; the fetch fallback cannot click or type.
    if (process.env.AGENT_BROWSER !== '1') throw new Error('browser.action needs a real browser: set AGENT_BROWSER=1 on this device.');
    return captureWithBrowser(target, {allow, steps});
  }
  throw new Error(`Unknown task kind "${task.kind}".`);
}

let stopping = false;
async function run() {
  const config = loadConfig();
  const interval = Math.max(2000, Number(config.pollIntervalMs || POLL_MS));
  console.log(`Agent ${config.agentId} polling ${config.server} every ${interval / 1000}s. Ctrl+C to stop.`);
  process.on('SIGINT', () => { stopping = true; console.log('\nagent: stopped.'); process.exit(0); });
  while (!stopping) {
    try {
      const beat = await call(config, '/api/agent/heartbeat', {version: '1', os: process.platform, node: process.version});
      config.lastSeenAt = new Date().toISOString();
      for (const task of beat.tasks || []) {
        console.log(`agent: running ${task.kind} ${task.id}`);
        try {
          const result = await execute(task, config);
          await call(config, `/api/agent/tasks/${task.id}/result`, {status: 'done', result});
          console.log(`agent: ${task.kind} ${task.id} done`);
        } catch (e) {
          console.error(`agent: ${task.kind} ${task.id} failed: ${e.message}`);
          await call(config, `/api/agent/tasks/${task.id}/result`, {status: 'failed', error: e.message}).catch(() => {});
        }
      }
      saveConfig({...config, lastSeenAt: config.lastSeenAt});
    } catch (e) {
      console.error(`agent: heartbeat failed (${e.message}). Retrying in ${interval / 1000}s.`);
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

function status() {
  const config = loadConfig();
  console.log(`server:      ${config.server}`);
  console.log(`agent id:    ${config.agentId}`);
  console.log(`permissions: ${config.permissions.join(', ') || '(none)'}`);
  console.log(`last seen:   ${config.lastSeenAt || 'never (no successful heartbeat)'}`);
}

const [command, ...argv] = process.argv.slice(2);
if (command === 'pair') await pair(argv);
else if (command === 'run') await run();
else if (command === 'status') status();
else {
  console.log('Agent Control local agent\n\n  node agent/agent.mjs pair --server <url> --code <pairing-code>\n  node agent/agent.mjs run\n  node agent/agent.mjs status');
}
