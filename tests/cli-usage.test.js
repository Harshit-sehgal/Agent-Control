import test from 'node:test';
import assert from 'node:assert/strict';
import {usageFromCli} from '../agent/cli-model.mjs';

// A subscription run costs nothing extra, but the tokens its CLI reports are still shown on the run.

test('claude stream-json: the result event carries Messages-API usage, cache reads and writes apart', () => {
  const raw = [
    JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'hi'}]}}),
    JSON.stringify({type: 'result', result: 'hi', usage: {input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300}}),
  ].join('\n');
  assert.deepEqual(usageFromCli('claude', raw), {input: 12, output: 4, cacheRead: 9000, cacheWrite: 300});
});

test('codex --json: turn.completed counts cached input inside input, so it is split out', () => {
  const raw = [JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'x'}}), JSON.stringify({type: 'turn.completed', usage: {input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 70}})].join('\n');
  assert.deepEqual(usageFromCli('codex', raw), {input: 1000, output: 70, cacheRead: 4000, cacheWrite: 0});
});

test('a CLI that reports nothing (or zeros) gives no usage rather than a fake zero', () => {
  assert.equal(usageFromCli('codex', JSON.stringify({type: 'turn.completed', usage: {}})), null);
  assert.equal(usageFromCli('claude', 'not json\n'), null);
});
