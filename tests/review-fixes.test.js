/** Findings from the Phase 1 whole-branch review, each pinned by a test. */
import test from 'node:test';
import assert from 'node:assert/strict';

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
