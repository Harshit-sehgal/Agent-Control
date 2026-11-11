/** Route table invariants: every API route declares an access level, the table
 * is collision-free, and the set of routes that skip a session is pinned.
 *
 * What this proves
 * - The routing table can be built with no services (each `*Routes(router, app)`
 *   only *declares*; handlers read their dependencies when a request arrives),
 *   and every declared route sits under `/api/` with an access level from the
 *   documented vocabulary.
 * - No method+path is registered twice, and no two patterns for one method are
 *   the same path with differently-named params (which would make route
 *   resolution depend on registration order).
 * - The public surface — routes reachable with no session — is pinned, so a new
 *   one fails this test and has to be reviewed. No route that takes an id is
 *   public. `agent`-access routes only live under `/api/agent/`.
 * - The least role for the sensitive routes (user management, credentials,
 *   workspace ownership, backup/restore, AI provider keys) is pinned, so
 *   loosening one is a test failure rather than a quiet widening.
 * - Every pattern's compiled regex resolves back to itself for a realistic id,
 *   so a route cannot be registered and then be unreachable.
 *
 * What this does NOT prove
 * - That each handler enforces ownership inside its workspace, or that the role
 *   it declares is the *least* one that works: the table is the claim being
 *   checked, not the behaviour behind it. `tests/authz-matrix.test.js` drives
 *   real HTTP requests for the write surface; the per-module tests cover the
 *   rest.
 * - That `src/app.js` calls some module we forgot to import here. The list
 *   below is asserted against what the dispatcher imports.
 * - Anything about the session/cookie mechanics (tests/auth.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRouter,ACCESS,allows} from '../src/router.js';
import {Auth,DEFAULT_WORKSPACE,ROLES} from '../src/auth.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as notifications from '../src/notifications.js';
import {publicRoutes} from '../src/routes-public.js';
import {workflowRoutes} from '../src/routes-workflow.js';
import {groupRoutes} from '../src/routes-groups.js';
import {accountRoutes} from '../src/routes-account.js';
import {workspaceRoutes} from '../src/routes-workspaces.js';
import {pushRoutes} from '../src/routes-push.js';
import {aiRoutes} from '../src/routes-ai.js';
import {memoryRoutes} from '../src/routes-memory.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The modules src/server.js registers, in its order. */
const MODULES = [
  ['publicRoutes', publicRoutes], ['workflowRoutes', workflowRoutes], ['groupRoutes', groupRoutes],
  ['accountRoutes', accountRoutes], ['workspaceRoutes', workspaceRoutes], ['pushRoutes', pushRoutes],
  ['aiRoutes', aiRoutes], ['memoryRoutes', memoryRoutes],
];

/** Registration must not need a live server. Anything a module reads from the
 * second argument outside a handler still resolves (to this stub), so a module
 * that starts inspecting `auth` at registration time fails loudly instead of
 * being skipped. */
const services = new Proxy(function stub() { return stub; }, {
  get: () => services,
  apply: () => services,
});

function registered() {
  const router = createRouter();
  for (const [, register] of MODULES) register(router, services);
  return router;
}

const routes = registered().routes;
const key = route => `${route.method} ${route.pattern}`;

/** Routes that answer without a session. Pinned: adding one is a security
 * decision, not a refactor, so it has to change this list. */
const PUBLIC_ROUTES = [
  'GET /api/health',
  'HEAD /api/health',
  'POST /api/login',
  'POST /api/logout',
  'POST /api/auth/forgot',
  'POST /api/auth/reset',
];

/** A public route with an id segment would be an unauthenticated lookup by id.
 * Empty on purpose; an entry needs a written reason (e.g. a signed one-time
 * token that the handler verifies). */
const PUBLIC_WITH_PARAM = [];

/** Least role for the routes where "who may do this" is the whole point. */
const LEAST_ROLE = {
  'POST /api/retention/prune': 'admin',
  'PATCH /api/retention': 'admin',
  // Asks and grants are the owner's call: a member or viewer cannot answer a bot's ask or widen what it may do.
  // The old browser-request routes answer the same ask, so they take the same role.
  'POST /api/asks/:id': 'admin',
  'POST /api/grants': 'admin',
  'POST /api/browser-requests/:id/approve': 'admin',
  'POST /api/browser-requests/:id/deny': 'admin',
  'GET /api/users': 'admin',
  'POST /api/users': 'admin',
  'PATCH /api/users/:id': 'admin',
  'DELETE /api/users/:id': 'admin',
  'POST /api/credentials': 'admin',
  'POST /api/credentials/:id/reveal': 'admin',
  'DELETE /api/credentials/:id': 'admin',
  'PATCH /api/agents/:id': 'admin',
  'DELETE /api/agents/:id': 'admin',
  'GET /api/admin/backup': 'owner',
  'POST /api/admin/restore': 'owner',
  'PATCH /api/workspaces/current': 'owner',
  'DELETE /api/workspaces/current': 'owner',
};

test('the server registers exactly the modules this test enumerates', async () => {
  // The route modules are registered by the dispatcher, `src/app.js`, which
  // `src/server.js` imports and hands the live services to.
  const app = await fs.readFile(path.join(root, 'src/app.js'), 'utf8');
  for (const [name] of MODULES) {
    assert.match(app, new RegExp(`\\b${name}\\b`), `${name} is enumerated here but src/app.js does not use it`);
  }
  const imported = [...app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/routes-[\w-]+\.js'/g)]
    .flatMap(m => m[1].split(',').map(s => s.trim()))
    .filter(Boolean);
  assert.deepEqual(imported.sort(), MODULES.map(([name]) => name).sort(),
    'src/app.js imports a different set of route modules than this test enumerates');
});

test('every route is an /api route with an explicit access level and a handler', () => {
  assert.ok(routes.length > 50, `sanity: expected the full table, found ${routes.length} routes`);
  for (const route of routes) {
    assert.match(route.pattern, /^\/api\//, `${key(route)} must live under /api/`);
    assert.ok(ACCESS.includes(route.access), `${key(route)} has no known access level ("${route.access}")`);
    assert.equal(typeof route.handler, 'function', `${key(route)} has no handler`);
    assert.ok(route.regex instanceof RegExp, `${key(route)} has no compiled matcher`);
    assert.equal(route.names.length, (route.pattern.match(/:/g) || []).length, `${key(route)} mis-counts its params`);
  }
});

test('no route is registered twice, and no two patterns are the same path', () => {
  const seen = new Map();
  for (const route of routes) {
    assert.equal(seen.has(key(route)), false, `${key(route)} is registered twice`);
    seen.set(key(route), true);
  }
  // `/api/tasks/:id` and `/api/tasks/:taskId` match the same URLs: whichever was
  // registered first would win for both, and which one that is would be an
  // accident of import order.
  const shapes = new Map();
  for (const route of routes) {
    const shape = `${route.method} ${route.pattern.replace(/:[a-zA-Z]+/g, ':')}`;
    assert.equal(shapes.has(shape), false,
      `${shapes.get(shape)} and ${route.pattern} are the same ${route.method} path with different param names`);
    shapes.set(shape, route.pattern);
  }
});

test('the public surface is exactly the pinned list', () => {
  const publicRoutesFound = routes.filter(route => route.access === 'public').map(key);
  assert.deepEqual([...publicRoutesFound].sort(), [...PUBLIC_ROUTES].sort(),
    'A route now answers without a session (or one stopped doing so). Review it, then update PUBLIC_ROUTES.');
  // Password reset still needs a session; it is public only in the sense that no role is checked.
  assert.equal(publicRoutesFound.some(route => route.includes('/api/agent/')), false,
    'agent endpoints must keep the agent access level');
});

test('no public route takes an id, unless it is a documented signed-token route', () => {
  for (const route of routes) {
    if (route.access !== 'public') continue;
    if (route.names.length === 0) continue;
    assert.ok(PUBLIC_WITH_PARAM.includes(key(route)),
      `${key(route)} is public and takes an id; an unauthenticated lookup by id needs a written reason in PUBLIC_WITH_PARAM`);
  }
});

test('agent access is only used for /api/agent/ endpoints', () => {
  for (const route of routes) {
    if (route.access !== 'agent') continue;
    assert.match(route.pattern, /^\/api\/agent\//, `${key(route)} asks for agent access outside /api/agent/`);
  }
});

test('the sensitive routes keep the least role they need', () => {
  const byKey = new Map(routes.map(route => [key(route), route]));
  for (const [routeKey, access] of Object.entries(LEAST_ROLE)) {
    const route = byKey.get(routeKey);
    assert.ok(route, `${routeKey} disappeared from the route table`);
    assert.equal(route.access, access, `${routeKey} must stay at "${access}", not "${route.access}"`);
  }
  // "Least role" is a floor: `allows` must refuse a role below it and allow the
  // ones above, which is what the dispatcher relies on.
  for (const route of routes) {
    if (route.access === 'public' || route.access === 'agent') continue;
    for (const role of ROLES) {
      assert.equal(allows(role, route.access), ROLES.indexOf(role) >= ROLES.indexOf(route.access),
        `allows(${role}, ${route.access}) disagrees with the role order for ${key(route)}`);
    }
  }
});

test("every pattern's matcher resolves back to that same route", () => {
  const router = registered();
  for (const route of routes) {
    const target = route.pattern.replace(/:([a-zA-Z]+)/g, (_, name) => (name === 'key' || name === 'bot' ? 'b-ob' : '0a1b2c3d-4e5f'));
    const found = router.find(route.method, target);
    assert.ok(found, `${key(route)} does not match its own pattern (${target})`);
    assert.equal(found.route.pattern, route.pattern, `${target} resolves to ${found.route.pattern} instead of ${route.pattern}`);
    for (const name of route.names) assert.ok(found.params[name], `${key(route)} did not capture :${name} from ${target}`);
  }
  assert.equal(router.find('GET', '/api/not-a-route'), null, 'an unknown path must not resolve');
});

test('the live takeover surface is member-level and lives under /api/browser-sessions', () => {
  // A person driving the browser is a write, like approving a card, so it needs
  // the writer role. Pinned here so widening it to viewer is a test failure.
  const surface = routes.filter(route => route.pattern.startsWith('/api/browser-sessions')).map(key).sort();
  assert.deepEqual(surface, [
    'DELETE /api/browser-sessions/:session',
    'GET /api/browser-sessions',
    'GET /api/browser-sessions/:session',
    'POST /api/browser-sessions',
    'POST /api/browser-sessions/:session/act',
    'POST /api/browser-sessions/:session/handback',
  ].sort());
  for (const route of routes) {
    if (route.pattern.startsWith('/api/browser-sessions')) assert.equal(route.access, 'member', `${key(route)} must stay at member or above`);
  }
});

/** A real store and the real account routes, driven the way the dispatcher
 * drives them (`handler({params, actor, store, body})`), so the ordering and
 * transaction of a write can be asserted instead of only its access level. */
async function accountHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-roles-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  const auth = new Auth(store);
  auth.ensureBootstrap('owner-secret-1');
  const actor = {userId: store.get('SELECT id FROM users LIMIT 1').id, role: 'owner', workspaceId: DEFAULT_WORKSPACE, sessionId: 's-owner', email: 'owner@localhost'};
  const router = createRouter();
  // The account routes that reconcile workspaces need the set of open stores,
  // not just an inert stub: a deletion has to reach every workspace a person was
  // a member of, so `all()` is what the handler iterates.
  const scope = new Proxy({all: () => [{id: DEFAULT_WORKSPACE, store}], sync: async () => ({})}, {get: (target, key) => (key in target ? target[key] : services)});
  accountRoutes(router, {auth, workspaces: scope});
  const call = async (method, target, body, who = actor) => {
    const found = router.find(method, target);
    assert.ok(found, `${method} ${target} is not registered`);
    return found.route.handler({params: found.params, actor: who, store, raw: async () => '', body: async () => body});
  };
  return {dir, store, auth, actor, call};
}

test("removing a user clears this workspace's notifications before the account", async () => {
  const {dir, store, auth, actor, call} = await accountHarness();
  const guest = auth.createUser(actor, {email: 'guest@example.com', password: 'guest-secret-1', role: 'member'});
  notifications.updatePreferences(store, guest.id, {email: true, emailAddress: 'guest@example.com'});
  // A laptop this person paired. Its secret is a live HMAC credential with the
  // permissions it was granted, and the only writer of `revoked_at` was the
  // revoke button on the agent - so removing the account used to leave the
  // device able to claim work for a workspace its owner no longer belonged to.
  store.run(`INSERT INTO agents (id,workspace_id,name,secret_hash,status,permissions,paired_by,paired_at)
    VALUES ('agent-guest','default','Guest laptop','stored-hash','paired','["browser.capture"]','guest@example.com',?)`, new Date().toISOString());
  store.run(`INSERT INTO agent_tasks (id,agent_id,kind,payload,status,created_at,updated_at)
    VALUES ('at-guest','agent-guest','browser.capture','{"url":"https://x.com/home"}','queued',?,?)`, new Date().toISOString(), new Date().toISOString());
  notifications.notify(store, null, {userId: guest.id, title: 'Pending', body: ''});
  assert.equal(store.get('SELECT count(*) AS n FROM notifications WHERE user_id=?', guest.id).n, 2, 'An in-app row and a queued delivery row.');

  // The cross-database step (the account, in the primary database) must run
  // LAST, so a crash in between leaves an account whose rows are already gone.
  // The other order left rows no account could ever match again, holding the
  // MAX_IN_APP cap slots forever. Crashing it here proves which side of the
  // pair runs first.
  const removeUser = auth.deleteUser;
  auth.deleteUser = () => { throw new Error('process died before the account delete.'); };
  try {
    await assert.rejects(call('DELETE', `/api/users/${guest.id}`), /process died/);
  } finally { auth.deleteUser = removeUser; }
  assert.equal(store.get('SELECT count(*) AS n FROM notifications WHERE user_id=?', guest.id).n, 0, "This workspace's rows are gone first.");
  assert.equal(store.get('SELECT count(*) AS n FROM notification_prefs WHERE user_id=?', guest.id).n, 0);
  assert.ok(store.get('SELECT id FROM users WHERE id=?', guest.id), 'The account is still there, because that step had not run.');

  // A complete removal still finishes the job, including the account.
  await call('DELETE', `/api/users/${guest.id}`);
  assert.equal(store.get('SELECT count(*) AS n FROM users WHERE id=?', guest.id).n, 0);
  // The device went with the account, and work aimed at it was failed instead of
  // waiting for a laptop that can no longer authenticate.
  const agent = store.get('SELECT status, revoked_at, secret_enc FROM agents WHERE id=?', 'agent-guest');
  assert.equal(agent.status, 'revoked');
  assert.ok(agent.revoked_at, 'the revocation is stamped');
  assert.equal(store.get('SELECT status, error FROM agent_tasks WHERE id=?', 'at-guest').status, 'failed');
  await fs.rm(dir, {recursive: true, force: true});
});

test('removing an id that is not a member here deletes nothing', async () => {
  const {dir, store, auth, actor, call} = await accountHarness();
  const guest = auth.createUser(actor, {email: 'guest@example.com', password: 'guest-secret-1', role: 'member'});
  notifications.notify(store, null, {userId: guest.id, title: 'Kept', body: ''});
  // A stale id from another workspace, or a typo, must not clear a real
  // member's feed: the guard runs before the first delete.
  await assert.rejects(call('DELETE', '/api/users/00000000-0000-4000-8000-000000000000'), /User not found/);
  assert.equal(store.get('SELECT count(*) AS n FROM notifications WHERE user_id=?', guest.id).n, 1);
  await fs.rm(dir, {recursive: true, force: true});
});

test('an agent rename and its permission list land together or not at all', async () => {
  const {dir, store, call} = await accountHarness();
  const agentId = crypto.randomUUID();
  store.run(`INSERT INTO agents (id,workspace_id,name,secret_hash,status,permissions,paired_at)
    VALUES (?,?,?,?,?,?,?)`, agentId, DEFAULT_WORKSPACE, 'Old name', 'hash', 'paired', '[]', new Date().toISOString());
  const rename = (name, permissions) => call('PATCH', `/api/agents/${agentId}`, {name, permissions});
  const row = () => store.get('SELECT name, permissions FROM agents WHERE id=?', agentId);

  assert.deepEqual(await rename('Checked laptop', ['http.check']), {ok: true, permissions: ['http.check']});
  assert.equal(row().name, 'Checked laptop');
  assert.equal(row().permissions, '["http.check"]');

  // A refused permission list must not keep the new name, and a crash between
  // the two writes can leave neither of them: three commits let an agent be
  // renamed with a scope an operator did not approve.
  await assert.rejects(rename('Renamed anyway', ['take-over-the-world']), /Unknown agent permission/);
  assert.equal(row().name, 'Checked laptop', 'The rename rolls back with the refused permissions.');
  assert.equal(row().permissions, '["http.check"]', 'The old scope is still the one in force.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('deleting your own account takes your paired devices with it, and only after the password', async () => {
  const {dir, store, actor, call} = await accountHarness();
  const stamp = new Date().toISOString();
  notifications.updatePreferences(store, actor.userId, {inApp: true});
  store.run(`INSERT INTO agents (id,workspace_id,name,secret_hash,status,permissions,paired_by,paired_at)
    VALUES ('agent-mine','default','My laptop','stored-hash','paired','["browser.capture"]',?,?)`, actor.email, stamp);
  store.run(`INSERT INTO agent_tasks (id,agent_id,kind,payload,status,created_at,updated_at)
    VALUES ('at-mine','agent-mine','browser.capture','{}','queued',?,?)`, stamp, stamp);

  // A wrong password is a typo, not a decision: no row may move.
  await assert.rejects(call('DELETE', '/api/account', {password: 'not-my-password'}), /Password is incorrect/);
  assert.equal(store.get('SELECT status FROM agents WHERE id=?', 'agent-mine').status, 'paired');
  assert.equal(store.get('SELECT count(*) AS n FROM notification_prefs WHERE user_id=?', actor.userId).n, 1);
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', 'at-mine').status, 'queued');

  await call('DELETE', '/api/account', {password: 'owner-secret-1'});
  assert.equal(store.get('SELECT status FROM agents WHERE id=?', 'agent-mine').status, 'revoked');
  assert.equal(store.get('SELECT count(*) AS n FROM notification_prefs WHERE user_id=?', actor.userId).n, 0);
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', 'at-mine').status, 'failed');
  await fs.rm(dir, {recursive: true, force: true});
});
