import test from 'node:test';
import assert from 'node:assert/strict';
import {runBotTask} from '../src/coordination.js';
import {enqueueTask} from '../shared/tasks.js';
import {briefingTaskBody, BRIEFING_MESSAGE} from '../shared/briefing.js';
import {company} from './run-fixture.js';

// When the briefing's timer fires, the run the primary bot gets carries the workspace's facts of that moment.

test('a briefing run is handed the facts; its chat line stays the short instruction', async t => {
  const {store, ids} = await company(t);
  let task = null;
  await store.update(s => {
    task = enqueueTask(s, briefingTaskBody(s, {at: '08:00'})).task;
    s.groupRuns.push({id: 'done-1', groupId: 'home', chatKey: ids.mail, input: 'Sort the receipts', status: 'completed', completedAt: new Date().toISOString(), recipients: [], trace: [], mode: 'direct', createdAt: new Date().toISOString()});
  });
  const sent = [];
  await runBotTask(store, task, {queue: async (_store, opts) => { sent.push(opts); return {}; }, available: () => true});
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.startsWith(BRIEFING_MESSAGE));
  assert.match(sent[0].message, /Done in the last 24 hours \(1\):\n- Mailroom: Sort the receipts/);
  assert.equal(sent[0].directBotId, 'atlas');
  const line = store.read().chats.atlas.at(-1).text;
  assert.equal(line, `Scheduled task: ${BRIEFING_MESSAGE}`);
});

test('an ordinary schedule is sent as it was written', async t => {
  const {store, ids} = await company(t);
  const sent = [];
  await runBotTask(store, {id: 'x', payload: {groupId: 'home', botId: ids.plan, message: 'Weekly check', label: 'Weekly'}}, {queue: async (_s, opts) => { sent.push(opts.message); return {}; }, available: () => true});
  assert.deepEqual(sent, ['Weekly check']);
});
