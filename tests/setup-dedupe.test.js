// A bot that proposes the same change twice in one stretch ("Sign in to reddit.com", then again) shows one card.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupCardsFromReply} from '../src/setup-cards.js';

const block = body => `Here.\n\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``;
const bot = {id: 'atlas', name: 'Atlas'};

test('the same card proposed again within minutes is not added twice', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], chats: {}};
  const store = {read: () => state};
  const first = setupCardsFromReply(store, {bot, output: block({action: 'signin', site: 'reddit.com'})});
  assert.equal(first.lines.length, 1);
  state.chats.atlas = [first.lines[0]];
  const second = setupCardsFromReply(store, {bot, output: block({action: 'signin', site: 'reddit.com'})});
  assert.equal(second.lines.length, 0);
  const other = setupCardsFromReply(store, {bot, output: block({action: 'signin', site: 'linkedin.com'})});
  assert.equal(other.lines.length, 1);
});
