/** Hands-off end to end, through the real connector path: a bot reads mail (outside content), then sends.
 * The send asks the owner even though Hands-off is on, and nothing leaves the app until the owner answers.
 * The model is scripted; Google is the fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {answerAskFlow} from '../src/ask-runs.js';
import {HOLD} from '../src/held-sends.js';
import {setGrant} from '../shared/asks.js';
import {company as plainCompany, model, ask} from './run-fixture.js';
import {fakeGoogle, CLIENT} from './google-fixture.js';
import {connect, rig} from './google-rig.js';
import * as wf from '../shared/workflow.js';

const company = async (...a) => { const r = await plainCompany(...a); await r.store.update(s => { s.askBasics = true; }); return r; };
const fence = (tool, args) => `On it.\n\`\`\`connector\n${JSON.stringify({use: 'google', tool, args})}\n\`\`\``;
const until = async (check, note) => { for (let i = 0; i < 400; i++) { const v = check(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw new Error(`timed out waiting for ${note}`); };
const MAIL = {to: 'bob@example.org', subject: 'Lunch', body: 'See you at noon.'};

async function world(t) {
  const r = await rig(t);
  await connect(r);
  const {store, ids} = await company(t);
  const connectors = r.store.read().connectors;
  store.vaultKey = r.store.vaultKey;
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  for (const row of r.store.all('SELECT * FROM credentials')) store.run('INSERT INTO credentials (id,workspace_id,name,kind,ciphertext,iv,tag,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)', row.id, row.workspace_id, row.name, row.kind, row.ciphertext, row.iv, row.tag, row.created_by, row.created_at, row.expires_at);
  await store.update(s => { s.connectors = connectors; });
  HOLD.ms = 150;
  t.after(() => { HOLD.ms = 30000; });
  return {...r, store, ids, account: connectors[0].account};
}

test('with Hands-off on, a send after the run read mail still asks, and nothing is sent', async t => {
  const w = await world(t);
  await w.store.update(s => { s.handsOff = true; setGrant(s, w.ids.mail, 'connector.google.read', w.account, 'always', undefined, {log: false}); });
  const ai = model({Mailroom: e => e.connectorResult
    ? (/Subject of m1abc/.test(e.connectorResult) ? fence('gmail.send', MAIL) : 'Done.')
    : fence('gmail.search', {query: 'rent'})});
  await ask(w.store, {message: 'Read the rent mail, then answer', to: w.ids.mail, executor: ai.executor});
  const card = await until(() => w.store.read().asks.find(a => a.action === 'connector.google.write.gmail.send'), 'the send ask');
  assert.equal(card.target, w.account);
  assert.equal(w.google.calls('/gmail/v1/users/me/messages').length >= 1, true, 'the read did happen under the grant');
  assert.deepEqual(w.google.state.sent, [], 'nothing was sent before the owner answers');
  await answerAskFlow(w.store, card.id, 'deny', {actor: 'o', executor: ai.executor}).catch(() => {});
  assert.deepEqual(w.google.state.sent, [], 'a denied send is never sent');
});
