/** What every bot is told about what it can do. Bots used to say "only allowlisted hosts", "I can't open X",
 * "a new bot has no permissions" and "one bot per reply", and asked again for details the owner had already
 * given; each of those came from a sentence in their instructions. These pin the corrected sentences. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_TOOL_HINT, MAX_REQUESTS_PER_REPLY} from '../shared/bot-browser.js';
import {BOT_CREATE_TOOL_HINT, MAX_NEW_BOTS_PER_REPLY, botCreatedText} from '../shared/bot-create.js';
import {createEnvelope} from '../shared/coordination.js';

test('the browser hint says any public site works and how to search, and nothing about an allowlist', () => {
  assert.doesNotMatch(BROWSER_TOOL_HINT, /allowlist/i);
  assert.match(BROWSER_TOOL_HINT, /Any public site works, including X and YouTube/);
  assert.match(BROWSER_TOOL_HINT, /https:\/\/www\.bing\.com\/search\?q=/);
  assert.doesNotMatch(BROWSER_TOOL_HINT, /never click or type on X/);
  assert.match(BROWSER_TOOL_HINT, /several blocks in one reply/);
});

test('the new-bot hint says how many, that the bot can browse, and to hand it the task at once', () => {
  assert.match(BOT_CREATE_TOOL_HINT, new RegExp(`up to ${MAX_NEW_BOTS_PER_REPLY} in one reply`));
  assert.doesNotMatch(BOT_CREATE_TOOL_HINT, /no permissions/);
  assert.match(BOT_CREATE_TOOL_HINT, /hand each new bot its first task: write @Name/);
  assert.match(BOT_CREATE_TOOL_HINT, /what the owner already told you/);
  assert.doesNotMatch(botCreatedText({name: 'Atlas'}, {name: 'Scout'}, 'Home'), /no permissions/);
});

test('every bot is told to work with what it has and that permission is not a reason to refuse', () => {
  const bot = {id: 'w', name: 'Writer', instructions: 'Writes.', permissions: []};
  const envelope = createEnvelope({run: {id: 'r', groupId: 'g', input: 'find internships', recipients: ['w'], currentStep: 0, maxSteps: 1, peerAsks: []}, bot});
  const rules = JSON.stringify(envelope);
  assert.match(rules, /never ask again for something they told you/);
  assert.match(rules, /Never refuse a task for lack of permission/);
  assert.doesNotMatch(rules, /has no permissions/);
});
