import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {complete, executeCustomBot, usageOf, fallsBack, clearCoolOff} from '../src/ai.js';
import {meterTurn, turnNote, fallbacksOf} from '../src/usage.js';

// A stub's port can be handed out again to a later test, and a provider that failed must not rest into it.
beforeEach(() => clearCoolOff());

// Usage parsing per wire, the prompt-cache markers, and the one fallback call, each driven against a loopback
// provider so the request body and the response shape are the real ones.

/** A provider that answers each request with the next reply in `replies` (the last one repeats). */
async function stub(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      requests.push({url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null});
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(reply.status, {'Content-Type': reply.type || 'application/json'});
      res.end(reply.raw ?? JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}
const cfg = (port, extra) => ({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key-123456', model: 'm', ...extra});
/** A store just big enough for meterTurn: one document, updated in place. */
const memStore = (state = {}) => ({read: () => state, update: async fn => fn(state), state});

test('usage is read from each wire and split into uncached input, cache reads and writes, and output', () => {
  assert.deepEqual(usageOf('anthropic', {usage: {input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300}}), {input: 20, output: 5, cacheRead: 1000, cacheWrite: 300});
  // OpenAI counts cached tokens inside prompt_tokens; they are taken out so they are not billed twice.
  assert.deepEqual(usageOf('openai-chat', {usage: {prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: {cached_tokens: 1024}}}), {input: 176, output: 40, cacheRead: 1024, cacheWrite: 0});
  assert.deepEqual(usageOf('azure-openai', {usage: {prompt_tokens: 10, completion_tokens: 2}}), {input: 10, output: 2, cacheRead: 0, cacheWrite: 0});
  assert.deepEqual(usageOf('openai-responses', {usage: {input_tokens: 2000, output_tokens: 90, input_tokens_details: {cached_tokens: 1500}, output_tokens_details: {reasoning_tokens: 30}}}), {input: 500, output: 90, cacheRead: 1500, cacheWrite: 0});
  // Gemini bills thinking as output, and its prompt count includes the cached content.
  assert.deepEqual(usageOf('gemini', {usageMetadata: {promptTokenCount: 800, candidatesTokenCount: 50, thoughtsTokenCount: 25, cachedContentTokenCount: 600, totalTokenCount: 875}}), {input: 200, output: 75, cacheRead: 600, cacheWrite: 0});
  assert.equal(usageOf('openai-chat', {choices: []}), null, 'no usage reported is no usage, not zero');
});

test('the Anthropic body marks the system prompt and the stable head of the task for caching, within 4 breakpoints', async () => {
  const {requests, port, close} = await stub([{status: 200, json: {content: [{type: 'text', text: 'ok'}], usage: {input_tokens: 3, output_tokens: 1}}}]);
  const tools = {browser: 'x'.repeat(3000)};
  const turn = n => JSON.stringify({botId: 'b1', botRole: 'Researcher', tools, objective: `question ${n}`, now: {iso: `2026-11-1${n}`}});
  try {
    await complete({instructions: 'Stable rules.', input: turn(1), config: cfg(port, {protocol: 'anthropic'})});
    await complete({instructions: 'Stable rules.', input: turn(2), config: cfg(port, {protocol: 'anthropic'})});
  } finally { close(); }
  const [a, b] = requests.map(r => r.body);
  assert.deepEqual(a.system, [{type: 'text', text: 'Stable rules.', cache_control: {type: 'ephemeral'}}]);
  const content = a.messages[0].content;
  assert.equal(content.length, 2);
  assert.deepEqual(content[0].cache_control, {type: 'ephemeral'});
  assert.deepEqual(Object.keys(JSON.parse(content[0].text)), ['botId', 'botRole', 'tools'], 'the stable part is the cached block');
  assert.deepEqual(Object.keys(JSON.parse(content[1].text)), ['objective', 'now'], 'per-turn values come after the breakpoint');
  assert.equal(content[1].cache_control, undefined);
  const marks = JSON.stringify(a).match(/cache_control/g).length;
  assert.ok(marks <= 4, `at most 4 cache breakpoints (got ${marks})`);
  // Turn to turn, everything up to the second breakpoint is byte-identical, so the cache can hit.
  assert.equal(JSON.stringify(a.system) + a.messages[0].content[0].text, JSON.stringify(b.system) + b.messages[0].content[0].text);
});

test('a short or non-JSON task is sent as plain text with only the system prompt cached', async () => {
  const {requests, port, close} = await stub([{status: 200, json: {content: [{type: 'text', text: 'ok'}]}}]);
  try { await complete({instructions: 'Rules.', input: 'ping', config: cfg(port, {protocol: 'anthropic'})}); } finally { close(); }
  assert.equal(requests[0].body.messages[0].content, 'ping');
  assert.equal(requests[0].body.system[0].cache_control.type, 'ephemeral');
});

test('OpenAI keeps the system prompt first and identical across turns, so its automatic prefix cache can hit', async () => {
  const {requests, port, close} = await stub([{status: 200, json: {choices: [{message: {content: 'ok'}}], usage: {prompt_tokens: 5, completion_tokens: 1}}}]);
  const bot = {id: 'b1', name: 'Scout', instructions: 'Find things.'};
  try {
    await executeCustomBot(bot, JSON.stringify({botId: 'b1', objective: 'one', now: {iso: '2026-11-12T10:00:00Z'}}), cfg(port, {protocol: 'openai-chat'}));
    await executeCustomBot(bot, JSON.stringify({botId: 'b1', objective: 'two', now: {iso: '2026-11-12T10:05:00Z'}}), cfg(port, {protocol: 'openai-chat'}));
  } finally { close(); }
  const [a, b] = requests.map(r => r.body.messages);
  assert.equal(a[0].role, 'system');
  assert.equal(a[0].content, b[0].content);
  assert.doesNotMatch(a[0].content, /2026|\d{1,2}:\d{2}/, 'no clock in the system prompt');
});

test('a metered turn records tokens per call, per bot per day and on the run, with cost only when a price is set', async () => {
  const {port, close} = await stub([{status: 200, json: {content: [{type: 'text', text: 'ok'}], usage: {input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 4000}}}]);
  const store = memStore({groupRuns: [{id: 'r1'}], ai: {providers: [{id: 'p1', prices: {m: {input: 3, output: 15, cached: 0.3}}}]}});
  const bot = {id: 'b1', name: 'Scout', instructions: 'Find things.'};
  try {
    const priced = await meterTurn(store, {runId: 'r1'}, () => executeCustomBot(bot, 'hello', cfg(port, {protocol: 'anthropic', providerId: 'p1'})));
    assert.equal(priced.value, 'ok');
    assert.equal(priced.calls.length, 1);
    assert.equal(priced.calls[0].botId, 'b1');
    assert.equal(Number(priced.calls[0].cost.toFixed(4)), 0.0057);
    const unpriced = await meterTurn(store, {runId: 'r1'}, () => executeCustomBot(bot, 'hello', cfg(port, {protocol: 'anthropic', providerId: 'p2'})));
    assert.equal(unpriced.calls[0].cost, undefined, 'no price, no cost');
  } finally { close(); }
  const run = store.state.groupRuns[0].usage;
  assert.equal(run.calls, 2);
  assert.equal(run.input, 2000);
  assert.equal(run.cacheRead, 8000);
  assert.equal(run.unpriced, 1);
  const day = Object.values(store.state.usage.days)[0].b1;
  assert.equal(day.calls, 2);
});

test('which errors fall back: busy, down, timed out, unreachable or signed out yes; a refused request no', () => {
  const err = (extra) => Object.assign(new Error('x'), extra);
  for (const yes of [{providerStatus: 429}, {providerStatus: 500}, {providerStatus: 503}, {timedOut: true}, {network: true}, {providerStatus: 401, code: 'auth'}, {providerStatus: 402, code: 'quota'}, {code: 'usage-limit', status: 429}, {code: 'not-signed-in', status: 422}, {code: 'agent-offline', status: 503}]) assert.equal(fallsBack(err(yes)), true, JSON.stringify(yes));
  for (const no of [{providerStatus: 400}, {status: 422}, {providerStatus: 404, code: 'model-not-found'}, {status: 429}, {}, null]) assert.equal(fallsBack(no && err(no)), false, JSON.stringify(no));
});

/** Run `fn` with AI_RETRY_MS=0 so a model's one retry does not wait. */
async function quick(fn) {
  const prev = process.env.AI_RETRY_MS; process.env.AI_RETRY_MS = '0';
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AI_RETRY_MS; else process.env.AI_RETRY_MS = prev; }
}
const ok = text => ({status: 200, json: {choices: [{message: {content: text}}], usage: {prompt_tokens: 7, completion_tokens: 3}}});
const down = status => ({status, json: {error: {message: 'trouble'}}});
const chat = (port, model, extra) => cfg(port, {protocol: 'openai-chat', model, ...extra});
const closeAll = (...servers) => servers.forEach(s => s.close());

test('the walk goes down the list: own model, then each fallback once, each with its own retry', async () => {
  const own = await stub([down(503)]);
  const f1 = await stub([down(503)]);
  const f2 = await stub([ok('from second')]);
  const store = memStore({groupRuns: []});
  const bot = {id: 'b1', name: 'Scout', instructions: 'Find things.'};
  try {
    await quick(async () => {
      const config = chat(own.port, 'main-model', {fallbacks: [chat(f1.port, 'f1'), chat(f2.port, 'f2')]});
      const out = await meterTurn(store, {}, () => executeCustomBot(bot, 'hi', config));
      assert.equal(out.value, 'from second');
      assert.deepEqual([own.requests.length, f1.requests.length, f2.requests.length], [2, 2, 1]);
      assert.equal(out.calls.length, 1);
      assert.equal(out.calls[0].model, 'f2');
      assert.deepEqual(out.calls[0].fallbackFrom, {model: 'main-model', why: 'the provider is having trouble'});
    });
  } finally { closeAll(own, f1, f2); }
});

test('every model failing rejects with the last model\'s error, and no model is asked twice beyond its own retry', async () => {
  const own = await stub([down(503)]);
  const f1 = await stub([down(503)]);
  const f2 = await stub([down(500)]);
  const spare = await stub([ok('never')]);
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  try {
    await quick(async () => {
      // A fallback's own `fallbacks` is never walked: only the bot's own list is.
      const config = chat(own.port, 'main', {fallbacks: [chat(f1.port, 'f1', {fallbacks: [chat(spare.port, 's')]}), chat(f2.port, 'f2', {fallbacks: [chat(spare.port, 's')]})]});
      await assert.rejects(() => meterTurn(memStore({}), {}, () => executeCustomBot(bot, 'hi', config)), /500/);
      assert.deepEqual([own.requests.length, f1.requests.length, f2.requests.length, spare.requests.length], [2, 2, 1, 0]);
    });
  } finally { closeAll(own, f1, f2, spare); }
});

test('a refused request never moves on', async () => {
  const own = await stub([{status: 400, json: {error: {message: 'content policy'}}}]);
  const backup = await stub([ok('never')]);
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  try {
    await quick(async () => {
      await assert.rejects(() => meterTurn(memStore({}), {}, () => executeCustomBot(bot, 'hi', chat(own.port, 'main', {fallbacks: [chat(backup.port, 'f1')]}))), /400/);
      assert.equal(backup.requests.length, 0);
    });
  } finally { closeAll(own, backup); }
});

test('once the bot has replied in a turn, a later call that fails is not replayed on another model', async () => {
  // The first reply may carry a send block; the turn has acted. A second call failing must not hand the work to
  // another model, or the send could be proposed twice.
  const own = await stub([ok('one'), down(503)]);
  const backup = await stub([ok('never')]);
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(backup.port, 'f1')]});
      await assert.rejects(() => meterTurn(memStore({}), {}, async () => {
        assert.equal(await executeCustomBot(bot, 'one', config), 'one');
        assert.equal(turnNote('b1').acted, true);
        return executeCustomBot(bot, 'two', config);
      }), /503/);
      assert.equal(own.requests.length, 3, 'the second call used its own retry and stopped');
      assert.equal(backup.requests.length, 0);
    });
  } finally { closeAll(own, backup); }
});

test('a turn that moved stays on the model that answered it', async () => {
  const own = await stub([down(503)]);
  const f1 = await stub([ok('first'), ok('second')]);
  const f2 = await stub([ok('never')]);
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(f1.port, 'f1'), chat(f2.port, 'f2')]});
      const out = await meterTurn(memStore({}), {}, async () => {
        const first = await executeCustomBot(bot, 'one', config);
        assert.deepEqual({...turnNote('b1')}, {acted: true, answeredBy: 1, kept: null, why: 'the provider is having trouble'});
        return [first, await executeCustomBot(bot, 'two', config)];
      });
      assert.deepEqual(out.value, ['first', 'second']);
      assert.equal(own.requests.length, 2, 'the second call never went back to the own model');
      assert.equal(f1.requests.length, 2);
      assert.equal(f2.requests.length, 0);
      assert.deepEqual(out.calls.map(c => c.model), ['f1', 'f1']);
      assert.equal(out.calls[1].fallbackFrom.model, 'main');
      assert.deepEqual(fallbacksOf(out.calls), [{botId: 'b1', from: 'main', why: 'the provider is having trouble', to: 'f1'}], 'one notice for the move, not one per later call');
    });
  } finally { closeAll(own, f1, f2); }
});

test('a later call that starts on a fallback and fails does not walk back up or on past a model that has answered', async () => {
  const own = await stub([down(503)]);
  const f1 = await stub([ok('first'), down(503)]);
  const f2 = await stub([ok('never')]);
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(f1.port, 'f1'), chat(f2.port, 'f2')]});
      await assert.rejects(() => meterTurn(memStore({}), {}, async () => { await executeCustomBot(bot, 'one', config); return executeCustomBot(bot, 'two', config); }), /503/);
      assert.equal(f2.requests.length, 0);
    });
  } finally { closeAll(own, f1, f2); }
});

test('outside a turn nothing has acted, and the note is per bot', async () => {
  assert.equal(turnNote('b1'), null);
  const own = await stub([ok('b1 reply'), down(503)]);
  const backup = await stub([ok('b2 from backup')]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(backup.port, 'f1')]});
      await meterTurn(memStore({}), {}, async () => {
        assert.deepEqual({...turnNote('b1')}, {acted: false, answeredBy: 0, kept: null, why: null}, 'made on first use');
        assert.equal(turnNote('b1'), turnNote('b1'), 'one mutable note per bot');
        assert.equal(await executeCustomBot({id: 'b1', name: 'A', instructions: 'x'}, 'hi', config), 'b1 reply');
        // b2 has not acted yet, so b1's reply does not stop b2's own model failing over to its fallback.
        assert.equal(await executeCustomBot({id: 'b2', name: 'B', instructions: 'x'}, 'hi', config), 'b2 from backup');
        assert.deepEqual([turnNote('b1').answeredBy, turnNote('b2').answeredBy], [0, 1]);
        assert.equal(turnNote('b2').acted, true);
      });
      assert.equal(turnNote('b1'), null, 'the note ends with the turn');
    });
  } finally { closeAll(own, backup); }
});

test('a subscription call is recorded as included, with the tokens its CLI reported', async () => {
  const store = memStore({});
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  const config = {kind: 'local-cli', engine: 'claude', model: 'sonnet', providerId: 'cli1', run: async () => ({text: 'from cli', usage: {input: 10, output: 2, cacheRead: 0, cacheWrite: 0}})};
  const out = await meterTurn(store, {}, () => executeCustomBot(bot, 'hi', config));
  assert.equal(out.value, 'from cli');
  assert.equal(out.calls[0].subscription, true);
  assert.equal(out.total.subscription, 1);
  // An older runner that returns only text still works.
  const plain = await meterTurn(store, {}, () => executeCustomBot(bot, 'hi', {...config, run: async () => 'text only'}));
  assert.equal(plain.value, 'text only');
});

test('a run envelope starts with what is the same every turn, and the clock and the objective come after it', async () => {
  const {createEnvelope} = await import('../shared/coordination.js');
  const {STABLE_KEYS} = await import('../src/ai.js');
  const bot = {id: 'b1', name: 'Scout', instructions: 'Find things.', permissions: []};
  const env = n => createEnvelope({run: {id: `r${n}`, groupId: 'home', input: `task ${n}`, recipients: ['b1'], currentStep: 0, now: `2026-11-1${n}T10:00:00Z`}, bot});
  const [a, b] = [env(1), env(2)];
  const keys = Object.keys(a);
  const head = keys.slice(0, keys.findIndex(k => !STABLE_KEYS.includes(k)));
  assert.ok(head.includes('botRole') && head.includes('tools'), `stable head: ${head}`);
  assert.ok(keys.indexOf('now') > keys.indexOf('tools') && keys.indexOf('objective') > keys.indexOf('tools'));
  const pick = e => JSON.stringify(Object.fromEntries(head.map(k => [k, e[k]])));
  assert.equal(pick(a), pick(b), 'the head is byte-identical across turns');
});
