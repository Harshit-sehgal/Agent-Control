// "Connect my Gmail": the card takes the owner to Google's sign-in in one tap,
// instead of only pointing at the Connectors page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSetupRequests, resolveSetup, setupCardOf, setupButton, SETUP_TOOL_HINT} from '../shared/setup.js';

const block = body => `Sure.\n\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``;
const ask = body => resolveSetup({groups: []}, parseSetupRequests(block(body))[0].request, {speaker: null});

test('a Gmail, Drive or Google page is a Connect card for that Google MCP app', () => {
  for (const [page, app] of [['gmail', 'gmail'], ['drive', 'google-drive'], ['google', 'gmail']]) {
    const made = ask({action: 'open', page});
    assert.equal(made.ok, true, made.error);
    assert.equal(made.card.action, 'connect');
    assert.equal(made.card.app, app);
    assert.equal(setupButton(made.card), 'Connect');
    assert.equal(setupCardOf({setup: made.card})?.app, app);
  }
  assert.equal(ask({action: 'open', page: 'connectors'}).card.app, undefined);
});

test('bots are told the Gmail card connects Google itself', () => {
  assert.match(SETUP_TOOL_HINT, /"page":"[^"]*gmail/);
});
