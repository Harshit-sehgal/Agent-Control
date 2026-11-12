// "Reddit needs me signed in": the bot gives the owner one button that opens this computer's browser on
// that site, in their hands, so they sign in once and every bot can use the shared browser after.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSetupRequests, resolveSetup, setupCardOf, setupButton, setupDone, SETUP_TOOL_HINT} from '../shared/setup.js';

const state = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}]};
const ask = body => resolveSetup(state, parseSetupRequests(`Sure.\n\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``)[0].request, {speaker: {id: 'atlas', name: 'Atlas'}});

test('a sign-in card opens the shared browser on the site', () => {
  const made = ask({action: 'signin', site: 'reddit.com'});
  assert.equal(made.ok, true, made.error);
  assert.deepEqual({action: made.card.action, botId: made.card.botId, url: made.card.url}, {action: 'signin', botId: 'atlas', url: 'https://reddit.com/'});
  assert.match(made.card.text, /Sign in to reddit\.com/);
  assert.equal(setupButton(made.card), 'Sign in');
  assert.equal(setupCardOf({setup: made.card})?.url, 'https://reddit.com/');
  assert.equal(setupDone(state, made.card), false);
});

test('a sign-in card needs a public site, and bots are told when to use it', () => {
  assert.equal(ask({action: 'signin', site: 'localhost'}).ok, false);
  assert.equal(ask({action: 'signin'}).ok, false);
  assert.equal(setupCardOf({setup: {action: 'signin', botId: 'atlas', url: 'javascript:alert(1)', text: 'x'}}), null);
  assert.match(SETUP_TOOL_HINT, /"action":"signin"/);
});
