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
    assert.deepEqual(seen[0].body.permissions, ['http.check', 'browser.capture', 'browser.action']);
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
