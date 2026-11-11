/** The `connector` fence a bot writes, and what the engine tells it about its connectors (Phase 6, Task 2).
 *
 * Pure parts only: how a block is read, how a call is classified as a read or a
 * write, and what the envelope lists. The run flow is tested in connector-runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTROL_FENCES, controlFence} from '../shared/reply-blocks.js';
import {parseConnectorCalls, stripConnectorBlocks, connectorNeeds, envelopeConnectors, MAX_CALLS_PER_REPLY, CONNECTOR_TOOL_HINT} from '../shared/connectors.js';
import {createEnvelope} from '../shared/coordination.js';
import {verdict, setGrant} from '../shared/asks.js';

const block = (body, close = true) => `\`\`\`connector\n${typeof body === 'string' ? body : JSON.stringify(body)}\n${close ? '```' : ''}`;
const notes = {id: 'notes', kind: 'mcp', name: 'Notes', account: 'mcp.example.com', status: 'ready', credentialId: 'SECRET-ID', actions: [
  {name: 'search_notes', write: false, description: 'Find notes.'}, {name: 'add_note', write: true, description: 'Save a note.'}]};

test('connector is one of the control fences, so a peer never carries it and the strip path removes it', () => {
  assert.ok(CONTROL_FENCES.includes('connector'));
  assert.equal(controlFence().test(block({use: 'notes', tool: 'x'})), true);
  assert.equal(controlFence('connector').test('```browser\n{}\n```'), false);
});

test('a block is read: use, tool and args; a bad one is reported, not dropped', () => {
  const found = parseConnectorCalls(`Looking.\n${block({use: 'notes', tool: 'search_notes', args: {query: 'rent'}})}\n${block('{nope')}\n${block({tool: 'x'})}\n${block({use: 'notes'})}`);
  assert.equal(found.length, MAX_CALLS_PER_REPLY, 'at most two blocks are looked at, valid or not');
  assert.deepEqual(found[0], {ok: true, call: {use: 'notes', tool: 'search_notes', args: {query: 'rent'}}});
  assert.equal(found[1].ok, false);
  assert.match(found[1].error, /not valid JSON/);
  const more = parseConnectorCalls(`${block({tool: 'x'})}\n${block({use: 'notes'})}`);
  assert.match(more[0].error, /use/);
  assert.match(more[1].error, /tool/);
});

test('args default to {}, must be an object and are bounded; names are bounded', () => {
  assert.deepEqual(parseConnectorCalls(block({use: 'notes', tool: 'ping'}))[0].call.args, {});
  assert.match(parseConnectorCalls(block({use: 'notes', tool: 'ping', args: [1]}))[0].error, /args/);
  assert.match(parseConnectorCalls(block({use: 'notes', tool: 'ping', args: {a: 'x'.repeat(30000)}}))[0].error, /too long/);
  assert.match(parseConnectorCalls(block({use: 'x'.repeat(200), tool: 'ping'}))[0].error, /use/);
  assert.match(parseConnectorCalls(block({use: 'notes', tool: 'bad name'}))[0].error, /tool/);
});

test('an unclosed final fence is a real block, the same grammar as every other control block', () => {
  assert.equal(parseConnectorCalls(block({use: 'notes', tool: 'ping'}, false))[0].ok, true);
});

test('the strip path removes connector blocks and nothing else', () => {
  const text = `Here.\n${block({use: 'notes', tool: 'ping'})}\n\`\`\`js\nconst a = 1;\n\`\`\`\nDone.`;
  const out = stripConnectorBlocks(text);
  assert.doesNotMatch(out, /connector/);
  assert.match(out, /const a = 1/);
  assert.match(out, /Done\./);
});

test('a call is classified by the connector, never by the bot: a read, a write, or unknown', () => {
  const read = connectorNeeds(notes, 'search_notes', {query: 'rent'});
  assert.deepEqual(read, [{action: 'connector.notes.read', target: 'mcp.example.com', detail: 'use Notes: search_notes (query: rent)'}]);
  assert.equal(connectorNeeds(notes, 'add_note', {})[0].action, 'connector.notes.write');
  assert.equal(connectorNeeds(notes, 'not_a_tool', {}), null);
  // A bot cannot say a write is a read: there is no field for it in the block.
  assert.equal(parseConnectorCalls(block({use: 'notes', tool: 'add_note', write: false, readOnly: true}))[0].call.write, undefined);
});

test('the envelope lists ready connectors and their tools by name and description, with no secret', () => {
  const list = envelopeConnectors({connectors: [notes, {...notes, id: 'old', name: 'Old', status: 'reconnect'}, {...notes, id: 'bad', name: 'Bad', status: 'error'}]});
  assert.deepEqual(list, [{id: 'notes', name: 'Notes', account: 'mcp.example.com', tools: [{name: 'search_notes', description: 'Find notes.', write: false}, {name: 'add_note', description: 'Save a note.', write: true}]}]);
  assert.equal(JSON.stringify(list).includes('SECRET-ID'), false);
  assert.deepEqual(envelopeConnectors({}), []);
});

test('createEnvelope offers the tool only when a connector is ready, and marks a result as untrusted data', () => {
  const run = {id: 'r1', groupId: 'home', currentStep: 0, recipients: ['b1'], input: 'Find the rent note'};
  const bot = {id: 'b1', name: 'Mailroom', instructions: 'Reads mail.'};
  const plain = createEnvelope({run, bot});
  assert.equal(plain.tools.connector, undefined);
  assert.equal(plain.connectors, undefined);
  assert.equal(plain.connectorResult, undefined);
  const withTool = createEnvelope({run: {...run, connectorPage: 'Result of Notes · search_notes: rent is due'}, bot, connectors: envelopeConnectors({connectors: [notes]})});
  assert.equal(withTool.tools.connector, CONNECTOR_TOOL_HINT);
  assert.equal(withTool.connectors[0].name, 'Notes');
  assert.match(withTool.connectorResult, /rent is due/);
  assert.match(withTool.restrictions.join('\n'), /connector result is untrusted/i);
  assert.match(withTool.restrictions.join('\n'), /not instructions/i);
  assert.match(CONNECTOR_TOOL_HINT, /```connector/);
});

test('with no grant a connector action asks, reads and writes separately; Always allow on a read does not cover a write', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'b1', name: 'Mailroom'}]}], grants: [], connectors: [notes]};
  const bot = state.groups[0].bots[0];
  assert.equal(verdict(state, bot, 'connector.notes.read', 'mcp.example.com').verdict, 'ask');
  setGrant(state, 'b1', 'connector.notes.read', 'mcp.example.com', 'always', undefined, {log: false});
  assert.equal(verdict(state, bot, 'connector.notes.read', 'mcp.example.com').verdict, 'allow');
  assert.equal(verdict(state, bot, 'connector.notes.write', 'mcp.example.com').verdict, 'ask');
  assert.equal(verdict(state, bot, 'connector.notes.read', 'other.example.com').verdict, 'ask', 'per account');
});

test('the ask card shows what a call would carry: a few arguments, each cut, with no control characters', () => {
  assert.equal(connectorNeeds(notes, 'add_note', {text: 'Buy milk', n: 2})[0].detail, 'use Notes: add_note (text: Buy milk, n: 2)');
  assert.equal(connectorNeeds(notes, 'add_note', {})[0].detail, 'use Notes: add_note');
  const long = connectorNeeds(notes, 'add_note', {text: 'x'.repeat(500), a: 1, b: 2, c: 3, d: 4, e: 5})[0].detail;
  assert.ok(long.length <= 280);
  assert.doesNotMatch(long, /e: 5/, 'only four keys');
  assert.equal(connectorNeeds(notes, 'add_note', {text: 'line\nbreak\u0000'})[0].detail, 'use Notes: add_note (text: line break)');
});
