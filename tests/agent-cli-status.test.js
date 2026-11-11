import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {checkCli, cliStatusReporter, STATUS_VALUES} from '../agent/cli-status.mjs';
import * as agent from '../src/agent.js';
import * as ai from '../src/ai-providers.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {DatabaseSync} from 'node:sqlite';

/* Sign-in status comes only from the CLIs' own status commands
 * (`claude auth status`, `codex login status`; neither makes a model call).
 * Here those are fake executables on PATH. A token-looking string in their output
 * must never reach the result. */

const SECRET = 'sk-ant-oat01-THIS-MUST-NEVER-LEAVE';
const FAKE = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const engine = path.basename(process.argv[1]);
const mode = process.env.FAKE_MODE || 'in';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({engine, argv: process.argv.slice(2), cwd: process.cwd()}) + '\\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else if (engine === 'claude') {
  if (mode === 'in') { console.log(JSON.stringify({loggedIn: true, authMethod: 'claude.ai', token: '${SECRET}', email: 'owner@example.com'})); }
  else if (mode === 'out') { console.log(JSON.stringify({loggedIn: false})); process.exit(1); }
  else if (mode === 'garbage') { console.log('¯\\\\_(ツ)_/¯'); }
  else if (mode === 'text-out') { console.error('Not logged in. Run claude to sign in.'); process.exit(1); }
} else {
  if (mode === 'in') { console.log('Logged in using ChatGPT (${SECRET})'); }
  else if (mode === 'out') { console.error('Not logged in'); process.exit(1); }
  else if (mode === 'garbage') { console.log('42'); }
  else if (mode === 'text-out') { console.log('Not logged in'); process.exit(0); }
}
`;

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-status-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(dir, name), FAKE, {mode: 0o755});
  const log = path.join(dir, 'log.jsonl');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const env = (extra = {}) => ({PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}`, HOME: os.tmpdir(), FAKE_LOG: log, ...extra});
  return {dir, calls, env};
}

test('claude and codex are asked with their own documented status commands, and nothing else', async t => {
  const {calls, env} = rig(t);
  assert.equal(await checkCli('claude', {env: env()}), 'signed-in');
  assert.equal(await checkCli('codex', {env: env()}), 'signed-in');
  const [c, x] = calls();
  assert.deepEqual([c.engine, c.argv], ['claude', ['auth', 'status', '--json']]);
  assert.deepEqual([x.engine, x.argv], ['codex', ['login', 'status']]);
  assert.notEqual(c.cwd, process.cwd(), 'run from a neutral directory');
});

test('signed in, signed out, missing and unknown are told apart, and a secret in the output is never kept', async t => {
  const {env} = rig(t);
  for (const engine of ['claude', 'codex']) {
    assert.equal(await checkCli(engine, {env: env({FAKE_MODE: 'in'})}), 'signed-in', `${engine} in`);
    assert.equal(await checkCli(engine, {env: env({FAKE_MODE: 'out'})}), 'signed-out', `${engine} out`);
    assert.equal(await checkCli(engine, {env: env({FAKE_MODE: 'text-out'})}), 'signed-out', `${engine} text-out`);
    assert.equal(await checkCli(engine, {env: env({FAKE_MODE: 'garbage'})}), 'unknown', `${engine} garbage`);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cli-'));
    t.after(() => fs.rmSync(empty, {recursive: true, force: true}));
    assert.equal(await checkCli(engine, {env: {PATH: empty, HOME: os.tmpdir()}}), 'missing', `${engine} missing`);
  }
  for (const value of ['in', 'out', 'garbage']) for (const engine of ['claude', 'codex']) {
    const got = await checkCli(engine, {env: env({FAKE_MODE: value})});
    assert.ok(STATUS_VALUES.includes(got));
    assert.equal(JSON.stringify(got).includes(SECRET), false);
  }
});

test('a status command that hangs is stopped and reads as unknown', async t => {
  const {env} = rig(t);
  const started = Date.now();
  assert.equal(await checkCli('claude', {env: env({FAKE_MODE: 'hang'}), timeoutMs: 300}), 'unknown');
  assert.ok(Date.now() - started < 4000);
});

test('the reporter answers at once, checks in the background, caches for ten minutes and then checks again', async t => {
  const {env, calls} = rig(t);
  let clock = 1_000_000;
  const reporter = cliStatusReporter({env: env(), now: () => clock});
  assert.deepEqual(reporter.snapshot(), {claude: 'unknown', codex: 'unknown'}, 'nothing is known before the first check, and asking does not block');
  await reporter.refreshed();
  assert.deepEqual(reporter.snapshot(), {claude: 'signed-in', codex: 'signed-in'});
  assert.equal(calls().length, 2);
  clock += 9 * 60000;
  reporter.snapshot();
  await reporter.refreshed();
  assert.equal(calls().length, 2, 'still inside ten minutes: no new check');
  clock += 2 * 60000;
  reporter.snapshot();
  await reporter.refreshed();
  assert.equal(calls().length, 4, 'after ten minutes both are checked again');
});

test('one check at a time, however often the heartbeat asks', async t => {
  const {env, calls} = rig(t);
  const reporter = cliStatusReporter({env: env(), now: () => 5});
  for (let i = 0; i < 20; i++) reporter.snapshot();
  await reporter.refreshed();
  assert.equal(calls().length, 2);
});

test('invalidate re-checks at the next beat, so signing in shows up without waiting ten minutes', async t => {
  const {env, calls} = rig(t);
  let mode = 'out';
  const reporter = cliStatusReporter({env: () => env({FAKE_MODE: mode}), now: () => 1});
  reporter.snapshot(); await reporter.refreshed();
  assert.equal(reporter.snapshot().claude, 'signed-out');
  mode = 'in';
  reporter.invalidate();
  reporter.snapshot(); await reporter.refreshed();
  assert.equal(reporter.snapshot().claude, 'signed-in');
  assert.equal(calls().length, 4);
});

test('server: a heartbeat stores only the four known values, and the agent list shows them', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-cli-hb-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  try {
    store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
    agent.attachVault(store, path.join(dir, 'state.json'));
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['model.run']});
    assert.equal(agent.listAgents(store, 'default')[0].cli, null, 'a device that has not reported shows nothing');
    agent.recordAgentCli(store, agentId, {claude: 'signed-in', codex: 'signed-out', extra: 'x', token: SECRET});
    const [listed] = agent.listAgents(store, 'default');
    assert.deepEqual({claude: listed.cli.claude, codex: listed.cli.codex}, {claude: 'signed-in', codex: 'signed-out'});
    assert.deepEqual(Object.keys(listed.cli).sort(), ['checkedAt', 'claude', 'codex']);
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
    agent.recordAgentCli(store, agentId, {claude: 'logged-in-as-root', codex: 7});
    assert.deepEqual({claude: agent.listAgents(store, 'default')[0].cli.claude, codex: agent.listAgents(store, 'default')[0].cli.codex}, {claude: 'unknown', codex: 'unknown'}, 'a value outside the four is unknown');
    agent.recordAgentCli(store, agentId, 'not an object');
    agent.recordAgentCli(store, agentId, null);
    assert.equal(agent.listAgents(store, 'default')[0].cli.claude, 'unknown', 'a malformed report changes nothing');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('a subscription provider is tested by the sign-in status, never by a message', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-cli-test-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  try {
    store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
    agent.attachVault(store, path.join(dir, 'state.json'));
    const p = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'My Claude'});
    const none = await ai.testProvider(store, p.id);
    assert.deepEqual([none.ok, none.status], [false, 'no-agent']);
    assert.match(none.message, /Pair a local agent and run `claude`/);
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['model.run']});
    agent.touchAgent(store, agentId);
    const unknown = await ai.testProvider(store, p.id);
    assert.deepEqual([unknown.ok, unknown.status], [false, 'unknown']);
    agent.recordAgentCli(store, agentId, {claude: 'signed-out', codex: 'signed-in'});
    const out = await ai.testProvider(store, p.id);
    assert.deepEqual([out.ok, out.status], [false, 'signed-out']);
    assert.match(out.message, /Run `claude` and sign in on that machine/);
    agent.recordAgentCli(store, agentId, {claude: 'signed-in', codex: 'signed-in'});
    const good = await ai.testProvider(store, p.id);
    assert.deepEqual([good.ok, good.status, good.agent], [true, 'signed-in', 'Laptop']);
    assert.equal(store.all('SELECT id FROM agent_tasks').length, 0, 'no model task was queued: the plan was not touched');
    await ai.updateProvider(store, 'default', p.id, {engine: 'codex'});
    assert.equal((await ai.testProvider(store, p.id)).ok, true, 'each engine reads its own value');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('over HTTP: the heartbeat carries the status and GET /api/agents returns it', {timeout: 40000}, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-cli-http-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  const send = async (method, url, body, cookie) => {
    const res = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')};
  };
  try {
    for (let i = 0; i < 120; i++) { if (child.exitCode !== null) break; try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* Starting. */ } await new Promise(r => setTimeout(r, 100)); }
    const owner = (await send('POST', '/api/login', {password: 'test-password-1234'})).cookie.split(';')[0];
    const pairing = await send('POST', '/api/agents/pair', {label: 'Laptop', permissions: ['model.run']}, owner);
    const paired = await send('POST', '/api/agent/pair', {code: pairing.body.code, name: 'Laptop', permissions: ['model.run']});
    const {agentId, secret} = paired.body;
    const beat = async body => {
      const requestPath = '/api/agent/heartbeat', timestamp = Date.now(), raw = JSON.stringify(body);
      const signature = agent.signRequest(secret, {method: 'POST', path: requestPath, timestamp, body: raw});
      const res = await fetch(base + requestPath, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Agent-Id': agentId, 'X-Agent-Ts': String(timestamp), 'X-Agent-Sig': signature}, body: raw});
      return {status: res.status, body: await res.json().catch(() => null)};
    };
    assert.equal((await send('GET', '/api/agents', undefined, owner)).body.agents[0].cli, null);
    assert.equal((await beat({version: '1', beat: 1, cli: {claude: 'signed-in', codex: 'missing'}})).status, 200);
    const listed = (await send('GET', '/api/agents', undefined, owner)).body.agents[0];
    assert.equal(listed.cli.claude, 'signed-in');
    assert.equal(listed.cli.codex, 'missing');
    assert.ok(Date.parse(listed.cli.checkedAt) > Date.now() - 60000);
    // A beat with no report keeps the last one; a hostile one cannot break the beat.
    assert.equal((await beat({version: '1', beat: 2})).status, 200);
    assert.equal((await send('GET', '/api/agents', undefined, owner)).body.agents[0].cli.claude, 'signed-in');
    assert.equal((await beat({version: '1', beat: 3, cli: 'x'.repeat(10000)})).status, 200);
    assert.equal((await beat({version: '1', beat: 4, cli: {claude: {nested: true}, __proto__: {polluted: 1}}})).status, 200);
    assert.equal(({}).polluted, undefined);
  } finally {
    child.kill('SIGINT');
    await new Promise(r => child.once('exit', r));
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

test('end to end with the real agent process: the heartbeat reports sign-in and a model.run task returns its answer', {timeout: 60000}, async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-cli-e2e-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'auth' || a[0] === 'login') { console.log(JSON.stringify({loggedIn: true})); console.log('Logged in using ChatGPT'); process.exit(0); }
let s = ''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => {
  const said = s.split('\\n').pop();
  console.log(JSON.stringify({type: 'result', is_error: false, result: 'fake ${name} heard: ' + said}));
  console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'fake ${name} heard: ' + said}}));
});
`, {mode: 0o755});
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const root = path.resolve(import.meta.dirname, '..');
  const server = spawn(process.execPath, ['src/server.js'], {cwd: root, env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')}, stdio: ['ignore', 'pipe', 'pipe']});
  let worker = null;
  const send = async (method, url, body, cookie) => {
    const res = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie')};
  };
  const until = async (probe, what) => { for (let i = 0; i < 150; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };
  try {
    await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'the server');
    const owner = (await send('POST', '/api/login', {password: 'test-password-1234'})).cookie.split(';')[0];
    const {body: pairing} = await send('POST', '/api/agents/pair', {label: 'Laptop'}, owner);
    const config = path.join(dir, 'agent.config.json');
    const agentEnv = {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config, AGENT_POLL_MS: '2000', PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: 'must-not-be-passed'};
    const paired = await new Promise(resolve => { const c = spawn(process.execPath, ['agent/agent.mjs', 'pair', '--server', base, '--code', pairing.code], {cwd: root, env: agentEnv, stdio: 'ignore'}); c.on('exit', resolve); });
    assert.equal(paired, 0);
    // The server proposes a 30 s poll; the saved config can narrow it for a test.
    fs.writeFileSync(config, JSON.stringify({...JSON.parse(fs.readFileSync(config, 'utf8')), pollIntervalMs: 2000}));
    worker = spawn(process.execPath, ['agent/agent.mjs', 'run'], {cwd: root, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe']});
    // The first beat has nothing yet; a later one carries the real answer.
    const listed = await until(async () => { const a = (await send('GET', '/api/agents', undefined, owner)).body.agents[0]; return a?.cli?.claude === 'signed-in' && a.cli.codex === 'signed-in' ? a : null; }, 'a signed-in report');
    assert.ok(listed.permissions.includes('model.run'));
    // And a model.run goes through the whole path: server queue, agent, fake CLI, result.
    const queued = await send('POST', `/api/agents/${listed.id}/tasks`, {kind: 'model.run', payload: {engine: 'codex', instructions: 'Be brief.', input: 'hello from the server', timeoutMs: 20000}}, owner);
    assert.equal(queued.status, 201);
    const row = await until(() => {
      const db = new DatabaseSync(path.join(dir, 'state.db'), {readOnly: true});
      try { const r = db.prepare('SELECT status,result FROM agent_tasks WHERE id=?').get(queued.body.id); return r?.status === 'done' || r?.status === 'failed' ? r : null; } finally { db.close(); }
    }, 'the task result');
    assert.equal(row.status, 'done');
    const result = JSON.parse(row.result);
    assert.equal(result.ok, true);
    assert.match(result.text, /fake codex heard: hello from the server/);
  } finally {
    if (worker) { worker.kill('SIGKILL'); await new Promise(r => worker.once('exit', r)); }
    server.kill('SIGINT');
    await new Promise(r => server.once('exit', r));
    await fsp.rm(dir, {recursive: true, force: true});
  }
});
