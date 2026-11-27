/** Browser accounts over HTTP (src/routes-browser-accounts.js): the owner alone lists, adds, renames, moves and
 * deletes them; a bot's `browserAccount` is the owner's to set and must name a real one; and they are stored in kv
 * `browser_accounts` under schema v15. The dispatcher's role check is repeated in the rig, as src/app.js does it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ACCOUNT_ID} from '../shared/bot-settings.js';
import {SqliteStore, SCHEMA_DB_VERSION} from '../src/sqlite-store.js';
import {createRouter, isReply, allows} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {browserAccountRoutes} from '../src/routes-browser-accounts.js';
import {DEFAULT_WORKSPACE} from '../src/auth.js';

const services = new Proxy(function stub() { return stub; }, {get: () => services, apply: () => services});
const OWNER_ONLY = "Only the owner can choose which browser account a bot signs in as.";
const GONE = "That browser account does not exist. Choose one in Settings → Local agents, or use the computer's own browser.";
const NOT_PAIRED = "That computer is not paired. Choose one in Settings → Local agents.";
const UNKNOWN_UUID = '0b6f1c2e-4d5a-4b8c-9e1f-2a3b4c5d6e7f';

async function rig(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-browser-accounts-'));
  const dbPath = path.join(dir, 'state.db'), jsonPath = path.join(dir, 'state.json');
  const store = await new SqliteStore(dbPath, jsonPath).init();
  t.after(async () => { await store.close().catch(() => {}); await rm(dir, {recursive: true, force: true}); });
  const router = createRouter();
  groupRoutes(router, services);
  browserAccountRoutes(router, services);
  const mk = role => async (method, pattern, body) => {
    const found = router.find(method, pattern);
    assert.ok(found, `${method} ${pattern} is not registered`);
    const actor = {email: `${role}@example.test`, role, userId: role, workspaceId: DEFAULT_WORKSPACE};
    try {
      if (!allows(role, found.route.access)) throw Object.assign(new Error(`needs ${found.route.access}`), {status: 403});
      const result = await found.route.handler({store, actor, params: found.params, req: {headers: {}}, path: pattern, raw: async () => JSON.stringify(body ?? {}), body: async () => body ?? {}});
      return isReply(result) ? {status: result.status, body: result.body} : {status: 200, body: result};
    } catch (error) { return {status: error.status || 500, body: {error: error.message}}; }
  };
  const now = new Date().toISOString();
  store.run('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING', DEFAULT_WORKSPACE, 'Main', now);
  const pc = 'dev-live', gone = 'dev-gone';
  for (const id of [pc, gone]) store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,permissions,paired_at) VALUES (?,?,?,?,?,?)', id, DEFAULT_WORKSPACE, id, 'x$y', '[]', now);
  store.run('UPDATE agents SET revoked_at=? WHERE id=?', now, gone);
  store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,permissions,paired_at) VALUES (?,?,?,?,?,?)', 'dev-other-ws', 'other', 'other', 'x$y', '[]', now);
  return {owner: mk('owner'), member: mk('member'), store, pcId: pc, goneId: gone, dbPath, jsonPath};
}

test('only the owner lists, adds, renames, moves and deletes accounts', async t => {
  const {owner, member, pcId, goneId} = await rig(t);
  assert.equal((await owner('POST', '/api/browser-accounts', {name: 'CRM', site: 'crm.example.com', deviceId: pcId})).status, 201);
  assert.equal((await member('GET', '/api/browser-accounts')).status, 403);
  assert.equal((await member('POST', '/api/browser-accounts', {name: 'M', site: 'm.example.com', deviceId: pcId})).status, 403);
  const [acct] = (await owner('GET', '/api/browser-accounts')).body.accounts;
  assert.match(acct.id, ACCOUNT_ID);
  assert.deepEqual([acct.state, acct.lost, acct.checkedAt, acct.storage, acct.deviceId], ['signed-out', false, null, 'cookies', pcId]);
  assert.equal((await member('PATCH', `/api/browser-accounts/${acct.id}`, {name: 'Nope'})).status, 403);
  assert.equal((await member('DELETE', `/api/browser-accounts/${acct.id}`)).status, 403);
  // A computer that is unknown, revoked or in another workspace is refused on add and on move.
  for (const deviceId of ['nope', goneId, 'dev-other-ws']) {
    const r = await owner('POST', '/api/browser-accounts', {name: 'X', site: 'x.com', deviceId});
    assert.deepEqual([r.status, r.body.error], [400, NOT_PAIRED], deviceId);
    const m = await owner('PATCH', `/api/browser-accounts/${acct.id}`, {deviceId});
    assert.deepEqual([m.status, m.body.error], [400, NOT_PAIRED], deviceId);
  }
  assert.equal((await owner('PATCH', `/api/browser-accounts/${acct.id}`, {name: 'Sales CRM'})).body.name, 'Sales CRM');
  assert.equal((await owner('PATCH', `/api/browser-accounts/${acct.id}`, {name: 'Sales CRM', deviceId: pcId})).status, 200);
  assert.equal((await owner('DELETE', `/api/browser-accounts/${acct.id}`)).body.ok, true);
  assert.deepEqual((await owner('GET', '/api/browser-accounts')).body.accounts, []);
});

test('a bot\'s account is the owner\'s to set, must exist, and an account in use cannot be deleted', async t => {
  const {owner, member, pcId, store} = await rig(t);
  const acct = (await owner('POST', '/api/browser-accounts', {name: 'CRM', site: 'crm.example.com', deviceId: pcId})).body;
  const group = (await owner('POST', '/api/groups', {name: 'Home'})).body.id;
  const base = `/api/groups/${group}/bots`;
  const bot = (await owner('POST', base, {name: 'Atlas', instructions: 'Read pages'})).body;
  const patch = (who, settings) => who('PATCH', `${base}/${bot.id}`, {settings});
  const pinned = () => store.read().groups.find(g => g.id === group).bots.find(b => b.id === bot.id).settings?.browserAccount ?? null;

  let r = await patch(member, {browserAccount: acct.id});
  assert.deepEqual([r.status, r.body.error], [403, OWNER_ONLY]);
  r = await patch(member, {browserAccount: null});
  assert.equal(r.status, 403, "even clearing is the owner's");
  assert.equal(pinned(), null);
  r = await patch(owner, {browserAccount: UNKNOWN_UUID});
  assert.deepEqual([r.status, r.body.error], [400, GONE]);
  assert.equal(pinned(), null);

  // The create route is guarded the same way, and nothing is created on a refusal.
  const before = store.read().groups.find(g => g.id === group).bots.length;
  r = await member('POST', base, {name: 'M1', instructions: 'x', settings: {browserAccount: acct.id}});
  assert.deepEqual([r.status, r.body.error], [403, OWNER_ONLY]);
  r = await owner('POST', base, {name: 'O1', instructions: 'x', settings: {browserAccount: UNKNOWN_UUID}});
  assert.deepEqual([r.status, r.body.error], [400, GONE]);
  assert.equal(store.read().groups.find(g => g.id === group).bots.length, before);
  r = await member('POST', base, {name: 'M2', instructions: 'x', settings: {style: 'brief'}});
  assert.equal(r.status, 201, 'a member still creates a bot with no account');
  r = await owner('POST', base, {name: 'O2', instructions: 'x', settings: {browserAccount: acct.id}});
  assert.equal(r.status, 201);
  const o2 = r.body.id;
  assert.equal((await owner('PATCH', `${base}/${o2}`, {settings: {browserAccount: ''}})).status, 200);

  r = await patch(owner, {browserAccount: acct.id});
  assert.equal(r.status, 200);
  assert.equal(pinned(), acct.id);
  r = await owner('DELETE', `/api/browser-accounts/${acct.id}`);
  assert.deepEqual([r.status, r.body.error], [409, 'Bots still sign in as this account: Atlas. Choose another account on their Edit pages first.']);
  r = await patch(member, {style: 'long'});
  assert.equal(r.status, 200);
  assert.equal(pinned(), acct.id, 'a member saving another field keeps the account');
  assert.equal((await patch(owner, {browserAccount: null})).status, 200);
  assert.equal((await owner('DELETE', `/api/browser-accounts/${acct.id}`)).status, 200);
});

test('accounts survive a restart, and the schema is v15', async t => {
  const {owner, pcId, store, dbPath, jsonPath} = await rig(t);
  assert.equal(SCHEMA_DB_VERSION, 15);
  const {state, lost, checkedAt, ...acct} = (await owner('POST', '/api/browser-accounts', {name: 'CRM', site: 'crm.example.com', deviceId: pcId})).body;
  assert.equal(state, 'signed-out');
  assert.equal(store.get('SELECT version FROM schema_meta WHERE id=1').version, 15);
  await store.close();
  const reopened = await new SqliteStore(dbPath, jsonPath).init();
  t.after(() => reopened.close());
  assert.deepEqual(reopened.read().browserAccounts, [acct]);
  assert.deepEqual(JSON.parse(reopened.kvGet('browser_accounts')), [acct]);
});
