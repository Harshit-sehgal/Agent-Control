import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateSpawnRequest,parseSpawnRequests,stripSpawnBlocks,subagentBot,subagentPrompt,subagentTurn,SUBAGENT_PERMISSION,MAX_TASK,MAX_SPAWNS_PER_REPLY,MAX_SUBAGENT_DEPTH} from '../shared/subagents.js';
import {ACTIONS,canBot} from '../shared/contracts.js';
import {createRun,createEnvelope} from '../shared/coordination.js';
import {replyWithSubagents} from '../src/subagents.js';
import {coordinationState,runGroup} from '../src/coordination.js';
import {SqliteStore} from '../src/sqlite-store.js';

const block = body => '```spawn\n' + (typeof body === 'string' ? body : JSON.stringify(body)) + '\n```';
const bot = (id, extra = {}) => ({id, name: id[0].toUpperCase() + id.slice(1), instructions: `Act as ${id}`, type: 'custom', ...extra});
const spawner = (extra = {}) => bot('helper', {permissions: [SUBAGENT_PERMISSION], ...extra});

test('subagent.spawn is a registered action, never a default', () => {
  assert.ok(ACTIONS.includes(SUBAGENT_PERMISSION));
  assert.equal(canBot({permissions: [SUBAGENT_PERMISSION]}, SUBAGENT_PERMISSION), true);
  assert.equal(canBot({permissions: []}, SUBAGENT_PERMISSION), false);
  assert.equal(canBot({permissions: ['browser.use']}, SUBAGENT_PERMISSION), false);
});

test('a spawn block is validated and bounded', () => {
  assert.deepEqual(validateSpawnRequest({name: 'Fact check', task: 'Does 2+2 hold?'}), {name: 'Fact check', task: 'Does 2+2 hold?'});
  assert.equal(validateSpawnRequest({task: 'summarise'}).name, 'helper');
  assert.throws(() => validateSpawnRequest({task: '   '}), /needs a task/);
  assert.throws(() => validateSpawnRequest('nope'), /must be an object/);
  assert.equal(validateSpawnRequest({task: 'x'.repeat(MAX_TASK + 500)}).task.length, MAX_TASK);
});

test('only one block per reply is read, and an invalid one is reported', () => {
  const two = parseSpawnRequests(`${block({task: 'first'})}\n${block({task: 'second'})}`);
  assert.equal(two.length, MAX_SPAWNS_PER_REPLY);
  assert.equal(two[0].request.task, 'first');
  const bad = parseSpawnRequests(block('{not json'));
  assert.deepEqual(bad, [{ok: false, error: 'The spawn block is not valid JSON.'}]);
  assert.deepEqual(parseSpawnRequests('no block here'), []);
  assert.equal(stripSpawnBlocks('Answer.\n\n' + block({task: 'x'})), 'Answer.');
});

test('the helper record has no permissions, no tools, and its own job', () => {
  const parent = spawner({instructions: 'Draft replies'});
  const helper = subagentBot(parent, {name: 'Fact check', task: 'Check the figure'});
  assert.deepEqual(helper.permissions, []);
  assert.match(helper.instructions, /You are a sub-agent/);
  assert.match(helper.instructions, /Draft replies/);
  assert.match(helper.instructions, /cannot run tools, open web pages, spawn another sub-agent, or post/);
  assert.equal(helper.settings.replyLength, 'short');
  const prompt = JSON.parse(subagentPrompt(parent, {task: 'Check the figure'}));
  assert.equal(prompt.task, 'Check the figure');
  assert.equal(prompt.askedBy, 'Helper');
  const turn = subagentTurn({name: 'Fact check', task: 't', output: 'the answer'});
  assert.equal(turn.subagent.output, 'the answer');
  assert.match(turn.restrictions[0], /untrusted text/);
});

test('a spawning bot gets the answer back in a second turn', async () => {
  const seen = [];
  const executor = async (who, prompt) => {
    seen.push({bot: who, prompt});
    if (who.id.endsWith('-subagent')) return 'the check passed';
    const input = JSON.parse(prompt);
    return input.subagent ? 'Final reply built on the check.' : block({name: 'Fact check', task: 'Does the figure hold?'});
  };
  const reply = await replyWithSubagents({bot: spawner(), envelope: {objective: 'draft a reply'}, executor, config: {}});
  assert.equal(reply.output, 'Final reply built on the check.');
  assert.equal(seen.length, 3);
  assert.equal(seen[1].bot.permissions.length, 0);
  assert.equal(JSON.parse(seen[1].prompt).task, 'Does the figure hold?');
  // The bot's second turn carries the helper's answer, marked as data.
  const second = JSON.parse(seen[2].prompt);
  assert.equal(second.subagent.output, 'the check passed');
  assert.ok(second.restrictions.some(line => /untrusted text/.test(line)));
  assert.ok(second.restrictions.some(line => /cannot spawn another/.test(line)));
  assert.equal(reply.spawns.length, 1);
  assert.deepEqual(reply.lines.map(line => line.kind), ['subagent', 'subagent']);
  assert.match(reply.lines[0].text, /started a sub-agent · Fact check/);
  assert.match(reply.lines[1].text, /answered:\n\nthe check passed/);
});

test('without the permission nothing runs, and the chat says why', async () => {
  const seen = [];
  const executor = async (who, prompt) => { seen.push(prompt); return block({task: 'do it'}); };
  const reply = await replyWithSubagents({bot: bot('writer'), envelope: {}, executor, config: {}});
  assert.equal(seen.length, 1);
  assert.equal(reply.spawns.length, 0);
  assert.match(reply.lines[0].text, new RegExp(`does not hold the ${SUBAGENT_PERMISSION} permission`));
  assert.match(reply.output, /asked for a sub-agent/);
});

test('the round limit stops a second spawn, and a failed helper still gets an answer', async () => {
  let calls = 0;
  const limited = await replyWithSubagents({bot: spawner(), envelope: {}, rounds: MAX_SUBAGENT_DEPTH, executor: async () => { calls++; return block({task: 'again'}); }, config: {}});
  assert.equal(calls, 1);
  assert.equal(limited.spawns.length, 0);
  assert.match(limited.lines[0].text, /one sub-agent round is the limit/);

  const seen = [];
  const failing = async (who, prompt) => {
    seen.push(who.id);
    if (who.id.endsWith('-subagent')) throw new Error('rate limited');
    return JSON.parse(prompt).subagent ? 'Answered without the helper.' : block({task: 'try it'});
  };
  const reply = await replyWithSubagents({bot: spawner(), envelope: {}, executor: failing, config: {}});
  assert.equal(reply.output, 'Answered without the helper.');
  assert.equal(reply.spawns[0].output, null);
  assert.equal(reply.spawns[0].error, 'rate limited');
  assert.match(reply.lines.at(-1).text, /failed: rate limited/);

  const again = await replyWithSubagents({bot: spawner(), envelope: {}, executor: async (who, prompt) => (who.id.endsWith('-subagent') ? 'ok' : (JSON.parse(prompt).subagent ? `Final.\n${block({task: 'nested'})}` : block({task: 'first'}))), config: {}});
  assert.equal(again.output, 'Final.');
  assert.ok(again.lines.some(line => /one sub-agent per reply is the limit/.test(line.text)));
});

test('a helper cannot spawn another helper: its reply is never parsed', async () => {
  const runners = [];
  const executor = async (who, prompt) => {
    runners.push(who.id);
    if (who.id.endsWith('-subagent')) return block({task: 'nested helper'});
    return JSON.parse(prompt).subagent ? 'Done.' : block({task: 'one job'});
  };
  const reply = await replyWithSubagents({bot: spawner(), envelope: {}, executor, config: {}});
  assert.deepEqual(runners, ['helper', 'helper-subagent', 'helper']);
  assert.equal(reply.spawns.length, 1);
});

test('the envelope describes the tool only to a bot that holds it', () => {
  const group = {id: 'g', name: 'G', bots: [bot('a', {permissions: [SUBAGENT_PERMISSION]}), bot('b')]};
  const run = createRun({group, message: 'go', makeId: () => 'r'});
  const withTool = createEnvelope({run, bot: group.bots[0]});
  const without = createEnvelope({run, bot: group.bots[1], previous: null});
  assert.match(withTool.tools.subagent, /spawn/);
  assert.equal(withTool.tools.browser, undefined);
  assert.ok(withTool.restrictions.some(line => /sub-agent is help with thinking/.test(line)));
  assert.equal(without.tools, undefined);
  assert.equal(without.restrictions.some(line => /sub-agent/.test(line)), false);
});

test('a group run files the helper lines and keeps the final reply as the step output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-subagent-'));
  try {
    const store = await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    const parent = bot('writer', {type: 'writing', permissions: [SUBAGENT_PERMISSION]});
    const group = {id: 'g', name: 'G', bots: [parent]};
    await store.update(s => { s.groups = [group]; coordinationState(s); s.groupRuns.push(createRun({group, message: 'draft a reply', makeId: () => 'run-1', chatKey: 'team-g'})); });
    const prompts = [];
    await runGroup(store, 'run-1', async (who, raw) => {
      prompts.push({bot: who.id, input: JSON.parse(raw)});
      if (who.id.endsWith('-subagent')) return 'Figures match.';
      return prompts.filter(p => p.bot === 'writer').length === 1 ? block({name: 'Fact check', task: 'Do the figures match?'}) : 'Here is a reply you can edit.';
    });
    const state = store.read();
    const run = state.groupRuns[0];
    assert.equal(run.status, 'completed');
    assert.equal(run.trace.length, 1);
    assert.equal(run.trace[0].output, 'Here is a reply you can edit.');
    assert.equal(run.subagents.length, 1);
    assert.equal(run.subagents[0].botId, 'writer');
    assert.equal(run.subagents[0].output, 'Figures match.');
    const lines = state.chats['team-g'].filter(m => m.kind === 'subagent');
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => line.runId === 'run-1'));
    assert.match(lines[1].text, /Figures match\./);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
