// The watch sweep against a real store: a check opens the page as the watch's bot under the watch's own key, the
// next pass compares it, and the owner hears once. The page's words never reach the bot's chat, and the chat is
// not counted as having read outside content. A site the bot must ask about stops the watch at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {company} from './run-fixture.js';
import {watchPass} from '../src/watches.js';
import {addWatch} from '../shared/watches.js';
import {outsideRead} from '../shared/asks.js';
import {pauseAllSchedules} from '../shared/tasks.js';

/** A server browser that returns whatever `page.text` says, and counts what it opened. */
function fakeRuntime(page) {
  const opened = [];
  return {opened, mode: 'server', available: () => true, async run({url}) { opened.push(url); return {url, finalUrl: url, title: 'Shop', text: page.text}; }};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function rig(t) {
  const {store, ids} = await company(t);
  const sent = [], page = {text: 'Widget\nPrice: £12.99\nUpdated 2 min ago'}, runtime = fakeRuntime(page);
  let clock = Date.parse('2026-11-25T12:00:00Z');
  const pass = async () => { await watchPass(store, {notify: async e => { sent.push(e); }, runtime, now: () => clock}); await settle(); };
  const later = ms => { clock += ms; };
  const watch = await store.update(s => addWatch(s, {botId: ids.scholar, url: 'https://shop.example/item', every: 'hour'}, {now: new Date(clock).toISOString()}));
  return {store, ids, sent, page, runtime, pass, later, watch};
}

test('a change is said once on the phone and in one line in the bot\'s chat, without the page\'s words', async t => {
  const {store, ids, sent, page, runtime, pass, later, watch} = await rig(t);
  await pass();
  assert.deepEqual(runtime.opened, ['https://shop.example/item']);
  await pass();
  assert.equal(sent.length, 0, 'the first read is the baseline');
  assert.equal(store.read().browserRequests.filter(r => r.watchId).length, 0, 'a read watch request is removed');
  later(3600000); page.text = 'Widget\nPrice: £12.99\nUpdated 9 min ago';
  await pass(); await pass();
  assert.equal(sent.length, 0, 'a ticking clock is not a change');
  later(3600000); page.text = 'Widget\nPrice: £9.99';
  await pass(); await pass();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'watch');
  assert.equal(sent[0].urgent, false);
  assert.match(sent[0].body, /£9\.99/);
  const chat = store.read().chats[ids.scholar] || [];
  assert.equal(chat.filter(m => m.kind === 'watch').length, 1);
  assert.ok(chat.every(m => !String(m.text).includes('£')), 'the page\'s words stay out of the chat');
  assert.ok(chat.every(m => m.kind !== 'browser-result'));
  assert.equal(outsideRead(store.read(), {chatKey: ids.scholar}), false, 'the bot\'s chat has not read outside content');
  assert.ok(store.read().watches.find(w => w.id === watch.id).lastChangedAt);
});

test('a site the bot must ask about stops the watch at once, with how to let it through; nothing is opened', async t => {
  const {store, sent, runtime, pass} = await rig(t);
  await store.update(s => { s.askBasics = true; });
  await pass();
  assert.deepEqual(runtime.opened, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /cannot check shop\.example/);
  assert.match(sent[0].body, /Always allow/);
  assert.equal((store.read().asks || []).length, 0, 'a watch never leaves an ask nobody is there to answer');
});

test('no browser anywhere: failed checks are counted and said on the third', async t => {
  const {store, sent, pass, later} = await rig(t);
  const none = {mode: 'agent', available: () => false, run: async () => { throw new Error('no'); }};
  const passNone = async () => { await watchPass(store, {notify: async e => { sent.push(e); }, runtime: none}); await settle(); };
  for (let i = 0; i < 3; i++) {
    await store.update(s => { s.watches[0].nextAt = new Date(0).toISOString(); });
    await passNone(); await passNone();
  }
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.match(sent[0].body, /3 times in a row/);
  void pass; void later;
});

test('the kill switch holds watches like schedules', async t => {
  const {store, runtime, pass} = await rig(t);
  await store.update(s => pauseAllSchedules(s));
  await pass();
  assert.deepEqual(runtime.opened, []);
});

test('watches survive a restart, with what they last saw', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-watch-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const open = () => new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  let store = await open();
  await store.update(s => { s.groups[0].bots.push({id: 'scout', name: 'Scout', settings: {}}); addWatch(s, {botId: 'scout', url: 'https://a.example', every: 'day'}); s.watches[0].lines = ['a', 'b']; });
  await store.close();
  store = await open();
  t.after(() => store.close());
  assert.equal(store.read().watches.length, 1);
  assert.deepEqual(store.read().watches[0].lines, ['a', 'b']);
});
