// Watch and tell: a page a bot checks on a timer, compared by code (never the model). The owner hears once when it
// changes, or when chosen words appear, and nothing while it stays the same. Design: docs/superpowers/specs/2026-11-25-watch-and-tell-design.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {addWatch, setWatchOn, removeWatch, dueWatches, pageLines, recordCheck, watchRequest, sanitizeWatch, publicWatch, WATCH_EVERY, MAX_WATCHES} from '../shared/watches.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const state = () => ({groups: [{id: 'home', bots: [{id: 'scout', name: 'Scout'}]}], watches: []});
let n = 0;
const opts = (at = NOW) => ({now: iso(at), makeId: () => `w${++n}`});

test('a watch belongs to a bot, needs a public page and a known pace, and is checked soon after it is made', () => {
  const s = state();
  const w = addWatch(s, {botId: 'scout', url: 'https://shop.example/item', every: 'hour'}, opts());
  assert.equal(w.botId, 'scout');
  assert.equal(w.on, true);
  assert.equal(w.nextAt, iso(NOW), 'the first check takes the baseline');
  assert.deepEqual(WATCH_EVERY.map(e => e.id), ['hour', '6h', 'day']);
  assert.throws(() => addWatch(s, {botId: 'nobody', url: 'https://a.example'}, opts()), /bot/);
  assert.throws(() => addWatch(s, {botId: 'scout', url: 'file:///etc/passwd'}, opts()), /address/);
  assert.throws(() => addWatch(s, {botId: 'scout', url: 'https://a.example', every: 'minute'}, opts()), /often/);
  assert.throws(() => addWatch(s, {botId: 'scout', url: 'https://shop.example/item', every: 'day'}, opts()), /already/);
  const words = addWatch(s, {botId: 'scout', url: 'https://shop.example/item', words: '  In   stock '}, opts());
  assert.equal(words.words, 'In stock', 'the same page for other words is another watch');
  for (let i = s.watches.length; i < MAX_WATCHES; i++) addWatch(s, {botId: 'scout', url: `https://a.example/${i}`}, opts());
  assert.throws(() => addWatch(s, {botId: 'scout', url: 'https://b.example'}, opts()), /20/);
});

test('due watches: on, past their time, not waiting on a check, and not while the kill switch holds schedules', () => {
  const s = state();
  const a = addWatch(s, {botId: 'scout', url: 'https://a.example'}, opts());
  const b = addWatch(s, {botId: 'scout', url: 'https://b.example'}, opts());
  const c = addWatch(s, {botId: 'scout', url: 'https://c.example'}, opts());
  setWatchOn(s, b.id, false);
  c.requestId = 'r1';
  assert.deepEqual(dueWatches(s, NOW).map(w => w.id), [a.id]);
  assert.deepEqual(dueWatches(s, NOW - 1000), [], 'not before its time');
  assert.deepEqual(dueWatches({...s, schedulesPaused: true}, NOW), []);
  assert.throws(() => setWatchOn(s, 'nope', true), /not found/);
  removeWatch(s, a.id);
  assert.equal(s.watches.length, 2);
  assert.equal(setWatchOn(s, b.id, true, {now: iso(NOW + 5000)}).nextAt, iso(NOW + 5000), 'switched back on, it checks soon');
});

test('a page\'s lines ignore what changes on every load: clocks, dates and "3 min ago"; prices and words stay', () => {
  const one = pageLines('Price: £12.99\nUpdated 3 min ago\n\nLast checked 10:42 am · 2026-11-25\nIn stock');
  const two = pageLines('Price:   £12.99\nUpdated 4 min ago\nLast checked 11:07 am · 2026-11-26\nIn stock');
  assert.deepEqual(one.map(l => l.key), two.map(l => l.key));
  assert.notDeepEqual(pageLines('Price: £12.99').map(l => l.key), pageLines('Price: £10.99').map(l => l.key));
  assert.ok(pageLines('x\n'.repeat(5000)).length <= 400, 'a long page is bounded');
});

test('the first check is a baseline; then only new lines are a change, said once, with the new line', () => {
  const s = state();
  const w = addWatch(s, {botId: 'scout', url: 'https://shop.example/item', every: 'hour'}, opts());
  const first = recordCheck(s, w.id, {ok: true, text: 'Widget\nPrice: £12.99\nUpdated 2 min ago'}, {now: iso(NOW)});
  assert.equal(first.notice, null, 'nothing to compare yet');
  assert.equal(w.lastCheckedAt, iso(NOW));
  assert.equal(w.nextAt, iso(NOW + 3600000));
  const same = recordCheck(s, w.id, {ok: true, text: 'Widget\nPrice: £12.99\nUpdated 9 min ago'}, {now: iso(NOW + 3600000)});
  assert.equal(same.notice, null, 'a clock ticking is not a change');
  const gone = recordCheck(s, w.id, {ok: true, text: 'Widget'}, {now: iso(NOW + 7200000)});
  assert.equal(gone.notice, null, 'lines that went away are not news; new ones are');
  const moved = recordCheck(s, w.id, {ok: true, text: 'Widget\nPrice: £10.99\nOnly 3 left'}, {now: iso(NOW + 10800000)});
  assert.match(moved.notice.title, /shop\.example changed/);
  assert.match(moved.notice.body, /Price: £10\.99/);
  assert.match(moved.notice.body, /Scout/);
  assert.equal(w.lastChangedAt, iso(NOW + 10800000));
  assert.match(moved.line, /shop\.example changed/);
  assert.doesNotMatch(moved.line, /£10/, 'the page\'s words stay out of the bot\'s chat');
});

test('with words, the owner hears when they appear, not on every other change, and again only after they went away', () => {
  const s = state();
  const w = addWatch(s, {botId: 'scout', url: 'https://tix.example/show', words: 'tickets available'}, opts());
  assert.equal(recordCheck(s, w.id, {ok: true, text: 'Sold out'}, {now: iso(NOW)}).notice, null);
  assert.equal(recordCheck(s, w.id, {ok: true, text: 'Sold out. New date added'}, {now: iso(NOW + 1)}).notice, null);
  const yes = recordCheck(s, w.id, {ok: true, text: 'Great news: Tickets Available now!'}, {now: iso(NOW + 2)});
  assert.match(yes.notice.title, /"tickets available" is on tix\.example/);
  assert.equal(recordCheck(s, w.id, {ok: true, text: 'Tickets available now'}, {now: iso(NOW + 3)}).notice, null);
  recordCheck(s, w.id, {ok: true, text: 'Sold out'}, {now: iso(NOW + 4)});
  assert.ok(recordCheck(s, w.id, {ok: true, text: 'tickets available'}, {now: iso(NOW + 5)}).notice);
  const baseline = addWatch(s, {botId: 'scout', url: 'https://tix.example/other', words: 'on sale'}, opts());
  assert.ok(recordCheck(s, baseline.id, {ok: true, text: 'Now on sale'}, {now: iso(NOW)}).notice, 'words already there on the first check are news');
});

test('three failed checks in a row are one notice, and the next good check says it works again', () => {
  const s = state();
  const w = addWatch(s, {botId: 'scout', url: 'https://a.example'}, opts());
  recordCheck(s, w.id, {ok: true, text: 'hello'}, {now: iso(NOW)});
  assert.equal(recordCheck(s, w.id, {ok: false, error: 'timeout'}, {now: iso(NOW + 1)}).notice, null);
  assert.equal(recordCheck(s, w.id, {ok: false, error: 'timeout'}, {now: iso(NOW + 2)}).notice, null);
  const third = recordCheck(s, w.id, {ok: false, error: 'The site refused'}, {now: iso(NOW + 3)});
  assert.match(third.notice.title, /cannot check a\.example/);
  assert.match(third.notice.body, /The site refused/);
  assert.equal(w.problem, 'The site refused');
  assert.equal(recordCheck(s, w.id, {ok: false, error: 'x'}, {now: iso(NOW + 4)}).notice, null, 'said once');
  const back = recordCheck(s, w.id, {ok: true, text: 'hello'}, {now: iso(NOW + 5)});
  assert.match(back.notice.title, /checking a\.example again/);
  assert.equal(w.problem, '');
  const blocked = recordCheck(s, w.id, {ok: false, error: 'not allowed', blocked: true}, {now: iso(NOW + 6)});
  assert.ok(blocked.notice, 'a permission that stops it is said at once: it will not fix itself');
  assert.equal(recordCheck(s, 'gone', {ok: true, text: 'x'}).notice, null, 'a removed watch is ignored');
});

test('the page a watch opens is its own: a plain read under its own key, looking for its words', () => {
  const s = state();
  const w = addWatch(s, {botId: 'scout', url: 'https://tix.example/show', words: 'tickets'}, opts());
  const r = watchRequest(s, w, {now: iso(NOW), makeId: () => 'req1'});
  assert.equal(r.chatKey, `watch:${w.id}`, 'never the bot\'s chat: watch pages do not taint or feed it');
  assert.equal(r.watchId, w.id);
  assert.equal(r.kind, 'browser.capture');
  assert.deepEqual(r.steps, []);
  assert.equal(r.find, 'tickets');
  assert.equal(r.botName, 'Scout');
  assert.equal(r.runId, undefined);
});

test('a watch from a backup keeps its settings, checked, and starts a new baseline; one that is not a watch is dropped', () => {
  const w = sanitizeWatch({id: 'w1', botId: 'scout', url: 'https://a.example/x', every: '6h', words: ' sale ', on: false, lines: ['old'], requestId: 'r9', told: true, createdAt: '2026-11-01T00:00:00.000Z'});
  assert.deepEqual([w.id, w.botId, w.url, w.every, w.words, w.on], ['w1', 'scout', 'https://a.example/x', '6h', 'sale', false]);
  assert.equal(w.lines, null);
  assert.equal(w.requestId, null);
  assert.equal(w.told, false);
  for (const bad of [null, 'x', {id: 'w1', botId: 'scout', url: 'javascript:alert(1)', every: 'day'}, {id: 'w 1', botId: 'scout', url: 'https://a.example', every: 'day'}, {id: 'w1', botId: 'scout', url: 'https://a.example', every: 'minute'}]) {
    assert.equal(sanitizeWatch(bad), null);
  }
  const shown = publicWatch({...w, lines: ['a']});
  assert.equal(shown.lines, undefined, 'the snapshot never carries what a watch last saw');
  assert.equal(shown.site, 'a.example');
  assert.equal(shown.everyLabel, 'Every 6 hours');
});
