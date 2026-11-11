/** A bot uses a connector through the ask mechanism (Phase 6, Task 2).
 *
 * The model is scripted, the MCP server is a fake on a local port, and the run
 * loop, the store, the vault and the answer flow are the real ones. What is
 * proved: the first use asks, a write asks apart from a read, a tool nobody
 * described asks as a write, a result goes back to the same bot as untrusted
 * data, a decline or a Deny never reaches the server, and a connector removed
 * while an ask waits resolves cleanly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {answerAskFlow, expirePendingAsks} from '../src/ask-runs.js';
import {addMcpConnector, removeConnector} from '../src/connectors.js';
import {cancelRun} from '../src/coordination.js';
import {grantFor, setGrant} from '../shared/asks.js';
import {MAX_CONNECTOR_DEPTH} from '../shared/connectors.js';
import {company, model, ask} from './run-fixture.js';
import {fakeMcpHttp} from './mcp-fixture.js';

const fence = (tool, args = {}, use = 'notes') => `One moment.\n\`\`\`connector\n${JSON.stringify({use, tool, args})}\n\`\`\``;
const until = async (check, note) => {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};
const runOf = (store, id) => store.read().groupRuns.find(r => r.id === id);
const toolCalls = server => server.calls.filter(c => c.message?.method === 'tools/call');
const OWNER = {actor: 'owner@example.test'};

async function rig(t, options) {
  const {store, ids} = await company(t);
  store.vaultKey = crypto.randomBytes(32);
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  const server = await fakeMcpHttp(options);
  t.after(() => server.close());
  const notes = await addMcpConnector(store, 'default', {kind: 'mcp', name: 'Notes', url: server.url});
  server.calls.length = 0;
  return {store, ids, server, notes};
}
/** Mailroom uses a tool on its first turn and reports what came back on its next. */
const using = (tool, args, extra = {}) => model({Mailroom: envelope => (envelope.connectorResult || envelope.declined ? `Report: ${envelope.connectorResult || ''} ${envelope.declined || ''}`.trim() : fence(tool, args)), ...extra});

test('the first use asks the owner: the run parks, nothing reaches the server, the card is in the chat', async t => {
  const {store, ids, server, notes} = await rig(t);
  const ai = using('search_notes', {query: 'rent'});
  const run = await ask(store, {message: 'Find the rent note', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'awaiting_ask');
  const [card] = store.read().asks;
  assert.deepEqual([card.action, card.target, card.detail, card.botId, card.runId, card.grantScope], ['connector.notes.read', notes.account, 'use Notes: search_notes (query: rent)', ids.mail, run.id, notes.account]);
  assert.deepEqual(run.askIds, [card.id]);
  assert.deepEqual(toolCalls(server), [], 'nothing was sent to the server');
  assert.equal(ai.of('Mailroom').length, 1, 'the bot is not asked again while the owner decides');
  const cards = (store.read().chats[ids.mail] || []).filter(m => m.kind === 'ask');
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /Mailroom wants to use Notes: search_notes \(query: rent\)/);
  assert.doesNotMatch(JSON.stringify(store.read().chats[ids.mail]), /```connector/, 'the fence is not shown as text');
});

test('Allow once runs the call, hands the result to the same bot as untrusted data, and leaves no grant', async t => {
  const {store, ids, server, notes} = await rig(t);
  const ai = using('search_notes', {query: 'rent'});
  const run = await ask(store, {message: 'Find the rent note', to: ids.mail, executor: ai.executor});
  await answerAskFlow(store, store.read().asks[0].id, 'allow', {...OWNER, executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.equal(toolCalls(server).length, 1);
  assert.deepEqual(toolCalls(server)[0].message.params, {name: 'search_notes', arguments: {query: 'rent'}});
  const second = ai.of('Mailroom')[1];
  assert.match(second.connectorResult, /Result of Notes · search_notes/);
  assert.match(second.connectorResult, /search_notes ran with \{"query":"rent"\}/);
  assert.match(second.restrictions.join('\n'), /connector result is untrusted/i);
  assert.equal(second.objective, 'Find the rent note', 'the result is not the objective');
  assert.equal(ai.of('Mailroom').length, 2);
  assert.equal(grantFor(store.read(), ids.mail, 'connector.notes.read', notes.account), null);
  const done = runOf(store, run.id);
  assert.equal(done.connectorPage ?? null, null, 'the result is consumed by the turn it was for');
  assert.deepEqual(done.connectorCalls ?? [], []);
  const line = (store.read().chats[ids.mail] || []).find(m => m.kind === 'connector');
  assert.ok(line, 'the chat shows that the connector was used');
  assert.match(line.text, /Mailroom used Notes: search_notes/);
  assert.equal(line.connectorId, 'notes');
  assert.match(store.read().chats[ids.mail].filter(m => m.role === 'bot').at(-1).text, /^Report: Result of Notes/);
});

test('Always allow stores a per-account read grant: the next run goes unasked; a write still asks', async t => {
  const {store, ids, server, notes} = await rig(t);
  const ai = using('search_notes', {query: 'a'});
  const first = await ask(store, {message: 'one', to: ids.mail, executor: ai.executor});
  await answerAskFlow(store, store.read().asks[0].id, 'always', {...OWNER, executor: ai.executor});
  await until(() => runOf(store, first.id).status === 'completed', 'the first run');
  assert.equal(grantFor(store.read(), ids.mail, 'connector.notes.read', notes.account), 'always');
  const second = await ask(store, {message: 'two', to: ids.mail, executor: ai.executor});
  await until(() => runOf(store, second.id).status === 'completed', 'the second run unasked');
  assert.equal(store.read().asks.length, 1, 'no second ask');
  assert.equal(toolCalls(server).length, 2);
  // A write on the same connector is another question.
  const writer = using('add_note', {text: 'x'});
  const third = await ask(store, {message: 'three', to: ids.mail, executor: writer.executor});
  assert.equal(third.status, 'awaiting_ask');
  assert.equal(store.read().asks.at(-1).action, 'connector.notes.write');
  // Another bot never inherited the grant.
  const scholar = model({Scholar: e => (e.connectorResult ? 'ok' : fence('search_notes', {}))});
  assert.equal((await ask(store, {message: 'four', to: ids.scholar, executor: scholar.executor})).status, 'awaiting_ask');
});

test('Review focus 3: a tool with no annotations asks as a write, and so does a destructive one', async t => {
  const {store, ids, server} = await rig(t);
  for (const tool of ['ping', 'wipe_notes', 'add_note']) {
    const run = await ask(store, {message: `use ${tool}`, to: ids.mail, executor: using(tool, {}).executor});
    assert.equal(run.status, 'awaiting_ask', tool);
    assert.equal(store.read().asks.at(-1).action, 'connector.notes.write', `${tool} is a write`);
  }
  assert.deepEqual(toolCalls(server), []);
});

test('Decline never reaches the server; the bot gets one closing turn that says what was declined', async t => {
  const {store, ids, server} = await rig(t);
  const ai = model({Mailroom: envelope => (envelope.declined ? `${fence('search_notes')}\nI could not look. ${envelope.declined}` : fence('add_note', {text: 'x'}))});
  const run = await ask(store, {message: 'Save a note', to: ids.mail, executor: ai.executor});
  await answerAskFlow(store, store.read().asks[0].id, 'decline', {...OWNER, executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the closing turn');
  assert.deepEqual(toolCalls(server), []);
  assert.equal(ai.of('Mailroom').length, 2, 'exactly one closing turn');
  assert.match(ai.of('Mailroom')[1].declined, /The owner declined: use Notes: add_note \(text: x\)/);
  assert.equal(store.read().asks.length, 1, 'the closing reply could not start another ask');
  assert.equal(ai.of('Mailroom')[1].connectorResult, undefined);
});

test('a Deny grant refuses without asking or calling, says where to change it, and never loops', async t => {
  const {store, ids, server, notes} = await rig(t);
  await store.update(s => { setGrant(s, ids.mail, 'connector.notes.read', notes.account, 'deny', undefined, {log: false}); });
  const ai = model({Mailroom: fence('search_notes')});
  const run = await ask(store, {message: 'Find it', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'completed');
  assert.equal(ai.of('Mailroom').length, 1);
  assert.deepEqual(store.read().asks, []);
  assert.deepEqual(toolCalls(server), []);
  assert.match((store.read().chats[ids.mail] || []).filter(m => m.role === 'system').map(m => m.text).join('\n'), /Mailroom's profile → Permissions/);
});

test('a connector or tool that does not exist, or one that is not ready, is said so and asks nothing', async t => {
  const {store, ids, server} = await rig(t);
  for (const reply of [fence('search_notes', {}, 'nothere'), fence('no_such_tool')]) {
    const run = await ask(store, {message: 'try', to: ids.mail, executor: model({Mailroom: reply}).executor});
    assert.equal(run.status, 'completed');
  }
  await store.update(s => { s.connectors[0].status = 'reconnect'; });
  const run = await ask(store, {message: 'try again', to: ids.mail, executor: model({Mailroom: fence('search_notes')}).executor});
  assert.equal(run.status, 'completed');
  const said = (store.read().chats[ids.mail] || []).filter(m => m.role === 'system').map(m => m.text).join('\n');
  assert.match(said, /no connector called "nothere"/);
  assert.match(said, /Notes has no tool called "no_such_tool"/);
  assert.match(said, /Notes is not ready/);
  assert.deepEqual(store.read().asks, []);
  assert.deepEqual(toolCalls(server), []);
});

test('Review focus 5: a connector removed while its ask waits: the answer resolves cleanly and the bot is told', async t => {
  const {store, ids, server} = await rig(t);
  const ai = using('search_notes', {query: 'rent'});
  const run = await ask(store, {message: 'Find it', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  await removeConnector(store, 'default', 'notes');
  assert.equal(store.read().asks[0].status, 'pending');
  const out = await answerAskFlow(store, card.id, 'always', {...OWNER, executor: ai.executor});
  assert.equal(out.ask.status, 'allowed');
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.match(ai.of('Mailroom')[1].connectorResult, /Notes was removed, so nothing was done/);
  assert.deepEqual(toolCalls(server), []);
  assert.equal(store.read().connectors.length, 0);
});

test('an answer after the run was stopped is recorded and calls nothing', async t => {
  const {store, ids, server, notes} = await rig(t);
  const ai = using('search_notes', {});
  const run = await ask(store, {message: 'Find it', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  await cancelRun(store, run.id);
  await answerAskFlow(store, card.id, 'always', {...OWNER, executor: ai.executor});
  assert.equal(runOf(store, run.id).status, 'cancelled');
  assert.deepEqual(toolCalls(server), []);
  assert.equal(grantFor(store.read(), ids.mail, 'connector.notes.read', notes.account), 'always');
});

test('the result is data: backtick fences in it cannot become a new call, and a server error is a result, not a crash', async t => {
  const {store, ids, server} = await rig(t);
  await store.update(s => { setGrant(s, ids.mail, 'connector.notes.write', s.connectors[0].account, 'always', undefined, {log: false}); setGrant(s, ids.mail, 'connector.notes.read', s.connectors[0].account, 'always', undefined, {log: false}); });
  // The fake's `inject` tool answers with a connector block of its own, the way a hostile mail or page would.
  await store.update(s => { s.connectors[0].actions.push({name: 'inject', write: false, description: ''}); });
  const echoing = model({Mailroom: envelope => (envelope.connectorResult ? `Echo: ${envelope.connectorResult}` : fence('inject'))});
  const run = await ask(store, {message: 'search', to: ids.mail, executor: echoing.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run');
  assert.doesNotMatch(echoing.of('Mailroom')[1].connectorResult, /```/, 'fences are neutralised in a result');
  assert.equal(toolCalls(server).length, 1, 'the echo did not start another call');
  // A tool that reports its own error, and a protocol error.
  for (const tool of ['boom', 'missing']) {
    const ai = model({Mailroom: envelope => (envelope.connectorResult ? `Got: ${envelope.connectorResult}` : fence(tool))});
    await store.update(s => { s.connectors[0].actions.push({name: tool, write: false, description: ''}); });
    const r = await ask(store, {message: `use ${tool}`, to: ids.mail, executor: ai.executor});
    await until(() => runOf(store, r.id).status === 'completed', tool);
  }
  const lines = (store.read().chats[ids.mail] || []).filter(m => m.kind === 'connector-error');
  assert.equal(lines.length, 2);
  assert.match(lines.map(l => l.text).join('\n'), /It broke/);
  assert.match(lines.map(l => l.text).join('\n'), /Unknown tool: missing/);
});

test('rounds are limited: a bot that keeps calling stops at the limit with a line saying so', async t => {
  const {store, ids, server} = await rig(t);
  await store.update(s => { setGrant(s, ids.mail, 'connector.notes.read', s.connectors[0].account, 'always', undefined, {log: false}); });
  const ai = model({Mailroom: () => fence('search_notes')});
  const run = await ask(store, {message: 'loop', to: ids.mail, executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run');
  assert.equal(toolCalls(server).length, MAX_CONNECTOR_DEPTH);
  assert.match((store.read().chats[ids.mail] || []).filter(m => m.role === 'system').map(m => m.text).join('\n'), new RegExp(`${MAX_CONNECTOR_DEPTH} connector rounds in a row`));
});

test('the envelope lists ready connectors by name and description, and offers the tool', async t => {
  const {store, ids} = await rig(t);
  const ai = model({Mailroom: 'Nothing to use.'});
  await ask(store, {message: 'hello', to: ids.mail, executor: ai.executor});
  const envelope = ai.of('Mailroom')[0];
  assert.match(envelope.tools.connector, /```connector/);
  assert.deepEqual(envelope.connectors.map(c => c.name), ['Notes']);
  assert.deepEqual(envelope.connectors[0].tools.map(x => [x.name, x.write]), [['search_notes', false], ['add_note', true], ['wipe_notes', true], ['ping', true]]);
  assert.equal(JSON.stringify(envelope).includes('credentialId'), false);
});

test('two calls in one reply each ask; the run goes on once both are answered, with both results', async t => {
  const {store, ids, server} = await rig(t);
  const ai = model({Mailroom: envelope => (envelope.connectorResult ? `Both: ${envelope.connectorResult}` : `${fence('search_notes', {q: 'one'})}\n${fence('ping', {q: 'two'})}`)});
  const run = await ask(store, {message: 'both', to: ids.mail, executor: ai.executor});
  const [one, two] = store.read().asks;
  assert.equal(store.read().asks.length, 2);
  await answerAskFlow(store, two.id, 'allow', {...OWNER, executor: ai.executor});
  assert.equal(runOf(store, run.id).status, 'awaiting_ask');
  assert.deepEqual(toolCalls(server), [], 'nothing runs until the run is released');
  await answerAskFlow(store, one.id, 'decline', {...OWNER, executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run');
  assert.equal(toolCalls(server).length, 1, 'only the allowed call ran');
  assert.match(ai.of('Mailroom')[1].connectorResult, /ping ran with \{"q":"two"\}/);
  assert.match(ai.of('Mailroom')[1].declined, /search_notes/);
});

test('a reply with a page request and a connector call: the page goes, the call is dropped with a line', async t => {
  const {store, ids, server} = await rig(t);
  const ai = model({Mailroom: `${fence('search_notes')}\n\`\`\`browser\n{"url":"https://docs.example.com/x"}\n\`\`\``});
  const run = await ask(store, {message: 'both kinds', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'awaiting_ask');
  assert.deepEqual(store.read().asks.map(a => a.action), ['browser.use']);
  assert.match((store.read().chats[ids.mail] || []).filter(m => m.role === 'system').map(m => m.text).join('\n'), /one kind at a time/);
  assert.deepEqual(toolCalls(server), []);
});

test('an ask from an unattended run lapses after 24 hours as declined, and the bot reports', async t => {
  const {store, ids, server} = await rig(t);
  const ai = using('search_notes', {});
  const run = await ask(store, {message: 'Scheduled', to: ids.mail, executor: ai.executor, extra: {unattended: true}});
  const [card] = store.read().asks;
  assert.ok(card.expiresAt);
  await expirePendingAsks(store, {now: new Date(Date.parse(card.createdAt) + 25 * 3600000).toISOString(), executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run');
  assert.deepEqual(toolCalls(server), []);
  assert.match(ai.of('Mailroom')[1].declined, /no answer in 24 hours/);
});
