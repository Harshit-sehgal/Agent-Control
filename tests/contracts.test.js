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
import {JsonStore} from '../src/store.js';
import {coordinationState,runGroup} from '../src/coordination.js';

const store = () => {
  const s = structuredClone(initialState());
  s.settings.topics = ['AI'];
  s.settings.minDelay = 0;
  s.settings.maxDelay = 0;
  s.evidence = [];
  s.tasks = [];
  migrate(s);
  return s;
};

test('default contracts backfill on legacy bots without changing behavior', () => {
  const s = store();
  const writer = s.groups[0].bots.find(b => b.id === 'writer');
  const scout = s.groups[0].bots.find(b => b.id === 'scout');
  assert.equal(writer.contract.version, contracts.CONTRACT_VERSION);
  assert.deepEqual(writer.contract.inputs, contracts.INPUTS);
  assert.equal(writer.contract.output.kind, 'text');
  assert.deepEqual(writer.permissions, ['draft.create'], 'Writer keeps its historical drafting ability.');
  assert.deepEqual(scout.permissions, [], 'A source collector holds no actions.');
  // No bot of any kind can be granted publishing: the action is not grantable.
  assert.equal(contracts.ACTIONS.includes('publish.post'), false);
});

test('contract validation rejects unknown inputs, output kinds and field types', () => {
  assert.throws(() => contracts.validateContract({inputs: ['objective', 'memory_of_everything'], output: {kind: 'text', fields: []}}), /Unknown contract input/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'document', fields: []}}), /output kind/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: []}}), /at least one field/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: [{name: 'claims', type: 'paragraphs'}]}}), /field type/);
  assert.throws(() => contracts.validateContract({inputs: [], output: {kind: 'structured', fields: [{name: 'a', type: 'text'}, {name: 'a', type: 'text'}]}}), /unique/);
  const structured = contracts.validateContract({inputs: ['objective'], output: {kind: 'structured', fields: [{name: 'claims', type: 'evidence_list', required: true}]}});
  assert.deepEqual(structured.inputs, ['objective']);
  assert.equal(structured.output.fields[0].required, true);
});

test('permission grants are explicit, and unknown actions fail loudly', () => {
  assert.deepEqual(contracts.validatePermissions([]), []);
  assert.deepEqual(contracts.validatePermissions(['draft.create', 'draft.create']), ['draft.create']);
  assert.throws(() => contracts.validatePermissions(['publish.post']), /Unknown permission/);
  assert.throws(() => contracts.validatePermissions(['draft.create', 'exfiltrate']), /Unknown permission "exfiltrate"/);
  const s = store();
  const g = addGroup(s, {name: 'Pipeline'});
  const bot = addBot(s, g.id, {name: 'Analyst', instructions: 'Analyze.', permissions: ['schedule.set']});
  assert.deepEqual(bot.permissions, ['schedule.set']);
  assert.equal(contracts.canBot(bot, 'schedule.set'), true);
  assert.equal(contracts.canBot(bot, 'draft.create'), false);
  assert.equal(contracts.canBot(bot, 'publish.post'), false);
  // A profile edit that omits permissions must not drop the existing ones.
  const renamed = updateBot(s, g.id, bot.id, {name: 'Senior Analyst', instructions: 'Analyze deeply.'});
  assert.deepEqual(renamed.permissions, ['schedule.set']);
  assert.throws(() => updateBot(s, g.id, bot.id, {name: 'Analyst', instructions: 'x', permissions: ['memory.read']}), /Unknown permission/);
});

test('the coordinator enforces structured output contracts and records failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-contracts-'));
  try {
    const store = await new JsonStore(path.join(dir, 'state.json')).init();
    const group = {id: 'g1', name: 'Pipeline', bots: [
      {id: 'curator', name: 'Curator', instructions: 'Collect claims.', type: 'custom'},
      {id: 'writer', name: 'Writer', instructions: 'Draft a reply.', type: 'custom'},
    ]};
    group.bots[0].contract = contracts.validateContract({inputs: ['objective'], output: {kind: 'structured', fields: [{name: 'claims', type: 'evidence_list', required: true}, {name: 'confidence', type: 'number'}]}});
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

test('the handoff envelope carries the contract and permission list', () => {
  const group = {id: 'g', name: 'G', bots: [{id: 'b1', name: 'B1', instructions: 'Do work.', type: 'custom', permissions: ['draft.create']}]};
  const bot = contracts.normalizeBot(group.bots[0]);
  const run = createRun({group, message: 'Work', makeId: randomUUID});
  const envelope = createEnvelope({run, bot, previous: null});
  assert.equal(envelope.contract.output.kind, 'text');
  assert.deepEqual(envelope.permissions, ['draft.create']);
});
