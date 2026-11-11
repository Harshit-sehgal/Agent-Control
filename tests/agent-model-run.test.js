import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';

async function harness(permissions) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions});
  return {dir, store, agentId: device.agentId};
}
const payload = {engine: 'claude', model: 'sonnet', instructions: 'Be brief.', input: '{"message":"hi"}', timeoutMs: 60000};

test('model.run is a task kind and its own permission', async () => {
  assert.ok(agent.AGENT_ACTIONS.includes('model.run'));
  assert.equal(agent.permissionForKind('model.run'), 'model.run');
  const {store, dir, agentId} = await harness(['http.check']);
  try {
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload}), /does not hold the model.run permission/);
    agent.setAgentPermissions(store, agentId, ['model.run']);
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload});
    assert.equal(task.kind, 'model.run');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a model.run payload is validated and canonical: no extra fields, a safe model, bounded text', async () => {
  const {store, dir, agentId} = await harness(['model.run']);
  try {
    const bad = p => assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload: p}), /./);
    bad({...payload, engine: 'gemini'});
    bad({...payload, engine: undefined});
    bad({...payload, model: '--bare'});
    bad({...payload, input: ''});
    bad({...payload, input: 5});
    bad({...payload, instructions: {}});
    bad({...payload, input: 'x'.repeat(100001)});
    bad({...payload, timeoutMs: 'soon'});
    assert.equal(store.all("SELECT id FROM agent_tasks").length, 0, 'nothing was queued by a refused request');
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload: {...payload, sneaky: 'x', cmd: 'rm -rf /'}});
    assert.deepEqual(Object.keys(JSON.parse(task.payload)).sort(), ['engine', 'input', 'instructions', 'model', 'timeoutMs']);
    const lean = agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload: {engine: 'codex', input: 'hello'}}).task;
    assert.deepEqual(JSON.parse(lean.payload), {engine: 'codex', model: '', instructions: '', input: 'hello', timeoutMs: 180000});
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a model.run is never retried: a second try would spend the subscription twice', async () => {
  const {store, dir, agentId} = await harness(['model.run']);
  try {
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload});
    assert.equal(task.max_attempts, 1);
    agent.claimAgentTasks(store, agentId);
    assert.equal(agent.completeAgentTask(store, agentId, task.id, {status: 'failed', error: 'boom'}).status, 'failed');
    // A device that vanishes mid-run: the task fails, it is not re-queued.
    const {task: orphan} = agent.enqueueAgentTask(store, agentId, {kind: 'model.run', payload});
    agent.claimAgentTasks(store, agentId);
    store.run('UPDATE agent_tasks SET lease_until=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), orphan.id);
    store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 10 * 60000).toISOString(), agentId);
    assert.equal(agent.recoverAgentTasks(store), 1);
    const row = store.get('SELECT * FROM agent_tasks WHERE id=?', orphan.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /not retried/i);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
