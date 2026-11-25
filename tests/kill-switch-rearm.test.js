/** The kill switch holds a schedule that was already running when it was switched on.
 *
 * "A run already in progress finishes; nothing new starts." A recurring schedule re-arms itself when its run
 * completes or fails, and a crashed worker's lease is re-armed by recovery. Each of those used to put the task
 * straight back to `queued`, so the next sweep ran it again while every schedule was meant to be held. They now
 * park it as paused by the switch, and the switch's Resume brings it back. A daily weekdays schedule that ran out
 * of retries is also re-armed on a weekday, as a completed one is. A schedule the owner resumes or retries by hand
 * while the switch is on waits for the switch as well.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueTask, claimTasks, completeTask, failTask, recoverStalledTasks,
  pauseAllSchedules, resumeAllSchedules, RETRY_STARTED, RETRY_WINDOW_MS,
  resumeTask as resumeTaskByHand, retryTask as retryTaskByHand,
} from '../shared/tasks.js';

const fresh = () => ({tasks: [], events: [], schedulesPaused: false,
  groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'B', instructions: 'Act.'}]}]});
const schedule = (state, extra = {}, body = {}) => enqueueTask(state, {
  kind: 'bot-task', payload: {groupId: 'g', botId: 'b', message: 'Check my feed', kind: 'interval', intervalMinutes: 60, ...extra}, ...body,
}).task;

/** A schedule mid-run when the owner switches everything off. */
function runningThenSwitchedOff(extra, body) {
  const state = fresh();
  const task = schedule(state, extra, body);
  const now = Date.now() + 1000;
  assert.equal(claimTasks(state, {workerId: 'w', now}).length, 1);
  pauseAllSchedules(state);
  assert.equal(task.status, 'running', 'the switch leaves a running task alone');
  return {state, task, now};
}

const held = task => {
  assert.equal(task.status, 'paused');
  assert.equal(task.payload.pausedBy, 'switch');
};

test('a schedule that finishes while the switch is on waits instead of re-arming', () => {
  const {state, task, now} = runningThenSwitchedOff();
  completeTask(state, task.id, null, now);
  held(task);
  assert.deepEqual(claimTasks(state, {workerId: 'w', now: now + 10 * 3600000}), []);
  resumeAllSchedules(state, now + 10 * 3600000);
  assert.equal(task.status, 'queued');
  assert.equal(claimTasks(state, {workerId: 'w', now: now + 10 * 3600000}).length, 1);
});

test('a schedule that fails while the switch is on does not retry until it is off', () => {
  const {state, task, now} = runningThenSwitchedOff();
  failTask(state, task.id, 'provider down', now);
  held(task);
  assert.equal(task.lastError, 'provider down', 'the error stays visible');
  assert.deepEqual(claimTasks(state, {workerId: 'w', now: now + 3600000}), []);
});

test('a schedule that misses its window while the switch is on is held too', () => {
  const {state, task, now} = runningThenSwitchedOff({}, {maxAttempts: 1});
  task.payload = {...task.payload, [RETRY_STARTED]: now - RETRY_WINDOW_MS - 1};
  failTask(state, task.id, 'still down', now);
  held(task);
});

test('a crashed run recovered while the switch is on is held', () => {
  const {state, task, now} = runningThenSwitchedOff();
  recoverStalledTasks(state, now + 2 * 3600000);
  held(task);
});

test('the queue never claims a queued schedule while the switch is on', () => {
  const state = fresh();
  const task = schedule(state);
  const other = enqueueTask(state, {kind: 'notification', payload: {title: 'Hi', body: 'There'}}).task;
  state.schedulesPaused = true; // a row written by an older build, still queued
  const claimed = claimTasks(state, {workerId: 'w', now: Date.now() + 1000});
  assert.deepEqual(claimed.map(t => t.id), [other.id], 'a notice still goes out');
  assert.equal(task.status, 'queued');
});

test('a weekdays schedule that ran out of retries on a Friday next runs on Monday', () => {
  const state = fresh();
  const task = schedule(state, {intervalMinutes: 1440, days: 'weekdays'}, {maxAttempts: 1});
  const friday = new Date(2026, 10, 27, 8, 0).getTime();
  assert.equal(new Date(friday).getDay(), 5);
  task.runAt = new Date(friday).toISOString();
  const now = friday + 5 * 60000;
  assert.equal(claimTasks(state, {workerId: 'w', now}).length, 1);
  task.payload = {...task.payload, [RETRY_STARTED]: now - RETRY_WINDOW_MS - 1};
  failTask(state, task.id, 'down all day', now);
  assert.equal(task.status, 'queued');
  const next = new Date(task.runAt);
  assert.equal(next.getDay(), 1, `re-armed for ${next}`);
  assert.equal(next.getHours(), 8);
});

test('a schedule resumed by hand while the switch is on waits for the switch', () => {
  const state = fresh();
  const task = schedule(state);
  pauseAllSchedules(state);
  task.payload = {...task.payload, pausedBy: null}; // paused by hand, not by the switch
  resumeTaskByHand(state, task.id);
  held(task);
  const later = Date.now() + 3600000;
  assert.deepEqual(claimTasks(state, {workerId: 'w', now: later}), []);
  resumeAllSchedules(state, later);
  assert.equal(task.status, 'queued');
  assert.equal(claimTasks(state, {workerId: 'w', now: later}).length, 1);
});

test('a failed schedule retried by hand while the switch is on waits too', () => {
  const state = fresh();
  const task = schedule(state);
  task.status = 'failed';
  pauseAllSchedules(state);
  retryTaskByHand(state, task.id);
  held(task);
});
