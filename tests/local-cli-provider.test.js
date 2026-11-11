import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import {configReady} from '../src/ai.js';
import {migrate} from '../shared/workflow.js';
import {createRouter} from '../src/router.js';
import {aiRoutes} from '../src/routes-ai.js';
import {LOCAL_CLI_ENGINES, LOCAL_CLI_KIND, cleanCliModel} from '../shared/ai-presets.js';

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-cli-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
    store.vaultKey = loadMasterKey(dataFile).key;
    await store.update(s => {
      migrate(s);
      s.groups = [{id: 'home', name: 'Home', bots: [{id: 'writer', name: 'Writer', type: 'writing'}]}];
    });
    return await fn(store);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

test('the engines are claude and codex, and a model name can never read as a flag', () => {
  assert.equal(LOCAL_CLI_KIND, 'local-cli');
  assert.deepEqual(LOCAL_CLI_ENGINES.map(e => e.id), ['claude', 'codex']);
  assert.equal(cleanCliModel('sonnet'), 'sonnet');
  assert.equal(cleanCliModel('gpt-5-codex'), 'gpt-5-codex');
  assert.equal(cleanCliModel(''), '');
  assert.equal(cleanCliModel(undefined), '');
  for (const bad of ['--dangerously-skip-permissions', '-p', 'a b', 'x;rm -rf /', 'a\nb', '$(id)', 'x'.repeat(81)]) {
    assert.equal(cleanCliModel(bad), null, `${JSON.stringify(bad)} is refused`);
  }
});

test('saving a local-cli provider needs no key and stores nothing in the vault', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'My Claude', createdBy: 'owner@localhost'});
    assert.equal(p.kind, 'local-cli');
    assert.equal(p.engine, 'claude');
    assert.equal(p.label, 'My Claude');
    assert.equal(p.model, '');
    assert.equal(store.all('SELECT id FROM credentials').length, 0, 'no vault row for a subscription');
    const record = store.read().ai.providers[0];
    assert.equal(record.credentialId ?? null, null);
    assert.equal(record.baseUrl ?? '', '');
    assert.equal(store.read().ai.defaultProviderId, p.id, 'the first provider becomes the default, like any other');
  });
});

test('a local-cli provider is validated: engine, model and the absence of a key', async () => {
  await withStore(async store => {
    await assert.rejects(ai.addProvider(store, 'default', {kind: 'local-cli', label: 'X'}), /claude or codex/i);
    await assert.rejects(ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'gemini', label: 'X'}), /claude or codex/i);
    await assert.rejects(ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: ''}), /name/i);
    await assert.rejects(ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'X', model: '--bare'}), /model/i);
    await assert.rejects(ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'X', apiKey: 'sk-ant-secret'}), /no key/i);
    await assert.rejects(ai.addProvider(store, 'default', {kind: 'carrier-pigeon', label: 'X'}), /kind/i);
    assert.equal(store.read().ai.providers.length, 0, 'nothing half-saved');
    assert.equal(store.all('SELECT id FROM credentials').length, 0);
  });
});

test('listings never show a secret, a key reference or an endpoint for a local-cli provider', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'codex', label: 'My ChatGPT', model: 'gpt-5-codex'});
    const surfaces = {
      admin: ai.listProviders(store.read()).providers[0],
      full: ai.listProviderListings(store).providers[0],
      public: ai.publicAi(store.read()).providers[0],
      one: ai.getProvider(store, p.id),
    };
    for (const [name, view] of Object.entries(surfaces)) {
      assert.equal(view.kind, 'local-cli', name);
      assert.equal(view.engine, 'codex', name);
      assert.equal(view.model, 'gpt-5-codex', name);
      for (const field of ['apiKey', 'credentialId', 'headersCredentialId', 'headerNames']) assert.equal(field in view, false, `${name} has no ${field}`);
      assert.equal(view.baseUrl ?? '', '', `${name} has no endpoint`);
      assert.equal(view.host ?? '', '', `${name} has no host`);
    }
  });
});

test('a local-cli provider can be renamed and re-pointed, but never given a key', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'A'});
    const renamed = await ai.updateProvider(store, 'default', p.id, {label: 'B', model: 'opus'});
    assert.equal(renamed.label, 'B');
    assert.equal(renamed.model, 'opus');
    assert.equal(renamed.engine, 'claude');
    const moved = await ai.updateProvider(store, 'default', p.id, {engine: 'codex', model: ''});
    assert.equal(moved.engine, 'codex');
    assert.equal(moved.model, '');
    await assert.rejects(ai.updateProvider(store, 'default', p.id, {apiKey: 'sk-secret'}), /no key/i);
    await assert.rejects(ai.updateProvider(store, 'default', p.id, {baseUrl: 'https://x.example/v1'}), /no endpoint|no key/i);
    await assert.rejects(ai.updateProvider(store, 'default', p.id, {model: '-p'}), /model/i);
    assert.equal(store.all('SELECT id FROM credentials').length, 0);
  });
});

test('reading the catalogue of a local-cli provider makes no call and finds no models', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'A'});
    const found = await ai.refreshModels(store, p.id);
    assert.deepEqual(found.models, []);
    assert.equal(found.protocol, 'local-cli');
    assert.equal(store.read().ai.providers[0].modelsError ?? null, null);
  });
});

test('a bot chooses a local-cli provider like any other, and resolves to a runnable config', async () => {
  await withStore(async store => {
    const api = await ai.addProvider(store, 'default', {label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret-123'});
    const cli = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'claude', label: 'My Claude', model: 'sonnet'});
    await ai.setDefaults(store, {providerId: api.id, model: 'gpt-4.1'});
    assert.equal(ai.resolveConfig(store, 'writer').source, 'byok', 'unpinned bots stay on the default');
    await ai.setBotModel(store, 'writer', {providerId: cli.id});
    const config = ai.resolveConfig(store, 'writer');
    assert.equal(config.kind, 'local-cli');
    assert.equal(config.engine, 'claude');
    assert.equal(config.model, 'sonnet', 'the provider model, not the API default gpt-4.1');
    assert.equal(config.providerId, cli.id);
    assert.equal(configReady(config), true);
    assert.equal('apiKey' in config, false);
    await ai.setBotModel(store, 'writer', {model: 'opus'});
    assert.equal(ai.resolveConfig(store, 'writer').model, 'opus', 'a bot override wins');
    await ai.setBotModel(store, 'writer', {model: '--bare'});
    assert.equal(ai.resolveConfig(store, 'writer').model, 'sonnet', 'a model that would read as a flag is dropped, not passed');
  });
});

test('deleting a local-cli provider frees its bots and touches no vault row', async () => {
  await withStore(async store => {
    const cli = await ai.addProvider(store, 'default', {kind: 'local-cli', engine: 'codex', label: 'C'});
    await ai.setBotModel(store, 'writer', {providerId: cli.id});
    await ai.deleteProvider(store, 'default', cli.id);
    assert.equal(store.read().ai.providers.length, 0);
    assert.equal(store.read().ai.bots.writer ?? null, null);
  });
});

test('the provider route takes kind local-cli and never returns a key', async () => {
  await withStore(async store => {
    const router = createRouter();
    aiRoutes(router);
    const ctx = body => ({body: async () => body, store, actor: {workspaceId: 'default', email: 'owner@localhost'}, params: {}});
    const created = await router.find('POST', '/api/ai/providers').route.handler(ctx({kind: 'local-cli', engine: 'claude', label: 'My Claude'}));
    assert.equal(created.status, 201);
    assert.equal(created.body.kind, 'local-cli');
    assert.equal(created.body.engine, 'claude');
    const patched = await (found => found.route.handler({...ctx({model: 'sonnet'}), params: found.params}))(router.find('PATCH', `/api/ai/providers/${created.body.id}`));
    assert.equal(patched.model, 'sonnet');
    assert.equal(JSON.stringify(patched).includes('credential'), false);
  });
});
