// "Delete the price tracker bot" got "open the Agents page and remove it there": the hint called the devices page
// "agents", so the model read it as bots. Bot changes are cards, never a page to open.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSetup, SETUP_TOOL_HINT} from '../shared/setup.js';

const state = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}, {id: 'pt', name: 'Price tracker'}]}]};

test('the hint names the devices page as devices and says bot changes are cards', () => {
  assert.match(SETUP_TOOL_HINT, /"page":"[^"]*\bdevices\b/);
  assert.doesNotMatch(SETUP_TOOL_HINT, /\|agents\|/);
  assert.match(SETUP_TOOL_HINT, /never a page/i);
});

test('asking to open a bots page is refused with the block to use instead', () => {
  for (const page of ['bots', 'bot', 'team']) {
    const out = resolveSetup(state, {action: 'open', page});
    assert.equal(out.ok, false);
    assert.match(out.error, /"action":"remove"/);
  }
  assert.equal(resolveSetup(state, {action: 'open', page: 'devices'}).card.section, 'agents');
  assert.equal(resolveSetup(state, {action: 'remove', bot: 'Price tracker'}).card.botId, 'pt');
});
