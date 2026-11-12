/** A subscription's model list names every model it can run, by its full name and id, not only the
 * opus/sonnet/haiku shorthands; a bot asking for "Haiku 5.5" gets that exact version. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {CLI_MODELS} from '../shared/ai-presets.js';
import {modelChoices, OTHER_MODEL} from '../shared/ui-connect-model.js';
import {modelFor} from '../shared/setup.js';

const claude = {kind: 'local-cli', engine: 'claude', label: 'My Claude'};

test('the Claude list has the shorthands, then every versioned model by its full name', () => {
  const rows = modelChoices({provider: claude});
  const values = rows.map(r => r.value);
  assert.deepEqual(values.slice(0, 4), ['', 'opus', 'sonnet', 'haiku']);
  for (const id of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-4-8', 'claude-haiku-4-5']) assert.ok(values.includes(id), id);
  assert.equal(rows.find(r => r.value === 'claude-haiku-5-5').label, 'Claude Haiku 5.5 · claude-haiku-5-5');
  assert.match(rows.find(r => r.value === 'haiku').label, /newest Haiku/);
  assert.equal(values.at(-1), OTHER_MODEL);
  assert.equal(new Set(values).size, values.length, 'no row twice');
});

test('Codex lists its models by name too', () => {
  const values = modelChoices({provider: {kind: 'local-cli', engine: 'codex'}}).map(r => r.value);
  assert.ok(values.includes('gpt-5.5'));
  assert.ok(CLI_MODELS.codex.every(([id, label]) => id && label));
});

test('a bot naming a version gets that exact model; a family alone gets the shorthand', () => {
  assert.deepEqual(modelFor(claude, 'haiku 5.5'), {ok: true, model: 'claude-haiku-5-5'});
  assert.deepEqual(modelFor(claude, 'Claude Haiku 5.5'), {ok: true, model: 'claude-haiku-5-5'});
  assert.deepEqual(modelFor(claude, 'haiku-4.5'), {ok: true, model: 'claude-haiku-4-5'});
  assert.deepEqual(modelFor(claude, 'claude-opus-4-8'), {ok: true, model: 'claude-opus-4-8'});
  assert.deepEqual(modelFor(claude, 'Sonnet'), {ok: true, model: 'sonnet'});
  assert.match(modelFor(claude, 'haiku 9.9').error, /no Claude Haiku 9\.9.*claude-haiku-5-5/);
});

import {buildCommand} from '../agent/cli-model.mjs';
test('every listed model reaches its CLI as that exact id', () => {
  for (const [id] of CLI_MODELS.claude) {
    const {args} = buildCommand('claude', {model: id, dir: '/tmp'});
    assert.equal(args[args.indexOf('--model') + 1], id, id);
  }
  for (const [id] of CLI_MODELS.codex) {
    const {args} = buildCommand('codex', {model: id, dir: '/tmp'});
    assert.ok(args.includes(id), id);
  }
});
