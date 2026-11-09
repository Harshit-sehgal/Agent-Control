/** Guards that live inside a handler rather than in the route table.
 *
 * `tests/route-roles.test.js` proves which role a route *declares*; this file
 * drives the handlers with a real store and a fake request context, because the
 * three holes it covers were all invisible to the table:
 *
 *  1. `POST /api/tasks` compared the raw `kind` to `'notification'`, while the
 *     queue stores `cleanText(kind)`. `{"kind":" notification"}` therefore passed
 *     the guard and became a genuine delivery task addressed to any stored
 *     webhook — the one family the server is supposed to queue by itself.
 *  2. A run is addressed under `/api/groups/:group/runs/:run`, but the three run
 *     verbs passed only `:run`, so a run belonging to one group could be
 *     continued, stopped or planned through a path naming another group (or a
 *     group that does not exist), and the thread logged it as that group's.
 *  3. `PATCH /api/agents/:id` only ran an UPDATE, which touches no rows for an
 *     unknown id: a rename-only request answered 200 and wrote the audit line
 *     "Updated local agent permissions." for an agent that does not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {createRouter, isReply} from '../src/router.js';
import {workflowRoutes} from '../src/routes-workflow.js';
import {groupRoutes} from '../src/routes-groups.js';
import {accountRoutes} from '../src/routes-account.js';

const services = new Proxy(function stub() { return stub; }, {get: () => services, apply: () => services});

/** Build the table, then invoke one handler the way `src/server.js` would. */
function harness(register) {
  const router = createRouter();
  register(router, services);
  return async (store, {method, path: pattern, params = {}, body, actor = {email: 'owner@example.test', role: 'owner', userId: 'u1'}}) => {
    const found = router.find(method, pattern.replace(/:([a-z]+)/g, (_, name) => params[name]));
    assert.ok(found, `${method} ${pattern} is not registered`);
    try {
      const result = await found.route.handler({
        store, actor, params, req: {headers: {}}, path: pattern,
        raw: async () => JSON.stringify(body ?? {}),
        body: async () => body ?? {},
      });
      return isReply(result) ? {status: result.status, body: result.body} : {status: 200, body: result};
    } catch (error) {
      return {status: error.status || 500, body: {error: error.message}};
    }
  };
}

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-route-guard-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close?.(); await rm(dir, {recursive: true, force: true}); });
  return store;
}

test('a delivery task cannot be smuggled through the generic queue by whitespace', async t => {
  const store = await workspace(t);
  const call = harness(workflowRoutes);

  // `cleanText` trims but does not fold case, so these two are the delivery kind
  // and are refused as a policy (403). A case variant is refused as an unknown
  // kind (400) - either way nothing is queued, which is the property that matters.
  for (const kind of ['notification', ' notification', 'notification ']) {
    const res = await call(store, {method: 'POST', path: '/api/tasks', body: {kind, payload: {channel: 'email', target: 'anyone@example.test', title: 't', body: 'b'}}});
    assert.equal(res.status, 403, `"${kind}" must be refused as a delivery, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(String(res.body.error), /queued by the server/i);
  }
  for (const kind of ['NOTIFICATION', 'Notification']) {
    const res = await call(store, {method: 'POST', path: '/api/tasks', body: {kind, payload: {channel: 'email', target: 'anyone@example.test', title: 't', body: 'b'}}});
    assert.equal(res.status, 400, `"${kind}" must not become a task, got ${res.status}`);
  }
  // Nothing reached the queue, so nothing can be delivered to a stored webhook.
  assert.equal(store.read().tasks.filter(task => /notification/i.test(task.kind)).length, 0);

  // An ordinary kind is still accepted through the same route.
  const ok = await call(store, {method: 'POST', path: '/api/tasks', body: {kind: 'reminder', payload: {label: 'Ping me', kind: 'interval', intervalMinutes: 5}}});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, 'reminder');
});

test('a run is only reachable under the group it belongs to', async t => {
  const store = await workspace(t);
  const call = harness(groupRoutes);
  await store.update(state => {
    state.groups.push({id: 'alpha', name: 'Alpha', bots: [{id: 'a1', name: 'A1', instructions: 'Act as a bot'}]});
    state.groups.push({id: 'beta', name: 'Beta', bots: [{id: 'b1', name: 'B1', instructions: 'Act as a bot'}]});
    state.groupRuns.push({id: 'run-1', groupId: 'alpha', chatKey: 'team-alpha', mode: 'pipeline', status: 'running', input: 'Coordinate these bots', recipients: ['a1'], trace: [], createdAt: new Date().toISOString(), startedAt: new Date().toISOString()});
    state.groupRuns.push({id: 'run-2', groupId: 'alpha', chatKey: 'team-alpha', mode: 'pipeline', status: 'running', input: 'Coordinate these bots', recipients: ['a1'], trace: [], createdAt: new Date().toISOString(), startedAt: new Date().toISOString()});
  });

  for (const verb of ['cancel', 'continue']) {
    const wrong = await call(store, {method: 'POST', path: `/api/groups/:group/runs/:run/${verb}`, params: {group: 'beta', run: 'run-1'}});
    assert.equal(wrong.status, 404, `${verb} through the wrong group must 404, got ${wrong.status}`);
    const missing = await call(store, {method: 'POST', path: `/api/groups/:group/runs/:run/${verb}`, params: {group: 'nope', run: 'run-1'}});
    assert.equal(missing.status, 404, `${verb} through a group that does not exist must 404`);
  }
  assert.equal(store.read().groupRuns.find(run => run.id === 'run-1').status, 'running', 'a refused cancel must not touch the run');

  const seen = await call(store, {method: 'POST', path: '/api/groups/:group/runs/:run/plan', params: {group: 'beta', run: 'run-2'}, body: {approve: false}});
  assert.equal(seen.status, 404, 'a plan decision through the wrong group must 404');

  const right = await call(store, {method: 'POST', path: '/api/groups/:group/runs/:run/cancel', params: {group: 'alpha', run: 'run-1'}});
  assert.equal(right.status, 202, JSON.stringify(right.body));
  assert.equal(store.read().groupRuns.find(run => run.id === 'run-1').status, 'cancelled');
  assert.equal(store.read().groupRuns.find(run => run.id === 'run-2').status, 'running', 'only the addressed run stops');
});

test('renaming an agent that does not exist is a 404, not a 200 and a false audit line', async t => {
  const store = await workspace(t);
  const call = harness(accountRoutes);
  const before = store.read().events.length;

  const missing = await call(store, {method: 'PATCH', path: '/api/agents/:id', params: {id: 'no-such-agent'}, body: {name: 'Renamed'}});
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /Agent not found/);
  assert.equal(store.read().events.length, before, 'a refused rename must not write an audit line');
});
