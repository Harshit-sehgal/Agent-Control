/** Google through the ask mechanism, the outside log and the Undo window (Phase 6, Task 3).
 *
 * A bot reads mail only after the owner says yes; sending asks as a write. An email send the owner has
 * Always-allowed is held for 30 seconds (here: a few milliseconds) so it can be undone, and is logged as having
 * left the app either way. The model is scripted; Google is the fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {answerAskFlow} from '../src/ask-runs.js';
import {HOLD, undoHeldSend, settleHeldOnStart} from '../src/held-sends.js';
import {setGrant} from '../shared/asks.js';
import {activityPage} from '../shared/activity-log.js';
import {company as plainCompany, model, ask} from './run-fixture.js';
// These tests are about the ask card, so the owner's switch to ask even before a page or a read is on.
const company = async (...a) => { const r = await plainCompany(...a); await r.store.update(s => { s.askBasics = true; }); return r; };
import {fakeGoogle, CLIENT} from './google-fixture.js';
import {connect, rig} from './google-rig.js';
import * as wf from '../shared/workflow.js';

const fence = (tool, args) => `On it.\n\`\`\`connector\n${JSON.stringify({use: 'google', tool, args})}\n\`\`\``;
const until = async (check, note) => { for (let i = 0; i < 400; i++) { const v = check(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw new Error(`timed out waiting for ${note}`); };
const runOf = (store, id) => store.read().groupRuns.find(r => r.id === id);
const MAIL = {to: 'bob@example.org', subject: 'Lunch', body: 'See you at noon.'};

/** Google connected on the run-fixture company's own store. */
async function world(t) {
  const r = await rig(t);
  await connect(r);
  const {store, ids} = await company(t);
  // Move the connected Google record, its vault rows and the workspace into the company store.
  const connectors = r.store.read().connectors;
  store.vaultKey = r.store.vaultKey;
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  for (const row of r.store.all('SELECT * FROM credentials')) store.run('INSERT INTO credentials (id,workspace_id,name,kind,ciphertext,iv,tag,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)', row.id, row.workspace_id, row.name, row.kind, row.ciphertext, row.iv, row.tag, row.created_by, row.created_at, row.expires_at);
  await store.update(s => { s.connectors = connectors; });
  HOLD.ms = 150;
  t.after(() => { HOLD.ms = 30000; });
  return {...r, store, ids, account: connectors[0].account};
}
const grant = (w, action, bot) => w.store.update(s => { setGrant(s, bot, action, w.account, 'always', undefined, {log: false}); });
const outside = store => activityPage(store.read(), {filter: 'outside', limit: 50}).items;

test('reading mail asks first, shows what it is, and returns the mail as untrusted data', async t => {
  const w = await world(t);
  const ai = model({Mailroom: e => (e.connectorResult ? `Report: ${e.connectorResult}` : fence('gmail.search', {query: 'rent'}))});
  const run = await ask(w.store, {message: 'Find the rent mail', to: w.ids.mail, executor: ai.executor});
  const [card] = w.store.read().asks;
  assert.deepEqual([card.action, card.target, card.detail], ['connector.google.read', w.account, 'search Gmail for "rent"']);
  assert.equal(w.google.calls('/gmail/v1/users/me/messages').length, 0, 'nothing was read before the answer');
  await answerAskFlow(w.store, card.id, 'allow', {actor: 'o', executor: ai.executor});
  await until(() => runOf(w.store, run.id).status === 'completed', 'the run');
  assert.match(ai.of('Mailroom')[1].connectorResult, /Subject of m1abc/);
  assert.match(ai.of('Mailroom')[1].restrictions.join(' '), /untrusted/i);
  assert.deepEqual(outside(w.store), [], 'a read does not leave the app');
});

test('a send asks as a write, apart from reading; Allow once sends at once and logs it as left the app, with no Undo', async t => {
  const w = await world(t);
  await grant(w, 'connector.google.read', w.ids.mail);
  const ai = model({Mailroom: e => (e.connectorResult ? `Done: ${e.connectorResult}` : fence('gmail.send', MAIL))});
  const run = await ask(w.store, {message: 'Email Bob', to: w.ids.mail, executor: ai.executor});
  const [card] = w.store.read().asks;
  assert.equal(card.action, 'connector.google.write.gmail.send');
  assert.match(card.detail, /^send an email to bob@example\.org \(outside your domain\): "Lunch" \(See you at noon\.\)$/);
  assert.deepEqual(w.google.state.sent, []);
  await answerAskFlow(w.store, card.id, 'allow', {actor: 'o', executor: ai.executor});
  await until(() => runOf(w.store, run.id).status === 'completed', 'the run');
  assert.equal(w.google.state.sent.length, 1, 'sent at once: the owner just read exactly this');
  const [entry] = outside(w.store);
  assert.equal(entry.kind, 'outside');
  assert.equal(entry.botId, w.ids.mail);
  assert.equal(entry.threadId, w.ids.mail);
  assert.match(entry.text, /Mailroom sent an email to bob@example\.org: "Lunch"/);
  assert.equal(entry.undoUntil, null);
});

test('an Always-allowed send is held, logged with an Undo window, and goes out when the window ends', async t => {
  const w = await world(t);
  await grant(w, 'connector.google.write.gmail.send', w.ids.mail);
  const ai = model({Mailroom: e => (e.connectorResult ? `Report: ${e.connectorResult}` : fence('gmail.send', MAIL))});
  const run = await ask(w.store, {message: 'Email Bob', to: w.ids.mail, executor: ai.executor});
  await until(() => runOf(w.store, run.id).status === 'completed', 'the run');
  assert.deepEqual(w.google.state.sent, [], 'held, not sent');
  const [entry] = outside(w.store);
  assert.ok(entry.undoUntil, 'the entry carries the Undo window');
  const left = Date.parse(entry.undoUntil) - Date.parse(entry.at);
  assert.ok(left > 0 && left <= 200, `the window is HOLD.ms (${left})`);
  assert.match(entry.text, /Mailroom is sending an email to bob@example\.org: "Lunch"/);
  assert.match(ai.of('Mailroom')[1].connectorResult, /will be sent in a moment unless the owner undoes it/);
  const line = w.store.read().chats[w.ids.mail].find(m => m.kind === 'connector' && m.activityId);
  assert.equal(line.activityId, entry.id);
  assert.equal(line.undoUntil, entry.undoUntil);
  await until(() => w.google.state.sent.length === 1, 'the window to end');
  assert.match(w.store.read().chats[w.ids.mail].filter(m => m.role === 'system').at(-1).text, /was sent/);
  assert.deepEqual(w.store.read().heldSends ?? [], []);
});

test('Undo inside the window cancels the send: nothing reaches Google, the log and the chat say so', async t => {
  const w = await world(t);
  await grant(w, 'connector.google.write.gmail.send', w.ids.mail);
  HOLD.ms = 1500;
  const ai = model({Mailroom: e => (e.connectorResult ? 'ok' : fence('gmail.send', MAIL))});
  const run = await ask(w.store, {message: 'Email Bob', to: w.ids.mail, executor: ai.executor});
  await until(() => runOf(w.store, run.id).status === 'completed', 'the run');
  const [entry] = outside(w.store);
  const out = await undoHeldSend(w.store, entry.id);
  assert.equal(out.ok, true);
  const after = outside(w.store);
  assert.equal(after.length, 2);
  assert.match(after[0].text, /Mailroom's email to bob@example\.org was not sent: you undid it/);
  assert.equal(after[1].undoUntil, null, 'the window is closed');
  await new Promise(r => setTimeout(r, 1700));
  assert.deepEqual(w.google.state.sent, []);
  await assert.rejects(undoHeldSend(w.store, entry.id), error => error.status === 409);
  await assert.rejects(undoHeldSend(w.store, 'nope'), error => error.status === 404);
});

test('Undo after the window is too late; a server restart during the window sends nothing and says so', async t => {
  const w = await world(t);
  await grant(w, 'connector.google.write.gmail.send', w.ids.mail);
  const ai = model({Mailroom: e => (e.connectorResult ? 'ok' : fence('gmail.send', MAIL))});
  const run = await ask(w.store, {message: 'Email Bob', to: w.ids.mail, executor: ai.executor});
  await until(() => w.google.state.sent.length === 1, 'the send');
  await assert.rejects(undoHeldSend(w.store, outside(w.store)[0].id), error => error.status === 409 && /already/i.test(error.message));
  // A hold the process no longer has a timer for (a restart): never sent, logged.
  HOLD.ms = 60000;
  const second = await ask(w.store, {message: 'Email Bob again', to: w.ids.mail, executor: ai.executor});
  await until(() => (w.store.read().heldSends || []).length === 1, 'the second hold');
  const {settleHeldOnStart: settle} = await import('../src/held-sends.js');
  await settle(w.store, {fresh: true});
  assert.equal(w.google.state.sent.length, 1, 'the held one was not sent');
  assert.match(outside(w.store)[0].text, /was not sent: the server restarted/);
  assert.deepEqual(w.store.read().heldSends, []);
  assert.ok(run.id && second.id);
});

test('a Google call while the connector needs reconnecting is refused with the reason, and no ask is made', async t => {
  const w = await world(t);
  await w.store.update(s => { s.connectors[0].status = 'reconnect'; s.connectors[0].statusMessage = 'Google sign-in expired or was revoked. Reconnect Google in Settings → Connectors.'; });
  const run = await ask(w.store, {message: 'Find mail', to: w.ids.mail, executor: model({Mailroom: fence('gmail.search', {query: 'x'})}).executor});
  assert.equal(run.status, 'completed');
  assert.deepEqual(w.store.read().asks, []);
  assert.match(w.store.read().chats[w.ids.mail].filter(m => m.role === 'system').map(m => m.text).join('\n'), /Google is not ready: Google sign-in expired/);
});

test('a revoked sign-in found at call time turns the connector to reconnect and tells the bot', async t => {
  const w = await world(t);
  await grant(w, 'connector.google.read', w.ids.mail);
  const {resetGoogleTokenCache} = await import('../src/google.js');
  resetGoogleTokenCache();
  w.google.revokeRefresh();
  const ai = model({Mailroom: e => (e.connectorResult ? `Report: ${e.connectorResult}` : fence('gmail.search', {query: 'x'}))});
  const run = await ask(w.store, {message: 'Find mail', to: w.ids.mail, executor: ai.executor});
  await until(() => runOf(w.store, run.id).status === 'completed', 'the run');
  assert.equal(w.store.read().connectors[0].status, 'reconnect');
  assert.match(ai.of('Mailroom')[1].connectorResult, /Reconnect Google/);
  assert.equal(w.store.read().chats[w.ids.mail].some(m => m.kind === 'connector-error'), true);
});
