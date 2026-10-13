import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import {migrate} from '../shared/workflow.js';

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-prov-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
    store.vaultKey = loadMasterKey(dataFile).key;
    await store.update(s => {
      migrate(s);
      // A couple of real bots, so the per-bot override can be validated against them.
      s.groups = [{id: 'x-engage', name: 'X-engage', bots: [{id: 'writer', name: 'Writer', type: 'writing'}, {id: 'other', name: 'Other', type: 'custom'}]}];
    });
    return await fn(store);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

test('a BYOK provider stores its key encrypted and never lists it', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-secret-123', createdBy: 'owner@localhost'});
    assert.equal(p.label, 'OpenAI');
    assert.equal(p.baseUrl, 'https://api.openai.com/v1', 'base URL is trimmed of a trailing slash');
    assert.equal(p.style, 'responses', 'OpenAI hosts infer the Responses API');
    assert.equal(p.host, 'api.openai.com');

    const listed = ai.listProviders(store.read());
    assert.equal(listed.providers.length, 1);
    assert.equal(listed.defaultProviderId, p.id, 'the first provider becomes the default');
    assert.equal('apiKey' in listed.providers[0], false, 'the listing must not carry the key');
    assert.equal('credentialId' in listed.providers[0], false, 'the vault reference stays server-side');

    const cfg = ai.resolveConfig(store, null);
    assert.equal(cfg.apiKey, 'sk-secret-123', 'resolveConfig decrypts the key for a call');
    assert.equal(cfg.baseUrl, 'https://api.openai.com/v1');
    assert.equal(cfg.model, 'auto');
    assert.equal(ai.aiAvailable(store), true);
  });
});

test('the workspace default model and a per-bot override both apply', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x'});
    assert.equal(ai.resolveConfig(store, null).style, 'chat', 'non-OpenAI hosts use chat completions');

    await ai.setDefaults(store, {providerId: p.id, model: 'llama-3.3-70b'});
    assert.equal(ai.resolveConfig(store, null).model, 'llama-3.3-70b');

    await ai.setBotModel(store, 'writer', {model: 'llama-3.1-8b'});
    assert.equal(ai.resolveConfig(store, 'writer').model, 'llama-3.1-8b', 'the bot overrides the default');
    assert.equal(ai.resolveConfig(store, 'other').model, 'llama-3.3-70b', 'other bots keep the default');

    await ai.setBotModel(store, 'writer', {model: ''});
    assert.equal(ai.resolveConfig(store, 'writer').model, 'llama-3.3-70b', 'clearing the override falls back to the default');

    // An override for a bot that does not exist is refused, not stored.
    await assert.rejects(ai.setBotModel(store, 'ghost', {model: 'x'}), /Bot not found/);
    assert.equal(store.read().ai.bots.ghost, undefined);
  });
});

test('provider validation and deletion', async () => {
  await withStore(async store => {
    await assert.rejects(ai.addProvider(store, 'default', {label: '', baseUrl: 'https://x/v1', apiKey: 'k'}), /name/i);
    await assert.rejects(ai.addProvider(store, 'default', {label: 'X', baseUrl: 'not-a-url', apiKey: 'k'}), /absolute http/i);
    await assert.rejects(ai.addProvider(store, 'default', {label: 'X', baseUrl: 'https://x/v1', apiKey: ''}), /API key/i);

    const p = await ai.addProvider(store, 'default', {label: 'X', baseUrl: 'https://x.example/v1', apiKey: 'k'});
    await ai.deleteProvider(store, 'default', p.id);
    assert.equal(ai.listProviders(store.read()).providers.length, 0);
    assert.equal(ai.aiAvailable(store), false);
    await assert.rejects(ai.deleteProvider(store, 'default', p.id), /not found/i);
  });
});
