/** The Pages demo keeps templates and runs the daily briefing through the same routes as the server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWebLocks} from './web-locks.js';
import {briefingTaskBody, BRIEFING_MESSAGE} from '../shared/briefing.js';
import {searchMessages} from '../shared/message-search.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
installWebLocks();
const map = new Map();
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, get: () => ({getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))})});
await import(path.join(root, 'shared/local-api.js'));
const request = (...a) => globalThis.window.AGENT_LOCAL_API(...a);

test('the demo saves and deletes a template', async () => {
  const saved = await request('/api/templates', 'POST', {text: 'Find me a cheap flight'});
  assert.deepEqual((await request('/api/state')).templates.map(t => t.text), ['Find me a cheap flight']);
  assert.deepEqual(await request(`/api/templates/${saved.id}`, 'DELETE'), {ok: true});
  assert.deepEqual((await request('/api/state')).templates, []);
});

test('the demo runs a due briefing with the facts, and its chat can be searched', async () => {
  const state = await request('/api/state');
  const task = await request('/api/tasks', 'POST', briefingTaskBody(state, {at: '08:00'}));
  assert.equal(task.payload.brief, 'daily');
  // Make it due now, the way the clock would.
  for (const [key, value] of map) {
    const doc = JSON.parse(value);
    if (!Array.isArray(doc?.tasks)) continue;
    doc.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() - 1000).toISOString();
    map.set(key, JSON.stringify(doc));
  }
  const after = await request('/api/state');
  const run = after.groupRuns.find(r => r.scheduleId === task.id || String(r.input || '').startsWith(BRIEFING_MESSAGE));
  assert.ok(run, 'the briefing ran');
  assert.match(run.input, /Facts from this workspace/);
  assert.ok(searchMessages(after, 'scheduled task daily briefing').some(h => h.chatKey === 'atlas'));
});
