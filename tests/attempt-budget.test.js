/** "Was that the last attempt?" must have one answer.
 *
 * `shared/tasks.js` decided it in `failTask`, and `src/notifications.js`
 * predicted it a second time to write a delivery row, with a subtle mismatch
 * once (the payload key) that left a spent channel `queued` forever. Both now
 * read `attemptSpent`. This test pins that the two agree on every input the
 * task rules can see, so a future change to one moves the other with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {enqueueTask, failTask, attemptSpent, RETRY_WINDOW_MS, RETRY_STARTED} from '../shared/tasks.js';

/** A non-recurring task mid-run, so `failTask`'s spent branch lands on `failed`
 * (no interval re-arm to confuse the comparison) and nothing else moves. */
function runningTask({attempts = 0, maxAttempts = 5, elapsedMs = 0} = {}) {
  const state = {tasks: [], events: [], groups: []};
  const {task} = enqueueTask(state, {kind: 'group-run', payload: {groupId: 'g', message: 'Coordinate.'}});
  task.status = 'running';
  task.attempts = attempts;
  task.maxAttempts = maxAttempts;
  task.payload = {...task.payload, [RETRY_STARTED]: Date.now() - elapsedMs};
  return {state, task};
}

test('the task transition and the shared rule agree on when an attempt is the last', () => {
  const cases = [];
  for (const attempts of [0, 1, 4, 5, 6]) {
    for (const elapsedMs of [0, RETRY_WINDOW_MS - 1, RETRY_WINDOW_MS, RETRY_WINDOW_MS + 1]) {
      for (const conflict of [false, true]) {
        for (const permanent of [false, true]) cases.push({attempts, elapsedMs, conflict, permanent});
      }
    }
  }
  for (const c of cases) {
    const {state, task} = runningTask(c);
    const now = Date.now();
    // `failTask` reads the anchor it may have just written; the shared rule is
    // asked about the same task object right after, so the two see one payload.
    const failed = failTask(state, task.id, 'provider said no', now, {conflict: c.conflict, permanent: c.permanent}).status === 'failed';
    const spent = attemptSpent({attempts: task.attempts, maxAttempts: task.maxAttempts, payload: task.payload, now, conflict: c.conflict, permanent: c.permanent});
    assert.equal(spent, failed, `attempts=${c.attempts} elapsed=${c.elapsedMs}ms conflict=${c.conflict} permanent=${c.permanent}`);
  }
});

test('an attempt count inside the window is never the last one', () => {
  // The count alone used to mark a channel failed hours before its last try.
  assert.equal(attemptSpent({attempts: 99, maxAttempts: 5, payload: {}, now: 0}), false, 'no anchor means the window just opened');
  assert.equal(attemptSpent({attempts: 99, maxAttempts: 5, payload: {}, now: Date.now()}), false);
});

test('past the window the count and a conflict both count as spent', () => {
  const long = Date.now() - RETRY_WINDOW_MS - 1000;
  assert.equal(attemptSpent({attempts: 5, maxAttempts: 5, payload: {[RETRY_STARTED]: long}}), true);
  assert.equal(attemptSpent({attempts: 0, maxAttempts: 5, payload: {[RETRY_STARTED]: long}}), false, 'not yet at the count');
  assert.equal(attemptSpent({attempts: 0, maxAttempts: 5, payload: {[RETRY_STARTED]: long}, conflict: true}), true, 'a conflict is held to the window, not the count');
  assert.equal(attemptSpent({attempts: 0, maxAttempts: 5, payload: {}, permanent: true}), true, 'a permanent miss ends on the first attempt');
});

test('a recurring task that spent its budget re-arms instead of failing, and the rule still says spent', () => {
  const state = {tasks: [], events: [], groups: []};
  state.groups = [{id: 'g', name: 'G', bots: []}];
  const {task} = enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'g', message: 'Hourly sweep', kind: 'interval', intervalMinutes: 60}});
  assert.equal(task.intervalMinutes, 60);
  task.status = 'running';
  task.attempts = task.maxAttempts;
  task.payload = {...task.payload, [RETRY_STARTED]: Date.now() - RETRY_WINDOW_MS - 1};
  const now = Date.now();
  assert.equal(attemptSpent({attempts: task.attempts, maxAttempts: task.maxAttempts, payload: task.payload, now}), true);
  const after = failTask(state, task.id, 'provider said no', now);
  assert.equal(after.status, 'queued', 'a recurring task missed a window; it did not retire');
  assert.equal(after.payload[RETRY_STARTED], undefined, 'and its next window starts clean');
});
