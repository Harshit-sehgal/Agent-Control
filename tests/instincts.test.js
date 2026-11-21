/** Agent instincts: a rule the owner can turn off without losing it, and a correction phrased as "next time".
 *
 * A rule is one executable sentence the bot keeps doing. A disabled rule stays in the book (so the owner
 * can turn it back on) but never reaches a bot turn, and a model tidy-up pass must not revive it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {addRules, extractRuleCandidates, findRulebook, memoryState, mergeConsolidation, publicMemory, ruleLines, setRuleEnabled} from '../shared/memory.js';

const at = '2026-01-01T00:00:00.000Z';
const fresh = () => ({memory: memoryState({})});
const KEY = 'bot:atlas';

test('a disabled rule is kept in the book but never reaches a bot turn', () => {
  const state = fresh();
  addRules(state, KEY, ['Always answer in English.', 'Compare competitors in a table.'], {now: at});
  const english = findRulebook(state, KEY).rules.find(r => /English/.test(r.text));
  setRuleEnabled(state, KEY, english.id, false, {now: at});
  assert.deepEqual(ruleLines(findRulebook(state, KEY)), ['Compare competitors in a table.']);
  assert.equal(findRulebook(state, KEY).rules.length, 2, 'the disabled rule is still stored');
});

test('the owner sees whether each rule is on', () => {
  const state = fresh();
  addRules(state, KEY, ['Keep replies under 200 characters.'], {now: at});
  const [rule] = findRulebook(state, KEY).rules;
  setRuleEnabled(state, KEY, rule.id, false, {now: at});
  const view = publicMemory(state, {bot: 'atlas'});
  assert.equal(view.bot.rules[0].enabled, false);
  setRuleEnabled(state, KEY, rule.id, true, {now: at});
  assert.equal(publicMemory(state, {bot: 'atlas'}).bot.rules[0].enabled, true);
});

test('a tidy-up pass that leaves out a disabled rule keeps it, still disabled', () => {
  const state = fresh();
  addRules(state, KEY, ['Always answer in English.', 'Use short sentences.'], {now: at});
  const english = findRulebook(state, KEY).rules.find(r => /English/.test(r.text));
  setRuleEnabled(state, KEY, english.id, false, {now: at});
  mergeConsolidation(state, KEY, {rules: ['Use short sentences.']}, {now: at});
  const kept = findRulebook(state, KEY).rules.find(r => r.id === english.id);
  assert.ok(kept, 'the disabled rule survives the pass');
  assert.equal(kept.enabled, false);
});

test('a tidy-up pass that writes a disabled rule again does not turn it back on', () => {
  const state = fresh();
  addRules(state, KEY, ['Always answer in English.'], {now: at});
  const [rule] = findRulebook(state, KEY).rules;
  setRuleEnabled(state, KEY, rule.id, false, {now: at});
  mergeConsolidation(state, KEY, {rules: ['Always answer in English.']}, {now: at});
  assert.equal(findRulebook(state, KEY).rules.find(r => r.id === rule.id).enabled, false);
});

test('a "next time" correction is taken as a rule', () => {
  const text = 'Next time compare competitors in a table and include source links.';
  assert.ok(extractRuleCandidates(text).includes(text));
});

test('an ordinary request is still not taken as a rule', () => {
  assert.deepEqual(extractRuleCandidates('Find the three best sources on solar panels.'), []);
});

test('the owner switches a rule off from the memory route, and it stops reaching the bot', async () => {
  const {createRouter} = await import('../src/router.js');
  const {memoryRoutes} = await import('../src/routes-memory.js');
  const {ruleLines: lines} = await import('../shared/memory.js');
  const router = createRouter();
  memoryRoutes(router);
  const state = fresh();
  addRules(state, KEY, ['Always answer in English.'], {now: at});
  const rule = findRulebook(state, KEY).rules[0];
  const store = {read: () => state, update: fn => Promise.resolve(fn(state))};
  const found = router.find('PATCH', `/api/memory/rules/${rule.id}`);
  const out = await found.route.handler({store, params: {id: rule.id}, req: {url: '/api/memory/rules/x'}, body: async () => ({bot: 'atlas', enabled: false})});
  assert.equal(out.rule.enabled, false);
  assert.deepEqual(lines(findRulebook(state, KEY)), []);
});

test('a "next time" correction the owner gave survives a tidy-up pass that leaves it out', async () => {
  const {noteTurn} = await import('../shared/memory.js');
  const state = fresh();
  noteTurn(state, KEY, {userText: 'Next time compare competitors in a table and include source links.', botText: 'Noted.', now: at});
  const pending = findRulebook(state, KEY).pending;
  mergeConsolidation(state, KEY, {rules: ['Keep replies short.']}, {now: at, sentPending: pending});
  const kept = findRulebook(state, KEY).rules.map(r => r.text);
  assert.ok(kept.some(text => /compare competitors in a table/.test(text)), `kept: ${kept.join(' | ')}`);
});
