/** A bot may be pinned to one paired computer. Only the owner sets it, and no
 * model text ever can: `device` is outside BOT_SETTABLE and buildCreatedBot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BOT_DEFAULTS, validateBotSettings, pinnedDevice} from '../shared/bot-settings.js';
import {BOT_SETTABLE, resolveSetup} from '../shared/setup.js';
import {buildCreatedBot, validateCreateBotRequest} from '../shared/bot-create.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {createRouter, isReply} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {DEFAULT_WORKSPACE} from '../src/auth.js';

const services = new Proxy(function stub() { return stub; }, {get: () => services, apply: () => services});
const BAD = /^Error: A computer must be a paired computer's id, or empty for any computer\.$/;
const OWNER_ONLY = "Only the owner can choose which computer a bot uses.";
const NOT_PAIRED = "That computer is not paired. Choose one in Settings → Local agents, or use any computer.";

function harness(register) {
  const router = createRouter();
  register(router, services);
  return async (store, {method, path: pattern, params = {}, body, actor}) => {
    const found = router.find(method, pattern.replace(/:([a-z]+)/g, (_, name) => params[name]));
    assert.ok(found, `${method} ${pattern} is not registered`);
    try {
      const result = await found.route.handler({
        store, actor, params, req: {headers: {}}, path: pattern,
        raw: async () => JSON.stringify(body ?? {}),
        body: async () => body ?? {},
      });
      return isReply(result) ? {status: result.status, body: result.body} : {status: 200, body: result};
    } catch (error) {
      return {status: error.status || 500, body: {error: error.message}};
    }
  };
}

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-device-pin-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close?.(); await rm(dir, {recursive: true, force: true}); });
  return store;
}

test('device is a bot setting: null by default, an id or empty, nothing else', () => {
  assert.equal(BOT_DEFAULTS.device, null);
  assert.equal(validateBotSettings({device: '1b2c-3d4e'}).device, '1b2c-3d4e');
  assert.equal(validateBotSettings({device: ''}, {device: 'x'}).device, null);
  assert.equal(validateBotSettings({device: null}, {device: 'x'}).device, null);
  for (const bad of [7, true, {}, 'has space', 'x'.repeat(65)]) assert.throws(() => validateBotSettings({device: bad}), BAD);
  assert.equal(validateBotSettings({style: 'brief'}, {device: 'a1'}).device, 'a1', 'saving another field keeps the pin');
});

test('pinnedDevice reads a bot in any group', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'atlas', settings: {}}]}, {id: 'lab', bots: [{id: 'web', settings: {device: 'a1'}}]}]};
  assert.deepEqual([pinnedDevice(state, 'web'), pinnedDevice(state, 'atlas'), pinnedDevice(state, 'gone')], ['a1', null, null]);
  assert.equal(pinnedDevice({}, 'web'), null);
});

test('no model text sets a pin: not a setup card, not a new-bot block', () => {
  assert.equal(BOT_SETTABLE.includes('device'), false);
  const state = {groups: [{id: 'home', bots: [{id: 'web', name: 'Web', instructions: 'x', settings: {}}]}]};
  assert.match(resolveSetup(state, {action: 'settings', bot: 'Web', settings: {device: 'a1'}}).error, /nothing to change/);
  const made = buildCreatedBot(validateCreateBotRequest({name: 'Scout', job: 'Read the supplier pages each morning', device: 'a1', settings: {device: 'a1'}}), {bot: {id: 'atlas'}});
  assert.equal(Object.hasOwn(made.settings, 'device'), false);
});

test('only the owner pins, and only to a computer paired here', async t => {
  const store = await workspace(t);
  const call = harness(groupRoutes);
  const owner = {email: 'owner@example.test', role: 'owner', userId: 'u1'};
  const member = {email: 'member@example.test', role: 'member', userId: 'u2'};
  const now = new Date().toISOString();
  store.run('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING', DEFAULT_WORKSPACE, 'Main', now);
  for (const id of ['dev-live', 'dev-gone']) store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,permissions,paired_at) VALUES (?,?,?,?,?,?)', id, DEFAULT_WORKSPACE, id, 'x$y', '[]', now);
  store.run('UPDATE agents SET revoked_at=? WHERE id=?', now, 'dev-gone');

  const made = await call(store, {actor: owner, method: 'POST', path: '/api/groups', body: {name: 'Home'}});
  assert.equal(made.status, 201);
  const group = made.body.id;
  const bot = await call(store, {actor: owner, method: 'POST', path: '/api/groups/:group/bots', params: {group}, body: {name: 'Web', instructions: 'Read pages'}});
  assert.equal(bot.status, 201);
  const patch = (actor, settings) => call(store, {actor, method: 'PATCH', path: '/api/groups/:group/bots/:bot', params: {group, bot: bot.body.id}, body: {settings}});
  const pin = () => pinnedDevice(store.read(), bot.body.id);

  // A member cannot pin, and the bot is unchanged; the rest of the settings stay theirs.
  let r = await patch(member, {device: 'dev-live'});
  assert.deepEqual([r.status, r.body.error], [403, OWNER_ONLY]);
  r = await patch(member, {device: null});
  assert.equal(r.status, 403, 'even clearing is the owner\'s');
  assert.equal(pin(), null);
  r = await patch(member, {style: 'brief'});
  assert.equal(r.status, 200);

  // An unknown or revoked computer is refused.
  for (const id of ['nope', 'dev-gone']) {
    r = await patch(owner, {device: id});
    assert.deepEqual([r.status, r.body.error], [400, NOT_PAIRED]);
  }
  assert.equal(pin(), null);

  // A live one is saved; null clears it; empty clears it.
  r = await patch(owner, {device: 'dev-live'});
  assert.equal(r.status, 200);
  assert.equal(pin(), 'dev-live');
  r = await patch(member, {style: 'long'});
  assert.equal(r.status, 200);
  assert.equal(pin(), 'dev-live', 'a member saving another field keeps the pin');
  r = await patch(owner, {device: null});
  assert.equal(r.status, 200);
  assert.equal(pin(), null);
  await patch(owner, {device: 'dev-live'});
  r = await patch(owner, {device: ''});
  assert.equal(r.status, 200);
  assert.equal(pin(), null);

  // A new bot: the owner may pin, a member may not, and nothing is created on refusal.
  const create = (actor, settings) => call(store, {actor, method: 'POST', path: '/api/groups/:group/bots', params: {group}, body: {name: `B${Math.random()}`, instructions: 'x', settings}});
  const before = store.read().groups.find(g => g.id === group).bots.length;
  r = await create(member, {device: 'dev-live'});
  assert.deepEqual([r.status, r.body.error], [403, OWNER_ONLY]);
  r = await create(owner, {device: 'dev-gone'});
  assert.deepEqual([r.status, r.body.error], [400, NOT_PAIRED]);
  assert.equal(store.read().groups.find(g => g.id === group).bots.length, before);
  r = await create(owner, {device: 'dev-live'});
  assert.equal(r.status, 201);
  assert.equal(pinnedDevice(store.read(), r.body.id), 'dev-live');
  r = await create(member, {style: 'brief'});
  assert.equal(r.status, 201, 'a member still creates a bot without a pin');
});
