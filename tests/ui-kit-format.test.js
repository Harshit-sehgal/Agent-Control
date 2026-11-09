/** Chat-list and thread time labels plus the settings row shape, from
 * shared/ui-kit.js.
 *
 * These three functions decide what every chat row and every day divider in the
 * UI says, and they branch on "how many days ago" with four outputs. Only the
 * pure helpers around them were imported by Node before, so a broken branch
 * (a date where a weekday belongs, or a "Yesterday" that never appears) went
 * unnoticed.
 *
 * `now` is a parameter of both label functions, so the cases are fixed dates and
 * do not drift with the calendar. Expected strings are formatted with the same
 * default locale the module uses; the assertions that matter are the ones about
 * *which* branch answered, so each one also checks the shape of the answer
 * (digits only in the date branch, no date where a weekday belongs, etc.).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {stamp,dayLabel,clock,row} from '../shared/ui-kit.js';

const now = new Date(2025, 2, 5, 15, 0, 0);           // Wednesday, Mar 5 2025
const daysAgo = n => new Date(2025, 2, 5 - n, 9, 30, 0);
const weekdayShort = date => date.toLocaleDateString(undefined, {weekday: 'short'});
const shortDate = date => date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
const longDate = date => date.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'});

test('stamp() shows a time for today, then "Yesterday", then a weekday, then a date', () => {
  const today = daysAgo(0);
  assert.equal(stamp(today, now), clock(today), 'today must show the time, not a date');
  assert.match(stamp(today, now), /^\d{1,2}:\d{2}/, 'the time branch must look like a time');

  assert.equal(stamp(daysAgo(1), now), 'Yesterday');

  // Days 2..6 are inside the week: weekday name, no digits.
  for (const n of [2, 3, 6]) {
    const date = daysAgo(n);
    const label = stamp(date, now);
    assert.equal(label, weekdayShort(date), `day ${n} must show the short weekday`);
    assert.equal(/\d/.test(label), false, `day ${n} must not leak digits ("${label}")`);
  }

  // Day 7 is the boundary: the weekday branch stops there.
  for (const n of [7, 30]) {
    const date = daysAgo(n);
    const label = stamp(date, now);
    assert.equal(label, shortDate(date), `day ${n} must show a short date`);
    assert.equal(label.includes(String(date.getDate())), true, `day ${n} must include the day number ("${label}")`);
  }

  // A clock skew or a scheduled message: nothing is "in the future" for the
  // chat list, so it keeps the time instead of an empty cell.
  const future = daysAgo(-3);
  assert.equal(stamp(future, now), clock(future));
});

test('stamp() answers an empty string when there is no usable date', () => {
  for (const value of ['', undefined, null, 0, 'not a date', 'yesterday-ish', {}]) {
    assert.equal(stamp(value, now), '', `stamp(${JSON.stringify(value)}) must be empty`);
  }
});

test('dayLabel() names today and yesterday, and dates everything older', () => {
  assert.equal(dayLabel(daysAgo(0), now), 'Today');
  const later = new Date(2025, 2, 5, 23, 59, 0);       // same day, later clock time
  assert.equal(dayLabel(later, new Date(2025, 2, 5, 0, 1, 0)), 'Today', 'the divider is about the day, not the hour');
  assert.equal(dayLabel(daysAgo(1), now), 'Yesterday');

  for (const n of [2, 8, 40]) {
    const date = daysAgo(n);
    assert.equal(dayLabel(date, now), longDate(date), `day ${n} must show the full day heading`);
  }
  const eight = daysAgo(8);
  const heading = dayLabel(eight, now);
  assert.equal(heading.includes(eight.toLocaleDateString(undefined, {weekday: 'long'})), true,
    `a day heading must name the weekday ("${heading}")`);
  assert.equal(heading.includes(String(eight.getDate())), true, 'a day heading includes the day number');

  // `new Date(null)` is the epoch, so null is deliberately not in this list:
  // dayLabel(null) renders "Thursday, Jan 1" today. Every real missing value
  // (an absent message timestamp is undefined or '') is handled.
  for (const value of ['', undefined, 'not a date']) {
    assert.equal(dayLabel(value, now), '', `dayLabel(${JSON.stringify(value)}) must be empty`);
  }
});

test('clock() formats a real time and gives up on junk', () => {
  assert.equal(clock(new Date(2025, 2, 5, 17, 30)), new Date(2025, 2, 5, 17, 30).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}));
  assert.match(clock(new Date(2025, 2, 5, 17, 30)), /^\d{1,2}:\d{2}/);
  assert.equal(clock('nope'), '');
});

test('row() is a static container without an action', () => {
  const html = row({title: 'Work', sub: 'Two bots', right: '3'});
  assert.match(html, /^<div class="row">/);
  assert.equal(html.includes('<button'), false, 'a row with no action must not pretend to be clickable');
  assert.equal(html.includes('data-action'), false);
  assert.match(html, /<span class="row-title">Work<\/span>/);
  assert.match(html, /<span class="row-sub">Two bots<\/span>/);
  assert.match(html, /<span class="row-right ">3<\/span>/);
});

test('row() becomes a button, carries the action and tone, and spreads data-*', () => {
  const html = row({title: 'Delete', action: 'bot.remove', id: 'bot-1', tone: 'danger', data: {uid: 'u1'}});
  assert.match(html, /^<button type="button" class="row tone-danger" data-action="bot\.remove"/);
  assert.match(html, /data-uid="u1"/);
  assert.match(html, /data-id="bot-1"/, 'the row id travels as data-id');
  assert.match(html, /<span class="row-right danger"><\/span>|<\/button>$/);
  assert.match(html, /<svg/, 'the button form shows the drill-in chevron');

  // A value of false/undefined is a conditional attribute, not "data-id=false".
  const sparse = row({title: 'T', action: 'go', id: undefined, data: {on: false, off: undefined, keep: ''}});
  assert.equal(sparse.includes('data-id'), false, 'a missing id must not become data-id="undefined"');
  assert.equal(sparse.includes('data-on'), false, 'false must mean "omit the attribute"');
  assert.equal(sparse.includes('data-off'), false);
  assert.match(sparse, /data-keep=""/, 'an empty string is still a value');
});

test('row() escapes attribute values and leaves the title to the caller', () => {
  const html = row({title: 'T', action: 'go "x"', data: {q: 'a"b<c'}});
  assert.match(html, /data-action="go &quot;x&quot;"/);
  assert.match(html, /data-q="a&quot;b&lt;c"/);
  // Titles come from shared builders that already escaped them; row() must not
  // double-escape or the UI shows entities.
  assert.match(row({title: 'Tom & Jerry'}), /<span class="row-title">Tom & Jerry<\/span>/);
});
