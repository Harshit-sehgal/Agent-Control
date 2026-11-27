import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createJarStore} from '../agent/account-jars.mjs';

/* The real server and the real agent process, with no browser on the device: what a computer does with its browser
 * accounts across a re-pair, a restart and a heartbeat. Cookie values and secrets are never asserted into a message. */

const root = path.resolve(import.meta.dirname, '..');
const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const O = '0a1b2c3d-0000-4000-8000-0000000000f0';
const SITE = 'crm.example.com';
const MARKER = 'MARKER-COOKIE-7f3';
const cookie = {name: 'sid', value: MARKER, domain: SITE, path: '/', httpOnly: true};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (probe, what) => { for (let i = 0; i < 200; i++) { const value = await probe(); if (value) return value; await sleep(100); } assert.fail(`timed out waiting for ${what}`); };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The agent as a child process: `pair` runs to its end, `run` is held until it is told to stop. */
function agentIn(dir, env) {
  const config = path.join(dir, 'agent.config.json');
  const full = {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config, AGENT_POLL_MS: '2000', ...env};
  delete full.AGENT_BROWSER;
  let log = '';
  const pair = (server, code) => new Promise(resolve => {
    const c = spawn(process.execPath, ['agent/agent.mjs', 'pair', '--server', server, '--code', code, '--permissions', 'browser.capture'], {cwd: root, env: full, stdio: ['ignore', 'pipe', 'pipe']});
    c.stdout.on('data', b => { log += b; }); c.stderr.on('data', b => { log += b; });
    c.on('exit', status => resolve({status, log}));
  });
  const run = () => {
    const c = spawn(process.execPath, ['agent/agent.mjs', 'run'], {cwd: root, env: full, stdio: ['ignore', 'pipe', 'pipe']});
    c.stdout.on('data', b => { log += b; }); c.stderr.on('data', b => { log += b; });
    return {stop: async () => { const exited = new Promise(r => c.once('exit', r)); c.kill('SIGTERM'); await exited; }, kill: () => c.kill('SIGKILL')};
  };
  return {config, pair, run, log: () => log};
}

async function serverIn(dir) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {cwd: root, env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')}, stdio: ['ignore', 'pipe', 'pipe']});
  const send = async (method, url, body, cookieHeader) => {
    const res = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookieHeader ? {Cookie: cookieHeader} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')};
  };
  await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'the server');
  const owner = (await send('POST', '/api/login', {password: 'test-password-1234'})).cookie.split(';')[0];
  return {base, send: (m, u, b) => send(m, u, b, owner), stop: async () => { child.kill('SIGINT'); await new Promise(r => child.once('exit', r)); }};
}

async function scratch(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-accounts-e2e-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

/** A control plane that answers every heartbeat with `answer(beatNumber)` and keeps what the device sent. */
async function stubPlane(t, answer) {
  const beats = [], results = {};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => { raw += b; });
    req.on('end', () => {
      const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agent/heartbeat') { beats.push({body, raw}); res.end(JSON.stringify(answer(beats.length))); return; }
      const m = /^\/api\/agent\/tasks\/([^/]+)\/result$/.exec(req.url);
      if (m) { results[m[1]] = body; res.end('{"ok":true}'); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  return {url: `http://127.0.0.1:${srv.address().port}`, beats, results};
}
const stubConfig = (dir, server, extra = {}) => {
  const file = path.join(dir, 'agent.config.json');
  fs.writeFileSync(file, JSON.stringify({server, agentId: 'stub-agent', secret: 'stub-secret-1', permissions: ['browser.capture'], workspaceId: 'default', pollIntervalMs: 2000, ...extra}), {mode: 0o600});
  return file;
};

test('a re-pair keeps every jar: the first heartbeat after it wipes nothing it should keep, and each still opens', {timeout: 90000}, async t => {
  const dir = await scratch(t);
  const server = await serverIn(dir);
  t.after(() => server.stop());
  const agent = agentIn(dir, {});
  const code = async () => (await server.send('POST', '/api/agents/pair', {label: 'Laptop', permissions: ['browser.capture']})).body.code;
  assert.equal((await agent.pair(server.base, await code())).status, 0);
  const first = readJson(agent.config);
  const made = await server.send('POST', '/api/browser-accounts', {name: 'CRM', site: SITE, deviceId: first.agentId});
  assert.equal(made.status, 201);
  const account = (await server.send('GET', '/api/browser-accounts')).body.accounts[0];
  const jarDir = path.join(dir, 'browser-accounts');
  const before = createJarStore({dir: jarDir, secret: first.secret});
  before.save(account.id, [cookie]);
  before.save(O, [cookie]);                         // an orphan: an account the server never had

  const second = await agent.pair(server.base, await code());
  assert.equal(second.status, 0);
  assert.match(second.log, /Kept 2 browser account\(s\); 0 need signing in again\./);
  const config2 = readJson(agent.config);
  assert.notEqual(config2.agentId, first.agentId);
  assert.equal('rekeyFrom' in config2, false, 'the old secret is not kept once the jars are re-keyed');
  assert.equal(createJarStore({dir: jarDir, secret: config2.secret}).load(account.id)?.[0].value, MARKER, 'the jar opens under the new secret');
  const moved = (await server.send('GET', '/api/browser-accounts')).body.accounts.find(a => a.id === account.id);
  assert.equal(moved.deviceId, config2.agentId, 'the server moved the account to the new computer id');
  const agents = (await server.send('GET', '/api/agents')).body.agents;
  assert.ok(!agents.find(a => a.id === first.agentId && a.status !== 'revoked'), 'the old row is revoked');

  const worker = agent.run();
  t.after(() => worker.kill());
  await until(() => readJson(agent.config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  const after = createJarStore({dir: jarDir, secret: config2.secret});
  assert.deepEqual(after.ids(), [account.id], 'the account\'s jar stays, the orphan the server omits is gone');
  assert.equal(after.load(account.id)?.[0].value, MARKER);
  assert.ok(!agent.log().includes(MARKER) && !agent.log().includes(config2.secret) && !agent.log().includes(first.secret), 'no cookie and no secret in the output');
});

test('a re-pair that stopped before the jars were re-keyed is finished at the next start', {timeout: 90000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: [], accounts: [{id: A, site: SITE}, {id: O, site: SITE}]}));
  // The new config was saved with both secrets; one jar was moved to the new secret, the other was not.
  const config = stubConfig(dir, plane.url, {secret: 'new-secret-2', rekeyFrom: 'old-secret-1'});
  createJarStore({dir: jarDir, secret: 'old-secret-1'}).save(A, [cookie]);
  createJarStore({dir: jarDir, secret: 'new-secret-2'}).save(O, [cookie]);
  const agent = agentIn(dir, {});
  const worker = agent.run();
  t.after(() => worker.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  const saved = readJson(config);
  assert.equal('rekeyFrom' in saved, false, 'the old secret is dropped once done');
  assert.equal(saved.secret, 'new-secret-2');
  const jars = createJarStore({dir: jarDir, secret: 'new-secret-2'});
  assert.deepEqual(jars.ids().sort(), [A, O]);
  assert.equal(jars.load(A)?.[0].value, MARKER);
  assert.equal(jars.load(O)?.[0].value, MARKER);
});

test('a device whose server sends no account list wipes nothing, and reports each jar as unknown without a cookie', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url);
  const jars = createJarStore({dir: jarDir, secret: 'stub-secret-1'});
  jars.save(A, [cookie]); jars.save(O, [cookie]);
  const worker = agentIn(dir, {}).run();
  t.after(() => worker.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  assert.deepEqual(jars.ids().sort(), [A, O], 'both jars remain');
  const beat = plane.beats[0];
  assert.deepEqual(beat.body.accounts.map(a => [a.id, a.state, a.storage]).sort(), [[A, 'unknown', 'cookies'], [O, 'unknown', 'cookies']]);
  assert.ok(!beat.raw.includes(MARKER), 'no cookie in the heartbeat');
  assert.ok(beat.body.features.includes('browser-accounts-v1'), 'the device says it keeps browser accounts');
});

test('a list the server sends wipes the jars it omits; a task for an account is refused with no browser, never read plainly', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const task = (id, payload) => ({id, kind: 'browser.capture', attempts: 0, payload: {url: `https://${SITE}/`, botId: 'scout', ...payload}});
  const plane = await stubPlane(t, n => ({ok: true, accounts: [{id: A, site: SITE}], tasks: n === 1 ? [
    task('t-held', {account: A, deviceId: 'stub-agent'}),
    task('t-other', {account: A, deviceId: 'another-computer'}),
    task('t-none', {account: A}),
  ] : []}));
  const config = stubConfig(dir, plane.url);
  const jars = createJarStore({dir: jarDir, secret: 'stub-secret-1'});
  jars.save(A, [cookie]); jars.save(O, [cookie]);
  const worker = agentIn(dir, {AGENT_BROWSER_ALLOWLIST: SITE}).run();
  t.after(() => worker.kill());
  await until(() => Object.keys(plane.results).length === 3, 'the three results');
  await worker.stop();
  assert.deepEqual(jars.ids(), [A], 'the orphan the list omits is wiped, the listed jar stays');
  assert.match(plane.results['t-held'].error, /real browser/, 'no browser: refused, not read by the plain fetch');
  assert.match(plane.results['t-other'].error, /another computer/);
  assert.match(plane.results['t-none'].error, /cannot use/);
  for (const result of Object.values(plane.results)) assert.equal(result.status, 'failed');
});

test('a first pairing wipes jars it cannot open, and keeps a new computer from inheriting them', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const server = await serverIn(dir);
  t.after(() => server.stop());
  const jarDir = path.join(dir, 'browser-accounts');
  createJarStore({dir: jarDir, secret: 'a-secret-nobody-holds-now'}).save(A, [cookie]);
  const agent = agentIn(dir, {});
  const code = (await server.send('POST', '/api/agents/pair', {label: 'Laptop', permissions: ['browser.capture']})).body.code;
  assert.equal((await agent.pair(server.base, code)).status, 0);
  assert.deepEqual(createJarStore({dir: jarDir, secret: readJson(agent.config).secret}).ids(), []);
});
