// "Delete the price tracker bot": Atlas proposes the removal as a card the owner
// applies, like a rename, instead of sending the owner to find the button.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSetupRequests, resolveSetup, setupCardOf, setupDone, SETUP_TOOL_HINT} from '../shared/setup.js';

const block = body => `Sure.\n\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``;
const ask = (state, body) => resolveSetup(state, parseSetupRequests(block(body))[0].request, {speaker: null});
const state = () => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}, {id: 'price', name: 'Price tracker', instructions: 'Tracks prices.'}]}], tasks: [], events: []});

test('a bot can propose removing another bot, as a card the owner applies', () => {
  const made = ask(state(), {action: 'remove', bot: 'Price tracker'});
  assert.equal(made.ok, true, made.error);
  assert.equal(made.card.action, 'remove');
  assert.equal(made.card.botId, 'price');
  assert.match(made.card.text, /Remove Price tracker/);
  assert.equal(setupCardOf({setup: made.card})?.botId, 'price');
});

test('Atlas cannot be removed, and an unknown bot is named back', () => {
  assert.match(ask(state(), {action: 'remove', bot: 'Atlas'}).error, /cannot be removed/);
  assert.match(ask(state(), {action: 'remove', bot: 'Nobody'}).error, /Price tracker/);
});

test('the card is done once the bot is gone', () => {
  const {card} = ask(state(), {action: 'remove', bot: 'Price tracker'});
  assert.equal(setupDone(state(), card), false);
  const gone = state(); gone.groups[0].bots.pop();
  assert.equal(setupDone(gone, card), true);
});

test('bots are told they can propose a removal', () => {
  assert.match(SETUP_TOOL_HINT, /"action":"remove"/);
});

test('the card\'s button says Remove, not Apply', async () => {
  const {setupButton} = await import('../shared/setup.js');
  assert.equal(setupButton({action: 'remove', text: 'Remove Price tracker'}), 'Remove');
  assert.equal(setupButton({action: 'job', text: 'x'}), 'Apply');
});
