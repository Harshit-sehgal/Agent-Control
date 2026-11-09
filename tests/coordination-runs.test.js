import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import * as coordination from '../src/coordination.js';
import {
  assertGroup, planHandoffs, assertValidHandoff, createRun, createEnvelope, BUSY_STATUSES, MAX_HANDOFFS,
} from '../shared/coordination.js';
import {MAX_STEPS_LIMIT} from '../shared/bot-settings.js';
import {simulateGroup} from '../shared/group-simulator.js';

const until = async (check, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the background work.');
};
const quietly = async fn => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

/** A throwaway provider that answers each call with the next reply and keeps
 * the request bodies, so a test can read what a bot was actually told. */
async function provider(replies) {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      bodies.push(raw);
      const content = replies.length > 1 ? replies.shift() : replies[0];
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({choices: [{message: {content}}]}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.AI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
  process.env.AI_API_STYLE = 'chat';
  return {bodies, close: () => new Promise(resolve => server.close(resolve))};
}

function group(overrides = {}) {
  return {
    id: 'x-engage', name: 'Engage', kind: 'group', instructions: 'Coordinate the bots.',
    autopilot: false, coordination: 'tracked', maxSteps: MAX_HANDOFFS, messages: [],
    bots: [{id: 'scout', name: 'Scout', instructions: 'Read the room.', permissions: []}],
    ...overrides,
  };
}

const talk = bots => {
  const message = `Coordinate these bots ${bots.map(bot => `@${bot.id}`).join(' ')}`;
  return {message, bots};
};

// A workspace of its own per test, because a run writes its own row and the
// store is part of what is under test.
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-runs-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(() => rm(dir, {recursive: true, force: true}));
  // A store seeds its demo groups; each test starts from a blank workspace so
  // the run it inspects is the one it wrote.
  // A store seeds its demo groups; each test starts from a blank workspace so
  // the run it inspects is the one it wrote. A configured provider is what lets
  // a run queue at all; the fake one below answers the calls.
  process.env.AI_BASE_URL = process.env.AI_BASE_URL || 'http://127.0.0.1:9/v1';
  process.env.AI_API_KEY = process.env.AI_API_KEY || 'test-key';
  process.env.AI_MODEL = process.env.AI_MODEL || 'test-model';
  await store.update(state => {
    state.groups = [];
    state.groupRuns = [];
    state.groupMessages = {};
  });
  return store;
}

test('a run the workspace refuses to start is marked failed, not left queued', async t => {
  const store = await workspace(t);
  await store.update(state => { state.groups.push(group()); });
  // A workspace restored from a backup refuses every write with a 503.
  store.trackWork = () => Promise.reject(Object.assign(new Error('This workspace is being restored. Try again shortly.'), {status: 503}));
  const {runId} = await quietly(() => coordination.queueGroupRun(store, {groupId: 'x-engage', message: 'Coordinate these bots'}));
  assert.ok(runId);
  await until(() => store.read().groupRuns.find(run => run.id === runId)?.status === 'failed');
  const run = store.read().groupRuns.find(row => row.id === runId);
  assert.match(run.error, /restored/);
  assert.ok(!BUSY_STATUSES.includes(run.status), 'A run that never ran must not block the group.');
});

test('one task, one run: a re-armed task finds the run it already started', async t => {
  const store = await workspace(t);
  await store.update(state => { state.groups.push(group()); });
  // Freeze the run at the point where it has been created but not executed, so
  // the retry the scheduler would make can be replayed exactly.
  store.trackWork = () => Promise.reject(Object.assign(new Error('This workspace is being restored. Try again shortly.'), {status: 503}));
  const call = taskId => quietly(() => coordination.queueGroupRun(store, {groupId: 'x-engage', message: 'Coordinate these bots', chatKey: 'engage', taskId}));
  const first = await call('task-1');
  await until(() => store.read().groupRuns.find(run => run.id === first.runId)?.status === 'failed');
  const runs = store.read().groupRuns.length;
  const notes = (store.read().groupMessages.engage || []).length;

  // A crash after the run was written re-arms the task, and the scheduler asks
  // for the same `taskId` again. That must not start a second paid run or post
  // a second line in the thread.
  const again = await call('task-1');
  assert.equal(again.runId, first.runId);
  assert.equal(again.deduped, true);
  assert.equal(store.read().groupRuns.length, runs, 'no second run row');
  assert.equal((store.read().groupMessages.engage || []).length, notes, 'no second chat line');

  // A different task is a different intent and still gets its own run.
  const other = await call('task-2');
  assert.notEqual(other.runId, first.runId);
});

test('a structured result reaches the next bot as the value the contract approved', async t => {
  const store = await workspace(t);
  // The model writes readable, indented JSON; the contract approves the object.
  const fake = await provider([
    '{\n  "summary": "Two posts need a reply"\n}',
    'Working from that list.',
  ]);
  t.after(() => fake.close());
  const bots = [
    {id: 'scout', name: 'Scout', instructions: 'Read the room.', permissions: [],
      contract: {version: 1, inputs: ['objective'], output: {kind: 'structured', fields: [{name: 'summary', type: 'text', required: true}]}}},
    {id: 'writer', name: 'Writer', instructions: 'Draft replies.', permissions: []},
  ];
  await store.update(state => { state.groups.push(group({bots, maxSteps: 2})); });
  const {runId} = await quietly(() => coordination.queueGroupRun(store, {groupId: 'x-engage', message: talk(bots).message}));
  await until(() => ['completed', 'failed'].includes(store.read().groupRuns.find(run => run.id === runId)?.status));
  const run = store.read().groupRuns.find(row => row.id === runId);
  assert.equal(run.status, 'completed', run.error || '');
  assert.deepEqual(JSON.parse(run.trace[0].output), {summary: 'Two posts need a reply'});
  assert.ok(!/```/.test(run.trace[0].output), 'The approved value, not the fenced reply.');
  // The next bot is handed the same value: the raw indented JSON, with its
  // fences, is not what a bot downstream sees.
  assert.equal(fake.bodies.length, 2);
  const second = JSON.parse(JSON.parse(fake.bodies[1]).messages[1].content);
  assert.equal(second.previous.output, '{"summary":"Two posts need a reply"}', 'The next bot reads the approved object.');
  assert.equal(second.thread.at(-1).text, second.previous.output, 'And the thread it reads says the same thing.');
});

test('the envelope tells a bot the same step ceiling the loop enforces', () => {
  const bot = group().bots[0];
  const run = createRun({group: group(), message: 'Handle this post', makeId: () => 'run-1'});
  delete run.maxSteps;
  assert.equal(createEnvelope({run, bot}).maxSteps, MAX_HANDOFFS, 'One bot is not one step: a hand-off is still possible.');
  run.maxSteps = 3;
  assert.equal(createEnvelope({run, bot}).maxSteps, 3);
  run.maxSteps = 99;
  assert.equal(createEnvelope({run, bot}).maxSteps, MAX_STEPS_LIMIT, 'The shared ceiling still applies.');
});

test('the group thread stays bounded when a run files one more message per step', async t => {
  const store = await workspace(t);
  const fake = await provider(['First answer.', 'Second answer.']);
  t.after(() => fake.close());
  const bots = [
    {id: 'scout', name: 'Scout', instructions: 'Read the room.', permissions: []},
    {id: 'writer', name: 'Writer', instructions: 'Draft replies.', permissions: []},
  ];
  await store.update(state => {
    state.groupMessages = {'x-engage': Array.from({length: 300}, (_, i) => ({id: `m${i}`, role: 'bot', text: `old ${i}`}))};
    state.groups.push(group({bots, maxSteps: 2}));
  });
  const {runId} = await quietly(() => coordination.queueGroupRun(store, {groupId: 'x-engage', message: talk(bots).message}));
  await until(() => ['completed', 'failed'].includes(store.read().groupRuns.find(run => run.id === runId)?.status));
  const chat = store.read().groupMessages['x-engage'];
  assert.ok(chat.length <= 300, `The thread grew to ${chat.length} entries.`);
  assert.equal(chat.at(-1).text, 'Second answer.', 'The newest message is kept, the oldest are the ones dropped.');
});

test('a run that is not paused at a checkpoint cannot be resumed', async () => {
  const state = {candidates: [], drafts: [], settings: {topics: []}};
  const api = async () => ({});
  const run = {id: 'run-1', status: 'completed', trace: [], recipients: ['scout'], input: 'Coordinate these bots'};
  // A stale tab or a second click on Continue hands back a finished record. It
  // must not be pushed back to running and repeat the steps it already ran.
  for (const status of ['completed', 'failed', 'running', 'cancelled']) {
    await assert.rejects(
      simulateGroup({group: group(), message: 'Coordinate these bots', state, api, makeId: () => 'm', emit: () => {}, resume: {...run, status}}),
      error => error.status === 409 && /paused at a checkpoint/.test(error.message),
    );
  }
  // A run that is paused does resume, and comes back finished.
  const paused = {...run, status: 'awaiting_checkpoint', checkpoint: {nextStep: 0}};
  const done = await simulateGroup({group: group(), message: 'Coordinate these bots', state, api, makeId: () => 'm', emit: () => {}, resume: paused});
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.trace.length, 1);
  // The resumed run works on its own copy. It used to push into the record it was
  // handed, so `shared/local-runs.js` stored the caller's stale checkpoint state
  // next to a trace that had already grown.
  assert.equal(paused.trace.length, 0, 'the caller\'s record is not written through');
  assert.equal(paused.status, 'awaiting_checkpoint');
});

test('the coordination refusals a person can cause answer 400 or 404, not 500', () => {
  assert.throws(() => assertGroup(null), error => error.status === 404);
  assert.throws(() => assertGroup({bots: []}), error => error.status === 400 && /Add a bot/.test(error.message));
  assert.throws(() => assertGroup({bots: [{id: 'a'}, {id: 'a'}]}), error => error.status === 400 && /unique/.test(error.message));
  assert.throws(() => assertGroup({bots: Array.from({length: 101}, (_, i) => ({id: `b${i}`}))}), error => error.status === 400);
  assert.throws(() => planHandoffs({...group(), bots: []}, 'Handle this post'), error => error.status === 400);
  assert.throws(() => planHandoffs(group(), 'x'.repeat(4001)), error => error.status === 400 && /1–4000/.test(error.message));
  assert.throws(() => assertValidHandoff(group(), 'scout', 'scout'), error => error.status === 400 && /itself/.test(error.message));
  // A bot in another group is addressed by id from here: that is a bad request,
  // not a server fault.
  assert.throws(() => assertValidHandoff(group(), 'scout', 'writer'), error => error.status === 400 && /Cross-group/.test(error.message));
});

test('a person can stop a run that is working, and the stop is what the thread says', async t => {
  const store = await workspace(t);
  await store.update(state => { state.groups.push(group()); });
  await store.update(state => {
    state.groupRuns.push({id: 'run-stop', groupId: 'x-engage', chatKey: 'team-x-engage', mode: 'pipeline', status: 'running', input: 'Coordinate these bots', recipients: ['scout'], trace: [], createdAt: new Date().toISOString(), startedAt: new Date().toISOString()});
  });
  const stopped = await coordination.cancelRun(store, 'run-stop', {actor: 'owner@example.test'});
  assert.deepEqual(stopped, {runId: 'run-stop', status: 'cancelled'});
  const after = store.read();
  const run = after.groupRuns.find(row => row.id === 'run-stop');
  assert.equal(run.status, 'cancelled');
  assert.ok(run.completedAt, 'a stopped run is finished, not left without a time');
  assert.equal(run.checkpoint, null);
  // The thread has to say it stopped: a run that just goes quiet reads as a
  // crash, and the person who pressed Stop cannot tell the difference.
  const lines = (after.chats['team-x-engage'] || []).filter(m => m.runId === 'run-stop');
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /discarded/);
  // A second press is not a second outcome.
  await assert.rejects(() => coordination.cancelRun(store, 'run-stop'), /cannot be stopped/);
  await assert.rejects(() => coordination.cancelRun(store, 'nope'), /Run not found/);
});

test('stopping a run also calls back the page it already sent', async t => {
  // `awaiting_browser` is stoppable, and the page for it may already be on a
  // device. Flipping the run alone left the approval card live and the device
  // lease held, so a page opened after Stop came back to a run nobody was
  // waiting for and approving the card queued work for it.
  const store = await workspace(t);
  const now = new Date().toISOString();
  await store.update(state => {
    state.groupRuns.push({id: 'run-page', groupId: 'x-engage', chatKey: 'team-x-engage', mode: 'pipeline', status: 'awaiting_browser', input: 'x', recipients: ['scout'], trace: [], createdAt: now});
    state.browserRequests = [
      {id: 'req-live', runId: 'run-page', botId: 'scout', botName: 'Scout', chatKey: 'team-x-engage', status: 'dispatched', agentTaskIds: ['task-a'], url: 'https://example.com/', kind: 'browser.capture', updatedAt: now},
      {id: 'req-other', runId: 'run-two', botId: 'scout', botName: 'Scout', chatKey: 'team-x-engage', status: 'dispatched', agentTaskIds: ['task-b'], url: 'https://example.com/', kind: 'browser.capture', updatedAt: now},
    ];
  });
  await coordination.cancelRun(store, 'run-page');
  const after = store.read();
  const live = after.browserRequests.find(r => r.id === 'req-live');
  assert.equal(live.status, 'denied', 'a page nobody is waiting for must not stay approvable');
  assert.ok(live.updatedAt);
  assert.equal(after.browserRequests.find(r => r.id === 'req-other').status, 'dispatched', 'another run keeps its page');
});

test('stopping a run between steps takes effect at the next boundary, not mid-call', async t => {
  // The loop refuses to write a step of a run that is no longer `running`, which
  // is what makes a cancel safe while a model call is in flight: the reply is
  // discarded rather than appended to a run somebody stopped.
  const store = await workspace(t);
  await store.update(state => { state.groupRuns.push({id: 'run-late', groupId: 'x-engage', chatKey: 'team-x-engage', mode: 'pipeline', status: 'awaiting_checkpoint', input: 'x', recipients: ['scout'], trace: [], createdAt: new Date().toISOString(), checkpoint: {nextStep: 0}}); });
  await coordination.cancelRun(store, 'run-late');
  const run = store.read().groupRuns.find(row => row.id === 'run-late');
  // A pending checkpoint no longer exists to be approved, so the continue route
  // has nothing to resume.
  assert.equal(run.checkpoint, null);
  await assert.rejects(() => coordination.resumeGroupRun(store, 'run-late'), /not waiting for a checkpoint/);
});
