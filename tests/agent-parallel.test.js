import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

/* The device runs the tasks one heartbeat hands over side by side (agent/task-pool.mjs),
 * keeps its leases renewed while they run, and on Ctrl+C lets the running ones finish and
 * report while the queued ones are handed back instead of started. */

const root = path.resolve(import.meta.dirname, '..');
const listen = () => new Promise(resolve => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const until = async (ready, ms, step = 50) => {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, step));
};

// A stand-in control plane. `beats` says what each heartbeat hands over (by 1-based count);
// every result report is held `holdMs` before it is answered.
async function rig({beats, holdMs, concurrency}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-parallel-'));
  const config = path.join(dir, 'agent.config.json');
  const state = {arrived: {}, answered: {}, bodies: {}, heartbeats: [], held: 0, beatsWhileHeld: 0};
  const front = await listen();
  front.on('request', (req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const json = body => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
      if (req.url === '/api/agent/heartbeat') {
        state.heartbeats.push(Date.now());
        if (state.held > 0) state.beatsWhileHeld += 1;
        const tasks = (beats[state.heartbeats.length] || []).map(id => ({id, kind: 'http.check', payload: {url: 'http://example.com/'}, attempts: 1}));
        json({ok: true, agent: {id: 'device-1', name: 'Device', permissions: []}, tasks});
        return;
      }
      const match = /^\/api\/agent\/tasks\/([^/]+)\/result$/.exec(req.url);
      if (match) {
        const id = match[1];
        state.arrived[id] = Date.now();
        state.bodies[id] = JSON.parse(raw);
        state.held += 1;
        await new Promise(resolve => setTimeout(resolve, holdMs));
        state.held -= 1;
        state.answered[id] = Date.now();
        json({ok: true, status: 'failed'});
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await fs.writeFile(config, JSON.stringify({server: `http://127.0.0.1:${front.address().port}`, agentId: 'device-1', secret: 'secret', workspaceId: 'default', permissions: [], pollIntervalMs: 2000}));
  const env = {...process.env, AGENT_SKIP_DOTENV: '1', AGENT_CONFIG: config};
  delete env.AGENT_CONCURRENCY;
  if (concurrency) env.AGENT_CONCURRENCY = String(concurrency);
  const child = spawn(process.execPath, ['agent/agent.mjs', 'run'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  const out = {text: ''};
  child.stdout.on('data', chunk => { out.text += chunk; });
  child.stderr.on('data', chunk => { out.text += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const close = async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    front.close();
    await fs.rm(dir, {recursive: true, force: true});
  };
  return {state, out, child, exited, close};
}

test('two tasks from one heartbeat run side by side, and the keepalive beats while they do', {timeout: 30000}, async () => {
  const {state, out, close} = await rig({beats: {1: ['t1', 't2']}, holdMs: 3000});
  try {
    await until(() => state.arrived.t1 && state.arrived.t2, 15000);
    const arrived = state.arrived;
    assert.ok(arrived.t1 && arrived.t2, out.text);
    assert.ok(Math.abs(arrived.t2 - arrived.t1) < 2000, 't2 did not wait for t1\'s report to be answered');
    await until(() => state.beatsWhileHeld >= 1, 8000);
    assert.ok(state.beatsWhileHeld >= 1, 'a heartbeat renewed the leases while both were running');
  } finally { await close(); }
});

test('with AGENT_CONCURRENCY=1 the second task waits for the first one to finish', {timeout: 30000}, async () => {
  const {state, out, close} = await rig({beats: {1: ['t1', 't2']}, holdMs: 1500, concurrency: 1});
  try {
    await until(() => state.arrived.t1 && state.arrived.t2, 15000);
    assert.ok(state.arrived.t2, out.text);
    assert.ok(state.arrived.t2 >= state.answered.t1, 't2 started before t1 had finished');
  } finally { await close(); }
});

test('Ctrl+C lets a running task finish and report, hands queued tasks back unstarted, and keeps beating until then', {timeout: 40000}, async () => {
  // One slot: t1 runs (its report is held 6 s), t2 is queued behind it. The second heartbeat, which arrives
  // while the device is stopping, hands over t3.
  const {state, out, child, exited, close} = await rig({beats: {1: ['t1', 't2'], 2: ['t3']}, holdMs: 6000, concurrency: 1});
  try {
    await until(() => state.arrived.t1, 15000);
    assert.ok(state.arrived.t1, out.text);
    child.kill('SIGINT');
    await until(() => /stopping after the running tasks\./.test(out.text), 5000);
    assert.match(out.text, /stopping after the running tasks\./);
    // t2, which never started, is handed back at once; t1 is still being answered.
    await until(() => state.arrived.t2, 5000);
    assert.ok(state.arrived.t2, `a queued task must be reported, not held: ${out.text}`);
    assert.equal(state.bodies.t2.status, 'failed');
    assert.equal(state.bodies.t2.attempts, 1);
    assert.ok(!state.answered.t1, 'the running task is still reporting');
    // The keepalive goes on while t1 runs, and what that beat hands over is handed back too.
    await until(() => state.arrived.t3, 8000);
    assert.ok(state.heartbeats.length >= 2, 'a heartbeat renewed the lease while the device was stopping');
    assert.ok(state.arrived.t3, `a task claimed while stopping must be reported: ${out.text}`);
    assert.ok(!state.answered.t1, 't3 was handed back while t1 was still running');
    const code = await exited;
    assert.equal(code, 0, out.text);
    assert.ok(state.answered.t1, 'the running task finished its report before the device exited');
    assert.match(out.text, /agent: stopped\./);
    assert.ok(!/running http\.check t[23]/.test(out.text), `queued tasks never start: ${out.text}`);
  } finally { await close(); }
});
