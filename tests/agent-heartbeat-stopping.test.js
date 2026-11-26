import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createApp} from '../src/app.js';
import {browserLive} from '../src/browser-live.js';

/* A device that is stopping still heartbeats, so the tasks it is running keep their leases, but it must
 * not be handed anything new: `stopping: true` on the beat renews and records, and claims nothing. */

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-stopping-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  t.after(async () => { browserLive.close(); await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  await store.update(s => { wf.migrate(s); });
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['http.check']});
  const app = createApp({store, auth: {session: () => null}, workspaces: {get: () => store, holding: () => store}, push: {}, version: 't'});
  let lastTs = 0;
  const beat = async body => {
    const url = '/api/agent/heartbeat', text = JSON.stringify(body);
    const ts = Math.max(Date.now(), lastTs + 1);
    lastTs = ts;
    const headers = {host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'x-agent-id': device.agentId, 'x-agent-ts': String(ts), 'x-agent-sig': agent.signRequest(device.secret, {method: 'POST', path: url, timestamp: ts, body: text})};
    const req = Object.assign(Readable.from([Buffer.from(text)]), {method: 'POST', url, headers, socket: {remoteAddress: '127.0.0.1'}});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  const queue = key => agent.enqueueAgentTask(store, device.agentId, {kind: 'http.check', payload: {url: 'http://example.com/'}, idempotencyKey: key}).task;
  return {store, beat, queue, agentId: device.agentId};
}

test('a heartbeat that says the device is stopping claims nothing, and a normal one still does', async t => {
  const {store, beat, queue} = await harness(t);
  const waiting = queue('wait-1');
  const stopping = await beat({version: '1', stopping: true});
  assert.equal(stopping.status, 200);
  assert.deepEqual(stopping.body.tasks, [], 'a stopping device is handed no task');
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', waiting.id).status, 'queued', 'the task stays queued for another beat');
  const normal = await beat({version: '1'});
  assert.deepEqual(normal.body.tasks.map(x => x.id), [waiting.id], 'a device that is not stopping still gets it');
});

test('only stopping: true stops claiming; other values are ignored as an older app would be', async t => {
  const {beat, queue} = await harness(t);
  const waiting = queue('wait-2');
  const odd = await beat({version: '1', stopping: 'yes'});
  assert.deepEqual(odd.body.tasks.map(x => x.id), [waiting.id]);
});

test('a stopping heartbeat still renews the leases of the tasks the device is running and records the beat', async t => {
  const {store, beat, queue, agentId} = await harness(t);
  const running = queue('run-1');
  assert.equal((await beat({version: '1'})).body.tasks.length, 1);
  const soon = new Date(Date.now() + 5000).toISOString();
  store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', soon, running.id);
  store.run('UPDATE agents SET last_seen_at=NULL WHERE id=?', agentId);
  queue('wait-3');
  const stopping = await beat({version: '1', stopping: true});
  assert.deepEqual(stopping.body.tasks, []);
  const row = store.get('SELECT status, lease_until FROM agent_tasks WHERE id=?', running.id);
  assert.equal(row.status, 'running');
  assert.ok(Date.parse(row.lease_until) > Date.parse(soon) + 30000, 'the lease was pushed out');
  assert.ok(store.get('SELECT last_seen_at FROM agents WHERE id=?', agentId).last_seen_at, 'the beat was recorded');
});
