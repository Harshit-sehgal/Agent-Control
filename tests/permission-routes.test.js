// The preset and Undo routes (owner only), a grant's end and Hands-off surviving a restart, and the Pages demo
// answering the same routes the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWebLocks} from './web-locks.js';
import {openStore} from '../src/sqlite-store.js';
import {createRouter} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {createAsk, grantFor} from '../shared/asks.js';
import * as wf from '../shared/workflow.js';

const later = ms => new Date(Date.now() + ms).toISOString();
const seed = s => { wf.migrate(s); s.groups = [{id: 'home', name: 'Home', settings: {}, bots: [{id: 'mail', name: 'Mailroom', instructions: 'Mail.', settings: {}}]}]; };

async function freshStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presets-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'db.sqlite');
  const store = await openStore(file);
  await store.update(seed);
  return {store, file};
}

test('the preset and restore routes are for the owner only', () => {
  const router = createRouter();
  groupRoutes(router, {});
  assert.equal(router.find('POST', '/api/permissions/preset').route.access, 'owner');
  assert.equal(router.find('POST', '/api/permissions/restore').route.access, 'owner');
});

test('a preset goes through the route, its Undo comes back, and Hands-off and a grant\'s end survive a restart', async t => {
  const {store, file} = await freshStore(t);
  const router = createRouter();
  groupRoutes(router, {});
  const call = (method, url, body) => { const f = router.find(method, url); return f.route.handler({store, params: f.params, actor: {email: 'owner@example.test'}, body: async () => body}); };
  const out = await call('POST', '/api/permissions/preset', {preset: 'handsOff'});
  assert.equal(out.preset, 'handsOff');
  assert.equal(store.read().handsOff, true);
  await assert.rejects(call('POST', '/api/permissions/preset', {preset: 'reckless'}), e => e.status === 400);
  await call('POST', '/api/grants', {botId: 'mail', action: 'post', scope: 'https://x.com', choice: 'always', until: later(3600000)});
  store.close?.();
  const again = await openStore(file);
  assert.equal(again.read().handsOff, true);
  assert.ok(again.read().grants[0].until, 'the end is stored');
  await again.update(s => { s.grants[0].until = later(-1000); });
  again.close?.();
  const third = await openStore(file);
  assert.equal(grantFor(third.read(), 'mail', 'post', 'https://x.com'), null, 'an ended grant is no answer');
  await third.update(s => { wf.migrate(s); }); // what a workspace's start-up runs (src/app.js)
  assert.equal(third.read().grants.length, 0, 'and it is swept on load');
  await third.update(s => { s.handsOff = false; });
  assert.equal(third.read().handsOff, false);
  third.close?.();
});

test('Always allow on an ask takes an end and returns its Undo; the restore route puts it back', async t => {
  const {store} = await freshStore(t);
  const router = createRouter();
  groupRoutes(router, {});
  const call = (method, url, body) => { const f = router.find(method, url); return f.route.handler({store, params: f.params, actor: {email: 'owner@example.test'}, body: async () => body}); };
  await store.update(s => { createAsk(s, {botId: 'mail', action: 'post', target: 'https://x.com/compose', makeId: () => 'a1'}); });
  const out = await call('POST', '/api/asks/a1', {answer: 'always', until: later(3600000)});
  assert.equal(grantFor(store.read(), 'mail', 'post', 'https://x.com'), 'always');
  assert.deepEqual(out.undo, {grants: [{botId: 'mail', action: 'post', scope: 'https://x.com', choice: null}]});
  await call('POST', '/api/permissions/restore', out.undo);
  assert.equal(store.read().grants.length, 0);
  await assert.rejects(call('POST', '/api/permissions/restore', {grants: [{botId: 'mail', action: 'spend', scope: '', choice: 'always'}]}), e => e.status === 400);
});

// The Pages demo answers the same routes.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let storage = {getItem: () => null, setItem: () => {}};
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, get: () => storage, set: value => { storage = value; }});
installWebLocks();
await import(path.join(root, 'shared/local-api.js'));

test('the Pages demo applies presets, takes an end on Always allow and restores the same way', async () => {
  const map = new Map();
  storage = {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
  const request = globalThis.window.AGENT_LOCAL_API;
  const out = await request('/api/permissions/preset', 'POST', {preset: 'careful'});
  assert.equal(out.preset, 'careful');
  assert.equal((await request('/api/state')).askBasics, true);
  await request('/api/permissions/restore', 'POST', out.undo);
  assert.equal((await request('/api/state')).askBasics, false);
  const bot = await request('/api/groups/home/bots', 'POST', {name: 'Scout', instructions: 'Looks things up.'});
  const g = await request('/api/grants', 'POST', {botId: bot.id, action: 'post', scope: 'https://x.com', choice: 'always', until: later(3600000)});
  assert.ok(g.until);
  await assert.rejects(request('/api/permissions/preset', 'POST', {preset: 'nope'}), e => e.status === 400);
});
