import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as contracts from '../shared/contracts.js';
import {initialState} from '../shared/core.js';
import {migrate,addGroup,addBot,updateBot} from '../shared/workflow.js';
import {createRun,createEnvelope} from '../shared/coordination.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {coordinationState,runGroup} from '../src/coordination.js';

const store = () => migrate(structuredClone(initialState()));

test('default contracts backfill on legacy bots without changing behavior', () => {
  const s = store();
  const atlas = s.groups[0].bots.find(b => b.id === 'atlas');
  assert.equal(atlas.contract.version, contracts.CONTRACT_VERSION);
  assert.deepEqual(atlas.contract.inputs, contracts.INPUTS);
  assert.equal(atlas.contract.output.kind, 'text');
  assert.deepEqual(atlas.permissions, [], 'A bot starts with no actions.');
  // A stored bot with no contract or permissions gets the defaults.
  const legacy = contracts.normalizeBot({id: 'old', type: 'custom'});
  assert.equal(legacy.contract.output.kind, 'text');
  assert.deepEqual(legacy.permissions, []);
  // No bot of any kind can be granted publishing: the action is not grantable.
  assert.equal(contracts.ACTIONS.includes('publish.post'), false);
});

test('a contract saved before the X inputs and evidence lists went away still loads', () => {
  const bot = contracts.normalizeBot({id: 'old', type: 'custom', contract: {version: 1, inputs: ['objective', 'evidence', 'source_post'], output: {kind: 'structured', fields: [{name: 'claims', type: 'evidence_list'}]}}});
  assert.deepEqual(bot.contract.inputs, ['objective'], 'Retired inputs are dropped.');
  assert.equal(bot.contract.output.fields[0].type, 'string_list', 'An evidence list reads as a list of strings.');
  assert.throws(() => contracts.validateContract({inputs: ['evidence'], output: {kind: 'text', fields: []}}), /Unknown contract input/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: [{name: 'claims', type: 'evidence_list'}]}}), /field type/);
});

test('contract validation rejects unknown inputs, output kinds and field types', () => {
  assert.throws(() => contracts.validateContract({inputs: ['objective', 'memory_of_everything'], output: {kind: 'text', fields: []}}), /Unknown contract input/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'document', fields: []}}), /output kind/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: []}}), /at least one field/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: [{name: 'claims', type: 'paragraphs'}]}}), /field type/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: [{name: 'a', type: 'text'}, {name: 'a', type: 'text'}]}}), /unique/);
  const structured = contracts.validateContract({inputs: ['objective'], output: {kind: 'structured', fields: [{name: 'claims', type: 'string_list', required: true}]}});
  assert.deepEqual(structured.inputs, ['objective']);
  assert.equal(structured.output.fields[0].required, true);
});

test('permission grants are explicit, and unknown actions fail loudly', () => {
  assert.deepEqual(contracts.validatePermissions([]), []);
  assert.deepEqual(contracts.validatePermissions(['chat.send', 'chat.send']), ['chat.send']);
  assert.throws(() => contracts.validatePermissions(['publish.post']), /Unknown permission/);
  assert.throws(() => contracts.validatePermissions(['chat.send', 'exfiltrate']), /Unknown permission "exfiltrate"/);
  const s = store();
  const g = addGroup(s, {name: 'Pipeline'});
  const bot = addBot(s, g.id, {name: 'Analyst', instructions: 'Analyze.', permissions: ['schedule.set']});
  assert.deepEqual(bot.permissions, ['schedule.set']);
  assert.equal(contracts.canBot(bot, 'schedule.set'), true);
  assert.equal(contracts.canBot(bot, 'chat.send'), false);
  assert.equal(contracts.canBot(bot, 'publish.post'), false);
  const smuggled = contracts.normalizeBot({id: 'smuggled', type: 'custom', permissions: ['publish.post', 'chat.send', 'chat.send']});
  assert.deepEqual(smuggled.permissions, ['chat.send']);
  assert.equal(contracts.canBot({permissions: ['publish.post']}, 'publish.post'), false);
  // A profile edit that omits permissions must not drop the existing ones.
  const renamed = updateBot(s, g.id, bot.id, {name: 'Senior Analyst', instructions: 'Analyze deeply.'});
  assert.deepEqual(renamed.permissions, ['schedule.set']);
  assert.throws(() => updateBot(s, g.id, bot.id, {name: 'Analyst', instructions: 'x', permissions: ['memory.read']}), /Unknown permission/);
});

test('the coordinator enforces structured output contracts and records failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-contracts-'));
  try {
    const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    const group = {id: 'g1', name: 'Pipeline', bots: [
      {id: 'curator', name: 'Curator', instructions: 'Collect claims.', type: 'custom'},
      {id: 'writer', name: 'Writer', instructions: 'Draft a reply.', type: 'custom'},
    ]};
    group.bots[0].contract = contracts.validateContract({inputs: ['objective'], output: {kind: 'structured', fields: [{name: 'claims', type: 'string_list', required: true}, {name: 'confidence', type: 'number'}]}});
    await store.update(s => { s.groups = [group]; coordinationState(s); s.groupRuns.push(createRun({group, message: 'Summarize', makeId: () => 'run-1'})); });
    await runGroup(store, 'run-1', async (bot) => {
      if (bot.id === 'curator') return 'Sure! Here is a plain sentence that ignores the contract.';
      return 'Draft text.';
    });
    const failed = store.read().groupRuns[0];
    assert.equal(failed.status, 'failed', 'A contract violation fails the run.');
    assert.match(failed.error, /not valid JSON/);
    // With a compliant curator, the run completes and the writer receives the
    // structured payload as its context.
    await store.update(s => { const r = s.groupRuns[0]; r.status = 'queued'; r.error = null; r.currentStep = 0; r.trace = []; });
    const seen = [];
    await runGroup(store, 'run-1', async (bot) => {
      if (bot.id === 'curator') return '```json\n{"claims": ["https://example.com/a"], "confidence": 0.8}\n```';
      seen.push(bot.id); return 'Draft text.';
    });
    const done = store.read().groupRuns[0];
    assert.equal(done.status, 'completed');
    assert.deepEqual(seen, ['writer']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('structured output validates every declared field type, not just presence', () => {
  const bot = contracts.normalizeBot({id: 'typed', type: 'custom', contract: contracts.validateContract({inputs: ['objective'], output: {kind: 'structured', fields: [
    {name: 'confidence', type: 'number', required: true},
    {name: 'label', type: 'text'},
    {name: 'tags', type: 'string_list'},
    {name: 'ok', type: 'boolean'},
    {name: 'link', type: 'url'},
  ]}})});
  const good = {confidence: 0.8, label: 'fine', tags: ['a', 'b'], ok: true, link: 'https://example.com/a'};
  assert.deepEqual(contracts.assertContractOutput(bot, JSON.stringify(good)), good);

  assert.throws(() => contracts.assertContractOutput(bot, JSON.stringify({confidence: 'high'})), /"confidence" must be of type number/);
  assert.throws(() => contracts.assertContractOutput(bot, JSON.stringify({confidence: 1, tags: 'a'})), /"tags" must be of type string_list/);
  assert.throws(() => contracts.assertContractOutput(bot, JSON.stringify({confidence: 1, ok: 'yes'})), /"ok" must be of type boolean/);
  assert.throws(() => contracts.assertContractOutput(bot, JSON.stringify({confidence: 1, link: 'javascript:alert(1)'})), /"link" must be of type url/);
  assert.throws(() => contracts.assertContractOutput(bot, JSON.stringify({confidence: 1, publish: true})), /unexpected field "publish"/);
  assert.throws(() => contracts.assertContractOutput({contract: {output: {kind: 'publish'}}}, 'hello'), /output kind/);
  // An optional field may be omitted, but a required one may not.
  assert.throws(() => contracts.assertContractOutput(bot, JSON.stringify({label: 'x'})), /missing the required field "confidence"/);
});

test('a structured bot may attach a browser block; the fence is stripped before the contract gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-struct-browse-'));
  try {
    const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    const bot = {
      id: 'curator', name: 'Curator', instructions: 'Collect claims.', type: 'custom',
      permissions: ['browser.use'], settings: {browserApproval: 'auto'},
      contract: contracts.validateContract({inputs: ['objective'], output: {kind: 'structured', fields: [{name: 'verdict', type: 'text', required: true}]}}),
    };
    await store.update(s => {
      s.groups = [{id: 'g1', name: 'Lab', bots: [bot]}];
      coordinationState(s);
      s.groupRuns.push(createRun({group: s.groups[0], message: 'Look it up', makeId: () => 'run-s'}));
    });
    await runGroup(store, 'run-s', async () => '```json\n{"verdict":"needs a page"}\n```\n```browser\n{"url":"https://example.com"}\n```');
    const run = store.read().groupRuns[0];
    assert.equal(run.status, 'awaiting_browser');
    assert.match(run.trace[0].output, /needs a page/);
    assert.doesNotMatch(run.trace[0].output, /```browser/);
    assert.equal(store.read().browserRequests[0].url, 'https://example.com/');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the handoff envelope carries the contract and permission list', () => {
  const group = {id: 'g', name: 'G', bots: [{id: 'b1', name: 'B1', instructions: 'Do work.', type: 'custom', permissions: ['chat.send']}]};
  const bot = contracts.normalizeBot(group.bots[0]);
  const run = createRun({group, message: 'Work', makeId: randomUUID});
  const envelope = createEnvelope({run, bot, previous: null});
  assert.equal(envelope.contract.output.kind, 'text');
  assert.deepEqual(envelope.permissions, ['chat.send']);
});
