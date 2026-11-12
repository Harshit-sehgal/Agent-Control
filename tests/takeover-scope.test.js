/* A takeover is opened, looked at, acted on and ended only from the workspace
 * that opened it, and driving one is an admin's write. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {beginTakeover, handBackTakeover} from '../src/bot-browser.js';

const store = {read: () => ({browserRequests: [{id: 'r1', url: 'https://example.com/', status: 'pending'}]})};

test('beginTakeover records the opening workspace and handBackTakeover scopes its end to it', async () => {
  const calls = [];
  const runtime = {
    mode: 'auto', available: () => true,
    beginLive: async spec => { calls.push(['begin', spec]); return {id: 'takeover-x', url: spec.url}; },
    endLive: async (id, scope) => { calls.push(['end', id, scope]); return {requestId: null, page: null}; },
  };
  await beginTakeover(store, 'r1', {actor: 'ada@a', workspaceId: 'ws-a', runtime});
  await handBackTakeover(store, 'takeover-x', {workspaceId: 'ws-a', runtime});
  assert.deepEqual(calls, [
    ['begin', {url: 'https://example.com/', requestId: 'r1', openedBy: 'ada@a', workspaceId: 'ws-a'}],
    ['end', 'takeover-x', {workspaceId: 'ws-a'}],
  ]);
});
