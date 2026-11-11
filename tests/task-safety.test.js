/** Three ways a task could spend money, or spin, without ever saying so.
 *
 * `shared/tasks.js` decides how long a queue waits and when a row retires. The
 * tests below pin the three paths that used to run forever:
 *
 *  1. `body.intervalMinutes` was read for *every* kind, unbounded. A stray
 *     field on a one-off group run made it recurring, and `1e15` made the next
 *     `runAt` an invalid date, which threw out of `completeTask` and left the
 *     row `running` for the sweep to re-claim: the paid work ran again, forever.
 *  2. A group parked on a checkpoint answers 409 on every attempt. That is a
 *     conflict, so it never exhausted the attempt count - the row retried every
 *     few minutes and recorded nothing, for as long as the group stayed busy.
 *  3. A one-off scheduled task must fire at exactly the time that was picked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {enqueueTask, claimTasks, failTask, RETRY_WINDOW_MS, RETRY_STARTED} from '../shared/tasks.js';

const fresh = () => ({tasks: [], events: [], groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'B', instructions: 'Act.'}]}]});
const at = (state, id) => state.tasks.find(task => task.id === id);

test('a stray interval on a one-off task is not a recurring spend, and a huge one is refused', () => {
  const state = fresh();
  const {task} = enqueueTask(state, {kind: 'group-run', payload: {groupId: 'g', message: 'Coordinate.'}, intervalMinutes: 30});

  assert.equal(task.intervalMinutes, null, 'only a validated interval schedule may repeat');
  assert.equal(task.payload.intervalMinutes, undefined, 'the stray field must not survive into the payload either');

  // A schedule that names an interval out of range is a client mistake, not a
  // task the queue has to live with.
  for (const intervalMinutes of [0, -5, 1e15, 1.5]) {
    assert.throws(
      () => enqueueTask(fresh(), {kind: 'bot-task', payload: {groupId: 'g', message: 'x', kind: 'interval', intervalMinutes}}),
      error => error.status === 400 && /1\u201310080/.test(error.message),
      `intervalMinutes ${intervalMinutes} must be refused`);
  }
});

test('a group that stays busy cannot block its own task in silence past the window', () => {
  const state = fresh();
  const start = Date.now();
  const {task} = enqueueTask(state, {kind: 'group-run', runAt: new Date(start).toISOString(), payload: {groupId: 'g', message: 'Coordinate.'}});
  let now = start;
  for (let i = 0; i < 200 && task.status !== 'failed'; i += 1) {
    // Wait until the row is due (the backoff ladder owns that), claim it, then
    // fail with the conflict a busy group answers with.
    now = Math.max(now, Date.parse(task.runAt));
    const claimed = claimTasks(state, {workerId: 'w', now});
    assert.equal(claimed.length, 1, `attempt ${i}: the task should have been claimable at its own runAt`);
    failTask(state, task.id, 'That group is already in the middle of another run.', now, {conflict: true});
    now += 5 * 60000;
  }

  assert.equal(task.status, 'failed', 'after the retry window a conflict has to say why instead of spinning');
  assert.match(String(task.lastError), /already in the middle/);
  assert.ok(Number.isFinite(Date.parse(task.runAt)), 'the row keeps a readable runAt');
  // The window, not the attempt count, is what retired it.
  assert.ok(now - start >= RETRY_WINDOW_MS, `retired after ${Math.round((now - start) / 60000)} minutes`);
});

test('a one-off scheduled task fires at exactly the time that was picked', () => {
  const state = fresh();
  const soon = new Date(Date.now() + 10 * 60000).toISOString();
  const {task} = enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'g', message: 'Once.', kind: 'once', nextAt: soon}});
  assert.equal(task.runAt, soon);
  assert.equal(task.intervalMinutes, null, 'a one-off never repeats');
});
