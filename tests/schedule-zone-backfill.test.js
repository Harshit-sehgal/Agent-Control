/** Schedules saved before they carried a time zone get the owner's.
 *
 * A recurring schedule with a time of day or a weekdays/weekends rule keeps the owner's clock only through the zone
 * it carries (`tz`). One made by an older build has none, and the server cannot know the owner's zone, so the app
 * sends its browser's zone once when it sees such a schedule (`POST /api/tasks/zone`). Only a schedule with no zone
 * is filled; one that has a zone keeps it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fillScheduleZones} from '../shared/tasks.js';
import {schedulesNeedZone} from '../shared/schedules.js';

const row = (id, payload, extra = {}) => ({id, kind: 'bot-task', status: 'queued', intervalMinutes: payload.kind === 'interval' ? payload.intervalMinutes : null,
  payload: {groupId: 'g', botId: 'b', message: 'Hi', ...payload}, ...extra});
const state = () => ({events: [], tasks: [
  row('daily', {kind: 'interval', intervalMinutes: 1440, at: '08:00'}),
  row('weekdays', {kind: 'interval', intervalMinutes: 1440, days: 'weekdays'}, {status: 'paused'}),
  row('zoned', {kind: 'interval', intervalMinutes: 1440, at: '08:00', tz: 'Asia/Kolkata'}),
  row('hourly', {kind: 'interval', intervalMinutes: 60}),
  row('once', {kind: 'once', at: '17:30', nextAt: '2026-12-01T12:00:00.000Z'}),
  row('stopped', {kind: 'interval', intervalMinutes: 1440, at: '08:00'}, {status: 'cancelled'}),
  {id: 'note', kind: 'notification', status: 'queued', payload: {channel: 'push'}},
]});
const zones = s => Object.fromEntries(s.tasks.map(t => [t.id, t.payload.tz]));

test('the app sees when a live schedule needs the owner\'s zone', () => {
  assert.equal(schedulesNeedZone(state()), true);
  const s = state();
  s.tasks = s.tasks.filter(t => !['daily', 'weekdays'].includes(t.id));
  assert.equal(schedulesNeedZone(s), false, 'hourly, one-off, stopped and already-zoned schedules do not');
  assert.equal(schedulesNeedZone(null), false);
});

test('only live recurring schedules with a time or a day rule and no zone are filled', () => {
  const s = state();
  assert.equal(fillScheduleZones(s, 'Europe/London'), 2);
  assert.deepEqual(zones(s), {daily: 'Europe/London', weekdays: 'Europe/London', zoned: 'Asia/Kolkata', hourly: undefined, once: undefined, stopped: undefined, note: undefined});
  assert.equal(schedulesNeedZone(s), false);
  assert.equal(fillScheduleZones(s, 'America/New_York'), 0, 'a second browser elsewhere changes nothing');
});

test('a zone the runtime does not know fills nothing', () => {
  const s = state();
  assert.equal(fillScheduleZones(s, 'Not/AZone'), 0);
  assert.equal(fillScheduleZones(s, ''), 0);
  assert.equal(schedulesNeedZone(s), true);
});

test('the demo answers the same route', async () => {
  const {installWebLocks} = await import('./web-locks.js');
  installWebLocks();
  const map = new Map();
  globalThis.window = globalThis.window || {};
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, get: () => ({getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key)})});
  await import('../shared/local-api.js');
  const request = (...a) => globalThis.window.AGENT_LOCAL_API(...a);
  assert.deepEqual(await request('/api/tasks/zone', 'POST', {tz: 'Europe/London'}), {filled: 0});
});
