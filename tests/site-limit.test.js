// A per-site daily limit: the owner may cap how many pages bots open on one site in a day (UTC), so a looping
// schedule cannot spend an account's goodwill on X or LinkedIn. Like every limit it is off by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import {limitsOf, setLimits, siteOf, sitePagesToday, countSitePage, siteCapLeft, MAX_PER_SITE} from '../shared/limits.js';
import {recordBrowserRequests} from '../shared/bot-browser.js';

const DAY = '2026-11-25T10:00:00.000Z', NEXT = '2026-11-26T00:05:00.000Z';

test('no per-site limit by default, and one the owner sets is kept', () => {
  assert.equal(limitsOf({}).perSite, null);
  const s = {};
  setLimits(s, {perSite: 20});
  assert.equal(limitsOf(s).perSite, 20);
  assert.throws(() => setLimits(s, {perSite: 0}));
  assert.throws(() => setLimits(s, {perSite: MAX_PER_SITE + 1}));
  setLimits(s, {perSite: null});
  assert.equal(limitsOf(s).perSite, null);
});

test('a site is its host without www, and the count starts over each UTC day', () => {
  assert.equal(siteOf('https://www.x.com/home'), 'x.com');
  assert.equal(siteOf('not a url'), '');
  const s = {};
  countSitePage(s, 'x.com', DAY);
  countSitePage(s, 'x.com', DAY);
  countSitePage(s, 'linkedin.com', DAY);
  assert.equal(sitePagesToday(s, 'x.com', DAY), 2);
  assert.equal(sitePagesToday(s, 'x.com', NEXT), 0);
  countSitePage(s, 'x.com', NEXT);
  assert.deepEqual(s.siteVisits, {day: '2026-11-26', counts: {'x.com': 1}}, 'yesterday is dropped, not kept forever');
  assert.equal(siteCapLeft({siteVisits: s.siteVisits}, 'x.com', NEXT), Infinity, 'no limit, no cap');
  assert.equal(siteCapLeft({...s, limits: {perSite: 3}}, 'x.com', NEXT), 2);
});

const state = () => ({
  groups: [{id: 'home', bots: [{id: 'b1', name: 'Scout'}]}], browserRequests: [], groupRuns: [], asks: [], grants: [],
  handsOff: true, askBasics: false,
});
const bot = {id: 'b1', name: 'Scout'};
const fence = url => `Looking.\n\`\`\`browser\n{"url":"${url}"}\n\`\`\``;

test('a bot past the day\'s limit on a site opens nothing there and is told why', () => {
  const s = {...state(), limits: {perSite: 2}};
  const open = url => recordBrowserRequests(s, {bot, groupId: 'home', chatKey: 'b1', output: fence(url), now: DAY});
  assert.equal(open('https://x.com/a').records.length, 1);
  assert.equal(open('https://www.x.com/b').records.length, 1);
  const third = open('https://x.com/c');
  assert.equal(third.records.length, 0);
  assert.match(third.lines.map(l => l.text).join(' '), /2 pages on x\.com today/);
  assert.match(third.invalid.join(' '), /x\.com/);
  assert.equal(open('https://linkedin.com/feed').records.length, 1, 'another site is not affected');
});

test('with no limit set, pages are still counted but never refused', () => {
  const s = state();
  for (const path of ['a', 'b', 'c', 'd']) recordBrowserRequests(s, {bot, groupId: 'home', chatKey: 'b1', output: fence(`https://x.com/${path}`), now: DAY});
  assert.equal(s.browserRequests.length, 4);
  assert.equal(sitePagesToday(s, 'x.com', DAY), 4);
});

test('today\'s per-site count survives a restart', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const {SqliteStore} = await import('../src/sqlite-store.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-limit-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const open = () => new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  const first = await open();
  await first.update(s => { countSitePage(s, 'x.com', DAY); countSitePage(s, 'x.com', DAY); });
  await first.close?.();
  const second = await open();
  t.after(() => second.close?.());
  assert.equal(sitePagesToday(second.read(), 'x.com', DAY), 2);
});
