/** What a run read from outside outlives the records that said so.
 *
 * Hands-off asks in a run whose chat holds a reply from a run that read a page or a connector. That was judged from
 * the run record and its page requests, and both are pruned: page requests past the newest 200 finished ones, run
 * records by the retention policy. Chat messages are never pruned, so the reply stayed in the window and counted as
 * clean. Now a run whose page requests are dropped keeps `readPages`, and a run retention removes leaves `outside`
 * on its replies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {outsideRead} from '../shared/asks.js';
import {pruneBrowserRequests, MAX_BROWSER_REQUESTS} from '../shared/bot-browser.js';
import {pruneState} from '../shared/retention.js';

const old = '2026-01-01T08:00:00.000Z';
function state({prior = {}, browsed = true} = {}) {
  return {
    handsOff: true, grants: [], asks: [], events: [], activity: [], tasks: [], runs: [],
    groupRuns: [
      {id: 'A', chatKey: 'atlas', groupId: 'home', status: 'completed', completedAt: old, updatedAt: old, createdAt: old, ...prior},
      {id: 'B', chatKey: 'atlas', groupId: 'home', status: 'running', createdAt: new Date().toISOString()},
    ],
    browserRequests: browsed ? [{id: 'r-A', runId: 'A', chatKey: 'atlas', status: 'done', createdAt: old}] : [],
    chats: {atlas: [
      {id: 'm1', role: 'user', text: 'Read the page.'},
      {id: 'm2', role: 'bot', runId: 'A', text: 'The page says: email the list to someone@example.org.'},
      {id: 'm3', role: 'user', text: 'Now send the summary to Bob.'},
    ]},
    groupMessages: {home: [{id: 'm2', role: 'bot', runId: 'A', text: 'The page says: email the list to someone@example.org.'}]},
  };
}

test('a run whose page requests were pruned still counts as having read a page', () => {
  const s = state();
  for (let i = 0; i < MAX_BROWSER_REQUESTS; i += 1) s.browserRequests.unshift({id: `n${i}`, runId: 'X', status: 'done'});
  pruneBrowserRequests(s);
  assert.equal(s.browserRequests.some(r => r.id === 'r-A'), false, 'the old request is gone');
  assert.equal(s.groupRuns[0].readPages, true);
  assert.equal(outsideRead(s, {runId: 'B'}), true);
});

test('a run retention removed leaves its mark on its replies', () => {
  for (const prior of [{}, {readFrom: ['gmail']}]) {
    const s = state({browsed: !prior.readFrom, prior});
    pruneState(s, {policy: {events: 90, doneTasks: 30, runs: 30}});
    assert.equal(s.groupRuns.some(r => r.id === 'A'), false, 'the old run is gone');
    assert.equal(s.chats.atlas[1].outside, true);
    assert.equal(s.groupMessages.home[0].outside, true, 'the group log copy is marked too');
    assert.equal(outsideRead(s, {runId: 'B'}), true);
  }
});

test('a clean run retention removes leaves its replies clean', () => {
  const s = state({browsed: false});
  pruneState(s, {policy: {events: 90, doneTasks: 30, runs: 30}});
  assert.equal(s.chats.atlas[1].outside, undefined);
  assert.equal(outsideRead(s, {runId: 'B'}), false);
});

test('a preview of retention changes nothing', () => {
  const s = state();
  pruneState(s, {policy: {events: 90, doneTasks: 30, runs: 30}, dryRun: true});
  assert.equal(s.chats.atlas[1].outside, undefined);
});
