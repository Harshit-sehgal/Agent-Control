/* A takeover is opened, looked at, acted on and ended only from the workspace
 * that opened it, and driving one is an admin's write. */
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import assert from 'node:assert/strict';
import {beginTakeover, browserLane, handBackTakeover} from '../src/bot-browser.js';

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
    ['begin', {url: 'https://example.com/', requestId: 'r1', openedBy: 'ada@a', workspaceId: 'ws-a', lane: browserLane(store, undefined)}],
    ['end', 'takeover-x', {workspaceId: 'ws-a'}],
  ]);
});

test('the lane is the workspace and the bot, and dispatch and takeover pass it', async () => {
  const {dispatchBrowserRequest} = await import('../src/bot-browser.js');
  assert.notEqual(browserLane({dbPath: '/d/a.db'}, 'atlas'), browserLane({dbPath: '/d/b.db'}, 'atlas'));
  assert.notEqual(browserLane({dbPath: '/d/a.db'}, 'atlas'), browserLane({dbPath: '/d/a.db'}, 'other'));
  assert.equal(browserLane({dbPath: '/d/a.db'}, 'atlas'), '/d/a.db\u0000atlas');
  assert.equal(browserLane(null, undefined), '\u0000');
  const seen = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeover-lane-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  try {
    store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
    const now = new Date().toISOString();
    const pending = (id, url) => ({id, botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url, steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now});
    await store.update(s => { s.browserRequests = [pending('br1', 'https://example.com/'), pending('br2', 'https://example.com/2')]; });
    const runtime = {
      mode: 'auto', available: () => true,
      run: async r => { seen.push(r.lane); return {url: r.url, text: 'x'}; },
      beginLive: async o => { seen.push(o.lane); return {id: 'takeover-x', url: o.url}; },
    };
    await dispatchBrowserRequest(store, 'br1', {runtime});
    for (let i = 0; i < 200 && !seen.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await beginTakeover(store, 'br2', {runtime});
    assert.equal(seen.length, 2, 'both the dispatch and the takeover reached the runtime');
    assert.match(store.dbPath, /state\.db$/, 'the lane comes from the real store');
    for (const lane of seen) assert.equal(lane, browserLane(store, 'web'));
    assert.notEqual(browserLane(store, 'web'), browserLane({dbPath: '/elsewhere/state.db'}, 'web'));
  } finally {
    await store.close?.();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
