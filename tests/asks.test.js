/** Ask records and per-bot grants (shared/asks.js), their storage (schema v12)
 * and their place in backups. The rules under test:
 *  - the basic kit is never asked about; every other action asks until the
 *    owner says Always allow, and a Deny stops the bot (no retry loop);
 *  - a grant belongs to one bot, one action and one origin or account;
 *  - `spend` asks every time unless the owner sets Always allow for one site; with no site, even a crafted
 *    request or a doctored backup;
 *  - an ask answered after its run is gone is recorded and resumes nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ASK_ACTIONS, isAskAction, isBasicKit, scopeOf, grantFor, setGrant, createAsk, answerAsk,
  expireAsks, pendingAsks, verdict, grantsOf, sweepGrants, askChoices, grantChoices, ASK_ANSWER_LABELS, GRANT_LABELS, answeredText, askText, orphanAsks,
} from '../shared/asks.js';
import {canBot, BASIC_KIT} from '../shared/contracts.js';
import * as wf from '../shared/workflow.js';
import {openStore, TABLE_SHAPES} from '../src/sqlite-store.js';
import * as backup from '../src/backup.js';

// These tests are about the ask card, so the owner's switch to ask even before a page or a read is on.
const state = () => wf.migrate({
  askBasics: true, settings: {}, runs: [], tasks: [], events: [], groupMessages: {}, groupRuns: [],
  groups: [{id: 'home', name: 'Home', bots: [{id: 'a', name: 'Atlas', instructions: 'lead'}, {id: 'b', name: 'Mailroom', instructions: 'mail'}]}],
});
const mk = (() => { let n = 0; return () => `id-${++n}`; })();
const NOW = '2026-11-11T10:00:00.000Z';
const bot = (id, extra = {}) => ({id, name: id, permissions: [], ...extra});

test('which actions ask and which never do', () => {
  assert.deepEqual(ASK_ACTIONS, ['browser.use', 'send', 'post', 'delete', 'spend']);
  for (const action of ASK_ACTIONS) assert.equal(isAskAction(action), true, action);
  assert.equal(isAskAction('connector.gmail.read'), true);
  assert.equal(isAskAction('connector.gmail.write'), true);
  assert.equal(isAskAction('connector.gmail.admin'), false);
  assert.equal(isAskAction('publish.post'), false, 'no automated publishing exists');
  for (const action of ['bot.ask', 'bot.create', 'schedule.set']) assert.equal(isBasicKit(action), true, action);
  assert.deepEqual([...BASIC_KIT].sort(), ['bot.ask', 'bot.create', 'schedule.set']);
  for (const action of ASK_ACTIONS) assert.equal(isBasicKit(action), false, action);
});

test('scope: the origin for a browser, the account for a connector, nothing else', () => {
  assert.equal(scopeOf({action: 'browser.use', target: 'https://Docs.Example.com:8443/a/b?q=1'}), 'https://docs.example.com:8443');
  assert.equal(scopeOf({action: 'browser.use', target: 'not a url'}), '');
  assert.equal(scopeOf({action: 'browser.use', target: 'file:///etc/passwd'}), '');
  assert.equal(scopeOf({action: 'connector.gmail.write', target: ' Me@Example.com '}), 'me@example.com');
  assert.equal(scopeOf({action: 'send', target: 'https://example.com/compose'}), 'https://example.com', 'a Send click is per site (review I2)');
  assert.equal(scopeOf({action: 'delete'}), '');
});

test('a grant is per bot, per action and per origin, and nobody inherits', () => {
  const s = state();
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://a.com'), null, 'no grant, no entry');
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'always', NOW);
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://a.com'), 'always');
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://b.com'), null, 'another origin is another grant');
  assert.equal(grantFor(s, 'a', 'browser.use', 'https://a.com'), null, 'another bot never inherits it');
  assert.equal(grantFor(s, 'b', 'send', ''), null, 'another action neither');
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'deny', NOW);
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://a.com'), 'deny', 'the same key is replaced, not duplicated');
  assert.equal(s.grants.length, 1);
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'ask', NOW);
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://a.com'), 'ask');
  assert.deepEqual(grantsOf(s, 'b').map(g => [g.action, g.scope, g.choice]), [['browser.use', 'https://a.com', 'ask']]);
  assert.deepEqual(grantsOf(s, 'a'), []);
});

test('setGrant refuses what cannot be a grant', () => {
  const s = state();
  assert.throws(() => setGrant(s, 'b', 'spend', '', 'always'), e => e.status === 400 && /one site/i.test(e.message), 'a payment Always allow names its site');
  assert.throws(() => setGrant(s, 'b', 'publish.post', '', 'always'), e => e.status === 400);
  assert.throws(() => setGrant(s, 'b', 'bot.ask', '', 'deny'), e => e.status === 400, 'the basic kit has no grants');
  assert.throws(() => setGrant(s, 'b', 'send', '', 'sometimes'), e => e.status === 400);
  assert.throws(() => setGrant(s, 'b', 'browser.use', '', 'always'), e => e.status === 400, 'a browser grant names its site');
  assert.throws(() => setGrant(s, 'b', 'connector.gmail.read', '', 'always'), e => e.status === 400, 'a connector grant names its account');
  assert.throws(() => setGrant(s, 'nobody', 'send', '', 'always'), e => e.status === 404);
  assert.deepEqual(s.grants, []);
  // spend may be set to ask or deny.
  setGrant(s, 'b', 'spend', '', 'deny', NOW);
  assert.equal(grantFor(s, 'b', 'spend', ''), 'deny');
  // A Send, Post or Delete grant is for one site, stored as its origin (review I2).
  assert.throws(() => setGrant(s, 'b', 'send', '', 'always', NOW), e => e.status === 400, 'a send grant names its site');
  setGrant(s, 'b', 'send', 'https://Mail.com/compose', 'always', NOW);
  assert.equal(grantFor(s, 'b', 'send', 'https://mail.com'), 'always');
  // A browser scope given as a full URL is stored as its origin.
  setGrant(s, 'b', 'browser.use', 'https://Site.com/some/page', 'always', NOW);
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://site.com'), 'always');
});

test('a stored always grant for spend (a doctored backup) is never honoured', () => {
  const s = state();
  s.grants.push({botId: 'b', action: 'spend', scope: '', choice: 'always', at: NOW});
  assert.equal(grantFor(s, 'b', 'spend', ''), 'ask');
  assert.equal(verdict(s, bot('b'), 'spend', '').verdict, 'ask');
  wf.migrate(s);
  assert.deepEqual(s.grants, [], 'and the next load drops it');
});

test('verdict: basic kit allowed, always allowed, deny refused with where to change it, otherwise ask', () => {
  const s = state();
  const b = bot('b', {name: 'Mailroom'});
  assert.equal(verdict(s, b, 'bot.ask').verdict, 'allow');
  assert.equal(verdict(s, b, 'schedule.set').verdict, 'allow');
  assert.equal(verdict(s, b, 'browser.use', 'https://a.com/x').verdict, 'ask', 'no grant: ask, never "no permission"');
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'always', NOW);
  assert.equal(verdict(s, b, 'browser.use', 'https://a.com/x').verdict, 'allow');
  assert.equal(verdict(s, b, 'browser.use', 'https://other.com').verdict, 'ask');
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'deny', NOW);
  const denied = verdict(s, b, 'browser.use', 'https://a.com/x');
  assert.equal(denied.verdict, 'deny');
  assert.match(denied.message, /Mailroom's profile/);
  assert.match(denied.message, /Permissions/);
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'ask', NOW);
  assert.equal(verdict(s, b, 'browser.use', 'https://a.com/x').verdict, 'ask');
  assert.equal(verdict(s, b, 'bogus', '').verdict, 'deny', 'an action nobody declared is not allowed');
});

test('a permission a bot held before asks existed reads as Ask each time; only an explicit grant allows', () => {
  const s = state();
  const holds = bot('b', {permissions: ['browser.use'], settings: {browserApproval: 'auto'}});
  assert.equal(verdict(s, holds, 'browser.use', 'https://a.com').verdict, 'ask', 'permission plus auto is a member setting, not an admin grant (review I3)');
  const asks = bot('b', {permissions: ['browser.use'], settings: {browserApproval: 'ask'}});
  assert.equal(verdict(s, asks, 'browser.use', 'https://a.com').verdict, 'ask', 'permission plus ask was ask each time');
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'ask', NOW);
  assert.equal(verdict(s, holds, 'browser.use', 'https://a.com').verdict, 'ask', 'the owner choosing Ask each time wins');
  // The legacy permission never opens a payment.
  assert.equal(verdict(s, bot('b', {permissions: ['spend']}), 'spend', '').verdict, 'ask');
});

test('canBot: the same answer, with a grant store to read', () => {
  const s = state();
  const b = bot('b');
  assert.equal(canBot(b, 'bot.ask'), true);
  assert.equal(canBot(b, 'browser.use'), false, 'with no store the permission list decides, as before');
  assert.equal(canBot(b, 'browser.use', {state: s, scope: 'https://a.com'}), false, 'ask needed is not allowed yet');
  setGrant(s, 'b', 'browser.use', 'https://a.com', 'always', NOW);
  assert.equal(canBot(b, 'browser.use', {state: s, scope: 'https://a.com'}), true);
  assert.equal(canBot(b, 'send', {state: s, scope: 'https://a.com'}), false);
  setGrant(s, 'b', 'send', 'https://a.com', 'always', NOW);
  assert.equal(canBot(b, 'send', {state: s, scope: 'https://a.com/compose'}), true);
  assert.equal(canBot(b, 'send', {state: s}), false, 'a send grant is for its site only');
});

test('an ask is created pending, answered once, and the answer is the card', () => {
  const s = state();
  const ask = createAsk(s, {botId: 'b', runId: 'r1', chatKey: 'b', action: 'browser.use', target: 'https://a.com/page', detail: 'read a.com', now: NOW, makeId: mk});
  assert.equal(ask.status, 'pending');
  assert.equal(ask.grantScope, 'https://a.com');
  assert.equal(ask.createdAt, NOW);
  assert.equal(ask.scope, null);
  assert.deepEqual(pendingAsks(s).map(a => a.id), [ask.id]);
  assert.throws(() => createAsk(s, {botId: 'b', action: 'bot.ask', now: NOW, makeId: mk}), e => e.status === 400, 'the basic kit is never asked');
  assert.throws(() => answerAsk(s, ask.id, 'maybe', NOW), e => e.status === 400);
  assert.throws(() => answerAsk(s, 'missing', 'allow', NOW), e => e.status === 404);
  const out = answerAsk(s, ask.id, 'allow', NOW);
  assert.equal(out.ask.status, 'allowed');
  assert.equal(out.ask.scope, 'once');
  assert.equal(out.ask.answeredAt, NOW);
  assert.equal(out.resumeRunId, null, 'no run is parked on it in this state');
  assert.deepEqual(grantsOf(s, 'b'), [], 'Allow is once: no grant');
  assert.deepEqual(pendingAsks(s), []);
  assert.throws(() => answerAsk(s, ask.id, 'decline', NOW), e => e.status === 409, 'an ask is answered once');
});

test('Always allow stores the grant for this bot, this action and this origin; Decline stores nothing', () => {
  const s = state();
  const first = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'browser.use', target: 'https://a.com/x', now: NOW, makeId: mk});
  answerAsk(s, first.id, 'always', NOW);
  assert.equal(s.asks.find(a => a.id === first.id).scope, 'always');
  assert.equal(grantFor(s, 'b', 'browser.use', 'https://a.com'), 'always');
  assert.equal(grantFor(s, 'a', 'browser.use', 'https://a.com'), null);
  const second = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'send', target: 'x', now: NOW, makeId: mk});
  answerAsk(s, second.id, 'decline', NOW);
  assert.equal(s.asks.find(a => a.id === second.id).status, 'declined');
  assert.equal(grantFor(s, 'b', 'send', ''), null);
});

test('Review focus 2: Always allow for a payment with no site, through a crafted request, is refused with a 400', () => {
  const s = state();
  const ask = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'spend', target: 'not a site', detail: 'pay', now: NOW, makeId: mk});
  assert.throws(() => answerAsk(s, ask.id, 'always', NOW), e => e.status === 400);
  assert.equal(s.asks.find(a => a.id === ask.id).status, 'pending', 'the refused answer changed nothing');
  assert.deepEqual(s.grants, []);
  assert.deepEqual(askChoices('spend', {site: false}), ['decline', 'allow']);
  assert.deepEqual(askChoices('send'), ['decline', 'allow', 'always']);
  assert.deepEqual(grantChoices('spend'), ['always', 'ask', 'deny']);
  assert.deepEqual(grantChoices('browser.use'), ['always', 'ask', 'deny']);
  assert.equal(answerAsk(s, ask.id, 'allow', NOW).ask.status, 'allowed');
  assert.deepEqual(s.grants, [], 'and an allowed payment leaves no grant behind');
});

test('Review focus 4: two asks pending in one run resume it only when the last is answered, in any order', () => {
  const s = state();
  s.groupRuns.push({id: 'r1', groupId: 'home', status: 'awaiting_ask'});
  const one = createAsk(s, {botId: 'b', runId: 'r1', chatKey: 'b', action: 'browser.use', target: 'https://a.com', now: NOW, makeId: mk});
  const two = createAsk(s, {botId: 'b', runId: 'r1', chatKey: 'b', action: 'browser.use', target: 'https://b.com', now: NOW, makeId: mk});
  assert.equal(answerAsk(s, two.id, 'allow', NOW).resumeRunId, null, 'one is still waiting');
  assert.equal(answerAsk(s, one.id, 'decline', NOW).resumeRunId, 'r1', 'the last answer, in either order, resumes it');
});

test('Review focus 1: an answer after the run was cancelled or deleted is recorded and resumes nothing', () => {
  const s = state();
  s.groupRuns.push({id: 'r1', groupId: 'home', status: 'cancelled'});
  const ask = createAsk(s, {botId: 'b', runId: 'r1', chatKey: 'b', action: 'send', target: 'https://x.example/', now: NOW, makeId: mk});
  const out = answerAsk(s, ask.id, 'always', NOW);
  assert.equal(out.ask.status, 'allowed');
  assert.equal(out.resumeRunId, null);
  assert.equal(grantFor(s, 'b', 'send', 'https://x.example'), 'always', 'the owner\'s choice stands even though the run is gone');
  const gone = createAsk(s, {botId: 'b', runId: 'deleted', chatKey: 'b', action: 'send', target: 'x', now: NOW, makeId: mk});
  assert.equal(answerAsk(s, gone.id, 'allow', NOW).resumeRunId, null);
});

test('an ask from an unattended run expires declined after 24 hours; an attended one waits', () => {
  const s = state();
  const mine = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'send', target: 'x', now: NOW, makeId: mk});
  const timer = createAsk(s, {botId: 'b', runId: 'r9', chatKey: 'b', action: 'send', target: 'x', unattended: true, now: NOW, makeId: mk});
  assert.equal(mine.expiresAt, undefined, 'the owner is in the conversation');
  assert.equal(timer.expiresAt, '2026-11-12T10:00:00.000Z');
  assert.deepEqual(expireAsks(s, '2026-11-12T09:59:59.000Z').expired, []);
  const out = expireAsks(s, '2026-11-12T10:00:00.000Z');
  assert.deepEqual(out.expired.map(a => a.id), [timer.id]);
  const done = s.asks.find(a => a.id === timer.id);
  assert.equal(done.status, 'declined');
  assert.equal(done.expired, true);
  assert.equal(s.asks.find(a => a.id === mine.id).status, 'pending');
  assert.deepEqual(expireAsks(s, '2030-01-01T00:00:00.000Z').expired.map(a => a.id), [], 'only an ask with an expiry ever expires');
});

test('an ask whose run ended gets an expiry so it cannot sit in Needs you for ever', () => {
  const s = state();
  const ask = createAsk(s, {botId: 'b', runId: 'r1', chatKey: 'b', action: 'send', target: 'x', now: NOW, makeId: mk});
  orphanAsks(s, a => a.runId === 'r1', NOW);
  assert.equal(s.asks.find(a => a.id === ask.id).expiresAt, '2026-11-12T10:00:00.000Z');
  assert.equal(s.asks.find(a => a.id === ask.id).status, 'pending', 'still answerable until then');
});

test('Review focus 5: a grant for a bot that no longer exists is ignored and swept, and nothing crashes', () => {
  const s = state();
  setGrant(s, 'b', 'send', 'https://x.example', 'always', NOW);
  s.grants.push({botId: 'ghost', action: 'send', scope: '', choice: 'always', at: NOW});
  s.grants.push({botId: 'b', action: 'nonsense', scope: '', choice: 'always', at: NOW});
  s.grants.push({botId: 'b', action: 'send', scope: '', choice: 'maybe', at: NOW});
  s.grants.push(null);
  assert.equal(grantFor(s, 'ghost', 'send', ''), null, 'a grant for a missing bot is never read');
  sweepGrants(s);
  assert.deepEqual(s.grants.map(g => g.botId), ['b']);
  wf.migrate(s);
  assert.equal(s.grants.length, 1);
  // Removing a bot takes its grants and orphans its asks.
  const ask = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'post', target: 'x', now: NOW, makeId: mk});
  wf.removeBot(s, 'home', 'b');
  assert.deepEqual(s.grants, []);
  assert.ok(s.asks.find(a => a.id === ask.id).expiresAt, 'its pending ask will lapse');
});

test('the card copy: one sentence, the three buttons, and the collapsed line', () => {
  assert.deepEqual(ASK_ANSWER_LABELS, {decline: "Don't allow", allow: 'Allow once', always: 'Always allow'});
  assert.deepEqual(GRANT_LABELS, {always: 'Always allow', ask: 'Ask each time', deny: 'Deny'});
  const s = state();
  const ask = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'browser.use', target: 'https://a.com/x', detail: 'read a.com', now: NOW, makeId: mk});
  assert.equal(askText(ask, 'Mailroom'), 'Mailroom wants to read a.com.');
  assert.equal(answeredText(ask), 'Waiting for you');
  answerAsk(s, ask.id, 'allow', NOW);
  assert.equal(answeredText(s.asks[0]), 'You allowed it once');
  const other = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'send', target: 'https://x.example/', now: NOW, makeId: mk});
  answerAsk(s, other.id, 'always', NOW);
  assert.equal(answeredText(s.asks[1]), 'You always allow it for this bot');
  const third = createAsk(s, {botId: 'b', runId: null, chatKey: 'b', action: 'post', target: 'x', now: NOW, makeId: mk});
  answerAsk(s, third.id, 'decline', NOW);
  assert.equal(answeredText(s.asks[2]), 'You declined it');
});

/** Recompute the checksum the way an operator's own tool would, so only the content is in doubt. */
const seal = doc => ({...doc, checksum: crypto.createHash('sha256').update(JSON.stringify(doc.tables)).digest('hex')});

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-asks-'));
  const store = await openStore(path.join(dir, 'state.json'));
  return {dir, store, async done() { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }};
}

test('schema v12: asks, grants and the activity log are stored, and survive a reopen', async () => {
  const names = TABLE_SHAPES.map(shape => shape.table);
  for (const table of ['asks', 'grants', 'activity']) assert.ok(names.includes(table), `${table} has a write shape`);
  const t = await sandbox();
  try {
    const {id} = (await t.store.update(s => {
      setGrant(s, 'atlas', 'browser.use', 'https://a.com', 'always', NOW, {log: false});
      setGrant(s, 'atlas', 'send', 'https://x.example', 'deny', NOW, {log: false});
      const ask = createAsk(s, {botId: 'atlas', runId: 'r1', chatKey: 'atlas', action: 'delete', target: 'x', detail: 'delete it', unattended: true, now: NOW, makeId: mk});
      s.activity.push({id: 'act-1', at: NOW, botId: 'atlas', kind: 'perm', text: 'Atlas may browse a.com', threadId: 'atlas', undoUntil: null});
      return ask;
    }));
    assert.equal(t.store.get('SELECT count(*) AS n FROM grants').n, 2);
    assert.equal(t.store.get('SELECT status FROM asks WHERE id=?', id).status, 'pending');
    assert.equal(t.store.get('SELECT kind FROM activity').kind, 'perm');
    await t.store.close();
    const again = await openStore(path.join(t.dir, 'state.json'));
    try {
      const s = again.read();
      assert.equal(grantFor(s, 'atlas', 'browser.use', 'https://a.com'), 'always');
      assert.equal(grantFor(s, 'atlas', 'send', 'https://x.example'), 'deny');
      assert.equal(s.asks.length, 1);
      assert.equal(s.asks[0].expiresAt, '2026-11-12T10:00:00.000Z', 'the whole record comes back, not only its columns');
      assert.equal(s.asks[0].detail, 'delete it');
      assert.deepEqual(s.activity.map(a => [a.id, a.kind, a.threadId]), [['act-1', 'perm', 'atlas']]);
      await again.update(st => { st.grants = st.grants.filter(g => g.action !== 'send'); });
      assert.equal(again.get('SELECT count(*) AS n FROM grants').n, 1, 'a removed grant is deleted from the table');
    } finally { await again.close(); }
  } finally { await fs.rm(t.dir, {recursive: true, force: true}); }
});

test('backup: the new tables travel, restore, and a grant for a missing bot is ignored', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => {
      setGrant(s, 'atlas', 'post', 'https://x.example', 'always', NOW, {log: false});
      createAsk(s, {botId: 'atlas', runId: null, chatKey: 'atlas', action: 'send', target: 'x', now: NOW, makeId: mk});
      s.activity.push({id: 'act-1', at: NOW, botId: 'atlas', kind: 'bots', text: 'Atlas was created', threadId: null, undoUntil: null});
    });
    const document = backup.exportBackup(t.store);
    for (const name of ['asks', 'grants', 'activity']) assert.ok(Array.isArray(document.tables[name]), `${name} is exported`);
    assert.equal(document.tables.grants.length, 1);
    // A grant for a bot that is not in the restored company: the checksum is
    // recomputed the way an operator's own tool would, so only the content is in doubt.
    const doctored = JSON.parse(JSON.stringify(document));
    doctored.tables.grants.push({bot_id: 'ghost', action: 'send', scope: '', choice: 'always', at: NOW});
    const sealed = seal(doctored);
    const other = await sandbox();
    try {
      assert.doesNotThrow(() => backup.importBackup(other.store, sealed, {force: true}));
      const s = other.store.read();
      assert.equal(grantFor(s, 'ghost', 'send', ''), null, 'a grant for a missing bot is ignored');
      assert.equal(grantFor(s, 'atlas', 'post', 'https://x.example'), 'always', 'the real one is restored');
      assert.equal(s.asks.length, 1);
      assert.equal(s.activity.length, 1);
      // And the next write sweeps the orphan out of the table.
      await other.store.update(st => { st.settings.x = 1; });
      assert.equal(other.store.get('SELECT count(*) AS n FROM grants').n, 1);
    } finally { await other.done(); }
    // A document that tries to smuggle in Always allow for a payment is refused before anything is written.
    const smuggled = JSON.parse(JSON.stringify(document));
    smuggled.tables.grants.push({bot_id: 'atlas', action: 'spend', scope: '', choice: 'always', at: NOW});
    assert.throws(() => backup.validateBackup(seal(smuggled)), e => e.status === 400 && /spend|payment/i.test(e.message));
    const badChoice = JSON.parse(JSON.stringify(document));
    badChoice.tables.grants[0].choice = 'whenever';
    assert.throws(() => backup.validateBackup(seal(badChoice)), e => e.status === 400);
    const badAsk = JSON.parse(JSON.stringify(document));
    badAsk.tables.asks[0].doc = '[1,2]';
    assert.throws(() => backup.validateBackup(seal(badAsk)), e => e.status === 400);
    // A backup from before v12 has none of the tables and still restores.
    const old = JSON.parse(JSON.stringify(document));
    for (const name of ['asks', 'grants', 'activity']) delete old.tables[name];
    assert.doesNotThrow(() => backup.validateBackup(seal(old)));
  } finally { await t.done(); }
});
