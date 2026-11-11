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

/* ---------- one grouped picker for a bot: every provider's models in one list ---------- */
import {botModelChoices, pickedModel, effortChoices} from '../shared/ui-connect-model.js';
import {modelLine} from '../shared/ui-profile-model.js';

const ai = {
  defaultProviderId: 'p1', defaultModel: 'llama-3.3-70b',
  providers: [
    {id: 'p1', label: 'Groq', kind: 'api', chatModels: ['llama-3.3-70b', 'mixtral'], labels: {mixtral: 'Mixtral 8x7B'}},
    {id: 'p2', label: 'My Claude', kind: 'local-cli', engine: 'claude', model: ''},
  ],
};

test('a bot picks any model from one list, grouped by provider, with the workspace default first', () => {
  const {top, groups} = botModelChoices(ai, {});
  assert.equal(top.value, '');
  assert.equal(top.label, 'Workspace default · Groq · llama-3.3-70b');
  assert.equal(top.selected, true);
  assert.deepEqual(groups.map(g => g.label), ['Groq', 'My Claude']);
  assert.deepEqual(values(groups[0].rows), ['p1|', 'p1|llama-3.3-70b', 'p1|mixtral', `p1|${OTHER_MODEL}`]);
  assert.equal(groups[0].rows[2].label, 'Mixtral 8x7B');
  assert.equal(groups[0].rows.at(-1).label, 'Another Groq model…');
  assert.deepEqual(values(groups[1].rows), ['p2|', 'p2|opus', 'p2|sonnet', 'p2|haiku', `p2|${OTHER_MODEL}`]);
  assert.equal(groups[1].rows[0].label, 'My Claude · its default');
});

test('the bot\'s own pick is selected, and a saved id the list lacks stays in', () => {
  const {top, groups} = botModelChoices(ai, {providerId: 'p2', model: 'opus-5.5'});
  assert.equal(top.selected, false);
  const picked = groups.flatMap(g => g.rows).filter(r => r.selected);
  assert.deepEqual(picked.map(r => r.value), ['p2|opus-5.5']);
  assert.equal(picked[0].label, 'opus-5.5 (current)');
  // A model with no provider of its own is on the workspace default's provider.
  assert.deepEqual(botModelChoices(ai, {model: 'mixtral'}).groups[0].rows.filter(r => r.selected).map(r => r.value), ['p1|mixtral']);
});

test('the posted pick is a provider and a model, or the typed id after Another…', () => {
  assert.deepEqual(pickedModel({model: ''}), {providerId: null, model: ''});
  assert.deepEqual(pickedModel({model: 'p1|mixtral'}), {providerId: 'p1', model: 'mixtral'});
  assert.deepEqual(pickedModel({model: 'p2|'}), {providerId: 'p2', model: ''});
  assert.deepEqual(pickedModel({model: `p1|${OTHER_MODEL}`, modelOther: ' my-finetune '}), {providerId: 'p1', model: 'my-finetune'});
});

test('effort is four plain choices with the current one checked', () => {
  const rows = effortChoices('high');
  assert.deepEqual(values(rows), ['', 'low', 'medium', 'high']);
  assert.deepEqual(rows.filter(r => r.selected).map(r => r.value), ['high']);
  assert.equal(rows[0].label, 'Default');
  assert.deepEqual(effortChoices().filter(r => r.selected).map(r => r.value), ['']);
});

test('the Model row names the subscription\'s default and the effort', () => {
  assert.equal(modelLine({ai: {...ai, bots: {b: {providerId: 'p2'}}}}, 'b'), 'My Claude · default model');
  assert.equal(modelLine({ai: {...ai, bots: {b: {effort: 'high'}}}}, 'b'), 'Groq · llama-3.3-70b · High effort');
  assert.equal(modelLine({ai: {...ai, defaultEffort: 'low'}}, 'b'), 'Groq · llama-3.3-70b · Low effort');
});

import {modelChip} from '../shared/ui-profile-model.js';
test('a bot chat shows a short model chip, or none when no model is connected', () => {
  assert.deepEqual(modelChip({ai}, 'b'), {text: 'llama-3.3-70b', title: 'Model: Groq · llama-3.3-70b. Change it'});
  assert.deepEqual(modelChip({ai: {...ai, bots: {b: {providerId: 'p2', effort: 'high'}}}}, 'b'), {text: 'My Claude · High', title: 'Model: My Claude · default model · High effort. Change it'});
  assert.equal(modelChip({}, 'b'), null);
  assert.equal(modelChip({aiEnabled: true, aiModel: 'env-model'}, 'b'), null, 'an environment model has no page to change it on');
});

test('the workspace default\'s provider is the first group', () => {
  const swapped = {...ai, defaultProviderId: 'p2', defaultModel: null};
  assert.deepEqual(botModelChoices(swapped, {}).groups.map(g => g.label), ['My Claude', 'Groq']);
  assert.equal(botModelChoices(swapped, {}).top.label, 'Workspace default · My Claude · default model');
});
