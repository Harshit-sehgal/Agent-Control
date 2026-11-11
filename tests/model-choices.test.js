/** The model dropdown: a list to pick from, filled from what the provider offers, with Other… for any id. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {modelChoices, chosenModel, OTHER_MODEL} from '../shared/ui-connect-model.js';

const values = rows => rows.map(r => r.value);

test('a Claude subscription offers the names the claude command knows', () => {
  const rows = modelChoices({provider: {kind: 'local-cli', engine: 'claude'}, defaultLabel: 'Default'});
  assert.deepEqual(values(rows), ['', 'opus', 'sonnet', 'haiku', OTHER_MODEL]);
  assert.equal(rows[0].selected, true);
  assert.equal(rows.at(-1).label, 'Other…');
});

test('an API provider offers its own chat models, by label when it names them', () => {
  const rows = modelChoices({provider: {kind: 'api', chatModels: ['llama-3.3-70b', 'mixtral'], labels: {mixtral: 'Mixtral 8x7B'}}, current: 'mixtral'});
  assert.deepEqual(values(rows), ['', 'llama-3.3-70b', 'mixtral', OTHER_MODEL]);
  assert.equal(rows.find(r => r.value === 'mixtral').label, 'Mixtral 8x7B');
  assert.deepEqual(rows.filter(r => r.selected).map(r => r.value), ['mixtral']);
});

test('a saved id the list does not have stays picked and says it is the current one', () => {
  const rows = modelChoices({provider: {kind: 'local-cli', engine: 'claude'}, current: 'haiku-5.5'});
  assert.deepEqual(values(rows), ['', 'haiku-5.5', 'opus', 'sonnet', 'haiku', OTHER_MODEL]);
  assert.equal(rows[1].label, 'haiku-5.5 (current)');
  assert.equal(rows[1].selected, true);
});

test('no provider or no catalogue still gives Default and Other…', () => {
  assert.deepEqual(values(modelChoices()), ['', OTHER_MODEL]);
  assert.deepEqual(values(modelChoices({provider: {kind: 'local-cli', engine: 'codex'}})), ['', OTHER_MODEL]);
});

test('the posted model is the picked one, or the typed id after Other…', () => {
  assert.equal(chosenModel({model: 'sonnet'}), 'sonnet');
  assert.equal(chosenModel({model: OTHER_MODEL, modelOther: '  claude-haiku-5-5 '}), 'claude-haiku-5-5');
  assert.equal(chosenModel({model: OTHER_MODEL}), '');
  assert.equal(chosenModel({}), '');
});
