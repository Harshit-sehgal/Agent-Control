/** Findings from the Phase 1 whole-branch review, each pinned by a test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {editableInputs} from '../shared/ui-model.js';
import {validateContract, normalizeBot} from '../shared/contracts.js';

test('an old bot whose inputs were all X inputs can be saved from its profile', () => {
  const bot = normalizeBot({id: 'b', name: 'Old', instructions: 'Old job.', contract: {version: 1, inputs: ['source_post', 'evidence'], output: {kind: 'text', fields: []}}});
  const inputs = editableInputs(bot);
  assert.doesNotThrow(() => validateContract({version: 1, inputs, output: {kind: 'text', fields: []}}));
  assert.ok(!inputs.includes('evidence') && !inputs.includes('source_post'));
});

test('an X feed page request left from before the upgrade is denied, not left waiting', async () => {
  const {migrate} = await import('../shared/workflow.js');
  const {initialState} = await import('../shared/core.js');
  const s = initialState();
  s.groupRuns = [{id: 'r1', groupId: 'home', status: 'awaiting_feed', recipients: ['atlas'], trace: []}];
  s.browserRequests = [
    {id: 'br1', runId: 'r1', botId: 'atlas', purpose: 'feed', url: 'https://x.com/home', status: 'pending'},
    {id: 'br2', runId: 'other', botId: 'atlas', url: 'https://example.com/', status: 'pending'},
  ];
  migrate(s);
  assert.equal(s.browserRequests.find(r => r.id === 'br1').status, 'denied');
  assert.equal(s.browserRequests.find(r => r.id === 'br2').status, 'pending', 'an ordinary page request is untouched');
});
