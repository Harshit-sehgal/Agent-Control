import test from 'node:test';
import assert from 'node:assert/strict';
import {pollRun, runWithTyping, RUN_TERMINAL, RUN_POLL_MS} from '../shared/run-follow.js';

// The loop in shared/run-follow.js has no DOM and no store: every dependency is
// injected, so a fake log replays a run's life exactly. These tests replace the
// regex-over-source checks that could not see a behaviour change at all.

/** A scripted run log: each `readLog` returns the next snapshot (an Error is a
 * failed read). Returns the harness plus what the loop did. */
function harness(snapshots, {runId = 'r1', groupId = 'g1', ignore = [], requests = () => [], messages = []} = {}) {
  const stored = [...messages], appended = [], waits = [];
  let cursor = 0, stalls = 0, syncs = 0;
  return {
    appended, waits,
    get stalls() { return stalls; },
    get syncs() { return syncs; },
    run: () => pollRun({
      runId, groupId, ignore, maxPolls: 50,
      wait: async ms => { waits.push(ms); },
      sync: async () => { syncs++; },
      readLog: async () => {
        const step = snapshots[Math.min(cursor, snapshots.length - 1)];
        cursor++;
        if (step instanceof Error) throw step;
        return step;
      },
      messages: () => stored,
      requests,
      onLine: m => { appended.push(m); stored.push(m); },
      onNote: note => { appended.push(note); stored.push(note); },
      onStall: () => { stalls++; },
    }),
  };
}

const bot = (id, runId, text = id) => ({id, role: 'bot', runId, text});

test('the loop appends only this run\'s new lines and stops on a terminal status', async () => {
  const h = harness([
    {messages: [{id: 'seen', role: 'bot', runId: 'r1'}, {id: 'u', role: 'user', runId: 'r1'}, {id: 'other', role: 'bot', runId: 'r2'}, bot('m1', 'r1', 'hello')],
      runs: [{id: 'r1', status: 'completed', trace: [1, 2]}]},
  ], {messages: [{id: 'seen', role: 'bot', runId: 'r1'}]});
  const last = await h.run();
  assert.deepEqual(h.appended.map(m => m.id), ['m1', 'r1-completed'], 'a seen line, a user line and another run are left alone');
  assert.equal(h.appended[1].text, 'Done in 2 step(s). Anything to post still needs your approval.');
  assert.equal(h.appended[1].role, 'system');
  assert.equal(last.status, 'completed');
  assert.deepEqual(h.waits, [RUN_POLL_MS], 'one look was enough');
});

test('a page that is only pending stops the loop on the person; a dispatched one is followed', async () => {
  const pending = harness([{runs: [{id: 'r1', status: 'awaiting_browser'}]}], {requests: () => [{runId: 'r1', status: 'pending', purpose: 'page'}]});
  await pending.run();
  assert.deepEqual(pending.appended.map(m => m.id), ['r1-awaiting_browser'], 'the loop hands the page back to the human');

  const followed = harness([
    {runs: [{id: 'r1', status: 'awaiting_browser'}]},
    {messages: [bot('m2', 'r1')], runs: [{id: 'r1', status: 'completed', trace: []}]},
  ], {requests: () => [{runId: 'r1', status: 'dispatched', purpose: 'page'}]});
  await followed.run();
  assert.deepEqual(followed.appended.map(m => m.id), ['m2', 'r1-completed'], 'a dispatched page keeps the watch alive');
});

test('a log that cannot be read says so once and keeps trying', async () => {
  const h = harness([new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), {runs: [{id: 'r1', status: 'completed', trace: []}]}]);
  const last = await h.run();
  assert.equal(h.stalls, 1, 'the "still trying" line is said once, at the fourth miss');
  assert.equal(last.status, 'completed');
  assert.equal(h.appended.length, 1, 'the closing note still lands after a rough start');
});

test('every terminal status ends the watch, and a busy one does not', () => {
  for (const status of ['completed', 'failed', 'interrupted', 'awaiting_checkpoint', 'awaiting_plan', 'awaiting_browser', 'cancelled'])
    assert.ok(RUN_TERMINAL.includes(status), `${status} ends a watch`);
  assert.ok(!RUN_TERMINAL.includes('running') && !RUN_TERMINAL.includes('queued'));
});

// ---- runWithTyping ----------------------------------------------------------------------

test('runWithTyping turns typing on, sends, follows, turns it off and refreshes once', async () => {
  const log = [];
  await runWithTyping({key: 'k', setTyping: (k, on) => log.push(`typing:${on}`), sync: async () => log.push('sync'), send: async () => log.push('send'), follow: async () => log.push('follow')});
  assert.deepEqual(log, ['typing:true', 'send', 'follow', 'typing:false', 'sync']);
});

test('a page decision with no send only follows, still under the typing indicator', async () => {
  const log = [];
  await runWithTyping({key: 'k', setTyping: (k, on) => log.push(`typing:${on}`), sync: async () => log.push('sync'), follow: async () => log.push('follow')});
  assert.deepEqual(log, ['typing:true', 'follow', 'typing:false', 'sync']);
});

test('a concurrent send is raced with the follow, not awaited first', async () => {
  const log = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const done = runWithTyping({key: 'k', setTyping: (k, on) => log.push(`typing:${on}`), sync: async () => log.push('sync'), concurrent: true,
    send: () => { log.push('send:start'); return gate.then(() => log.push('send:done')); },
    follow: async () => log.push('follow')});
  await Promise.resolve();
  assert.deepEqual(log, ['typing:true', 'send:start', 'follow'], 'the follow starts without waiting for the POST');
  release();
  await done;
  assert.deepEqual(log, ['typing:true', 'send:start', 'follow', 'send:done', 'typing:false', 'sync']);
});

test('typing is turned off even when the send throws', async () => {
  const log = [];
  await assert.rejects(runWithTyping({key: 'k', setTyping: (k, on) => log.push(`typing:${on}`), sync: async () => log.push('sync'), send: async () => { throw new Error('boom'); }, follow: async () => log.push('follow')}), /boom/);
  assert.deepEqual(log, ['typing:true', 'typing:false'], 'no follow and no refresh after a failed send');
});
