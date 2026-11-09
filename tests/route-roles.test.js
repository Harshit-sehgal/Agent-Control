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
 * - That `src/server.js` calls some module we forgot to import here. The list
 *   below is asserted against what the server imports.
 * - Anything about the session/cookie mechanics (tests/auth.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRouter,ACCESS,allows} from '../src/router.js';
import {ROLES} from '../src/auth.js';
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
  'POST /api/capture',
];

/** A public route with an id segment would be an unauthenticated lookup by id.
 * Empty on purpose; an entry needs a written reason (e.g. a signed one-time
 * token that the handler verifies). */
const PUBLIC_WITH_PARAM = [];

/** Least role for the routes where "who may do this" is the whole point. */
const LEAST_ROLE = {
  'PATCH /api/settings': 'admin',
  'POST /api/retention/prune': 'admin',
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
  const server = await readFile(path.join(root, 'src/server.js'), 'utf8');
  for (const [name] of MODULES) {
    assert.match(server, new RegExp(`\\b${name}\\b`), `${name} is enumerated here but src/server.js does not use it`);
  }
  const imported = [...server.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/routes-[\w-]+\.js'/g)]
    .flatMap(m => m[1].split(',').map(s => s.trim()))
    .filter(Boolean);
  assert.deepEqual(imported.sort(), MODULES.map(([name]) => name).sort(),
    'src/server.js imports a different set of route modules than this test enumerates');
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
  // Password reset and the extension capture endpoint still need a session or a
  // token; they are public only in the sense that no role is checked.
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
