import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import {migrate} from '../shared/workflow.js';
import {recordDay} from '../shared/usage.js';

// Settings → Models: a fallback model, per-model prices on a saved provider, and the usage totals they feed.

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-fallback-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const open = async () => { const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init(); store.vaultKey = loadMasterKey(dataFile).key; return store; };
    const store = await open();
    await store.update(s => { migrate(s); s.groups = [{id: 'home', name: 'Home', bots: [{id: 'writer', name: 'Writer', type: 'custom'}]}]; });
    return await fn(store, open);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}
// A provider saved with no catalogue read: the address is never called in these tests.
const add = (store, label, model) => ai.addProvider(store, 'w1', {label, baseUrl: `http://127.0.0.1/${label.toLowerCase()}/v1`, apiKey: `key-for-${label}-12345`, protocol: 'openai-chat'})
  .then(async p => { await store.update(s => { const row = s.ai.providers.find(x => x.id === p.id); row.models = row.chatModels = [model]; }); return p; });

test('the owner picks a fallback model; a bot turn carries it, and never carries itself as its own fallback', async () => withStore(async store => {
  const main = await add(store, 'Main', 'big-model');
  const spare = await add(store, 'Spare', 'small-model');
  await ai.setDefaults(store, {providerId: main.id, model: 'big-model'});
  assert.equal(ai.resolveConfig(store, 'writer').fallback, undefined, 'no fallback until one is picked');
  const listed = await ai.setDefaults(store, {fallback: {providerId: spare.id, model: 'small-model'}});
  assert.deepEqual(listed.fallback, {providerId: spare.id, model: 'small-model'});
  assert.deepEqual(ai.publicAi(store.read()).fallback, {providerId: spare.id, model: 'small-model'});
  const config = ai.resolveConfig(store, 'writer');
  assert.equal(config.model, 'big-model');
  assert.equal(config.fallback.model, 'small-model');
  assert.equal(config.fallback.providerId, spare.id);
  assert.equal(config.fallback.apiKey, 'key-for-Spare-12345');
  assert.equal(config.fallback.fallback, undefined, 'a fallback has no fallback of its own');
  // A bot already on the fallback model has nothing to fall back to.
  await ai.setBotModel(store, 'writer', {providerId: spare.id, model: 'small-model'});
  assert.equal(ai.resolveConfig(store, 'writer').fallback, undefined);
  // An unknown provider is refused; null clears; deleting the provider clears it too.
  await assert.rejects(() => ai.setDefaults(store, {fallback: {providerId: 'nope', model: 'x'}}), /Provider not found/);
  await ai.setDefaults(store, {fallback: {providerId: spare.id, model: 'small-model'}});
  await ai.deleteProvider(store, 'w1', spare.id);
  assert.equal(store.read().ai.fallback, null);
  await ai.setDefaults(store, {fallback: null});
  assert.equal(ai.listProviders(store.read()).fallback, null);
}));

test('prices are saved on a provider, shown to the admin listing only, and never change the endpoint', async () => withStore(async store => {
  const main = await add(store, 'Main', 'big-model');
  const updated = await ai.updateProvider(store, 'w1', main.id, {prices: {'big-model': {input: 2, output: 8, cached: 0.5}}});
  assert.equal(updated.endpointChanged, false, 'a price is not a new endpoint: the catalogue stays');
  assert.deepEqual(ai.getProvider(store, main.id).prices, {'big-model': {input: 2, output: 8, cached: 0.5}});
  assert.equal(ai.publicAi(store.read()).providers[0].prices, undefined, 'viewers do not get the price list');
  await assert.rejects(() => ai.updateProvider(store, 'w1', main.id, {prices: {'big-model': {input: 'cheap'}}}), /input and an output price/);
  await ai.updateProvider(store, 'w1', main.id, {prices: {}});
  assert.deepEqual(ai.getProvider(store, main.id).prices, {});
}));

test('usage totals survive a restart', async () => withStore(async (store, open) => {
  await store.update(s => { recordDay(s, {botId: 'writer', input: 10, output: 2}, '2026-11-12T10:00:00Z'); });
  await store.close();
  const again = await open();
  assert.equal(again.read().usage.days['2026-11-12'].writer.input, 10);
  await again.close();
}));
