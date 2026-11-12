import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRouter, isReply, allows} from '../src/router.js';
import {workflowRoutes} from '../src/routes-workflow.js';
import {SqliteStore} from '../src/sqlite-store.js';

// Saved templates belong to one workspace: a member saves and deletes them through the
// workspace's own store, a viewer only reads them in the snapshot, and they survive a restart.

const routes = () => { const router = createRouter(); workflowRoutes(router, {auth: {}}); return router; };
const call = async (router, store, method, url, {body = {}, role = 'member'} = {}) => {
  const found = router.find(method, url);
  assert.ok(found, `${method} ${url} is a route`);
  assert.ok(allows(role, found.route.access), `${role} may ${method} ${url}`);
  const out = await found.route.handler({store, params: found.params, actor: {role}, body: async () => body, req: null});
  return isReply(out) ? out.body : out;
};
async function openStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-tpl-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = name => path.join(dir, name);
  return {open: name => new SqliteStore(file(`${name}.db`), file(`${name}.json`)).init()};
}

test('a member saves and deletes templates; a viewer cannot', () => {
  const router = routes();
  assert.equal(router.find('POST', '/api/templates').route.access, 'member');
  assert.equal(router.find('DELETE', '/api/templates/abc-1').route.access, 'member');
  assert.equal(allows('viewer', 'member'), false);
});

test('templates are kept per workspace and survive a restart', async t => {
  const {open} = await openStore(t);
  const router = routes();
  const a = await open('a'), b = await open('b');
  const saved = await call(router, a, 'POST', '/api/templates', {body: {text: 'Check the flight prices to Lisbon'}});
  assert.equal(saved.text, 'Check the flight prices to Lisbon');
  assert.deepEqual(a.read().templates.map(x => x.id), [saved.id]);
  assert.deepEqual(b.read().templates || [], [], 'another workspace does not see it');
  await assert.rejects(call(router, b, 'DELETE', `/api/templates/${saved.id}`), e => e.status === 404, 'nor delete it');
  const again = await open('a');
  assert.deepEqual(again.read().templates.map(x => x.text), ['Check the flight prices to Lisbon']);
  assert.deepEqual(await call(router, again, 'DELETE', `/api/templates/${saved.id}`), {ok: true});
  assert.deepEqual((await open('a')).read().templates, []);
});
