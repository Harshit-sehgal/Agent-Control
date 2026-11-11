/** The Pages demo does what the served app does: when no bot fits, Atlas makes one and hands it the task in the
 * same run, then answers with a result, never "ask me to make a bot" or "here is what the team said". */
import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateGroup} from '../shared/group-simulator.js';
import {createThread} from '../shared/threads.js';
import {offlineReply} from '../shared/offline-bots.js';

const atlas = {id: 'atlas', name: 'Atlas', instructions: 'Atlas runs the company.', settings: {lead: true}};

test('a thread task no bot fits: Atlas makes a bot, the bot takes the task, and Atlas closes with a result', async () => {
  const home = {id: 'home', name: 'Home', bots: [atlas], settings: {}};
  const state = {groups: [home], chats: {}, events: []};
  const thread = createThread(state, {title: 'Weather in Delhi today'});
  state.groups.push(thread);
  const out = [];
  let n = 0;
  await simulateGroup({group: thread, message: 'What is the weather in Delhi today?', guests: [atlas], state, chatKey: `team-${thread.id}`,
    api: async () => { throw new Error('no api in the demo'); }, makeId: () => `d-${++n}`, emit: m => out.push(m)});
  const made = home.bots.find(b => b.id !== 'atlas');
  assert.ok(made, 'a bot was made');
  const speakers = out.filter(m => m.role === 'bot').map(m => m.senderName);
  assert.ok(speakers.includes(made.name), `the new bot spoke: ${speakers.join(', ')}`);
  const last = out.filter(m => m.role === 'bot').at(-1);
  assert.equal(last.senderName, 'Atlas');
  assert.doesNotMatch(last.text, /Here is what the team said|Ask me to make a bot/);
  assert.doesNotMatch(out.map(m => m.text).join('\n'), /Ask me to make a bot/);
});

test('a demo closing reply names who did the work instead of relaying it', () => {
  const text = offlineReply({bot: atlas, request: 'Plan a trip', closing: true, previous: {botId: 'r', output: 'On it: Plan a trip'}, team: [{id: 'r', name: 'Researcher'}]});
  assert.doesNotMatch(text, /Here is what the team said/);
});
