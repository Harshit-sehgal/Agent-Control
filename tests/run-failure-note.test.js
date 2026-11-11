/** When a run fails on a provider error, the chat keeps what the provider said and the fix, not a generic
 * "try again in a minute" that is wrong for a bad key or an unknown model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runNote} from '../shared/coordination.js';

const failed = error => runNote({id: 'r1', status: 'failed', error, steps: []}).text;

test('a provider error keeps its words and its fix', () => {
  const text = failed('AI provider returned 401: Incorrect API key provided (the key was rejected — check it belongs to this provider and has not expired)');
  assert.match(text, /Incorrect API key provided/);
  assert.match(text, /key was rejected/);
  assert.doesNotMatch(text, /Try again in a minute/, 'waiting does not fix a bad key');
});

test('a timeout and a 5xx still say try again', () => {
  assert.match(failed('AI provider returned 503: overloaded (the provider is having trouble; try again)'), /try again/i);
  assert.match(failed('AI provider timed out after 60s'), /did not answer in time/);
});
