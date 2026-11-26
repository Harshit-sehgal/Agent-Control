// The model picker's search bar: which rows a query keeps, and when the bar shows at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {modelRowMatches} from '../shared/ui-connect-model.js';
import {modelSelect, groupedModelSelect, MODEL_SEARCH_FROM} from '../shared/ui-kit.js';

const row = (value, label = value) => ({value, label});

test('every word of the query must appear, in any order, ignoring case, accents and separators', () => {
  assert.equal(modelRowMatches('son 4', row('claude-sonnet-4-5', 'Claude Sonnet 4.5')), true);
  assert.equal(modelRowMatches('4.5 SONNET', row('claude-sonnet-4-5')), true);
  assert.equal(modelRowMatches('gpt5', row('gpt-5-mini')), true, 'a query typed without the dash still finds it');
  assert.equal(modelRowMatches('mini', row('p1|gpt-5-mini', 'gpt-5-mini')), true);
  assert.equal(modelRowMatches('opus', row('claude-sonnet-4-5')), false);
  assert.equal(modelRowMatches('  ', row('anything')), true, 'an empty query keeps every row');
  assert.equal(modelRowMatches('gemini', row('p2|', 'Google · its default')), false);
  assert.equal(modelRowMatches('son 4', row('189d6400-5f58-4d8e|sonnet', 'Sonnet · the newest Sonnet')), false, 'the provider id before | is not searched');
});

test('the bar shows from MODEL_SEARCH_FROM models up, not counting the type-an-id rows', () => {
  const few = Array.from({length: MODEL_SEARCH_FROM - 1}, (_, i) => row(`m${i}`));
  const many = Array.from({length: MODEL_SEARCH_FROM}, (_, i) => row(`m${i}`));
  const bar = html => html.match(/<div class="mdl-find"[^>]*>/)?.[0] || '';
  assert.match(bar(modelSelect([...few, row('__other', 'Other…')])), /hidden/);
  assert.doesNotMatch(bar(modelSelect(many)), /hidden/);
  const grouped = {top: row('', 'Workspace default'), groups: [{label: 'A', rows: [...few.map(r => row(`a|${r.value}`)), row('a|__other')]}, {label: 'B', rows: [row('b|x')]}]};
  assert.doesNotMatch(bar(groupedModelSelect(grouped)), /hidden/, `${MODEL_SEARCH_FROM} models across two providers`);
});

test('the bar comes before the select, labelled, and never posts with the form', () => {
  const html = modelSelect(Array.from({length: 9}, (_, i) => row(`m${i}`)));
  assert.ok(html.indexOf('mdl-find') < html.indexOf('<select'));
  const input = html.match(/<input[^>]*data-model-search[^>]*>/)?.[0] || '';
  assert.match(input, /type="search"/);
  assert.match(input, /aria-label="Search models"/);
  assert.doesNotMatch(input, /\sname=/, 'no name, so FormData never carries the query');
});

test('a provider group stays while it holds a model or the picked row, even a typed-id one', async () => {
  const {modelGroupStays, OTHER_MODEL} = await import('../shared/ui-connect-model.js');
  const typed = `pA|${OTHER_MODEL}`;
  assert.equal(modelGroupStays(['pA|gpt-5', typed], ''), true);
  assert.equal(modelGroupStays([typed], ''), false, 'only the type-an-id row left: the group goes');
  assert.equal(modelGroupStays([typed], typed), true, 'the picked "Another model" row keeps its group, so the typed id is still sent');
  assert.equal(modelGroupStays([], typed), false);
});
