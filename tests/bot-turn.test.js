/** `runBotTurn` owns the one order a bot's reply is read in: a sub-agent round,
 * then a bot-to-bot ask, then a new-bot block. The group loop and the 1:1 chat
 * both call it (see src/coordination.js and src/routes-groups.js), so these
 * tests are what keeps the two callers from drifting apart again. They drive the
 * module with a fake executor and a store that is only a plain object, which is
 * the whole point: the sequence no longer needs a server to be exercised. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runBotTurn} from '../src/bot-turn.js';
import {SUBAGENT_PERMISSION} from '../shared/subagents.js';
import {BOT_ASK_PERMISSION} from '../shared/bot-link.js';
import {BOT_CREATE_PERMISSION} from '../shared/bot-create.js';

const block = (name, body) => '```' + name + '\n' + JSON.stringify(body) + '\n```';
const plainStore = state => ({state, read: () => state, update: fn => Promise.resolve(fn(state))});

const writer = {id: 'writer', name: 'Writer', type: 'custom', instructions: 'Draft the post', permissions: [SUBAGENT_PERMISSION, BOT_ASK_PERMISSION, BOT_CREATE_PERMISSION]};
const researcher = {id: 'researcher', name: 'Researcher', type: 'custom', instructions: 'Find sources', permissions: []};

/** An executor that walks a bot through all three blocks in order, and answers
 * as the helper and the peer when they are the one being called. */
function scriptedExecutor(calls) {
  return async (who, prompt) => {
    calls.push({bot: who.id, prompt: JSON.parse(prompt)});
    if (who.id.endsWith('-subagent')) return 'the check passed';
    if (who.id === 'researcher') return 'Source X supports it.';
    const turn = JSON.parse(prompt);
    if (turn.subagent) return `Draft with the check.\n${block('ask', {to: '@Researcher', task: 'Which source?'})}`;
    if (turn.peerAnswer) return `Final post.\n${block('create-bot', {name: 'Source scout', job: 'Watch the feed for new posts.'})}`;
    return `Draft.\n${block('spawn', {name: 'Fact check', task: 'Does the 30% figure hold?'})}`;
  };
}

test('one turn runs the three blocks in order and returns the last reply', async () => {
  const state = {events: [], groups: [{id: 'g1', name: 'Team', bots: [writer, researcher]}]};
  const calls = [];
  const turn = await runBotTurn(plainStore(state), {
    bot: writer,
    envelope: {task: 'Write the post.'},
    executor: scriptedExecutor(calls),
    config: {},
    peers: [writer, researcher],
    groupId: 'g1',
  });
  // The bot is called first, then the helper, then the bot again, then the peer,
  // then the bot once more: the ask runs only after the spawn's answer is in.
  assert.deepEqual(calls.map(c => c.bot), ['writer', 'writer-subagent', 'writer', 'researcher', 'writer']);
  assert.equal(turn.output, 'Final post.', 'the create-bot block is stripped from the output');
  assert.equal(turn.spawns.length, 1);
  assert.equal(turn.asks.length, 1);
  assert.equal(turn.created.length, 1);
  assert.equal(turn.created[0].name, 'Source scout');
  assert.equal(state.groups[0].bots.length, 3, 'the new bot is added to the caller group');
  // The chat lines read in the order the work happened, which is how a run
  // shows it: the helper, the peer, then the created bot.
  assert.deepEqual(turn.lines.map(l => l.kind), ['subagent', 'subagent', 'peer', 'peer', 'bot-created']);
});

test('no group means the new-bot block is skipped, not silently applied', async () => {
  const state = {events: [], groups: [{id: 'g1', name: 'Team', bots: [writer, researcher]}]};
  const calls = [];
  const turn = await runBotTurn(plainStore(state), {
    bot: writer,
    envelope: {task: 'Write the post.'},
    executor: async (who, prompt) => {
      calls.push(who.id);
      if (who.id.endsWith('-subagent')) return 'answer';
      const input = JSON.parse(prompt);
      // No spawn and no ask this time: go straight to a create-bot block.
      if (input.subagent || input.peerAnswer) return 'Plain reply.';
      return `Plain reply.\n${block('create-bot', {name: 'Ghost', job: 'Nowhere to live.'})}`;
    },
    config: {},
    peers: [writer, researcher],
    groupId: null,
  });
  assert.equal(turn.created.length, 0, 'a create-bot block with no group creates nothing');
  assert.equal(state.groups[0].bots.length, 2, 'the workspace is untouched');
  // With nowhere to put the bot the fence is not read, so it stays as plain
  // text. That is the pre-existing behaviour of the 1:1 path; this only pins it
  // so the two callers cannot start disagreeing about it by accident.
  assert.match(turn.output, /create-bot/);
});

test('the round budgets are honoured, so a resumed step does not repeat a block', async () => {
  const state = {events: [], groups: [{id: 'g1', name: 'Team', bots: [writer, researcher]}]};
  const calls = [];
  // Every round already spent: the spawn and the ask are refused, and the
  // bot's first reply is the answer (its block is stripped, not run).
  const turn = await runBotTurn(plainStore(state), {
    bot: writer,
    envelope: {task: 'Write the post.'},
    executor: scriptedExecutor(calls),
    config: {},
    peers: [writer, researcher],
    groupId: 'g1',
    spawnRounds: 1,
    askRounds: 1,
  });
  assert.deepEqual(calls.map(c => c.bot), ['writer'], 'neither the helper nor the peer is called');
  assert.equal(turn.spawns.length, 0);
  assert.equal(turn.asks.length, 0);
  assert.match(turn.lines[0].text, /does not hold|limit|round/);
});

test('the output always survives a refused block, so a person is never left with silence', async () => {
  const state = {events: [], groups: [{id: 'g1', name: 'Team', bots: [{...writer, permissions: []}, researcher]}]};
  const plain = {...writer, permissions: []};
  const turn = await runBotTurn(plainStore(state), {
    bot: plain,
    envelope: {task: 'Say something.'},
    executor: async () => `An answer.\n${block('create-bot', {name: 'Nope', job: 'Too short.'})}`,
    config: {},
    peers: [plain, researcher],
    groupId: 'g1',
  });
  assert.equal(turn.output, 'An answer.');
  assert.equal(turn.created.length, 0);
  assert.match(turn.lines.map(l => l.text).join(' '), /the request was refused/);
});

test('a setup card is a follow-up: it comes after the reply, not before it', async () => {
  const state = {events: [], groups: [{id: 'g1', name: 'Team', bots: [writer, researcher]}], ai: {providers: [{id: 'p1', label: 'My Claude', kind: 'local-cli', engine: 'claude'}]}};
  const turn = await runBotTurn(plainStore(state), {
    bot: writer, envelope: {task: 'Put Researcher on haiku.'}, config: {}, peers: [writer, researcher], groupId: 'g1',
    executor: async () => `Done.\n${block('setup', {action: 'model', bot: 'Researcher', provider: 'My Claude', model: 'haiku'})}`,
  });
  assert.equal(turn.output, 'Done.');
  assert.deepEqual(turn.lines, [], 'nothing happened before the reply');
  assert.deepEqual(turn.after.map(l => l.kind), ['setup']);
});
