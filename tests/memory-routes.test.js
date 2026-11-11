import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter, isReply} from '../src/router.js';
import {memoryRoutes} from '../src/routes-memory.js';
import {addRules, memoryState, noteChat} from '../shared/memory.js';

const makeId = (() => { let n = 0; return () => `rule-${++n}`; })();
const at = '2026-01-01T00:00:00.000Z';

/** The part of a workspace store the memory routes use. */
function memoryStore() {
  const state = {memory: memoryState({}), chats: {}};
  state.memory.rulebooks = {};
  return {
    read: () => structuredClone(state),
    update: fn => {
      const result = fn(state);
      return Promise.resolve(result);
    },
    state: () => state,
  };
}

function routes() {
  const router = createRouter();
  memoryRoutes(router);
  return router;
}

const context = (store, {body, url = '/api/memory', params = {}} = {}) => ({
  store,
  params,
  req: {url},
  body: async () => body || {},
});

test('GET /api/memory exposes counts and rule ids but no internal books', async () => {
  const store = memoryStore();
  addRules(store.state(), 'env:m', ['Always keep replies short.'], {now: at, makeId});
  noteChat(store.state(), 'writer', {messages: [{role: 'user', text: 'Draft the launch note.', at}]});
  const found = routes().find('GET', '/api/memory');
  assert.equal(found.route.access, 'viewer');
  const view = await found.route.handler(context(store));
  assert.equal(view.rulebooks[0].model, 'env:m');
  assert.equal(view.rulebooks[0].rules[0].id, 'rule-1');
  assert.equal(view.chats[0].chat, 'writer');
  assert.equal('pending' in view.rulebooks[0], true);
});

test('a member can add, delete and forget memory over HTTP', async () => {
  const store = memoryStore(), router = routes();
  const add = await router.find('POST', '/api/memory/rules').route.handler(context(store, {body: {model: 'env:m', text: 'Always cite a source.'}}));
  assert.ok(isReply(add));
  assert.equal(add.status, 201);
  assert.equal(add.body.rules[0].text, 'Always cite a source.');
  const id = add.body.rules[0].id;

  const remove = await router.find('DELETE', `/api/memory/rules/${id}`).route.handler(context(store, {url: `/api/memory/rules/${id}?model=env%3Am`, params: {id}}));
  assert.deepEqual(remove, {ok: true, removed: 1});
  assert.equal(store.state().memory.rulebooks['env:m'].rules.length, 0);

  addRules(store.state(), 'env:m', ['Always keep replies short.'], {now: at, makeId});
  noteChat(store.state(), 'writer', {messages: [{role: 'user', text: 'Draft.', at}]});
  const forget = await router.find('POST', '/api/memory/forget').route.handler(context(store, {body: {model: 'env:m', chat: 'writer'}}));
  assert.deepEqual(forget, {ok: true, model: 'env:m', chat: 'writer'});
  assert.deepEqual(store.state().memory.rulebooks, {});
  assert.deepEqual(store.state().memory.chats, {});
});

test('bad memory requests fail with a status the server can send', async () => {
  const store = memoryStore(), router = routes();
  const add = router.find('POST', '/api/memory/rules').route.handler;
  await assert.rejects(() => add(context(store, {body: {text: 'Always cite a source.'}})), error => error.status === 400 && /Which bot/.test(error.message));
  await assert.rejects(() => add(context(store, {body: {model: 'env:m', text: 'x'}})), error => error.status === 400 && /at least 4 characters/.test(error.message));
  const remove = router.find('DELETE', '/api/memory/rules/missing').route.handler;
  await assert.rejects(() => remove(context(store, {url: '/api/memory/rules/missing', params: {id: 'missing'}})), error => error.status === 404, 'with no book named the rule is looked for in every book');
  await assert.rejects(() => remove(context(store, {url: '/api/memory/rules/missing?model=env%3Am', params: {id: 'missing'}})), error => error.status === 404);
  const forget = router.find('POST', '/api/memory/forget').route.handler;
  await assert.rejects(() => forget(context(store, {body: {}})), error => error.status === 400);
});
