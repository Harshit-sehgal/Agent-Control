import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-guard-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  return {dir, store};
}

test('a corrupt vault keyfile is never silently overwritten', async () => {
  // Make the file path the only key source for this test.
  const saved = process.env.MASTER_KEY;
  delete process.env.MASTER_KEY;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-guard-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const keyfile = path.join(dir, 'vault.key');
    await fs.writeFile(keyfile, 'CORRUPTED-NOT-A-KEY');
    assert.throws(() => loadMasterKey(dataFile), /refusing to overwrite|not a valid 32-byte/i);
    assert.equal(await fs.readFile(keyfile, 'utf8'), 'CORRUPTED-NOT-A-KEY', 'A corrupt keyfile must be left untouched, not rotated.');

    // A missing keyfile is generated once and then reused byte-for-byte.
    await fs.rm(keyfile);
    const first = loadMasterKey(dataFile);
    const second = loadMasterKey(dataFile);
    assert.equal(first.key.length, 32);
    assert.equal(first.key.toString('base64'), second.key.toString('base64'));
  } finally {
    if (saved === undefined) delete process.env.MASTER_KEY; else process.env.MASTER_KEY = saved;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('the task kind permission gates enqueueing even without an explicit permission arg', async () => {
  const {store, dir} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Locked', permissions: []});
    // Deliberately no `permission` field: the kind's own permission must still apply.
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {}}), /does not hold/);
    agent.setAgentPermissions(store, agentId, ['http.check']);
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://example.com'}});
    assert.ok(task?.id, 'The permitted agent can be given the task.');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

const root = path.resolve(import.meta.dirname, '..');
const listen = () => new Promise(resolve => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => resolve(server));
});

test('the device keeps heartbeating while a task blocks, so its lease cannot lapse', {timeout: 30000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-keepalive-'));
  const config = path.join(dir, 'agent.config.json');
  let delivered = false;
  let reportAt = 0;
  let reportDoneAt = 0;
  const beatsDuringReport = [];
  const front = await listen();
  const base = `http://127.0.0.1:${front.address().port}`;
  // A server that hands over one task and then holds the result report open, the
  // way a long browser task holds the device's serial loop open.
  front.on('request', (req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const json = body => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
      if (req.url === '/api/agent/heartbeat') {
        if (reportAt && !reportDoneAt) beatsDuringReport.push(Date.now() - reportAt);
        const tasks = delivered ? [] : [{id: 'task-1', kind: 'http.check', payload: {url: 'http://example.com/'}, attempts: 1}];
        delivered = true;
        json({ok: true, agent: {id: 'device-1', name: 'Device', permissions: []}, tasks});
        return;
      }
      if (req.url === '/api/agent/tasks/task-1/result') {
        reportAt = Date.now();
        await new Promise(resolve => setTimeout(resolve, 5000));
        reportDoneAt = Date.now();
        json({ok: true, status: 'failed'});
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await fs.writeFile(config, JSON.stringify({server: base, agentId: 'device-1', secret: 'secret', workspaceId: 'default', permissions: [], pollIntervalMs: 2000}));
  const child = spawn(process.execPath, ['agent/agent.mjs', 'run'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    // The report is held for 5s, so a device that only polls between tasks sends
    // nothing while it is blocked; only a heartbeat on its own timer can arrive
    // inside that window.
    const deadline = Date.now() + 15000;
    while (!beatsDuringReport.length && Date.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 100));
    assert.ok(reportAt, `the device never reported its task: ${output}`);
    assert.ok(beatsDuringReport.length >= 1,
      `a heartbeat must arrive while the report is still in flight; got none before it was answered: ${output}`);
  } finally {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    front.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('pairing asks for the admin scope and neither pairing nor polling follows a redirect', {timeout: 20000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cli-'));
  const config = path.join(dir, 'agent.config.json');
  const trapHits = [];
  const trap = await listen();
  trap.on('request', (req, res) => { trapHits.push(req.url); res.end('stolen'); });
  const seen = [];
  const front = await listen();
  const base = `http://127.0.0.1:${front.address().port}`;
  front.on('request', (req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({url: req.url, body});
      // The first pairing succeeds. Every later request redirects at a private host.
      if (req.url === '/api/agent/pair' && seen.length === 1) {
        res.writeHead(201, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({agentId: 'device-1', secret: 'secret', workspaceId: 'default', permissions: body.permissions, pollIntervalMs: 2000}));
        return;
      }
      res.writeHead(307, {Location: `http://127.0.0.1:${trap.address().port}/stolen`}).end();
    });
  });
  const runAgent = args => new Promise(resolve => {
    const child = spawn(process.execPath, ['agent/agent.mjs', ...args], {
      cwd: root,
      env: {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => resolve({code, output}));
  });
  let polling = null;
  try {
    const paired = await runAgent(['pair', '--server', base, '--code', 'ABCD234567']);
    assert.equal(paired.code, 0, paired.output);
    assert.deepEqual(seen[0].body.permissions, ['http.check', 'browser.capture', 'browser.action', 'model.run', 'mcp.call']);
    const redirected = await runAgent(['pair', '--server', base, '--code', 'ABCD234567', '--permissions', 'http.check']);
    assert.equal(redirected.code, 1, redirected.output);
    assert.match(redirected.output, /Refusing to follow a redirect \(307\)/);
    assert.deepEqual(seen[1].body.permissions, ['http.check']);
    polling = spawn(process.execPath, ['agent/agent.mjs', 'run'], {
      cwd: root,
      env: {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    polling.stderr.on('data', chunk => { output += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`poll did not refuse the redirect: ${output}`)), 8000);
      const wait = () => {
        if (output.includes('Refusing to follow a redirect')) { clearTimeout(timer); resolve(); return; }
        setTimeout(wait, 50);
      };
      wait();
    });
    assert.deepEqual(trapHits, [], 'A redirect target must not receive the pairing code or the poll.');
  } finally {
    if (polling) { polling.kill('SIGKILL'); await new Promise(resolve => polling.once('exit', resolve)); }
    front.close();
    trap.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

/** Spawn the CLI and collect everything it said, with a hard ceiling so a hang
 * fails as a hang rather than a timeout on the whole file. */
function runCli(args, env = {}, timeoutMs = 25000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['agent/agent.mjs', ...args], {
      cwd: root,
      env: {...process.env, AGENT_SKIP_DOTENV: '1', ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', code => { clearTimeout(timer); resolve({code, output, child}); });
  });
}

test('a pairing answer that is not a credential leaves the working pairing alone', {timeout: 30000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pair-'));
  const config = path.join(dir, 'agent.config.json');
  const working = JSON.stringify({server: 'https://control.example', agentId: 'device-old', secret: 'old-secret', permissions: ['http.check']}, null, 2);
  await fs.writeFile(config, working);
  const seen = [];
  const front = await listen();
  front.on('request', (req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      if (seen.length === 1) {
        // A 2xx that is not the control plane: a proxy error page, a captive portal.
        res.writeHead(200, {'Content-Type': 'text/html'}).end('<html>Sign in to WiFi</html>');
        return;
      }
      res.writeHead(201, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({agentId: 'device-new', secret: 'new-secret', workspaceId: 'default', permissions: JSON.parse(raw).permissions}));
    });
  });
  const base = `http://127.0.0.1:${front.address().port}`;
  try {
    const bad = await runCli(['pair', '--server', base, '--code', 'ABCD234567'], {AGENT_CONFIG: config});
    assert.equal(bad.code, 1, bad.output);
    assert.match(bad.output, /did not return an agent credential/);
    assert.equal(await fs.readFile(config, 'utf8'), working, 'a failed pairing must not overwrite working credentials');

    // An explicitly empty permission list asks for nothing; only an absent flag
    // asks for the full scope. Both used to read as "absent".
    const empty = await runCli(['pair', '--server', base, '--code', 'ABCD234567', '--permissions', ''], {AGENT_CONFIG: config});
    assert.equal(empty.code, 0, empty.output);
    assert.deepEqual(seen[1].permissions, []);
    assert.match(empty.output, /Granted permissions: \(none\)/);
    assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).agentId, 'device-new');
  } finally {
    front.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a poll interval that is not a number does not become a one-millisecond spin, and Ctrl+C still cleans up', {timeout: 30000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-interval-'));
  const config = path.join(dir, 'agent.config.json');
  // No `pollIntervalMs`, exactly what an older pairing wrote.
  await fs.writeFile(config, JSON.stringify({server: 'http://127.0.0.1:1', agentId: 'device-1', secret: 's', permissions: ['http.check']}));
  let beats = 0;
  const front = await listen();
  front.on('request', (req, res) => {
    req.resume();
    beats += 1;
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({agent: {permissions: ['http.check']}, tasks: []}));
  });
  const base = `http://127.0.0.1:${front.address().port}`;
  await fs.writeFile(config, JSON.stringify({server: base, agentId: 'device-1', secret: 's', permissions: ['http.check']}));
  const child = spawn(process.execPath, ['agent/agent.mjs', 'run'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config, AGENT_POLL_MS: '15s'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 10000;
    while (!/polling .* every 15s/.test(output) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.match(output, /every 15s/, `a non-numeric interval must fall back to the default, not to NaN: ${output}`);
    // Two seconds of a 15 s interval must not be a heartbeat storm.
    const before = beats;
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(beats - before <= 1, `polling must stay paced, saw ${beats - before} beats in 1.2s`);
    child.kill('SIGTERM');
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, `SIGTERM must stop the loop cleanly: ${output}`);
    assert.match(output, /agent: stopped\./, 'the cleanup path must run, not be skipped by a hard exit');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    front.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a device the server keeps refusing says so and stops instead of retrying forever', {timeout: 40000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-revoked-'));
  const config = path.join(dir, 'agent.config.json');
  const front = await listen();
  front.on('request', (req, res) => {
    req.resume();
    res.writeHead(403, {'Content-Type': 'application/json'}).end(JSON.stringify({error: 'This device was revoked.'}));
  });
  await fs.writeFile(config, JSON.stringify({server: `http://127.0.0.1:${front.address().port}`, agentId: 'device-1', secret: 's', permissions: [], pollIntervalMs: 2000}));
  try {
    const run = await runCli(['run'], {AGENT_CONFIG: config}, 30000);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /keeps refusing this device/);
    assert.match(run.output, /Re-pair/);
  } finally {
    front.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
