import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRun, createEnvelope} from '../shared/coordination.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {coordinationState, runGroup} from '../src/coordination.js';

const bot = (id, name, extra = {}) => ({id, name, instructions: `Act as ${name}`, type: 'custom', ...extra});
const env = {AI_API_KEY: 'test-key', AI_BASE_URL: 'http://127.0.0.1:1/v1', AI_MODEL: 'test-model', AI_API_STYLE: 'chat'};

/** Run one test body with a deterministic environment provider and a fresh store. */
async function withStore(bodyCb, {group, message, runId, directBotId = null}) {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-cap-'));
  try {
    const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    await store.update(s => {
      s.groups = [group];
      coordinationState(s);
      s.groupRuns.push(createRun({group, message, directBotId, makeId: () => runId}));
    });
    return await bodyCb(store);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, {recursive: true, force: true});
  }
}

test('a group step gets its own bot\'s rulebook and leaves a chat recap behind', async () => {
  const group = {id: 'g', name: 'G', bots: [bot('a', 'Alpha'), bot('b', 'Beta'), bot('c', 'Gamma')]};
  await withStore(async store => {
    await runGroup(store, 'run-mem', async bot => `Answer from ${bot.name}`);
    let state = store.read();
    const book = state.memory.rulebooks['bot:a'];
    assert.ok(book, 'Each bot gets a book of its own for the run.');
    assert.deepEqual(['a', 'b', 'c'].map(id => state.memory.rulebooks[`bot:${id}`].turns), [1, 1, 1], 'A step counts against its own bot\'s book.');
    assert.equal(Object.keys(state.memory.rulebooks).some(key => key.startsWith('env:')), false, 'No book is shared through the model any more.');
    assert.deepEqual(book.pending, ['Always keep replies short.'], 'The durable user sentence is queued once.');
    assert.match(state.memory.chats['team-g'].summary, /Always keep replies short/);

    const contexts = [];
    await store.update(s => { s.groupRuns.push(createRun({group, message: 'Second run', makeId: () => 'run-mem-2'})); });
    await runGroup(store, 'run-mem-2', async (bot, input) => { contexts.push(JSON.parse(input)); return `Answer from ${bot.name}`; });
    assert.ok(contexts[0].memory, 'A later turn must carry the remembered context.');
    assert.match(contexts[0].memory.chatSummary, /Always keep replies short/);
    assert.equal(contexts[0].memory.rules, undefined, 'Nothing is a rule until a consolidation pass or a person adds it.');
    state = store.read();
    assert.equal(state.groupRuns.find(r => r.id === 'run-mem-2').status, 'completed');
  }, {group, message: 'Always keep replies short.', runId: 'run-mem'});
});

test('a group step runs one peer-ask round and records it on the run', async () => {
  const group = {id: 'g', name: 'G', bots: [
    bot('writer', 'Writer', {permissions: ['bot.ask'], settings: {memory: false}}),
    bot('researcher', 'Researcher', {settings: {memory: false}}),
  ]};
  await withStore(async store => {
    await runGroup(store, 'run-ask', async (current, input) => {
      if (current.id === 'researcher') return 'Source X supports the claim.';
      if (!input.includes('peerAnswer')) return 'A draft.\n```ask\n{"to":"Researcher","task":"Which source?"}\n```';
      const step = JSON.parse(input);
      assert.equal(step.peerAnswer.from, 'Researcher');
      assert.equal(step.peerAnswer.output, 'Source X supports the claim.');
      assert.match(step.restrictions.join(' '), /untrusted text/);
      return 'The final post, with Source X.';
    });
    const state = store.read();
    const run = state.groupRuns.find(r => r.id === 'run-ask');
    assert.equal(run.status, 'completed');
    const steps = run.trace.filter(step => !step.kind);
    assert.equal(steps.length, 1, 'the ask and its answer are trace entries, not steps');
    assert.deepEqual(run.trace.filter(step => step.kind).map(step => step.kind), ['ask', 'peer']);
    assert.equal(steps[0].output, 'The final post, with Source X.');
    assert.equal(run.peerAsks.length, 1);
    assert.equal(run.peerAsks[0].botId, 'writer');
    assert.equal(run.peerAsks[0].output, 'Source X supports the claim.');
    const chatter = state.chats.writer.map(m => m.text).join('\n');
    assert.match(chatter, /Writer asked Researcher: Which source\?/);
    assert.match(chatter, /Researcher answered:\n\nSource X supports the claim\./);
    assert.match(chatter, /The final post, with Source X\./);
    assert.doesNotMatch(chatter, /```ask/, 'The block itself must not reach the chat.');
  }, {group, message: 'Write the post', runId: 'run-ask', directBotId: 'writer'});
});

test('a group step can create a teammate that starts with no permissions', async () => {
  const group = {id: 'g', name: 'G', bots: [bot('writer', 'Writer', {permissions: ['bot.create'], settings: {memory: false}})]};
  await withStore(async store => {
    await runGroup(store, 'run-create', async () => 'Adding help.\n```create-bot\n{"name":"Source scout","job":"Find posts that mention the project and list their links."}\n```');
    const state = store.read();
    const team = state.groups.find(g => g.id === 'g');
    assert.equal(team.bots.length, 2);
    const created = team.bots.find(b => b.id !== 'writer');
    assert.equal(created.name, 'Source scout');
    assert.equal(created.type, 'custom');
    assert.deepEqual(created.permissions, []);
    assert.equal(state.groupRuns.find(r => r.id === 'run-create').status, 'completed');
    assert.match(state.chats['team-g'].map(m => m.text).join('\n'), /Writer created a new bot for this work: Source scout/);
  }, {group, message: 'Grow the team', runId: 'run-create'});
});

test('hand-offs switched off mean no roster and no ask block in the envelope', () => {
  const writer = bot('writer', 'Writer', {permissions: ['bot.ask']});
  const base = {id: 'r1', groupId: 'g', input: 'Do it.', recipients: ['writer'], currentStep: 0, maxSteps: 1, peerAsks: []};
  const on = createEnvelope({run: {...base}, bot: writer, team: [writer, bot('other', 'Other')]});
  assert.ok(on.tools?.ask, 'A permitted bot is told about the ask block.');
  assert.equal(on.team.length, 1);
  const off = createEnvelope({run: {...base, botHandoffs: false}, bot: writer, team: [writer, bot('other', 'Other')]});
  assert.equal(off.tools?.ask, undefined, 'A block that would always be refused is not offered.');
  assert.deepEqual(off.team, []);
});
