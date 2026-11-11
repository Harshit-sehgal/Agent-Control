/** An ask card is posted after the reply that asked, so it must read after it in the chat. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {addAskCards} from '../src/ask-cards.js';

test('the card is stamped when it is posted, not when the ask was made a moment before the reply', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], chats: {atlas: []}};
  const ask = {id: 'a1', chatKey: 'atlas', botId: 'atlas', action: 'read', site: 'example.com', url: 'https://example.com/', createdAt: '2026-11-11T10:00:00.000Z'};
  state.chats.atlas.push({id: 'r', role: 'bot', text: 'Opening it.', at: '2026-11-11T10:00:00.002Z'});
  addAskCards(state, ask, {name: 'Atlas'});
  const card = state.chats.atlas.find(m => m.kind === 'ask');
  assert.ok(card, 'the card is posted');
  assert.ok(card.at > '2026-11-11T10:00:00.002Z', `the card (${card.at}) reads after the reply`);
});
