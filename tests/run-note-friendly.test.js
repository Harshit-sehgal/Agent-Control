/** A failed run says what went wrong in plain words, not the provider's raw error. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {runNote} from '../shared/coordination.js';

const failed = error => runNote({id: 'r1', status: 'failed', error, chatKey: 'atlas', recipients: []}).text;

test('a provider timeout reads as the model not answering in time', () => {
  const raw = 'AI provider returned 502: All 1 routed attempt(s) failed with upstream provider errors (timeout ×1). This is a provider-side failure, not a problem with your request; retry, or check provider status. Attempt trail: nvidia/pool (the provider is having trouble; try again)';
  assert.equal(failed(raw), 'The run failed: the model did not answer in time. Try again in a minute, or pick another model on the bot\'s profile.');
});

test('another provider error names its status and nothing else', () => {
  assert.equal(failed('AI provider returned 503: Service Unavailable <html>…'), 'The run failed: the model provider had an error (503). Try again in a minute, or pick another model on the bot\'s profile.');
  assert.equal(failed('AI provider returned an error: overloaded'), 'The run failed: the model provider had an error. Try again in a minute, or pick another model on the bot\'s profile.');
});

test('any other error is shown as it was', () => {
  assert.equal(failed('Model unavailable'), 'The run failed: Model unavailable');
  assert.equal(failed(''), 'The run failed: unknown error');
});
