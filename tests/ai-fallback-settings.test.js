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
  assert.equal(ai.resolveConfig(store, 'writer').fallbacks, undefined, 'no fallbacks until one is picked');
  const listed = await ai.setDefaults(store, {fallback: {providerId: spare.id, model: 'small-model'}});
  assert.deepEqual(listed.fallbacks, [{providerId: spare.id, model: 'small-model'}]);
  assert.deepEqual(listed.fallback, {providerId: spare.id, model: 'small-model'});
  assert.deepEqual(ai.publicAi(store.read()).fallback, {providerId: spare.id, model: 'small-model'});
  assert.deepEqual(ai.publicAi(store.read()).fallbacks, [{providerId: spare.id, model: 'small-model'}]);
  assert.deepEqual(ai.listProviderListings(store).fallbacks, [{providerId: spare.id, model: 'small-model'}]);
  const config = ai.resolveConfig(store, 'writer');
  assert.equal(config.model, 'big-model');
  assert.equal(Object.hasOwn(config, 'fallback'), false, 'the single key is gone from a config');
  assert.equal(config.fallbacks.length, 1);
  assert.equal(config.fallbacks[0].model, 'small-model');
  assert.equal(config.fallbacks[0].providerId, spare.id);
  assert.equal(config.fallbacks[0].apiKey, 'key-for-Spare-12345');
  assert.equal(config.fallbacks[0].fallbacks, undefined, 'a fallback has no fallbacks of its own');
  // A bot already on the fallback model has nothing to fall back to.
  await ai.setBotModel(store, 'writer', {providerId: spare.id, model: 'small-model'});
  assert.equal(ai.resolveConfig(store, 'writer').fallbacks, undefined);
  // An unknown provider is refused; an empty list or null clears; deleting the provider clears it too.
  await assert.rejects(() => ai.setDefaults(store, {fallback: {providerId: 'nope', model: 'x'}}), /Provider not found/);
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: [{providerId: 'nope', model: 'x'}]}), /Provider not found/);
  await ai.setDefaults(store, {fallback: {providerId: spare.id, model: 'small-model'}});
  await ai.deleteProvider(store, 'w1', spare.id);
  assert.deepEqual(store.read().ai.fallbacks, []);
  assert.equal(Object.hasOwn(store.read().ai, 'fallback'), false);
  await ai.setDefaults(store, {fallback: null});
  assert.equal(ai.listProviders(store.read()).fallback, null);
  assert.deepEqual(ai.listProviders(store.read()).fallbacks, []);
}));

test('up to three fallbacks, in order, saved and listed; the old single fallback reads as a list of one', async () => withStore(async store => {
  const a = await add(store, 'A', 'x'), b = await add(store, 'B', 'y');
  const listed = await ai.setDefaults(store, {fallbacks: [{providerId: a.id, model: 'x'}, {providerId: b.id, model: 'y'}]});
  assert.deepEqual(listed.fallbacks, [{providerId: a.id, model: 'x'}, {providerId: b.id, model: 'y'}]);
  assert.deepEqual(listed.fallback, {providerId: a.id, model: 'x'});
  assert.equal(Object.hasOwn(store.read().ai, 'fallback'), false);
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: [1, 2, 3, 4].map(() => ({providerId: a.id, model: 'x'}))}), /^Error: At most 3 fallback models\.$/);
  // The failed save changed nothing.
  assert.deepEqual(ai.publicAi(store.read()).fallbacks, [{providerId: a.id, model: 'x'}, {providerId: b.id, model: 'y'}]);
  // Something that is not a list is refused, and so is an entry that is not a pick.
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: 'x'}), /list/);
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: [1]}), /\{providerId, model\}/);
  // The same pick twice is saved once.
  const twice = await ai.setDefaults(store, {fallbacks: [{providerId: a.id, model: 'x'}, {providerId: a.id, model: 'x'}, {providerId: b.id}]});
  assert.deepEqual(twice.fallbacks, [{providerId: a.id, model: 'x'}, {providerId: b.id, model: null}]);
  // An install from before: only the single key, read as a list of one until the owner saves again.
  await store.update(s => { delete s.ai.fallbacks; s.ai.fallback = {providerId: b.id, model: 'y'}; });
  assert.deepEqual(ai.publicAi(store.read()).fallbacks, [{providerId: b.id, model: 'y'}]);
  assert.deepEqual(ai.resolveConfig(store, 'writer').fallbacks.map(f => f.model), ['y']);
  await ai.setDefaults(store, {effort: 'low'});
  assert.deepEqual(store.read().ai.fallback, {providerId: b.id, model: 'y'}, 'a save that does not touch fallbacks leaves the old key');
  await ai.setDefaults(store, {fallback: null});
  assert.deepEqual(store.read().ai.fallbacks, []);
  assert.equal(Object.hasOwn(store.read().ai, 'fallback'), false);
}));

test('a bot\'s config carries its fallbacks in order, never itself, never a repeat, and none carries its own', async () => withStore(async store => {
  const a = await add(store, 'A', 'x'), b = await add(store, 'B', 'y'), c = await add(store, 'C', 'z');
  await ai.setDefaults(store, {providerId: a.id, model: 'x'});
  const pick = p => ({providerId: p.id, model: {A: 'x', B: 'y', C: 'z'}[p.label]});
  await store.update(s => { s.ai.fallbacks = [a, b, b, c].map(pick); });
  const config = ai.resolveConfig(store, 'writer');
  assert.deepEqual(config.fallbacks.map(f => f.model), ['y', 'z']);
  assert.ok(config.fallbacks.every(f => f.fallbacks === undefined && !Object.hasOwn(f, 'fallback')));
  // Three picks is the most a list reads, even when more were written straight into state.
  await store.update(s => { s.ai.fallbacks = [b, c, b, a].map(pick); });
  assert.deepEqual(ai.publicAi(store.read()).fallbacks.map(f => f.model), ['y', 'z', 'x']);
  // A provider that is deleted drops out of the list and the turn.
  await store.update(s => { s.ai.fallbacks = [b, c].map(pick); });
  await ai.deleteProvider(store, 'w1', b.id);
  assert.deepEqual(ai.resolveConfig(store, 'writer').fallbacks.map(f => f.model), ['z']);
  assert.deepEqual(store.read().ai.fallbacks, [{providerId: c.id, model: 'z'}]);
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

test('an empty old-style fallback means none, as the old API did; entries inside fallbacks stay strict', async () => withStore(async store => {
  const a = await add(store, 'A', 'x');
  await ai.setDefaults(store, {fallbacks: [{providerId: a.id, model: 'x'}]});
  for (const none of [{}, {providerId: ''}, {model: 'x'}, {providerId: null}]) {
    await ai.setDefaults(store, {fallbacks: [{providerId: a.id, model: 'x'}]});
    const cleared = await ai.setDefaults(store, {fallback: none});
    assert.deepEqual(cleared.fallbacks, [], JSON.stringify(none));
    assert.equal(cleared.fallback, null);
    assert.equal(Object.hasOwn(store.read().ai, 'fallback'), false);
  }
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: [{}]}), /\{providerId, model\}/);
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: [{providerId: ''}]}), /\{providerId, model\}/);
  await assert.rejects(() => ai.setDefaults(store, {fallback: {providerId: 5}}), /\{providerId, model\}/);
}));
