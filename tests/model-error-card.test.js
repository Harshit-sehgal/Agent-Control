/** A provider failure that another model would get past (an unknown model, no credit, a bad key, a rate limit)
 * leaves the same Switch card a CLI usage limit does, naming what went wrong. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {modelLimitLine} from '../src/cli-model.js';

const state = {
  ai: {providers: [{id: 'p1', label: 'OpenAI', kind: 'api'}, {id: 'p2', label: 'My Claude', kind: 'local-cli', engine: 'claude'}]},
  groups: [{id: 'g', bots: [{id: 'rep', name: 'Replier'}]}],
};
const err = (code, extra = {}) => Object.assign(new Error('x'), {code, providerId: 'p1', botId: 'rep', model: 'gpt-9', ...extra});

test('an unknown model, no credit, a bad key and a rate limit each offer the other model', () => {
  const words = {
    'model-not-found': /OpenAI does not offer gpt-9/,
    quota: /OpenAI is out of credit or quota/,
    auth: /OpenAI rejected its key/,
    'rate-limit': /OpenAI is rate limiting/,
  };
  for (const [code, re] of Object.entries(words)) {
    const line = modelLimitLine(state, err(code), {runId: 'r1'});
    assert.match(line.text, re, code);
    assert.match(line.text, /switch Replier to My Claude/, code);
    assert.equal(line.switchTo, 'p2');
    assert.equal(line.kind, 'model-limit');
    assert.equal(line.botId, 'rep');
  }
});

test('other failures leave no card', () => {
  assert.equal(modelLimitLine(state, err('provider-down'), {runId: 'r1'}), null);
  assert.equal(modelLimitLine(state, new Error('boom'), {runId: 'r1'}), null);
});
