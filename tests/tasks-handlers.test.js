import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPayload, enqueueTask, retryTask, cancelTask, fail} from '../shared/tasks.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {taskHandlers} from '../src/handlers.js';

const stamp = () => new Date().toISOString();
const emptyState = () => ({tasks: [], events: [], groups: [{id: 'home', name: 'Home', bots: [{id: 'atlas', name: 'Atlas'}]}]});

test('a rejected scheduled task names the schedule kinds it accepts', () => {
  // "Choose a schedule kind" told a person what was wrong but not what to pick.
  assert.throws(() => buildPayload('bot-task', {groupId: 'home', message: 'Standup', kind: 'weekly'}),
    error => error.status === 400 && /once or interval/.test(error.message));
  assert.throws(() => buildPayload('bot-task', {groupId: 'home', message: 'Standup', kind: 'once'}),
    error => error.status === 400 && /future date/.test(error.message));
  const once = buildPayload('bot-task', {groupId: 'home', message: 'Standup', kind: 'once', nextAt: new Date(Date.now() + 60000).toISOString()});
  assert.equal(once.kind, 'once');
});

test('a cancelled task cannot be retried, and a retry keeps runAt and nextAt in step', () => {
  const state = emptyState();
  const future = new Date(Date.now() + 3600000).toISOString();
  const {task} = enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'home', message: 'Standup', kind: 'once', nextAt: future}});
  assert.equal(task.runAt, future, 'A one-off scheduled task fires when it was set to.');
  // Only a failed task is retryable: a cancelled one is a decision, not a fault.
  assert.throws(() => retryTask(state, task.id), error => error.status === 409 && /Only a failed task/.test(error.message));
  state.tasks[0].status = 'failed';
  state.tasks[0].lastError = 'Provider unavailable';
  const retried = retryTask(state, task.id);
  assert.equal(retried.status, 'queued');
  // The payload carries its own next fire, and a stale one made the retried run
  // report itself as due at the old time on the way in.
  assert.equal(retried.payload.nextAt, retried.runAt);
  assert.notEqual(retried.payload.nextAt, future);
  cancelTask(state, task.id);
  assert.throws(() => retryTask(state, task.id), error => error.status === 409 && /cancelled task cannot be retried/.test(error.message));
  assert.throws(() => retryTask(state, 'missing'), error => error.status === 404);
});

/** A store with the real schema, plus a way to lie about one query. */
async function agentStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-handlers-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  const add = (id, permissions, extra = {}) => store.run(
    `INSERT INTO agents (id,workspace_id,name,secret_hash,secret_enc,status,permissions,paired_by,paired_at,revoked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, 'default', id, 'hash', 'enc', 'paired', JSON.stringify(permissions), 'u1', stamp(), extra.revoked_at || null);
  add('agent-a', ['http.check']);
  add('agent-b', ['browser.capture']);
  return {dir, store, add};
}

function handlers(store) {
  return taskHandlers({
    ws: store, workspaceId: 'default', auth: {}, push: {announce() {}, deliver: async () => ({})},
    notify: () => {},
  });
}

test('agent-job fans out to every agent holding the permission, once per task', async () => {
  const {dir, store} = await agentStore();
  try {
    const map = handlers(store);
    const task = {id: 'task-1', createdBy: 'u1', payload: {action: 'http.check', params: {url: 'https://example.com'}, agentId: null}};
    const result = await map['agent-job'](task);
    assert.deepEqual(result.dispatchedTo, ['agent-a'], 'Only the agent that holds http.check is given the job.');
    assert.equal(result.refused, undefined, 'Nothing was refused, so no refusal list is reported.');
    assert.equal(store.all('SELECT * FROM agent_tasks').length, 1);
    // The queue may retry the task; the per-agent idempotency key means the
    // second pass adds no second job.
    await map['agent-job'](task);
    assert.equal(store.all('SELECT * FROM agent_tasks').length, 1, 'A retried task does not run twice.');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('one agent refusing a job does not drop it for the others', async () => {
  const {dir, store} = await agentStore();
  try {
    // A row that vanishes between the roster read and the dispatch still has to
    // leave the other agents' work intact.
    const ws = Object.create(store);
    ws.all = sql => (sql.includes('FROM agents')
      ? [...store.all(sql), {id: 'agent-gone', permissions: '["http.check"]'}]
      : store.all(sql));
    const map = handlers(ws);
    const result = await map['agent-job']({id: 'task-2', payload: {action: 'http.check', params: {}, agentId: null}});
    assert.deepEqual(result.dispatchedTo, ['agent-a']);
    assert.deepEqual(result.refused.map(r => r.agentId), ['agent-gone']);
    assert.match(result.refused[0].error, /not found/i);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('an unreadable permission list means no permissions, not a crash', async () => {
  const {dir, store} = await agentStore();
  try {
    store.run("UPDATE agents SET permissions='not json' WHERE id='agent-a'");
    await assert.rejects(handlers(store)['agent-job']({id: 'task-3', payload: {action: 'http.check'}}),
      error => /No paired local agent holds the permission/.test(error.message));
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a job aimed at a missing agent is a 404, not a job for whoever is left', async () => {
  const {dir, store} = await agentStore();
  try {
    await assert.rejects(handlers(store)['agent-job']({id: 'task-4', payload: {action: 'http.check', agentId: 'nobody'}}),
      error => error.status === 404 && /not paired/.test(error.message));
    assert.equal(store.all('SELECT * FROM agent_tasks').length, 0);
  } finally { await rm(dir, {recursive: true, force: true}); }
});


test('reminder and candidate-draft are no longer task kinds', () => {
  for (const kind of ['reminder', 'candidate-draft']) {
    assert.throws(() => enqueueTask(emptyState(), {kind, payload: {label: 'x', kind: 'interval', intervalMinutes: 5, candidateId: 'c1'}, title: 'x'}), /Unknown task kind/, kind);
  }
});
