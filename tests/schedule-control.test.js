/** Pause, resume and the kill switch for scheduled tasks, and the weekdays / weekends rule.
 *
 * A schedule can be paused by its owner (it keeps its place and its record), resumed later, or
 * stopped at once for every schedule with the kill switch. A weekday schedule runs Monday to Friday
 * and never on a weekend. Pure state rules in shared/tasks.js, tested here without a server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueTask, claimTasks, completeTask, pauseTask, resumeTask,
  pauseAllSchedules, resumeAllSchedules,
} from '../shared/tasks.js';

const fresh = () => ({tasks: [], events: [], schedulesPaused: false,
  groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'B', instructions: 'Act.'}]}]});
const at = (state, id) => state.tasks.find(task => task.id === id);
const schedule = (state, extra = {}) => enqueueTask(state, {
  kind: 'bot-task', payload: {groupId: 'g', botId: 'b', message: 'Check my feed', kind: 'interval', intervalMinutes: 1440, ...extra},
}).task;

test('a paused schedule is never claimed, and keeps its record', () => {
  const state = fresh();
  const task = schedule(state);
  pauseTask(state, task.id);
  assert.equal(at(state, task.id).status, 'paused');
  assert.deepEqual(claimTasks(state, {workerId: 'w', now: Date.now() + 10 * 86400000}), []);
  assert.equal(at(state, task.id).kind, 'bot-task');
});

test('resuming a paused schedule queues it again, not in the past', () => {
  const state = fresh();
  const task = schedule(state);
  pauseTask(state, task.id);
  const later = Date.now() + 3 * 86400000;
  resumeTask(state, task.id, later);
  assert.equal(at(state, task.id).status, 'queued');
  assert.ok(Date.parse(at(state, task.id).runAt) >= later, 'a resumed schedule does not run at a time that already passed');
  assert.equal(claimTasks(state, {workerId: 'w', now: later}).length, 1);
});

test('a running task cannot be paused, and only a paused one can be resumed', () => {
  const state = fresh();
  const task = schedule(state, {intervalMinutes: 60});
  claimTasks(state, {workerId: 'w'});
  assert.throws(() => pauseTask(state, task.id), /running/);
  assert.throws(() => resumeTask(state, task.id), /paused/);
});

test('the kill switch pauses every schedule and stops new ones from running', () => {
  const state = fresh();
  const a = schedule(state);
  const b = schedule(state, {message: 'Second'});
  const notice = enqueueTask(state, {kind: 'notification', payload: {channel: 'in_app', title: 'Hi', body: 'x'}}).task;
  const paused = pauseAllSchedules(state);
  assert.equal(paused, 2);
  assert.equal(state.schedulesPaused, true);
  assert.equal(at(state, a.id).status, 'paused');
  assert.equal(at(state, b.id).status, 'paused');
  assert.equal(at(state, notice.id).status, 'queued', 'notices keep working while schedules are held');
  const fresh2 = schedule(state, {message: 'Created during the stop'});
  assert.equal(at(state, fresh2.id).status, 'paused', 'a schedule made during the stop starts paused');
});

test('resuming after the kill switch restores only what it paused', () => {
  const state = fresh();
  const a = schedule(state);
  const b = schedule(state, {message: 'Owner paused this one'});
  pauseTask(state, b.id);
  pauseAllSchedules(state);
  resumeAllSchedules(state);
  assert.equal(state.schedulesPaused, false);
  assert.equal(at(state, a.id).status, 'queued');
  assert.equal(at(state, b.id).status, 'paused', 'a schedule the owner paused by hand stays paused');
});

test('a weekdays schedule is accepted only for a daily interval', () => {
  const state = fresh();
  const ok = schedule(state, {days: 'weekdays'});
  assert.equal(ok.payload.days, 'weekdays');
  assert.throws(() => enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'g', botId: 'b', message: 'x', kind: 'interval', intervalMinutes: 60, days: 'weekdays'}}), /daily/);
  assert.throws(() => enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'g', botId: 'b', message: 'x', kind: 'interval', intervalMinutes: 1440, days: 'sometimes'}}), /weekdays or weekends/);
});

test('after a Friday run a weekdays schedule next runs on Monday, and a weekends one skips to Saturday', () => {
  const friday = new Date(2026, 10, 20, 8, 0).getTime();   // 2026-11-20 is a Friday
  const state = fresh();
  const weekdays = schedule(state, {days: 'weekdays', at: '08:00'});
  at(state, weekdays.id).runAt = new Date(friday).toISOString();
  claimTasks(state, {workerId: 'w', now: friday});
  completeTask(state, weekdays.id, null, friday);
  assert.equal(new Date(at(state, weekdays.id).runAt).getDay(), 1, 'Monday');
  assert.equal(new Date(at(state, weekdays.id).runAt).getHours(), 8);

  const weekend = schedule(state, {days: 'weekends', message: 'Weekend check'});
  at(state, weekend.id).runAt = new Date(friday).toISOString();
  claimTasks(state, {workerId: 'w', now: friday});
  completeTask(state, weekend.id, null, friday);
  assert.equal(new Date(at(state, weekend.id).runAt).getDay(), 6, 'Saturday');
});

test('the schedule list keeps a paused schedule and marks it paused', async () => {
  const {scheduleRows, whenWords} = await import('../shared/schedules.js');
  const state = fresh();
  const task = schedule(state, {at: '08:00'});
  pauseTask(state, task.id);
  const [row] = scheduleRows(state, 'b');
  assert.equal(row.paused, true);
  assert.equal(row.id, task.id);
  assert.equal(whenWords({every: 1440, at: '08:00', days: 'weekdays'}), 'every weekday at 08:00');
  assert.equal(whenWords({every: 1440, at: '08:00', days: 'weekends'}), 'every weekend at 08:00');
  assert.equal(whenWords({every: 1440, at: '08:00'}), 'every day at 08:00');
});
