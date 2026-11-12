/** The Pages demo's primary answers itself unless asked to make a bot, a bot it makes is named by its role and
 * takes the task in the same run, and a send, a post or a payment shows the ask card instead of saying "Done". */
import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateGroup} from '../shared/group-simulator.js';
import {createThread} from '../shared/threads.js';
import {offlineReply, outsideAsk} from '../shared/offline-bots.js';
import {askCard} from '../shared/ui-asks.js';

const atlas = {id: 'atlas', name: 'Atlas', instructions: 'Atlas runs the company.', settings: {lead: true}};

async function threadRun(message) {
  const home = {id: 'home', name: 'Home', bots: [{...atlas}], settings: {}};
  const state = {groups: [home], chats: {}, events: []};
  const thread = createThread(state, {title: 'x'});
  state.groups.push(thread);
  const out = [];
  let n = 0;
  const run = await simulateGroup({group: thread, message, guests: [home.bots[0]], state, chatKey: `team-${thread.id}`,
    api: async () => { throw new Error('no api in the demo'); }, makeId: () => `d-${++n}`, emit: m => out.push(m)});
  return {state, home, out, run};
}

test('a task no bot fits: the primary answers itself and makes no bot', async () => {
  const {home, out, run} = await threadRun('Open example.com and summarise it');
  assert.equal(home.bots.length, 1, 'no bot was made');
  assert.equal(run.status, 'completed');
  const said = out.filter(m => m.role === 'bot');
  assert.deepEqual(said.map(m => m.senderName), ['Atlas']);
  assert.match(said[0].text, /^I'll take this one myself: open example\.com and summarise it\./);
  assert.doesNotMatch(out.map(m => m.text).join('\n'), /Done:|created a new bot/);
});

test('asked to make a bot, the primary makes one named by its role, and it takes the task', async () => {
  const {home, out} = await threadRun('Make a bot that watches my inbox and drafts replies');
  const made = home.bots.find(b => b.id !== 'atlas');
  assert.equal(made?.name, 'Inbox Watcher');
  assert.ok(out.filter(m => m.role === 'bot').some(m => m.senderName === made.name), 'the new bot spoke');
  assert.doesNotMatch(out.map(m => m.text).join('\n'), /Here is what the team said|Ask me to make a bot|Done:/);
});

test('a send shows the ask card and waits: never "Done", nothing sent', async () => {
  const {state, out, run} = await threadRun('Send an email to bob@example.com saying hi');
  assert.equal(run.status, 'awaiting_ask');
  assert.equal(state.asks.length, 1);
  const [ask] = state.asks;
  assert.deepEqual([ask.action, ask.botId, ask.status, ask.body], ['send', 'atlas', 'pending', 'hi']);
  const line = out.find(m => m.kind === 'ask');
  assert.equal(line.askId, ask.id);
  const card = askCard(state, line);
  assert.equal(card.question, 'Let Atlas send an email to bob@example.com?', 'the whole request, not cut mid-sentence');
  assert.deepEqual(card.choices.map(c => c.label), ['Allow once', 'Always allow', "Don't allow"]);
  assert.doesNotMatch(out.map(m => m.text).join('\n'), /Done/);
});

test('posts and payments ask too; ordinary requests do not', () => {
  assert.equal(outsideAsk('Post on linkedin.com saying we launched').action, 'post');
  assert.equal(outsideAsk('Post on linkedin.com saying we launched').target, 'https://linkedin.com');
  assert.equal(outsideAsk('Please buy the blue mug on shop.example.com').action, 'spend');
  assert.equal(outsideAsk('Open example.com and summarise it'), null);
  assert.equal(outsideAsk('What can you do?'), null);
});

test('a demo closing reply neither relays the team nor says "Done" on a cut title', () => {
  const text = offlineReply({bot: atlas, request: 'Send an email to bob@example.com saying hi', closing: true, previous: {botId: 'r', output: 'On it'}, team: [{id: 'r', name: 'Researcher'}]});
  assert.doesNotMatch(text, /Here is what the team said|Done:|saying\./);
});
