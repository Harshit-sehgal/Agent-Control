// Grant expiry, the Hands-off switch, the three safety presets and their Undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {verdict, setGrant, grantFor, sweepGrants, answerAsk, createAsk, untilFor, cleanUntil, restorePermissions} from '../shared/asks.js';
import {PRESETS, presetOf, applyPreset} from '../shared/presets.js';

const NOW = '2026-11-12T10:00:00.000Z';
const bot = (id, name) => ({id, name, instructions: `${name} does a job.`, settings: {}});
const fresh = (extra = {}) => ({groups: [{id: 'home', name: 'Home', settings: {}, bots: [bot('atlas', 'Atlas'), bot('mail', 'Mailroom')]}], asks: [], grants: [], groupRuns: [], activity: [], ...extra});
const mail = {id: 'mail', name: 'Mailroom'};
const later = ms => new Date(Date.parse(NOW) + ms).toISOString();

// ---- expiry ----

test('an Always allow with an end allows until it ends, then asks again', () => {
  const s = fresh();
  setGrant(s, 'mail', 'post', 'https://x.com', 'always', NOW, {until: later(3600000)});
  assert.equal(verdict(s, mail, 'post', 'https://x.com', {now: later(60000)}).verdict, 'allow', 'unexpired allows');
  assert.equal(verdict(s, mail, 'post', 'https://x.com', {now: later(3600000)}).verdict, 'ask', 'expired asks again');
  assert.equal(grantFor(s, 'mail', 'post', 'https://x.com', later(7200000)), null, 'an expired grant is no answer at all');
});

test('an expired grant is swept; an unexpired one and one with no end stay', () => {
  const s = fresh();
  setGrant(s, 'mail', 'post', 'https://x.com', 'always', NOW, {until: later(1000)});
  setGrant(s, 'mail', 'send', 'https://mail.example.com', 'always', NOW, {until: later(9e6)});
  setGrant(s, 'atlas', 'post', 'https://x.com', 'always', NOW);
  sweepGrants(s, later(5000));
  assert.deepEqual(s.grants.map(g => `${g.botId} ${g.action}`), ['mail send', 'atlas post']);
});

test('setting a rule again without an end clears the old end; Ask each time and Deny never carry one', () => {
  const s = fresh();
  setGrant(s, 'mail', 'post', 'https://x.com', 'always', NOW, {until: later(1000)});
  setGrant(s, 'mail', 'post', 'https://x.com', 'always', NOW);
  assert.equal(s.grants[0].until, undefined);
  setGrant(s, 'mail', 'post', 'https://x.com', 'ask', NOW, {until: later(1000)});
  assert.equal(s.grants[0].until, undefined);
});

test('an end must be a time in the future, within a year', () => {
  assert.equal(cleanUntil(undefined, NOW), null);
  assert.equal(cleanUntil('', NOW), null);
  assert.equal(cleanUntil(later(1000), NOW), later(1000));
  assert.throws(() => cleanUntil('soon', NOW), /time/);
  assert.throws(() => cleanUntil(later(-1000), NOW), /future/);
  assert.throws(() => cleanUntil(later(400 * 86400000), NOW), /year/);
});

test('the three ends the card offers: an hour, the rest of today, no end', () => {
  const now = new Date(2026, 10, 12, 9, 30);
  assert.equal(untilFor('1h', now), new Date(2026, 10, 12, 10, 30).toISOString());
  assert.equal(untilFor('today', now), new Date(2026, 10, 12, 23, 59, 59, 999).toISOString());
  assert.equal(untilFor('always', now), null);
  assert.equal(untilFor('nonsense', now), null);
});

test('payment rules are unchanged: an every-site Always allow is still refused, with or without an end', () => {
  const s = fresh();
  assert.throws(() => setGrant(s, 'mail', 'spend', '', 'always', NOW, {until: later(1000)}), /one site/);
  setGrant(s, 'mail', 'spend', 'https://shop.example.com', 'always', NOW, {until: later(3600000)});
  assert.equal(verdict(s, mail, 'spend', 'https://shop.example.com/pay', {now: later(1000)}).verdict, 'allow');
  assert.equal(verdict(s, mail, 'spend', 'https://shop.example.com/pay', {now: later(3600001)}).verdict, 'ask');
  assert.equal(verdict(s, mail, 'spend', 'https://other.example.com/pay', {now: later(1000)}).verdict, 'ask');
});

test('Always allow on an ask can carry an end, and the answer says how to undo it', () => {
  const s = fresh();
  setGrant(s, 'mail', 'post', 'https://x.com', 'ask', NOW);
  const ask = createAsk(s, {botId: 'mail', action: 'post', target: 'https://x.com/compose', makeId: () => 'a1', now: NOW});
  const out = answerAsk(s, ask.id, 'always', NOW, {until: later(3600000)});
  assert.equal(grantFor(s, 'mail', 'post', 'https://x.com', later(1000)), 'always');
  assert.equal(s.grants[0].until, later(3600000));
  assert.deepEqual(out.undo, {grants: [{botId: 'mail', action: 'post', scope: 'https://x.com', choice: 'ask'}]});
  restorePermissions(s, out.undo, NOW);
  assert.equal(grantFor(s, 'mail', 'post', 'https://x.com', NOW), 'ask', 'Undo puts the rule back as it was');
});

test('Undo of a first Always allow removes the rule', () => {
  const s = fresh();
  const ask = createAsk(s, {botId: 'mail', action: 'post', target: 'https://x.com/compose', makeId: () => 'a1', now: NOW});
  const {undo} = answerAsk(s, ask.id, 'always', NOW);
  assert.deepEqual(undo.grants, [{botId: 'mail', action: 'post', scope: 'https://x.com', choice: null}]);
  restorePermissions(s, undo, NOW);
  assert.deepEqual(s.grants, []);
});

test('a restore cannot widen a payment rule to every site', () => {
  const s = fresh();
  assert.throws(() => restorePermissions(s, {grants: [{botId: 'mail', action: 'spend', scope: '', choice: 'always'}]}, NOW), /one site/);
  assert.throws(() => restorePermissions(s, {askBasics: 'yes'}, NOW), /true or false/);
  assert.throws(() => restorePermissions(s, {grants: 'all'}, NOW), /list/);
});

// ---- Hands-off ----

test('Hands-off: send, post and connector writes go without asking on any site; delete and payments still ask', () => {
  const s = fresh({handsOff: true});
  assert.equal(verdict(s, mail, 'send', 'https://mail.example.com').verdict, 'allow');
  assert.equal(verdict(s, mail, 'post', 'https://x.com').verdict, 'allow');
  assert.equal(verdict(s, mail, 'connector.gmail.write.send_email', 'me@example.com').verdict, 'allow');
  assert.equal(verdict(s, mail, 'delete', 'https://x.com').verdict, 'ask');
  assert.equal(verdict(s, mail, 'spend', 'https://shop.example.com').verdict, 'ask');
  assert.equal(verdict(s, mail, 'spend', '').verdict, 'ask');
});

test('Hands-off never overrides the owner\'s own Ask each time or Deny', () => {
  const s = fresh({handsOff: true});
  setGrant(s, 'mail', 'post', 'https://x.com', 'deny', NOW);
  setGrant(s, 'mail', 'send', 'https://mail.example.com', 'ask', NOW);
  setGrant(s, 'mail', 'connector.gmail.write', 'me@example.com', 'deny', NOW);
  assert.equal(verdict(s, mail, 'post', 'https://x.com').verdict, 'deny');
  assert.equal(verdict(s, mail, 'send', 'https://mail.example.com').verdict, 'ask');
  assert.equal(verdict(s, mail, 'connector.gmail.write.send_email', 'me@example.com').verdict, 'deny');
});

// ---- presets ----

test('a fresh workspace is Balanced; each preset matches once applied; anything else is Custom', () => {
  const s = fresh();
  assert.equal(presetOf(s), 'balanced');
  assert.deepEqual(PRESETS.map(p => p.id), ['careful', 'balanced', 'handsOff']);
  applyPreset(s, 'careful', NOW);
  assert.equal(presetOf(s), 'careful');
  applyPreset(s, 'handsOff', NOW);
  assert.equal(presetOf(s), 'handsOff');
  s.askBasics = true;
  assert.equal(presetOf(s), 'custom');
});

test('Careful: every bot asks before browsing and reading, and Always allow rules become Ask each time', () => {
  const s = fresh();
  setGrant(s, 'mail', 'post', 'https://x.com', 'always', NOW);
  setGrant(s, 'mail', 'spend', 'https://shop.example.com', 'always', NOW);
  setGrant(s, 'atlas', 'send', 'https://mail.example.com', 'deny', NOW);
  const {changes, undo} = applyPreset(s, 'careful', NOW);
  assert.equal(s.askBasics, true);
  assert.equal(verdict(s, mail, 'browser.use', 'https://example.com').verdict, 'ask');
  assert.equal(verdict(s, mail, 'post', 'https://x.com').verdict, 'ask');
  assert.equal(grantFor(s, 'atlas', 'send', 'https://mail.example.com'), 'deny', 'a Deny stays a Deny');
  assert.ok(changes.some(c => /ask before opening a web page/.test(c)), changes);
  assert.ok(changes.some(c => /Mailroom.*Post on x\.com.*Ask each time/.test(c)), changes);
  restorePermissions(s, undo, NOW);
  assert.equal(s.askBasics, false);
  assert.equal(grantFor(s, 'mail', 'post', 'https://x.com'), 'always');
  assert.equal(grantFor(s, 'mail', 'spend', 'https://shop.example.com'), 'always');
  assert.equal(presetOf(s), 'balanced');
});

test('Hands-off never creates a payment Always allow, and says payments still ask', () => {
  const s = fresh();
  const {changes} = applyPreset(s, 'handsOff', NOW);
  assert.equal(s.handsOff, true);
  assert.ok(!s.askBasics);
  assert.ok(!s.grants.some(g => g.action === 'spend' && g.choice === 'always'));
  assert.equal(s.grants.length, 0, 'Hands-off is one switch, not a rule per bot and site');
  assert.ok(changes.some(c => /Payments still ask/.test(c)), changes);
});

test('applying the preset already on changes nothing and says so', () => {
  const s = fresh();
  assert.deepEqual(applyPreset(s, 'balanced', NOW).changes, []);
  assert.throws(() => applyPreset(s, 'yolo', NOW), /preset/);
});

test('each preset change is in the activity log', () => {
  const s = fresh();
  applyPreset(s, 'handsOff', NOW);
  assert.ok(s.activity.some(e => e.kind === 'perm' && /send, post and change connected apps/.test(e.text)), JSON.stringify(s.activity));
});
