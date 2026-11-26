/** A weekdays or weekends schedule is judged in the owner's time zone, not the server's.
 *
 * The browser picks the first run on the owner's clock, and the server re-arms it each day. The server used its own
 * zone to say which day a run falls on, so on a server in UTC (the Docker image, a VPS) an owner far from UTC had
 * Monday's run skipped and Saturday's run made. The schedule now carries the zone the browser was in (`tz`), and the
 * day rule reads the weekday there. A schedule with no zone, or one the runtime does not know, keeps the server's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {skipToDays, scheduleTaskBody, cleanZone} from '../shared/schedules.js';
import {enqueueTask, claimTasks, completeTask} from '../shared/tasks.js';

const DAY = 86400000;
const zone = 'Pacific/Auckland'; // UTC+13 in November
// Monday 30 November 2026 08:00 in Auckland is Sunday 29 November 19:00 UTC.
const mondayAuckland = Date.UTC(2026, 10, 29, 19, 0);
const saturdayAuckland = mondayAuckland - 2 * DAY;

test('the day rule reads the weekday in the schedule\'s zone', () => {
  assert.equal(skipToDays(mondayAuckland, DAY, 'weekdays', zone), mondayAuckland, 'Monday morning in Auckland is a weekday');
  assert.equal(skipToDays(saturdayAuckland, DAY, 'weekdays', zone), mondayAuckland, 'Saturday in Auckland waits for Monday');
  assert.equal(skipToDays(saturdayAuckland, DAY, 'weekends', zone), saturdayAuckland);
});

test('an unknown zone falls back to the server clock', () => {
  assert.equal(cleanZone('Not/AZone'), '');
  assert.equal(cleanZone(''), '');
  assert.equal(cleanZone(42), '');
  assert.equal(cleanZone(zone), zone);
  const local = new Date(2026, 10, 28, 8, 0).getTime(); // a Saturday on this machine's clock
  assert.equal(skipToDays(local, DAY, 'weekdays', 'Not/AZone'), skipToDays(local, DAY, 'weekdays'));
});

test('the Schedule form records the browser\'s zone on a day-rule schedule', () => {
  const body = scheduleTaskBody({botId: 'b', groupId: 'g', message: 'Hi', every: 1440, at: '08:00', days: 'weekdays'});
  assert.equal(body.payload.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('a stored schedule keeps a real zone, drops a bad one, and re-arms on the owner\'s weekday', () => {
  const state = {tasks: [], events: [], groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'B'}]}]};
  const payload = {groupId: 'g', botId: 'b', message: 'Brief me', kind: 'interval', intervalMinutes: 1440, days: 'weekdays'};
  const bad = enqueueTask(state, {kind: 'bot-task', payload: {...payload, tz: 'Not/AZone'}}).task;
  assert.equal('tz' in bad.payload, false);
  const task = enqueueTask(state, {kind: 'bot-task', payload: {...payload, tz: zone}}).task;
  assert.equal(task.payload.tz, zone);
  // Friday 27 November 08:00 in Auckland; the next weekday there is Monday.
  const friday = mondayAuckland - 3 * DAY;
  task.runAt = new Date(friday).toISOString();
  bad.runAt = new Date(friday + 7 * DAY).toISOString();
  assert.equal(claimTasks(state, {workerId: 'w', now: friday + 60000}).length, 1);
  completeTask(state, task.id, null, friday + 60000);
  assert.equal(task.runAt, new Date(mondayAuckland).toISOString());
});

test('a daily 08:00 stays at 08:00 on the owner\'s clock across a daylight-saving change', () => {
  const state = {tasks: [], events: [], groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'B'}]}]};
  const task = enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'g', botId: 'b', message: 'Brief me', kind: 'interval', intervalMinutes: 1440, at: '08:00', tz: 'Europe/London'}}).task;
  assert.equal(task.payload.tz, 'Europe/London', 'a schedule with a time keeps its zone');
  const run = (at, now) => {
    task.runAt = new Date(at).toISOString();
    assert.equal(claimTasks(state, {workerId: 'w', now}).length, 1);
    completeTask(state, task.id, null, now);
    return task.runAt;
  };
  // Clocks go forward on 29 March 2026: 08:00 GMT is 08:00 UTC, 08:00 BST is 07:00 UTC.
  assert.equal(run(Date.UTC(2026, 2, 28, 8, 0), Date.UTC(2026, 2, 28, 8, 1)), '2026-03-29T07:00:00.000Z');
  // And back on 25 October 2026.
  assert.equal(run(Date.UTC(2026, 9, 24, 7, 0), Date.UTC(2026, 9, 24, 7, 1)), '2026-10-25T08:00:00.000Z');
  // An ordinary day is a plain 24 hours.
  assert.equal(run(Date.UTC(2026, 5, 10, 7, 0), Date.UTC(2026, 5, 10, 7, 1)), '2026-06-11T07:00:00.000Z');
});

test('the Schedule form records the zone for any schedule with a time of day', () => {
  const body = scheduleTaskBody({botId: 'b', groupId: 'g', message: 'Hi', every: 1440, at: '08:00'});
  assert.equal(body.payload.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const hourly = scheduleTaskBody({botId: 'b', groupId: 'g', message: 'Hi', every: 60});
  assert.equal('tz' in hourly.payload, false);
});
