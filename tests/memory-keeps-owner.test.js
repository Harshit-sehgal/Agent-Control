/** Memory keeps what the owner asked it to keep, and never teaches a bot that it cannot do what the app does for it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeConsolidation, ruleLines, rulebook} from '../shared/memory.js';

const KEY = 'bot:atlas';
const stateWith = (rules = [], pending = []) => {
  const state = {memory: {version: 1, rulebooks: {}}};
  const book = rulebook(state, KEY);
  book.rules = rules.map((text, i) => ({id: `r${i}`, text, source: 'model', createdAt: 'x', updatedAt: 'x', uses: 0}));
  book.pending = pending;
  return state;
};

test('a tidy-up that drops what the owner asked to remember puts it back', () => {
  const said = 'Remember: I prefer internships in Bangalore or remote, with a stipend above 20k per month.';
  const state = stateWith([], [said]);
  const book = mergeConsolidation(state, KEY, {rules: ['Reply in short paragraphs.'], summary: ''}, {sentPending: [said]});
  assert.ok(book.rules.some(r => /Bangalore or remote/.test(r.text)), JSON.stringify(book.rules));
});

test('a rephrased owner note is not kept twice', () => {
  const said = 'Remember: I prefer internships in Bangalore or remote, with a stipend above 20k per month.';
  const state = stateWith([], [said]);
  const book = mergeConsolidation(state, KEY, {rules: ['The owner prefers internships in Bangalore or remote, with a stipend above 20k per month.'], summary: ''}, {sentPending: [said]});
  assert.equal(book.rules.filter(r => /Bangalore/.test(r.text)).length, 1);
});

test('a note that says the bot cannot browse is never stored or sent', () => {
  const bad = 'In a text-only session Atlas cannot browse or open web pages; say so rather than implying a check was done.';
  const state = stateWith([bad, 'Reply in short paragraphs.']);
  assert.deepEqual(ruleLines(rulebook(state, KEY)), ['Reply in short paragraphs.']);
  const book = mergeConsolidation(state, KEY, {rules: [bad, 'I have no browsing access.', 'Reply in short paragraphs.'], summary: ''});
  assert.deepEqual(book.rules.map(r => r.text), ['Reply in short paragraphs.']);
});
