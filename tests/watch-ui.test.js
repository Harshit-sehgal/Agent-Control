// What a bot's Schedule page shows for its watched pages, and how the profile row counts them. Pure view models;
// the markup and the form live in shared/ui-profile.js and are checked by the usability smoke ("watch").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {watchRows, profileRows} from '../shared/ui-profile-model.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const base = (watches = []) => ({groups: [{id: 'home', bots: [{id: 'scout', name: 'Scout', settings: {}}, {id: 'other', name: 'Other', settings: {}}]}], tasks: [], watches});
const watch = over => ({id: 'w1', botId: 'scout', url: 'https://shop.example/item', every: 'hour', words: '', on: true, createdAt: ago(9e6), nextAt: ago(0), lastCheckedAt: null, lastChangedAt: null, problem: '', requestId: null, ...over});

test('each of a bot\'s watches says what, how often, when it was last checked and last changed, and any problem', () => {
  const s = base([
    watch({id: 'w1', lastCheckedAt: ago(5 * 60000), lastChangedAt: ago(3 * 3600000)}),
    watch({id: 'w2', url: 'https://tix.example/show', words: 'tickets', every: 'day', on: false}),
    watch({id: 'w3', botId: 'other'}),
    watch({id: 'w4', url: 'https://x.example/', problem: 'The site refused', requestId: 'r1', createdAt: ago(1)}),
  ]);
  const rows = watchRows(s, 'scout', NOW);
  assert.deepEqual(rows.map(r => r.id), ['w1', 'w2', 'w4'], 'this bot\'s, oldest first');
  assert.equal(rows[0].what, 'shop.example/item');
  assert.equal(rows[0].when, 'Every hour · checked 5 min ago · changed 3 h ago');
  assert.equal(rows[1].what, '"tickets" on tix.example/show');
  assert.equal(rows[1].when, 'Paused · Every day · not checked yet');
  assert.equal(rows[1].on, false);
  assert.equal(rows[2].problem, 'The site refused');
  assert.equal(rows[2].checking, true);
  assert.equal(rows[2].when, 'Every hour · checking now');
  assert.deepEqual(watchRows({groups: []}, 'scout', NOW), []);
});

test('the profile\'s Schedule row counts watched pages with the timers', () => {
  const value = s => profileRows(s, 'scout').find(r => r.key === 'schedule').value;
  assert.equal(value(base()), 'None');
  assert.equal(value(base([watch({})])), '1 page watched');
  assert.equal(value(base([watch({}), watch({id: 'w2', url: 'https://b.example/'})])), '2 pages watched');
  const both = {...base([watch({})]), tasks: [{id: 't', kind: 'bot-task', status: 'queued', every: 'day', at: '08:00', runAt: ago(-1), payload: {botId: 'scout', message: 'Sum up my inbox'}}]};
  assert.match(value(both), /^1 task · 1 page watched$/);
});

test('the Schedule page has the watch list, the form, and Check now, Pause and Remove', () => {
  const view = fs.readFileSync(new URL('../shared/ui-profile.js', import.meta.url), 'utf8');
  for (const needle of ['id="watch-form"', "'watch-check'", "'watch-toggle'", "'watch-remove'", '/api/watches']) assert.ok(view.includes(needle), needle);
});
