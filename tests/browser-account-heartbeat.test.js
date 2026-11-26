/** Browser accounts on the device protocol (src/agent.js, src/routes-public.js): a computer reports each account's
 * sign-in state and hears which accounts it holds; a re-pair that proves the old secret keeps them; and a backup
 * carries names only. A cookie value never reaches the server's store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createApp} from '../src/app.js';
import {browserLive} from '../src/browser-live.js';
import {createRouter} from '../src/router.js';
import {browserAccountRoutes} from '../src/routes-browser-accounts.js';
import {exportBackup, importBackup} from '../src/backup.js';

const A = '0b6f1c2e-4d5a-4b8c-9e1f-2a3b4c5d6e7f', B = '1c7a2d3f-5e6b-4c9d-8f2a-3b4c5d6e7f80';
const acct = (id, deviceId, name = `Account ${id.slice(0, 4)}`) => ({id, name, site: 'crm.example.com', deviceId, storage: 'cookies'});
const proofOf = (secret, code) => crypto.createHmac('sha256', secret).update(`re-pair\n${code}`).digest('hex');

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-account-beat-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  t.after(async () => { browserLive.close(); await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  await store.update(s => { wf.migrate(s); });
  const app = createApp({store, auth: {session: () => null}, workspaces: {get: () => store, holding: () => store}, push: {}, version: 't'});
  const send = async (url, text, headers = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(text)]), {method: 'POST', url, headers: {host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...headers}, socket: {remoteAddress: '127.0.0.1'}});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  let lastTs = 0;
  const beatAs = (device, body) => {
    const url = '/api/agent/heartbeat', text = JSON.stringify(body);
    const ts = Math.max(Date.now(), lastTs + 1);
    lastTs = ts;
    return send(url, text, {'x-agent-id': device.agentId, 'x-agent-ts': String(ts), 'x-agent-sig': agent.signRequest(device.secret, {method: 'POST', url, path: url, timestamp: ts, body: text})});
  };
  const pair = body => send('/api/agent/pair', JSON.stringify(body));
  const newCode = (workspaceId = 'default') => agent.createPairing(store, workspaceId, {}).code;
  const first = agent.redeemPairing(store, {code: newCode(), name: 'Laptop', permissions: ['http.check']});
  return {store, send, pair, newCode, beatAs, device: first, beat: body => beatAs(first, body), deviceId: first.agentId};
}

test('a heartbeat records its own accounts\' states, never a cookie, and hears the accounts it holds', async t => {
  const {store, beat, deviceId} = await harness(t);
  await store.update(s => { s.browserAccounts = [acct(A, deviceId), acct(B, 'other-pc')]; });
  const {body: reply} = await beat({accounts: [{id: A, state: 'signed-in', cookies: [{name: 'sid', value: 'MARKER-COOKIE'}]}, {id: B, state: 'signed-in'}, {id: 'not-an-id', state: 'signed-in'}]});
  assert.deepEqual(reply.accounts, [{id: A, site: 'crm.example.com'}]);
  const kept = store.kvGet(`agent_accounts:${deviceId}`);
  // The jar's `cookies` key and the planted value must be absent (the value "cookies" is the storage kind).
  assert.doesNotMatch(kept, /MARKER-COOKIE|"cookies"\s*:/);
  const rows = agent.readAccountReports(store, deviceId);
  assert.deepEqual(rows.map(r => [r.id, r.state, r.storage]), [[A, 'signed-in', 'cookies']], 'only the account on this computer');
  assert.ok(Date.parse(rows[0].checkedAt) > 0, 'each entry says when it was reported');
  await beat({});
  assert.equal(agent.readAccountReports(store, deviceId).length, 1, 'an older app sends no field: the last report stands');
  await beat({accounts: 'garbage'});
  assert.equal(agent.readAccountReports(store, deviceId).length, 1, 'a field that is not a list changes nothing');
  await beat({accounts: [{id: A, state: 'signed-out', lost: true}]});
  assert.deepEqual(agent.readAccountReports(store, deviceId).map(r => [r.state, r.lost]), [['signed-out', true]]);
  await beat({accounts: []});
  assert.deepEqual(agent.readAccountReports(store, deviceId), [], 'an empty list is a report: nothing is signed in');
  assert.deepEqual(agent.readAccountReports(store, 'nobody'), [], 'no report reads as none');
});

test('the owner\'s list reads each account\'s reported state, and signed out when nothing was reported', async t => {
  const {store, beat, deviceId} = await harness(t);
  await store.update(s => { s.browserAccounts = [acct(A, deviceId), acct(B, deviceId)]; });
  const router = createRouter();
  browserAccountRoutes(router, {});
  const list = async () => {
    const found = router.find('GET', '/api/browser-accounts');
    const out = await found.route.handler({store, actor: {role: 'owner', workspaceId: 'default'}, params: {}});
    return Object.fromEntries(out.accounts.map(a => [a.id, a]));
  };
  let rows = await list();
  assert.deepEqual([rows[A].state, rows[A].lost, rows[A].checkedAt], ['signed-out', false, null]);
  await beat({accounts: [{id: A, state: 'signed-in'}, {id: B, state: 'signed-out', lost: true}]});
  rows = await list();
  assert.equal(rows[A].state, 'signed-in');
  assert.equal(rows[A].lost, false);
  assert.ok(Date.parse(rows[A].checkedAt) > 0);
  assert.deepEqual([rows[B].state, rows[B].lost], ['signed-out', true]);
  await store.update(s => { s.browserAccounts[0].deviceId = 'moved-pc'; });
  assert.deepEqual([(await list())[A].state, (await list())[A].checkedAt], ['signed-out', null], 'moved to a computer that has not reported');
});

test('a re-pair that proves the old secret moves the accounts and pins, and revokes the old computer', async t => {
  const {store, pair, newCode, beatAs, device: d1} = await harness(t);
  await store.update(s => {
    s.browserAccounts = [acct(A, d1.agentId), acct(B, 'someone-elses-pc')];
    s.groups.push({id: 'g-t', name: 'Team', bots: [{id: 'atlas', name: 'Atlas', settings: {device: d1.agentId}}, {id: 'zed', name: 'Zed', settings: {device: 'someone-elses-pc'}}]});
  });
  const code = newCode();
  const paired = await pair({code, name: 'Laptop again', previous: {agentId: d1.agentId, proof: proofOf(d1.secret, code)}});
  assert.equal(paired.status, 201);
  assert.ok(!('replaces' in paired.body), 'the reply says nothing of what was replaced');
  const d2 = paired.body;
  assert.notEqual(d2.agentId, d1.agentId);
  const s = store.read();
  assert.deepEqual(s.browserAccounts.map(a => a.deviceId), [d2.agentId, 'someone-elses-pc']);
  const bots = Object.fromEntries(s.groups.flatMap(g => g.bots).map(b => [b.id, b.settings?.device]));
  assert.equal(bots.atlas, d2.agentId);
  assert.equal(bots.zed, 'someone-elses-pc');
  assert.ok(store.get('SELECT revoked_at FROM agents WHERE id=?', d1.agentId).revoked_at, 'the old computer is revoked');
  assert.equal(store.get('SELECT revoked_at FROM agents WHERE id=?', d2.agentId).revoked_at, null);
  assert.equal((await beatAs(d1, {})).status, 403, 'the old secret no longer works');
  const beat = await beatAs(d2, {});
  assert.deepEqual(beat.body.accounts, [{id: A, site: 'crm.example.com'}], 'the new computer hears its accounts on its first beat');
});

test('a wrong proof, or an old computer in another workspace, pairs a new computer and moves nothing', async t => {
  const {store, pair, newCode, device: d1} = await harness(t);
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('other','Other',?)", new Date().toISOString());
  const foreign = agent.redeemPairing(store, {code: newCode('other'), name: 'Foreign PC'});
  await store.update(s => { s.browserAccounts = [acct(A, d1.agentId), acct(B, foreign.agentId)]; });
  const moved = () => store.read().browserAccounts.map(a => a.deviceId);
  const revoked = id => store.get('SELECT revoked_at FROM agents WHERE id=?', id).revoked_at;
  const cases = {
    'a proof for another code': (code) => ({agentId: d1.agentId, proof: proofOf(d1.secret, 'SOMEOTHERCODE')}),
    'the wrong secret': code => ({agentId: d1.agentId, proof: proofOf('not-the-secret', code)}),
    'no proof': () => ({agentId: d1.agentId}),
    'a proof that is not hex': () => ({agentId: d1.agentId, proof: 'zz'.repeat(32)}),
    'a proof that is not a string': () => ({agentId: d1.agentId, proof: 7}),
    'an unknown computer': code => ({agentId: 'no-such-pc', proof: proofOf(d1.secret, code)}),
    'previous that is not an object': () => 'nope',
    'a computer of another workspace, rightly proved': code => ({agentId: foreign.agentId, proof: proofOf(foreign.secret, code)}),
  };
  for (const [label, make] of Object.entries(cases)) {
    const code = newCode();
    const paired = await pair({code, name: 'New', previous: make(code)});
    assert.equal(paired.status, 201, label);
    assert.notEqual(paired.body.agentId, d1.agentId, label);
    assert.deepEqual(moved(), [d1.agentId, foreign.agentId], `${label}: nothing moved`);
    assert.equal(revoked(d1.agentId), null, `${label}: the old computer stays`);
    assert.equal(revoked(foreign.agentId), null, label);
  }
  // A revoked old computer cannot be replaced either, even with a good proof.
  agent.revokeAgent(store, d1.agentId);
  const code = newCode();
  const paired = await pair({code, name: 'New', previous: {agentId: d1.agentId, proof: proofOf(d1.secret, code)}});
  assert.equal(paired.status, 201);
  assert.deepEqual(moved(), [d1.agentId, foreign.agentId], 'a revoked computer\'s accounts are not moved');
});

test('a backup carries account names, never a report, and a restore reads every account signed out', async t => {
  const {store, beat, deviceId} = await harness(t);
  await store.update(s => { s.browserAccounts = [acct(A, deviceId, 'CRM'), acct(B, deviceId, 'Billing')]; });
  await beat({accounts: [{id: A, state: 'signed-in', jar: 'MARKER-JAR'}, {id: B, state: 'signed-in'}]});
  const document = JSON.parse(JSON.stringify(exportBackup(store)));
  const row = document.tables.owner_settings.find(r => r.key === 'browser_accounts');
  assert.ok(row, 'the accounts travel');
  assert.deepEqual(JSON.parse(row.value).map(a => Object.keys(a).sort()), Array(2).fill(['deviceId', 'id', 'name', 'site', 'storage']));
  assert.doesNotMatch(JSON.stringify(document), /agent_accounts|MARKER-JAR/);

  const other = await new SqliteStore(path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-account-restore-')), 'state.db'), path.join(os.tmpdir(), `unused-${process.pid}.json`)).init();
  t.after(async () => { await other.close(); });
  // The target already holds a stale report: a restore drops it, so each account reads signed out.
  other.kvSet(`agent_accounts:${deviceId}`, JSON.stringify([{id: A, state: 'signed-in', storage: 'cookies', checkedAt: new Date().toISOString()}]));
  other.kvSet('agent_accounts:another', '[]');
  other.kvSet('agent_features:keep', '[]');
  importBackup(other, document, {force: true});
  assert.deepEqual(other.read().browserAccounts.map(a => a.name), ['CRM', 'Billing']);
  assert.equal(other.get("SELECT count(*) AS n FROM kv WHERE key LIKE 'agent\\_accounts:%' ESCAPE '\\'").n, 0, 'every report is gone');
  assert.deepEqual(agent.readAccountReports(other, deviceId), []);
  assert.notEqual(other.kvGet('agent_features:keep'), null, 'other kv keys stay');
  const router = createRouter();
  browserAccountRoutes(router, {});
  const out = await router.find('GET', '/api/browser-accounts').route.handler({store: other, actor: {role: 'owner', workspaceId: 'default'}, params: {}});
  assert.deepEqual(out.accounts.map(a => [a.name, a.state, a.checkedAt]), [['CRM', 'signed-out', null], ['Billing', 'signed-out', null]]);
});
