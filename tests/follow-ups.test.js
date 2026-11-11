/** A message sent while a bot is still working is held and runs next, instead of "send this again later". */
import test from 'node:test';
import assert from 'node:assert/strict';
import {holdFollowUp, nextFollowUp, MAX_FOLLOW_UPS} from '../src/follow-ups.js';
import {queueGroupRun} from '../src/coordination.js';
import {company} from './run-fixture.js';

const stateWith = status => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas'}]}], groupRuns: [{id: 'r1', groupId: 'home', chatKey: 'atlas', status, createdAt: '2026-11-12T00:00:00Z'}]});

test('a message to a busy chat is held on the run that is working', () => {
  const s = stateWith('running');
  const held = holdFollowUp(s, {groupId: 'home', chatKey: 'atlas', message: 'also check Flipkart', directBotId: 'atlas'});
  assert.equal(held.runId, 'r1');
  assert.deepEqual(s.groupRuns[0].followUps.map(f => f.message), ['also check Flipkart']);
  assert.equal(holdFollowUp(stateWith('completed'), {groupId: 'home', chatKey: 'atlas', message: 'x'}), null, 'a free chat holds nothing');
});

test('a chat holds at most a few messages', () => {
  const s = stateWith('running');
  for (let i = 0; i < MAX_FOLLOW_UPS; i++) assert.ok(holdFollowUp(s, {groupId: 'home', chatKey: 'atlas', message: `m${i}`}));
  assert.throws(() => holdFollowUp(s, {groupId: 'home', chatKey: 'atlas', message: 'one too many'}), /waiting/);
});

test('once the run ends, the oldest held message is next, one at a time', () => {
  const s = stateWith('running');
  holdFollowUp(s, {groupId: 'home', chatKey: 'atlas', message: 'first'});
  holdFollowUp(s, {groupId: 'home', chatKey: 'atlas', message: 'second'});
  assert.equal(nextFollowUp(s), null, 'not while it works');
  s.groupRuns[0].status = 'completed';
  assert.equal(nextFollowUp(s).message, 'first');
  assert.deepEqual(s.groupRuns[0].followUps.map(f => f.message), ['second']);
  s.groupRuns.unshift({id: 'r2', groupId: 'home', chatKey: 'atlas', status: 'running'});
  assert.equal(nextFollowUp(s), null, 'the chat is busy again with the first one');
});

test('the chat route holds a message for a busy chat and says it is waiting', async t => {
  const {store} = await company(t);
  await store.update(s => { s.groupRuns.unshift({id: 'busy', groupId: 'home', chatKey: 'atlas', status: 'running', input: 'first', mode: 'direct', recipients: ['atlas'], trace: [], createdAt: new Date().toISOString()}); });
  const out = await queueGroupRun(store, {groupId: 'home', message: 'and one more thing', directBotId: 'atlas', chatKey: 'atlas', wait: true});
  assert.equal(out.status, 'waiting');
  assert.equal(store.read().groupRuns.find(r => r.id === 'busy').followUps[0].message, 'and one more thing');
  await assert.rejects(queueGroupRun(store, {groupId: 'home', message: 'timer', directBotId: 'atlas', chatKey: 'atlas'}), /already active/, 'a timer still retries on its own');
});
