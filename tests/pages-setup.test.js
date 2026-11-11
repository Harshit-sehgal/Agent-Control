/** The Pages demo has no model, but its bots still change settings from chat: a plain request comes back as
 * the same setup card the served app shows, and the owner's Apply goes through the demo's own routes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wf from '../shared/workflow.js';
import {simulateGroup} from '../shared/group-simulator.js';
import {setupCardOf} from '../shared/setup.js';

function world() {
  const state = wf.migrate({version: 1, settings: {}, groups: [{id: 'home', name: 'Home', bots: [{id: 'atlas', name: 'Atlas', type: 'custom', instructions: 'Primary.', settings: {lead: true}}]}], runs: [], tasks: [], events: []});
  wf.addBot(state, 'home', {name: 'Replier', instructions: 'Drafts short replies to my emails.'});
  return state;
}
async function say(state, message, to = 'atlas') {
  const out = [];
  await simulateGroup({group: state.groups[0], message, directBotId: to, guests: [], state, api: async () => {}, makeId: () => `m${out.length}`, emit: m => out.push(m), chatKey: to});
  return out;
}
const cards = out => out.filter(m => m.kind === 'setup').map(setupCardOf).filter(Boolean);

test('Atlas in the demo turns rename, reply length and switch off into cards, not chat text', async () => {
  const state = world();
  const replier = state.groups[0].bots.find(b => b.name === 'Replier');
  let [card] = cards(await say(state, 'rename Replier to Mailer'));
  assert.equal(card.action, 'rename');
  assert.equal(card.name, 'Mailer');
  assert.equal(card.botId, replier.id);
  [card] = cards(await say(state, "make Replier's replies shorter"));
  assert.equal(card.action, 'settings');
  assert.deepEqual(card.settings, {replyLength: 'short'});
  [card] = cards(await say(state, 'switch Replier off'));
  assert.deepEqual(card.settings, {enabled: false});
  const out = await say(state, 'rename Replier to Mailer');
  assert.ok(!out.some(m => /```/.test(m.text || '')), 'the block never shows as text');
});

test('a plain bot in its own demo chat proposes a change to itself', async () => {
  const state = world();
  const replier = state.groups[0].bots.find(b => b.name === 'Replier');
  const [card] = cards(await say(state, 'please keep your replies shorter', replier.id));
  assert.equal(card.botId, replier.id);
  assert.deepEqual(card.settings, {replyLength: 'short'});
});

test('through the demo\'s own routes the card keeps its change, and Apply renames the bot', async () => {
  const {installWebLocks} = await import('./web-locks.js');
  const map = new Map([['agent-control-ghpages-v1', JSON.stringify(world())]]);
  globalThis.window = globalThis.window || {};
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v))}});
  installWebLocks();
  await import('../shared/local-api.js');
  const api = globalThis.window.AGENT_LOCAL_API;
  await api('/api/groups/home/chat', 'POST', {message: 'rename Replier to Mailer', directBotId: 'atlas', chatKey: 'atlas'});
  const state = await api('/api/state');
  const line = (state.chats.atlas || []).find(m => m.kind === 'setup');
  const card = setupCardOf(line);
  assert.equal(card?.action, 'rename', 'the stored line still carries its Apply');
  await api(`/api/groups/home/bots/${card.botId}`, 'PATCH', {name: card.name});
  const after = await api('/api/state');
  assert.ok(after.groups[0].bots.some(b => b.name === 'Mailer'));
});

test('"ask me before each step" in the demo is a team card for Atlas\'s team', async () => {
  const state = world();
  const [card] = cards(await say(state, 'please ask me before each step'));
  assert.deepEqual(card, {action: 'team', groupId: 'home', settings: {checkpoints: true}, text: 'Home: asks you before each step'});
});
