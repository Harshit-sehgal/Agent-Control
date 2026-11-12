/** Every bot can do the basics without the owner tapping a card: open web pages and read the apps that are
 * connected. Anything that leaves a mark (send, post, delete, a connector write) still asks until the owner
 * says Always allow, and a payment asks every time. The owner's own Ask each time or Deny still wins. And once a
 * run has read private data from a connector, a page on a site it has no grant for asks again, so read data
 * cannot be carried off to a site on its own. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {verdict, decide, setGrant, BASIC_ACCESS, isBasicAccess} from '../shared/asks.js';
import * as wf from '../shared/workflow.js';

const state = () => wf.migrate({
  settings: {}, runs: [], tasks: [], events: [], groupMessages: {}, groupRuns: [],
  groups: [{id: 'home', name: 'Home', bots: [{id: 'a', name: 'Atlas', instructions: 'lead'}, {id: 'b', name: 'Mailroom', instructions: 'mail'}]}],
});
const atlas = {id: 'a', name: 'Atlas'};

test('opening a page and reading a connector need no answer', () => {
  const s = state();
  assert.deepEqual(BASIC_ACCESS, ['browser.use', 'connector read']);
  assert.equal(isBasicAccess('browser.use'), true);
  assert.equal(isBasicAccess('connector.notes.read'), true);
  assert.equal(verdict(s, atlas, 'browser.use', 'https://news.example/today').verdict, 'allow');
  assert.equal(verdict(s, atlas, 'connector.notes.read', 'me@example.com').verdict, 'allow');
});

test('anything that leaves a mark still asks, and a payment always does', () => {
  const s = state();
  for (const action of ['send', 'post', 'delete', 'spend', 'connector.notes.write.add_note']) {
    assert.equal(isBasicAccess(action), false, action);
    assert.equal(verdict(s, atlas, action, action.startsWith('connector') ? 'me@example.com' : 'https://shop.example/').verdict, 'ask', action);
  }
});

test('the owner\'s Ask each time and Deny still win over the basics', () => {
  const s = state();
  setGrant(s, 'a', 'browser.use', 'https://bank.example', 'ask', undefined, {log: false});
  setGrant(s, 'a', 'connector.notes.read', 'me@example.com', 'deny', undefined, {log: false});
  assert.equal(verdict(s, atlas, 'browser.use', 'https://bank.example/login').verdict, 'ask');
  assert.equal(verdict(s, atlas, 'connector.notes.read', 'me@example.com').verdict, 'deny');
  assert.equal(verdict(s, atlas, 'browser.use', 'https://news.example/').verdict, 'allow', 'other sites keep the basics');
});

test('after reading private data, a new site asks; a site it was always allowed does not', () => {
  const s = state();
  setGrant(s, 'a', 'browser.use', 'https://docs.example', 'always', undefined, {log: false});
  const guarded = {readPrivate: true};
  assert.equal(verdict(s, atlas, 'browser.use', 'https://elsewhere.example/?q=x', guarded).verdict, 'ask');
  assert.equal(verdict(s, atlas, 'browser.use', 'https://docs.example/page', guarded).verdict, 'allow');
  // The guard covers connector reads too; the caller drops it for a connector that supplied the data (connectors.js).
  assert.equal(verdict(s, atlas, 'connector.notes.read', 'me@example.com', guarded).verdict, 'ask', 'a guarded read on another connector asks');
  assert.equal(verdict(s, atlas, 'connector.notes.read', 'me@example.com', {readPrivate: false}).verdict, 'allow', 'reading more of the same connector is fine');
  assert.equal(decide(s, atlas, [{action: 'browser.use', target: 'https://elsewhere.example/'}], guarded).verdict, 'ask');
  assert.equal(decide(s, atlas, [{action: 'browser.use', target: 'https://elsewhere.example/'}]).verdict, 'allow');
});

test('the owner can switch the basics to ask, and the switch survives a restart', async t => {
  const s = state();
  s.askBasics = true;
  assert.equal(verdict(s, atlas, 'browser.use', 'https://news.example/').verdict, 'ask');
  assert.equal(verdict(s, atlas, 'connector.notes.read', 'me@example.com').verdict, 'ask');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const {openStore} = await import('../src/sqlite-store.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'basics-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'db.sqlite');
  const store = await openStore(file);
  assert.equal(store.read().askBasics, false, 'off unless the owner turns it on');
  await store.update(x => { x.askBasics = true; });
  store.close?.();
  assert.equal((await openStore(file)).read().askBasics, true);
});
