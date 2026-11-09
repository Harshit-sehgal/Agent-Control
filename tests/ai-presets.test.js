import test from 'node:test';
import assert from 'node:assert/strict';
import {PROTOCOLS,PROTOCOL_IDS,DEFAULT_PROTOCOL,PROVIDER_PRESETS,normaliseProtocol,inferProtocol,protocolById,presetById} from '../shared/ai-presets.js';

// shared/ai-presets.js is the one list the settings page and the server share.
// A typo here is a provider that saves and then sends the wrong body shape, so
// these checks are pure data assertions: no network, no store.

const LOOPBACK=/^(127\.0\.0\.1|localhost|\[::1\])$/;

test('every protocol has a unique id, a label and a hint', () => {
  assert.ok(PROTOCOLS.length >= 4);
  const ids=PROTOCOLS.map(p=>p.id);
  assert.equal(new Set(ids).size,ids.length,'protocol ids must be unique');
  for(const p of PROTOCOLS){
    assert.match(p.id,/^[a-z][a-z0-9-]*$/,`protocol id "${p.id}" is a stable slug`);
    assert.ok(String(p.label||'').trim(),`${p.id} needs a label for the picker`);
    assert.ok(String(p.hint||'').trim(),`${p.id} needs a one-line hint`);
  }
  assert.deepEqual(PROTOCOL_IDS,ids,'PROTOCOL_IDS is derived from PROTOCOLS');
  assert.ok(PROTOCOL_IDS.includes(DEFAULT_PROTOCOL),'the default protocol is one of the known ids');
});

test('every preset points somewhere real and names a protocol the server speaks', () => {
  const ids=PROVIDER_PRESETS.map(p=>p.id);
  assert.equal(new Set(ids).size,ids.length,'preset ids must be unique');
  for(const preset of PROVIDER_PRESETS){
    assert.ok(String(preset.label||'').trim(),`${preset.id} needs a label`);
    assert.ok(PROTOCOL_IDS.includes(preset.protocol),`${preset.id} names an unknown protocol "${preset.protocol}"`);
    // `custom` and per-tenant clouds (Azure) have no universal endpoint: the
    // user must paste their own, so a blank base URL there is deliberate.
    if(preset.id==='custom'||preset.needsEndpoint){
      assert.equal(preset.baseUrl,'',`${preset.id} asks the user for its endpoint, so it ships none`);
      continue;
    }
    assert.ok(preset.baseUrl,`${preset.id} needs a base URL`);
    const url=new URL(preset.baseUrl);
    const ok=url.protocol==='https:'||(url.protocol==='http:'&&LOOPBACK.test(url.hostname));
    assert.ok(ok,`${preset.id} must use https, or plain http only on loopback (got ${preset.baseUrl})`);
    assert.equal(url.search,'',`${preset.id} base URL carries no query string`);
    assert.equal(url.hash,'',`${preset.id} base URL carries no fragment`);
    // keyOptional only marks a local server, which accepts any string as the key.
    if(url.protocol==='http:')assert.equal(preset.keyOptional,true,`${preset.id} is local, so its key is optional`);
    else assert.equal(Boolean(preset.keyOptional),false,`${preset.id} is hosted, so it needs a key`);
  }
  assert.ok(ids.includes('custom'),'there is a custom endpoint preset');
  assert.ok(ids.includes('ollama'),'there is a local Ollama preset');
});

test('normaliseProtocol accepts the ids and the documented aliases, and refuses junk', () => {
  for(const id of PROTOCOL_IDS)assert.equal(normaliseProtocol(id),id);
  assert.equal(normaliseProtocol('chat'),'openai-chat');
  assert.equal(normaliseProtocol('responses'),'openai-responses');
  assert.equal(normaliseProtocol('anthropic'),'anthropic');
  assert.equal(normaliseProtocol('messages'),'anthropic');
  assert.equal(normaliseProtocol('claude'),'anthropic');
  assert.equal(normaliseProtocol('gemini'),'gemini');
  assert.equal(normaliseProtocol('google'),'gemini');
  assert.equal(normaliseProtocol('  Claude  '),'anthropic','case and padding are ignored');
  for(const junk of ['', null, undefined, 'gpt', 'openai-chatty', 'anthropics', 42, {}])assert.equal(normaliseProtocol(junk),null,`${String(junk)} is not a protocol`);
});

test('inferProtocol only special-cases the three non-OpenAI hosts', () => {
  assert.equal(inferProtocol('https://api.anthropic.com/v1'),'anthropic');
  assert.equal(inferProtocol('https://generativelanguage.googleapis.com/v1beta'),'gemini');
  assert.equal(inferProtocol('https://api.openai.com/v1'),'openai-responses');
  assert.equal(inferProtocol('https://api.groq.com/openai/v1'),'openai-chat','other vendors speak chat');
  assert.equal(inferProtocol('https://my-router.example/v1'),'openai-chat','a custom gateway speaks chat');
  assert.equal(inferProtocol('http://127.0.0.1:11434/v1'),'openai-chat','a local server speaks chat');
  assert.equal(inferProtocol('not a url'),DEFAULT_PROTOCOL,'junk falls back to the default');
  assert.equal(inferProtocol(''),DEFAULT_PROTOCOL);
});

test('protocolById and presetById are case-insensitive and return null for unknown ids', () => {
  assert.equal(protocolById('ANTHROPIC').id,'anthropic');
  assert.equal(protocolById('nope'),null);
  assert.equal(presetById('anthropic').baseUrl,'https://api.anthropic.com/v1');
  assert.equal(presetById('  Gemini ').protocol,'gemini');
  assert.equal(presetById(''),null);
  assert.equal(presetById('not-a-provider'),null);
});
