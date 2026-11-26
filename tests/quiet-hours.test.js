/** Quiet hours for phone notices: `QUIET_HOURS=22:00-07:00` holds non-urgent push messages overnight.
 * The pure rule is in shared/quiet-hours.js; the push sender consults it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQuietHours, inQuietHours} from '../shared/quiet-hours.js';

test('quiet hours read a HH:MM-HH:MM window and refuse anything else', () => {
  assert.deepEqual(parseQuietHours('22:00-07:00'), {from: 22 * 60, to: 7 * 60});
  assert.deepEqual(parseQuietHours(' 9:30 - 17:00 '), {from: 570, to: 1020});
  assert.equal(parseQuietHours(''), null);
  assert.equal(parseQuietHours('late-night'), null);
  assert.equal(parseQuietHours('25:00-07:00'), null);
  assert.equal(parseQuietHours('07:00-07:00'), null, 'an empty window is refused');
});

test('a window that crosses midnight is quiet late at night and early in the morning', () => {
  const window = parseQuietHours('22:00-07:00');
  const at = (h, m) => new Date(2026, 10, 20, h, m);
  assert.equal(inQuietHours(window, at(23, 15)), true);
  assert.equal(inQuietHours(window, at(2, 0)), true);
  assert.equal(inQuietHours(window, at(6, 59)), true);
  assert.equal(inQuietHours(window, at(7, 0)), false);
  assert.equal(inQuietHours(window, at(12, 0)), false);
  assert.equal(inQuietHours(null, at(23, 15)), false, 'no window means never quiet');
});

test('quiet hours can be read in a named zone instead of the server clock', () => {
  const window = parseQuietHours('22:00-07:00');
  // 23:30 in Kolkata is 18:00 UTC; noon in Kolkata is 06:30 UTC.
  assert.equal(inQuietHours(window, new Date(Date.UTC(2026, 10, 20, 18, 0)), 'Asia/Kolkata'), true);
  assert.equal(inQuietHours(window, new Date(Date.UTC(2026, 10, 20, 6, 30)), 'Asia/Kolkata'), false);
  // An unknown zone keeps the server clock.
  const local = new Date(2026, 10, 20, 23, 15);
  assert.equal(inQuietHours(window, local, 'Not/AZone'), inQuietHours(window, local));
});
