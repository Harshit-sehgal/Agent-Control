import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import * as credentials from '../src/credentials.js';
import {envConfig} from '../src/ai.js';
import {migrate} from '../shared/workflow.js';
import {createRouter} from '../src/router.js';
import {aiRoutes} from '../src/routes-ai.js';
import {workflowRoutes} from '../src/routes-workflow.js';

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

/** A loopback provider stub, so a catalogue read never leaves the machine. */
async function stub(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      requests.push({method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null});
      res.writeHead(reply.status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}

// Apply env for one test and restore it exactly afterwards.
async function withEnv(env, fn) {
  const keys = Object.keys(env), saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('a BYOK provider stores its key encrypted and never lists it', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {label: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-secret-123', createdBy: 'owner@localhost'});
    assert.equal(p.label, 'OpenAI');
    assert.equal(p.baseUrl, 'https://api.openai.com/v1', 'base URL is trimmed of a trailing slash');
    assert.equal(p.protocol, 'openai-responses', 'OpenAI hosts infer the Responses API');
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
    assert.equal(ai.resolveConfig(store, null).protocol, 'openai-chat', 'non-OpenAI hosts use chat completions');

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

test('a bot pinned to a deleted provider uses the workspace default', async () => {
  await withStore(async store => {
    const gone = await ai.addProvider(store, 'default', {label: 'Old', baseUrl: 'https://old.example/v1', apiKey: 'old-key'});
    const kept = await ai.addProvider(store, 'default', {label: 'Kept', baseUrl: 'https://kept.example/v1', apiKey: 'kept-key'});
    await ai.setDefaults(store, {providerId: kept.id, model: 'kept-model'});
    await ai.setBotModel(store, 'writer', {providerId: gone.id, model: 'old-model'});
    await ai.deleteProvider(store, 'default', gone.id);
    const cfg = ai.resolveConfig(store, 'writer');
    assert.equal(cfg.apiKey, 'kept-key');
    assert.equal(cfg.baseUrl, 'https://kept.example/v1');
    assert.equal(cfg.model, 'old-model');
  });
});

test('creating a provider returns metadata, and a rejected provider is an error', async () => {
  await withStore(async store => {
    const router = createRouter();
    aiRoutes(router);
    const handler = router.find('POST', '/api/ai/providers').route.handler;
    const ctx = body => ({body: async () => body, store, actor: {workspaceId: 'default', email: 'owner@localhost'}, params: {}});
    await assert.rejects(() => handler(ctx({label: '', baseUrl: 'https://x.example/v1', apiKey: 'k'})), /name/i);
    const created = await handler(ctx({label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret-123'}));
    assert.equal(created.status, 201);
    assert.equal(created.body.label, 'OpenAI');
    assert.equal(JSON.stringify(created.body).includes('sk-secret-123'), false);
    assert.equal('apiKey' in created.body, false);
    assert.equal('credentialId' in created.body, false);
  });
});

test('a key hidden in a provider URL is refused and never returned', async () => {
  await withStore(async store => {
    await assert.rejects(ai.addProvider(store, 'default', {label: 'X', baseUrl: 'https://sk-secret@x.example/v1', apiKey: 'k'}), /absolute http/i);
    await assert.rejects(ai.addProvider(store, 'default', {label: 'X', baseUrl: 'https://x.example/v1?api_key=sk-secret', apiKey: 'k'}), /absolute http/i);
    await store.update(s => {
      s.ai.providers.push({id: 'p', label: 'L', baseUrl: 'https://user:sk-secret@evil.example/v1?api_key=sk-secret', style: 'chat', credentialId: 'cred-1', apiKey: 'sk-secret', createdAt: 't'});
      s.ai.bots = {writer: {providerId: 'p', model: 'm', apiKey: 'sk-secret'}};
    });
    const listed = ai.listProviders(store.read());
    assert.equal(JSON.stringify(listed).includes('sk-secret'), false);
    assert.equal(listed.providers[0].baseUrl, 'https://evil.example/v1');
    assert.equal('credentialId' in listed.providers[0], false);
    const router = createRouter();
    workflowRoutes(router, {auth: {listWorkspaces: () => [], roleOf: () => 'owner'}, processCandidate: async () => {}} );
    const body = await router.find('GET', '/api/state').route.handler({
      store, actor: {email: 'a@b.c', role: 'owner', userId: 'u1', workspaceId: 'default'},
    });
    assert.equal(JSON.stringify(body.ai).includes('sk-secret'), false);
    assert.equal(JSON.stringify(body.ai).includes('cred-1'), false);
    assert.equal(body.ai.providers.find(p => p.id === 'p').label, 'L');
    assert.equal(body.ai.bots.writer.model, 'm');
    assert.equal(body.ai.bots.writer.apiKey, undefined);
  });
});

test('an explicit protocol is stored as given, and saving a provider never calls the endpoint', async () => {
  await withStore(async store => {
    const srv = await stub({status: 200, json: {data: [{id: 'claude-sonnet-4-5'}]}});
    try {
      const p = await ai.addProvider(store, 'default', {label: 'Claude', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'sk-ant-1', protocol: 'anthropic'});
      assert.equal(p.protocol, 'anthropic', 'the requested protocol wins over host detection');
      assert.deepEqual(srv.requests, [], 'addProvider only saves; the route is what reads the catalogue');
      assert.equal(ai.listProviders(store.read()).providers[0].protocol, 'anthropic');
      assert.equal(ai.resolveConfig(store, null).protocol, 'anthropic', 'the saved shape is what a call speaks');
      assert.equal(ai.resolveConfig(store, null).apiKey, 'sk-ant-1');
    } finally { srv.close(); }
  });
});

test('refreshModels stores the catalogue and clears an earlier failure', async () => {
  await withStore(async store => {
    const srv = await stub({status: 200, json: {data: [{id: 'model-b'}, {id: 'model-a'}]}});
    try {
      const p = await ai.addProvider(store, 'default', {label: 'Groq', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'gsk_stub'});
      await store.update(s => { s.ai.providers.find(x => x.id === p.id).modelsError = 'an older failure'; });
      const found = await ai.refreshModels(store, p.id);
      assert.deepEqual(found.models, ['model-a', 'model-b']);
      const listed = ai.listProviders(store.read()).providers.find(x => x.id === p.id);
      assert.deepEqual(listed.models, ['model-a', 'model-b']);
      assert.ok(listed.modelsAt, 'the read is timestamped');
      assert.equal(listed.modelsError, null, 'a good read clears the old error');
      assert.equal(srv.requests[0].url, '/v1/models');
      assert.equal(srv.requests[0].headers.authorization, 'Bearer gsk_stub');
    } finally { srv.close(); }
  });
});

test('a failed catalogue read is recorded on the provider instead of losing it', async () => {
  await withStore(async store => {
    const srv = await stub({status: 500, json: {error: {message: 'catalogue exploded'}}});
    try {
      const p = await ai.addProvider(store, 'default', {label: 'Flaky', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'flaky-key'});
      await assert.rejects(() => ai.refreshModels(store, p.id), e => /500/.test(e.message) && /catalogue exploded/.test(e.message));
      const listed = ai.listProviders(store.read()).providers.find(x => x.id === p.id);
      assert.ok(listed, 'the provider is still saved');
      assert.match(listed.modelsError, /catalogue exploded/);
      assert.deepEqual(listed.models, []);
      assert.ok(listed.modelsAt, 'the failed attempt is timestamped too');
      assert.equal(ai.resolveConfig(store, null).apiKey, 'flaky-key', 'the key survived the failure');
    } finally { srv.close(); }
  });
});

test('renaming a provider keeps its stored key untouched', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {label: 'Old name', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'orig-key'});
    const credentialId = store.read().ai.providers.find(x => x.id === p.id).credentialId;
    const updated = await ai.updateProvider(store, 'default', p.id, {label: 'New name'});
    assert.equal(updated.label, 'New name');
    assert.equal(updated.baseUrl, 'https://api.groq.com/openai/v1', 'the endpoint is unchanged');
    assert.equal(updated.endpointChanged, false, 'a rename keeps the model catalogue');
    assert.equal(store.read().ai.providers.find(x => x.id === p.id).credentialId, credentialId);
    assert.equal(credentials.revealValue(store, credentialId), 'orig-key');
  });
});

test('rotating a key replaces the vault secret in place and drops the stale catalogue', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'old-key'});
    const credentialId = store.read().ai.providers.find(x => x.id === p.id).credentialId;
    await store.update(s => { const prov = s.ai.providers.find(x => x.id === p.id); prov.models = ['stale-model']; prov.modelsAt = 'earlier'; });
    const updated = await ai.updateProvider(store, 'default', p.id, {apiKey: 'new-key'});
    assert.equal(updated.endpointChanged, true, 'a new key invalidates the old list');
    assert.equal(store.read().ai.providers.find(x => x.id === p.id).credentialId, credentialId, 'the vault reference is reused, so nothing dangles');
    assert.equal(credentials.revealValue(store, credentialId), 'new-key');
    assert.equal(credentials.revealValue(store, credentialId).includes('old-key'), false, 'the old key no longer decrypts');
    assert.deepEqual(updated.models, [], 'the stale catalogue is cleared until the route re-reads it');
    assert.equal(ai.resolveConfig(store, null).apiKey, 'new-key');
  });
});

test('updating a provider that does not exist is a 404', async () => {
  await withStore(async store => {
    await assert.rejects(() => ai.updateProvider(store, 'default', 'ghost-provider', {label: 'X'}), e => e.status === 404 && /not found/i.test(e.message));
    assert.equal(store.read().ai.providers.length, 0, 'nothing was created by the failed update');
  });
});

test('resolveConfig uses the first catalogue model where "auto" cannot work', async () => {
  await withStore(async store => {
    const anthropic = await ai.addProvider(store, 'default', {label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', protocol: 'anthropic'});
    await store.update(s => { s.ai.providers.find(x => x.id === anthropic.id).models = ['claude-sonnet-4-5', 'claude-haiku-4-5']; });
    assert.equal(ai.resolveConfig(store, null).model, 'claude-sonnet-4-5', 'Anthropic cannot run "auto", so the first model is used');

    const gemini = await ai.addProvider(store, 'default', {label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gp-key', protocol: 'gemini'});
    await store.update(s => { s.ai.providers.find(x => x.id === gemini.id).models = ['gemini-2.5-flash']; });
    await ai.setDefaults(store, {providerId: gemini.id});
    assert.equal(ai.resolveConfig(store, null).model, 'gemini-2.5-flash');

    const groq = await ai.addProvider(store, 'default', {label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x'});
    await store.update(s => { s.ai.providers.find(x => x.id === groq.id).models = ['llama-3.3-70b']; });
    await ai.setDefaults(store, {providerId: groq.id});
    assert.equal(ai.resolveConfig(store, null).model, 'auto', 'a chat provider keeps the router\'s own choice');

    await ai.setDefaults(store, {providerId: anthropic.id, model: 'claude-opus-4-1'});
    assert.equal(ai.resolveConfig(store, null).model, 'claude-opus-4-1', 'an explicit choice still wins');
  });
});

test('a provider saved before protocols existed resolves from its legacy style', async () => {
  await withStore(async store => {
    const cred = credentials.addCredential(store, 'default', {name: 'AI key · Legacy', kind: 'ai_provider', value: 'legacy-key'});
    await store.update(s => {
      const state = ai.aiState(s);
      state.providers.push({id: 'legacy', label: 'Legacy', baseUrl: 'https://api.groq.com/openai/v1', style: 'chat', credentialId: cred.id, createdAt: 't'});
      state.defaultProviderId = 'legacy';
    });
    assert.equal(ai.listProviders(store.read()).providers.find(p => p.id === 'legacy').protocol, 'openai-chat');
    const cfg = ai.resolveConfig(store, null);
    assert.equal(cfg.protocol, 'openai-chat', 'style:"chat" predates protocol and still resolves');
    assert.equal(cfg.style, 'chat');
    assert.equal(cfg.apiKey, 'legacy-key');
  });
});

test('an environment key alone picks the Anthropic or Gemini endpoint', async () => {
  await withEnv({AI_BASE_URL: '', OPENAI_BASE_URL: '', AI_API_KEY: '', OPENAI_API_KEY: '', AI_API_STYLE: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ANTHROPIC_API_KEY: 'sk-ant-env'}, async () => {
    const cfg = envConfig();
    assert.equal(cfg.baseUrl, 'https://api.anthropic.com/v1');
    assert.equal(cfg.protocol, 'anthropic');
    assert.equal(cfg.apiKey, 'sk-ant-env');
    assert.equal(cfg.source, 'env');
  });
  await withEnv({AI_BASE_URL: '', OPENAI_BASE_URL: '', AI_API_KEY: '', OPENAI_API_KEY: '', AI_API_STYLE: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: 'gm-env'}, async () => {
    const cfg = envConfig();
    assert.equal(cfg.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
    assert.equal(cfg.protocol, 'gemini');
    assert.equal(cfg.apiKey, 'gm-env');
  });
});

test('the create route saves a provider and returns the catalogue it just read', async () => {
  await withStore(async store => {
    const srv = await stub({status: 200, json: {data: [{id: 'model-b'}, {id: 'model-a'}]}});
    try {
      const router = createRouter();
      aiRoutes(router);
      const handler = router.find('POST', '/api/ai/providers').route.handler;
      const created = await handler({
        body: async () => ({label: 'Local server', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'stub-key'}),
        store, actor: {workspaceId: 'default', email: 'owner@localhost', role: 'admin'}, params: {},
      });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body.models, ['model-a', 'model-b'], 'the reply carries the models the key can use');
      assert.equal(created.body.modelsError, null);
      assert.ok(created.body.modelsAt);
      assert.equal(created.body.protocol, 'openai-chat');
      assert.equal(JSON.stringify(created.body).includes('stub-key'), false, 'the key is never returned');
      assert.equal(srv.requests[0].url, '/v1/models');
      assert.equal(srv.requests[0].headers.authorization, 'Bearer stub-key');
    } finally { srv.close(); }
  });
});

test('custom headers ride on the call but never into the state or a listing', async () => {
  await withStore(async store => {
    const srv = await stub({status: 200, json: {choices: [{message: {content: 'OK'}}]}});
    try {
      const p = await ai.addProvider(store, 'default', {label: 'Gateway', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'gw-secret-key-123',
        headers: {'X-Api-Key': 'pasted-header-value', 'X-Beta': 'on'}});
      assert.deepEqual(p.hasHeaders, ['X-Api-Key', 'X-Beta'], 'the listing names the headers, nothing more');
      await ai.testProvider(store, p.id, {model: 'gateway-model'});
      assert.equal(srv.requests[0].headers['x-api-key'], 'pasted-header-value', 'a gateway header is sent alongside the protocol one');
      assert.equal(srv.requests[0].headers.authorization, 'Bearer gw-secret-key-123', 'the bearer key is still sent for a chat provider');
      assert.equal(srv.requests[0].headers['x-beta'], 'on');

      // A proxy that wants its own Authorization is a real provider, not a mistake.
      await ai.updateProvider(store, 'default', p.id, {headers: {'Authorization': 'Token pasted-token', 'X-Api-Key': 'pasted-header-value'}});
      await ai.testProvider(store, p.id, {model: 'gateway-model'});
      assert.equal(srv.requests[1].headers.authorization, 'Token pasted-token', 'a pasted Authorization wins over the bearer header');
      assert.equal(srv.requests[1].headers['x-api-key'], 'pasted-header-value');

      const secrets = ['pasted-header-value', 'pasted-token', 'gw-secret-key-123'];
      const state = JSON.stringify(store.read());
      for (const secret of secrets) assert.equal(state.includes(secret), false, `${secret} must not be readable from the state document`);
      const listings = JSON.stringify(ai.listProviderListings(store));
      const viewer = JSON.stringify(ai.publicAi(store.read()));
      for (const secret of secrets) {
        assert.equal(listings.includes(secret), false, `the admin listing must not carry ${secret}`);
        assert.equal(viewer.includes(secret), false, `the viewer payload must not carry ${secret}`);
      }
      assert.deepEqual(ai.listProviderListings(store).providers[0].hasHeaders, ['Authorization', 'X-Api-Key'], 'only names are listed');
      assert.equal(ai.publicAi(store.read()).providers[0].hasHeaders, undefined, 'a viewer does not even get the names');
    } finally { srv.close(); }
  });
});

test('a rejected header set is refused before any key or header is stored', async () => {
  await withStore(async store => {
    const nine = Object.fromEntries(Array.from({length: 9}, (_, i) => [`X-H${i}`, 'v']));
    const cases = [
      [{'Bad Name': 'x'}, /not a valid header name/i],
      [{'X-Evil\r\nX-Injected': '1'}, /not a valid header name/i],
      [{'X-Test': 'a\r\nX-Injected: 1'}, /line break/i],
      [{'X-Test': 42}, /text value/i],
      [{'X-Test': ''}, /1 to 2000/i],
      [nine, /at most 8/i],
    ];
    for (const [headers, expected] of cases) {
      await assert.rejects(
        () => ai.addProvider(store, 'default', {label: 'X', baseUrl: 'https://gw.example/v1', apiKey: 'k', headers}),
        e => e.status === 400 && expected.test(e.message),
      );
    }
    assert.equal(store.read().ai.providers.length, 0, 'a rejected save creates no provider');
    assert.equal(credentials.listCredentials(store, 'default').length, 0, 'and leaves no orphan credential behind');
  });
});

test('editing headers keeps, replaces in place, or clears the saved set', async () => {
  await withStore(async store => {
    const p = await ai.addProvider(store, 'default', {label: 'Gateway', baseUrl: 'https://gw.example/v1', apiKey: 'gw-key', headers: {'X-Lane': '1', 'X-Beta': '2'}});
    const saved = () => store.read().ai.providers.find(x => x.id === p.id);
    const headerId = saved().headersCredentialId;
    assert.ok(headerId, 'the header values live in the vault, not the record');
    await store.update(s => { const prov = s.ai.providers.find(x => x.id === p.id); prov.chatModels = ['m']; prov.models = ['m']; });

    // Omitted headers (a rename) must not wipe the set: the form may not resend it.
    const renamed = await ai.updateProvider(store, 'default', p.id, {label: 'Renamed'});
    assert.deepEqual(renamed.hasHeaders, ['X-Beta', 'X-Lane']);
    assert.equal(saved().headersCredentialId, headerId, 'the same vault row is still referenced');
    assert.deepEqual(JSON.parse(credentials.revealValue(store, headerId)), {'X-Lane': '1', 'X-Beta': '2'});

    // The same set again is not a change, so the cached catalogue survives.
    const same = await ai.updateProvider(store, 'default', p.id, {headers: {'X-Beta': '2', 'X-Lane': '1'}});
    assert.equal(same.endpointChanged, false);
    assert.equal(saved().headersCredentialId, headerId);

    // A changed set replaces the credential in place, so nothing dangles.
    const changed = await ai.updateProvider(store, 'default', p.id, {headers: {'X-Beta': '3'}});
    assert.equal(changed.endpointChanged, true, 'headers shape the request, so the old catalogue is stale');
    assert.deepEqual(changed.hasHeaders, ['X-Beta']);
    assert.equal(saved().headersCredentialId, headerId, 'the record keeps the same credential id');
    assert.deepEqual(JSON.parse(credentials.revealValue(store, headerId)), {'X-Beta': '3'});
    assert.deepEqual(saved().chatModels, [], 'the picker is re-read rather than left with stale models');

    // {} is the explicit clear.
    const cleared = await ai.updateProvider(store, 'default', p.id, {headers: {}});
    assert.deepEqual(cleared.hasHeaders, []);
    assert.equal(saved().headersCredentialId, null);
    assert.throws(() => credentials.revealValue(store, headerId), e => e.status === 404, 'the header credential is gone');
    assert.equal(ai.providerConfig(store, saved()).headers && Object.keys(ai.providerConfig(store, saved()).headers).length, 0, 'a call now carries only the protocol headers');
  });
});

test('an Azure provider resolves a real deployment instead of the literal "auto"', async () => {
  await withStore(async store => {
    const azure = await ai.addProvider(store, 'default', {label: 'Azure', baseUrl: 'https://res.openai.azure.com', apiKey: 'az-key-123', protocol: 'azure-openai', apiVersion: '2024-06-01'});
    await store.update(s => {
      const prov = s.ai.providers.find(x => x.id === azure.id);
      prov.models = ['whisper-1', 'gpt-4o'];
      prov.chatModels = ['gpt-4o'];
      prov.allModels = ['gpt-4o', 'whisper-1'];
    });
    const cfg = ai.resolveConfig(store, null);
    assert.equal(cfg.protocol, 'azure-openai');
    assert.equal(cfg.model, 'gpt-4o', 'the first chat-capable model wins; "auto" would be a guaranteed 400');
    assert.equal(cfg.apiVersion, '2024-06-01', 'the saved version reaches the call');
    assert.equal(ai.listProviders(store.read()).providers.find(x => x.id === azure.id).apiVersion, '2024-06-01');

    // A provider saved before chatModels existed still avoids "auto".
    const older = await ai.addProvider(store, 'default', {label: 'Azure 2', baseUrl: 'https://res2.openai.azure.com', apiKey: 'az-key-456', protocol: 'azure-openai'});
    await store.update(s => { s.ai.providers.find(x => x.id === older.id).models = ['gpt-4o-mini']; s.ai.defaultProviderId = older.id; });
    assert.equal(ai.resolveConfig(store, null).model, 'gpt-4o-mini');
  });
});

test('the test route makes one real call and returns the model, reply and timing', async () => {
  await withStore(async store => {
    const srv = await stub({status: 200, json: {choices: [{message: {content: 'OK'}}]}});
    try {
      const p = await ai.addProvider(store, 'default', {label: 'Local', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'stub-key-123'});
      const router = createRouter();
      aiRoutes(router);
      const found = router.find('POST', `/api/ai/providers/${p.id}/test`);
      assert.ok(found, 'POST /api/ai/providers/:id/test is registered');
      assert.equal(found.route.access, 'admin', 'spending a provider call is an admin action');
      assert.equal(found.params.id, p.id, 'the :id segment is captured for the handler');
      const ctx = body => ({body: async () => body, store, actor: {workspaceId: 'default', email: 'owner@localhost', role: 'admin'}, params: found.params});

      const result = await found.route.handler(ctx({model: 'gateway-model'}));
      assert.deepEqual(Object.keys(result).sort(), ['model', 'ms', 'ok', 'reply']);
      assert.equal(result.ok, true);
      assert.equal(result.model, 'gateway-model', 'the picked model is the one called');
      assert.equal(result.reply, 'OK');
      assert.ok(Number.isInteger(result.ms) && result.ms >= 0, 'the round trip is timed');
      assert.equal(srv.requests.length, 1, 'exactly one call, not a catalogue read as well');
      assert.equal(srv.requests[0].url, '/v1/chat/completions');
      assert.equal(srv.requests[0].body.model, 'gateway-model');

      const ghost = router.find('POST', '/api/ai/providers/ghost-provider/test');
      await assert.rejects(
        () => ghost.route.handler({body: async () => ({}), store, actor: {workspaceId: 'default', email: 'owner@localhost', role: 'admin'}, params: ghost.params}),
        e => e.status === 404 && /not found/i.test(e.message),
      );
    } finally { srv.close(); }
  });
});

test('a failed provider test reports the provider\'s own words, not a generic failure', async () => {
  await withStore(async store => {
    const srv = await stub({status: 401, json: {error: {message: 'that key is not valid here'}}});
    try {
      const p = await ai.addProvider(store, 'default', {label: 'Local', baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'stub-key-123'});
      await assert.rejects(
        () => ai.testProvider(store, p.id, {model: 'm'}),
        e => e.status === 502 && /that key is not valid here/.test(e.message) && /401/.test(e.message) && /key was rejected/i.test(e.message)
          && !/did not answer/i.test(e.message) && !e.message.includes('stub-key-123'),
      );
    } finally { srv.close(); }
  });
});
