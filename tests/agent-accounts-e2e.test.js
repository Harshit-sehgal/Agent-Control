import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
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
    const exited = new Promise(r => c.once('exit', status => r(status)));
    return {stop: async () => { c.kill('SIGTERM'); await exited; }, kill: () => c.kill('SIGKILL'), exited};
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
async function stubPlane(t, answer, {holdPair = false, pairReply = null} = {}) {
  const beats = [], results = {}, hits = [];
  let releasePair = null;
  const pairHeld = new Promise(r => { releasePair = r; });
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => { raw += b; });
    req.on('end', () => {
      const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      res.setHeader('Content-Type', 'application/json');
      hits.push(req.url);
      if (req.url === '/api/agent/pair' && holdPair) { pairHeld.then(() => { res.statusCode = 500; res.end('{"error":"stub"}'); }); return; }
      if (req.url === '/api/agent/pair' && pairReply) { res.statusCode = 201; res.end(JSON.stringify(pairReply)); return; }
      if (req.url === '/api/agent/heartbeat') { beats.push({body, raw}); res.end(JSON.stringify(answer(beats.length))); return; }
      const m = /^\/api\/agent\/tasks\/([^/]+)\/result$/.exec(req.url);
      if (m) { results[m[1]] = body; res.end('{"ok":true}'); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  t.after(() => releasePair());
  return {url: `http://127.0.0.1:${srv.address().port}`, beats, results, hits, releasePair};
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
  const deviceOf = async () => (await server.send('GET', '/api/browser-accounts')).body.accounts.find(a => a.id === account.id).deviceId;
  const oldLive = async () => (await server.send('GET', '/api/agents')).body.agents.some(a => a.id === first.agentId && a.status !== 'revoked');
  assert.equal(await deviceOf(), first.agentId, 'nothing moves until the new computer beats');
  assert.equal(await oldLive(), true);

  const worker = agent.run();
  t.after(() => worker.kill());
  await until(() => readJson(agent.config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  assert.equal(await deviceOf(), config2.agentId, 'the first beat moved the account to the new computer id');
  assert.equal(await oldLive(), false, 'and revoked the old row');
  const after = createJarStore({dir: jarDir, secret: config2.secret});
  assert.deepEqual(after.ids(), [account.id], 'the account\'s jar stays, the orphan the server omits is gone');
  assert.equal(after.load(account.id)?.[0].value, MARKER);
  assert.ok(!agent.log().includes(MARKER) && !agent.log().includes(config2.secret) && !agent.log().includes(first.secret), 'no cookie and no secret in the output');
});

test('a re-pair whose reply is lost on the way keeps the old pairing and every jar, and the next re-pair keeps them too', {timeout: 90000}, async t => {
  const dir = await scratch(t);
  const server = await serverIn(dir);
  t.after(() => server.stop());
  // A proxy that hands the pair to the server, lets it answer, then drops the connection: the server has redeemed the
  // code, the computer never hears it.
  const proxy = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => { raw += b; });
    req.on('end', async () => {
      await fetch(server.base + req.url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: raw}).then(r => r.text()).catch(() => {});
      req.socket.destroy();
    });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => proxy.close(r)));
  const lossy = `http://127.0.0.1:${proxy.address().port}`;
  const agent = agentIn(dir, {});
  const code = async () => (await server.send('POST', '/api/agents/pair', {label: 'Laptop', permissions: ['browser.capture']})).body.code;
  assert.equal((await agent.pair(server.base, await code())).status, 0);
  const first = readJson(agent.config);
  assert.equal((await server.send('POST', '/api/browser-accounts', {name: 'CRM', site: SITE, deviceId: first.agentId})).status, 201);
  const account = (await server.send('GET', '/api/browser-accounts')).body.accounts[0];
  const jarDir = path.join(dir, 'browser-accounts');
  createJarStore({dir: jarDir, secret: first.secret}).save(account.id, [cookie]);
  // The same server behind the proxy: the saved pairing is for `server.base`, so point it at the proxy for this pair.
  fs.writeFileSync(agent.config, JSON.stringify({...first, server: lossy}), {mode: 0o600});
  const lost = await agent.pair(lossy, await code());
  assert.notEqual(lost.status, 0, 'the pair reports the failure');
  assert.equal(readJson(agent.config).agentId, first.agentId, 'the old pairing is kept');
  assert.equal(readJson(agent.config).secret, first.secret);
  assert.equal(createJarStore({dir: jarDir, secret: first.secret}).load(account.id)?.[0].value, MARKER, 'the jar still opens under the old secret');
  const agents = (await server.send('GET', '/api/agents')).body.agents;
  assert.ok(agents.some(a => a.id === first.agentId && a.status !== 'revoked'), 'the server did not retire the old computer');
  assert.equal((await server.send('GET', '/api/browser-accounts')).body.accounts[0].deviceId, first.agentId, 'nor move its account');

  fs.writeFileSync(agent.config, JSON.stringify(first), {mode: 0o600});
  const again = await agent.pair(server.base, await code());
  assert.equal(again.status, 0);
  assert.match(again.log, /Kept 1 browser account\(s\)/);
  const next = readJson(agent.config);
  const worker = agent.run();
  t.after(() => worker.kill());
  await until(() => readJson(agent.config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  assert.equal((await server.send('GET', '/api/browser-accounts')).body.accounts[0].deviceId, next.agentId);
  assert.deepEqual(createJarStore({dir: jarDir, secret: next.secret}).ids(), [account.id]);
  assert.equal(createJarStore({dir: jarDir, secret: next.secret}).load(account.id)?.[0].value, MARKER);
});

test('a re-pair the server did not take as the same computer removes the old sign-ins and says so', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}), {pairReply: {agentId: 'new-agent', secret: 'new-secret-9', workspaceId: 'default', permissions: ['browser.capture'], pollIntervalMs: 2000, replaced: false}});
  stubConfig(dir, plane.url);
  createJarStore({dir: jarDir, secret: 'stub-secret-1'}).save(A, [cookie]);
  const agent = agentIn(dir, {});
  const out = await agent.pair(plane.url, 'ABCD-1234');
  assert.equal(out.status, 0);
  assert.doesNotMatch(out.log, /Kept/);
  assert.match(out.log, /not take this as the same computer/);
  const saved = readJson(agent.config);
  assert.equal(saved.agentId, 'new-agent');
  assert.equal('rekeyFrom' in saved, false);
  assert.deepEqual(createJarStore({dir: jarDir, secret: 'new-secret-9'}).ids(), [], 'no jar is kept for accounts that are not coming');
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

/* Fix round 1: no path leaves a jar unreadable under every secret on disk. */

/** A folder where re-keying jar A cannot stage its copy: a directory sits where the temp file goes. */
const blockRekey = jarDir => fs.mkdirSync(path.join(jarDir, `${A}.jar.tmp`));

test('a re-key that fails at start leaves the jars under the old secret and switches browser accounts off for the run', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: [], accounts: [{id: A, site: SITE}]}));
  const config = stubConfig(dir, plane.url, {secret: 'new-secret-2', rekeyFrom: 'old-secret-1'});
  createJarStore({dir: jarDir, secret: 'old-secret-1'}).save(A, [cookie]);
  blockRekey(jarDir);
  const agent = agentIn(dir, {});
  const worker = agent.run();
  t.after(() => worker.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  assert.equal(readJson(config).rekeyFrom, 'old-secret-1', 'the old secret is kept for the next start');
  assert.equal(createJarStore({dir: jarDir, secret: 'old-secret-1'}).load(A)?.[0].value, MARKER, 'the jar still opens under the old secret');
  assert.match(agent.log(), /browser accounts are off for this run/);
  assert.deepEqual(plane.beats[0].body.accounts, [], 'no account is reported while they are off');
});

test('a pair does not go on while the earlier pairing\'s re-key cannot finish', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url, {secret: 'new-secret-2', rekeyFrom: 'old-secret-1'});
  createJarStore({dir: jarDir, secret: 'old-secret-1'}).save(A, [cookie]);
  blockRekey(jarDir);
  const before = fs.readFileSync(config, 'utf8');
  const out = await agentIn(dir, {}).pair(plane.url, 'ABCD-1234');
  assert.notEqual(out.status, 0);
  assert.ok(!plane.hits.includes('/api/agent/pair'), 'the server was not asked to pair');
  assert.equal(fs.readFileSync(config, 'utf8'), before, 'the config is as it was');
  assert.equal(createJarStore({dir: jarDir, secret: 'old-secret-1'}).load(A)?.[0].value, MARKER);
});

test('a pair is refused while the agent runs here; a lock left by a dead process does not block it', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url);
  const agent = agentIn(dir, {});
  const worker = agent.run();
  t.after(() => worker.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  const before = fs.readFileSync(config, 'utf8').replace(/"lastSeenAt".*\n/, '');
  const refused = await agent.pair(plane.url, 'ABCD-1234');
  assert.notEqual(refused.status, 0);
  assert.match(refused.log, /\.lock/, 'the refusal names the lock file, not a process id');
  assert.ok(!plane.hits.includes('/api/agent/pair'), 'the server was not asked to pair');
  assert.equal(readJson(config).agentId, 'stub-agent');
  await worker.stop();
  assert.equal(fs.existsSync(`${config}.lock`), false, 'the lock goes when the agent stops');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(`${config}.lock`, JSON.stringify({pid: dead, token: 'a'.repeat(32), at: Date.now()}));
  await agent.pair(plane.url, 'ABCD-1234');
  assert.ok(plane.hits.includes('/api/agent/pair'), 'a stale lock does not block a pair');
  assert.ok(before.length > 0);
});

test('the config is replaced, never rewritten in place, and stays private', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url);
  const alias = path.join(dir, 'alias.json');
  fs.linkSync(config, alias);                      // a second name for the same file: an in-place write would change both
  const worker = agentIn(dir, {}).run();
  t.after(() => worker.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  assert.equal('lastSeenAt' in readJson(alias), false, 'the old file was not written through');
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'no temp file left behind');
});

/* Fix round 2: one holder of the lock at a time, whichever of run and pair it is. */

test('a second run is refused while the first lives, and it leaves the first\'s lock alone', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url);
  const agent = agentIn(dir, {});
  const first = agent.run();
  t.after(() => first.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  const second = agent.run();
  t.after(() => second.kill());
  assert.notEqual(await second.exited, 0, 'the second run did not start');
  assert.match(agent.log(), /\.lock/);
  assert.ok(fs.existsSync(`${config}.lock`), 'the first run still holds its lock');
  const beats = plane.beats.length;
  await until(() => plane.beats.length > beats, 'the first run to carry on');
  await first.stop();
  assert.equal(fs.existsSync(`${config}.lock`), false);
});

test('a run is refused, and reads no config, while a pair holds the lock; a second pair is refused too', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}), {holdPair: true});
  const config = stubConfig(dir, plane.url);
  const before = fs.readFileSync(config, 'utf8');
  const agent = agentIn(dir, {});
  const pairing = agent.pair(plane.url, 'ABCD-1234');
  await until(() => plane.hits.includes('/api/agent/pair'), 'the pair request');
  const run = agent.run();
  t.after(() => run.kill());
  assert.notEqual(await run.exited, 0, 'the run did not start');
  assert.equal(plane.beats.length, 0, 'it never beat: it did not load a config');
  const again = await agentIn(dir, {}).pair(plane.url, 'EFGH-5678');
  assert.notEqual(again.status, 0);
  assert.match(again.log, /\.lock/);
  assert.equal(plane.hits.filter(h => h === '/api/agent/pair').length, 1, 'only one pair reached the server');
  plane.releasePair();
  assert.notEqual((await pairing).status, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), before, 'the config is as it was');
  assert.equal(fs.existsSync(`${config}.lock`), false, 'a pair releases the lock on every way out');
});

test('a config that cannot be read makes pair fail before the server is asked, with every jar untouched', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = path.join(dir, 'agent.config.json');
  fs.writeFileSync(config, '{"server": "x", "secret": ', {mode: 0o600});   // a typo, or a write that stopped halfway
  createJarStore({dir: jarDir, secret: 'some-secret'}).save(A, [cookie]);
  const out = await agentIn(dir, {}).pair(plane.url, 'ABCD-1234');
  assert.notEqual(out.status, 0);
  assert.deepEqual(plane.hits, [], 'the server was not asked');
  assert.equal(createJarStore({dir: jarDir, secret: 'some-secret'}).load(A)?.[0].value, MARKER, 'the jar is still there');
  assert.equal(fs.readFileSync(config, 'utf8'), '{"server": "x", "secret": ');
});

test('a config that is a symlink stays one, and its target is the file that is updated', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const real = path.join(dir, 'volume');
  fs.mkdirSync(real);
  const target = stubConfig(real, plane.url);
  const config = path.join(dir, 'agent.config.json');
  fs.symlinkSync(target, config);
  const worker = agentIn(dir, {}).run();
  t.after(() => worker.kill());
  await until(() => readJson(target)?.lastSeenAt, 'a heartbeat');
  await worker.stop();
  assert.ok(fs.lstatSync(config).isSymbolicLink(), 'the link is still a link');
  assert.equal(fs.realpathSync(config), fs.realpathSync(target));
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [], 'no temp file beside the link');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

/* Fix round 3. */

test('a run starts in a folder it cannot write a lock to, saying so once; a pair there is refused plainly', {timeout: 60000}, async t => {
  if (process.getuid?.() === 0) return t.skip('root writes anywhere');
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url);
  fs.chmodSync(dir, 0o500);
  const agent = agentIn(dir, {});
  const worker = agent.run();
  t.after(() => worker.kill());
  try {
    await until(() => plane.beats.length > 0, 'a heartbeat');
    await worker.stop();
    assert.equal((agent.log().match(/without a lock/g) || []).length, 1);
    const refused = await agentIn(dir, {}).pair(plane.url, 'ABCD-1234');
    assert.notEqual(refused.status, 0);
    assert.ok(!plane.hits.includes('/api/agent/pair'));
  } finally { fs.chmodSync(dir, 0o700); }
  assert.ok(fs.existsSync(config));
});

test('a config that is a dangling symlink makes pair stop before the server is asked, with jars untouched', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const jarDir = path.join(dir, 'browser-accounts');
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  fs.symlinkSync(path.join(dir, 'volume-not-mounted.json'), path.join(dir, 'agent.config.json'));
  createJarStore({dir: jarDir, secret: 'some-secret'}).save(A, [cookie]);
  const out = await agentIn(dir, {}).pair(plane.url, 'ABCD-1234');
  assert.notEqual(out.status, 0);
  assert.deepEqual(plane.hits, []);
  assert.equal(createJarStore({dir: jarDir, secret: 'some-secret'}).load(A)?.[0].value, MARKER);
  assert.ok(fs.lstatSync(path.join(dir, 'agent.config.json')).isSymbolicLink(), 'the link is as it was');
});

test('the lock a running agent holds is one whole file of its own, refreshed while it runs', {timeout: 60000}, async t => {
  const dir = await scratch(t);
  const plane = await stubPlane(t, () => ({ok: true, tasks: []}));
  const config = stubConfig(dir, plane.url);
  const worker = agentIn(dir, {}).run();
  t.after(() => worker.kill());
  await until(() => readJson(config)?.lastSeenAt, 'a heartbeat');
  const body = readJson(`${config}.lock`);
  assert.ok(Number.isInteger(body.pid) && body.pid > 0 && typeof body.token === 'string');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.lock')), ['agent.config.json.lock']);
  await worker.stop();
});
