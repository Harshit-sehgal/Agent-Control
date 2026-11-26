import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {executeCustomBot, coolOffMs, coolKey, clearCoolOff, envConfig} from '../src/ai.js';
import {meterTurn} from '../src/usage.js';

// A provider that hit a limit or an outage rests for a while, then the bot is back on it. Loopback provider
// stubs, and the clock is the mocked Date (the retry and request timers stay real, none is unref'd).

beforeEach(() => clearCoolOff());

/** A provider that answers each request with the next reply (the last repeats); a reply may carry `headers`. */
async function stub(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push(req.url);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(reply.status, {'Content-Type': 'application/json', ...(reply.headers || {})});
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}
const chat = (port, model, extra) => ({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key-123456', protocol: 'openai-chat', model, ...extra});
const ok = text => ({status: 200, json: {choices: [{message: {content: text}}], usage: {prompt_tokens: 7, completion_tokens: 3}}});
const fail = (status, headers) => ({status, headers, json: {error: {message: 'trouble'}}});
const memStore = (state = {}) => ({read: () => state, update: async fn => fn(state), state});
const bot = {id: 'b1', name: 'Scout', instructions: 'Find things.'};
/** One bot turn: its own model, then its fallbacks. */
const turn = config => meterTurn(memStore({}), {}, () => executeCustomBot(bot, 'hi', config));
async function quick(fn) {
  const prev = process.env.AI_RETRY_MS; process.env.AI_RETRY_MS = '0';
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AI_RETRY_MS; else process.env.AI_RETRY_MS = prev; }
}
const closeAll = (...servers) => servers.forEach(s => s.close());

test('how long a provider rests: its Retry-After, else 5 minutes, at most an hour, and none for a refused key', () => {
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: '120'}), 120000);
  assert.equal(coolOffMs({providerStatus: 503}), 300000);
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: '86400'}), 3600000);
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: new Date(Date.now() + 60000).toUTCString()}) > 50000, true);
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: new Date(Date.now() - 60000).toUTCString()}), 0, 'a date already past is no rest, never below 0');
  assert.equal(coolOffMs({providerStatus: 503, retryAfter: 'soon'}), 300000, 'a Retry-After that cannot be read is the 5 minutes');
  for (const rests of [{providerStatus: 429}, {providerStatus: 402}, {providerStatus: 500}, {providerStatus: 408}, {code: 'quota'}, {code: 'usage-limit'}, {code: 'agent-offline'}, {timedOut: true}, {network: true}]) assert.equal(coolOffMs(rests), 300000, JSON.stringify(rests));
  for (const e of [{providerStatus: 401}, {providerStatus: 403}, {code: 'not-signed-in'}, {code: 'cli-missing'}, {providerStatus: 400}, {providerStatus: 404, code: 'model-not-found'}, {status: 429}, {}, null]) assert.equal(coolOffMs(e), null, JSON.stringify(e));
  assert.deepEqual([coolKey({providerId: 'p1'}), coolKey({kind: 'local-cli', engine: 'claude'}), coolKey({baseUrl: 'https://x/v1'}), coolKey({kind: 'local-cli', engine: 'codex', providerId: 'p2'})], ['p1', 'cli:claude', 'env:https://x/v1', 'p2']);
});

test('a rate-limited model is skipped until its cool-off ends, then the next turn is back on it', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1.7e12});
  const own = await stub([fail(429, {'Retry-After': '120'}), ok('own again')]);
  const spare = await stub([ok('from spare')]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(spare.port, 'f1')]});
      const one = await turn(config);
      assert.equal(one.value, 'from spare');
      assert.deepEqual([own.requests.length, spare.requests.length], [1, 1]);
      const two = await turn(config);
      assert.equal(two.value, 'from spare');
      assert.deepEqual([own.requests.length, spare.requests.length], [1, 2], 'the resting model is not asked');
      assert.deepEqual(two.calls[0].fallbackFrom, {model: 'main', why: 'rate limited'}, 'the reason stored with the rest');
      t.mock.timers.tick(119000);
      assert.equal((await turn(config)).value, 'from spare', 'still resting just before it ends');
      t.mock.timers.tick(2000);
      const three = await turn(config);
      assert.equal(three.value, 'own again');
      assert.equal(three.calls[0].fallbackFrom, undefined);
      assert.equal((await turn(config)).value, 'own again');
      assert.deepEqual([own.requests.length, spare.requests.length], [3, 3]);
    });
  } finally { closeAll(own, spare); }
});

test('when every model is resting the bot\'s own is tried, and a success clears its rest', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1.7e12});
  const own = await stub([fail(503, {'Retry-After': '3000'}), ok('own is back')]);
  const spare = await stub([fail(503)]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(spare.port, 'f1')]});
      // Both fail: both rest (own for 50 minutes, the spare for the 5 default).
      await assert.rejects(() => turn(config), /503/);
      assert.deepEqual([own.requests.length, spare.requests.length], [1, 2], 'a Retry-After of 50 minutes is not waited for; the spare retries once');
      // Every model is resting: the own one is asked once more, anyway, and answers.
      const back = await turn(config);
      assert.equal(back.value, 'own is back');
      assert.deepEqual([own.requests.length, spare.requests.length], [2, 2]);
      // Its success cleared the rest: with the spare's rest over, the own model is still first. (Had its 50 minutes stood, the spare would answer.)
      t.mock.timers.tick(301000);
      spare.requests.length = 0;
      assert.equal((await turn(config)).value, 'own is back');
      assert.equal(spare.requests.length, 0);
    });
  } finally { closeAll(own, spare); }
});

test('clearCoolOff is a restart: the own model is asked first again at once', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1.7e12});
  const own = await stub([fail(503), fail(503), ok('own')]);
  const spare = await stub([ok('from spare')]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(spare.port, 'f1')]});
      assert.equal((await turn(config)).value, 'from spare');
      const before = own.requests.length;
      assert.equal((await turn(config)).value, 'from spare');
      assert.equal(own.requests.length, before, 'resting');
      clearCoolOff();
      assert.equal((await turn(config)).value, 'own');
      assert.equal(own.requests.length, before + 1);
    });
  } finally { closeAll(own, spare); }
});

test('a refused key moves the walk on but sets no cool-off', async () => {
  const own = await stub([fail(401), ok('own')]);
  const spare = await stub([ok('from spare')]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(spare.port, 'f1')]});
      const one = await turn(config);
      assert.equal(one.value, 'from spare');
      assert.equal(one.calls[0].fallbackFrom.why, 'the key was rejected');
      assert.equal((await turn(config)).value, 'own', 'the own model is tried first again');
      assert.equal(own.requests.length, 2);
    });
  } finally { closeAll(own, spare); }
});

test('a model resting in the middle of the list is stepped over', async () => {
  const own = await stub([fail(503)]);
  const mid = await stub([fail(503)]);
  const last = await stub([ok('from last')]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(mid.port, 'f1'), chat(last.port, 'f2')]});
      assert.equal((await turn(config)).value, 'from last');
      assert.deepEqual([own.requests.length, mid.requests.length, last.requests.length], [2, 2, 1]);
      assert.equal((await turn(config)).value, 'from last');
      assert.deepEqual([own.requests.length, mid.requests.length, last.requests.length], [2, 2, 2], 'both resting models are stepped over');
    });
  } finally { closeAll(own, mid, last); }
});

test('a resting model is never asked while the own model is the one that failed: the own error is thrown', async () => {
  const a = await stub([fail(503)]), mid = await stub([ok('never')]), last = await stub([fail(503)]);
  const own = await stub([fail(401)]), free = await stub([fail(503)]), rested = await stub([fail(503, {'Retry-After': '3600'}), ok('never')]);
  try {
    await quick(async () => {
      // Make the spares rest through another bot's list.
      await assert.rejects(() => turn(chat(a.port, 'a', {fallbacks: [chat(rested.port, 'f1')]})), /503/);
      assert.equal(rested.requests.length, 1);
      // Own is free and f1 rests: own's 503 is thrown, and f1 (resting) is not touched, nor retried.
      await assert.rejects(() => turn(chat(free.port, 'main', {fallbacks: [chat(rested.port, 'f1')]})), /503/);
      assert.equal(rested.requests.length, 1, 'a resting spare is not asked');
      assert.equal(free.requests.length, 2, 'the own model had its own retry');
      // A refused own key (no rest) with every spare resting: the 401 is thrown, no spare is asked.
      await assert.rejects(() => turn(chat(own.port, 'main', {fallbacks: [chat(rested.port, 'f1')]})), /401/);
      assert.equal(rested.requests.length, 1);
      assert.equal(mid.requests.length + last.requests.length, 0);
    });
  } finally { closeAll(a, mid, last, own, free, rested); }
});

test('when every model is resting only the own one is tried, and its error is the one thrown', async () => {
  const own = await stub([fail(503), fail(503), fail(503), fail(503)]), f1 = await stub([fail(503)]), f2 = await stub([fail(500)]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(f1.port, 'f1'), chat(f2.port, 'f2')]});
      await assert.rejects(() => turn(config), /500/, 'the first turn walks them all, so all rest, and the last error is the third\'s');
      assert.deepEqual([own.requests.length, f1.requests.length, f2.requests.length], [2, 2, 1]);
      await assert.rejects(() => turn(config), /503/, 'then only the own model is asked, with its own retry, and its own error is thrown');
      assert.deepEqual([own.requests.length, f1.requests.length, f2.requests.length], [4, 2, 1]);
    });
  } finally { closeAll(own, f1, f2); }
});

test('a cool-off never holds a turn that has acted: its later calls stay on the model that answered, even once it rests', async () => {
  const own = await stub([fail(503)]);
  // Call 1 answers; the other bot's two requests (its call and its one retry) fail and so rest this spare; call 2 answers.
  const spare = await stub([ok('one'), fail(503), fail(503), ok('two')]);
  try {
    await quick(async () => {
      const config = chat(own.port, 'main', {fallbacks: [chat(spare.port, 'f1')]});
      const out = await meterTurn(memStore({}), {}, async () => {
        const first = await executeCustomBot(bot, 'one', config);
        // From outside this bot's turn work: another bot's call puts the model that answered into its rest.
        await assert.rejects(() => executeCustomBot({id: 'b2', name: 'Other', instructions: 'x'}, 'hi', chat(spare.port, 'f1')), /503/);
        assert.deepEqual(own.requests.length, 2, 'the own model was asked for call 1 only');
        return [first, await executeCustomBot(bot, 'two', config)];
      });
      assert.deepEqual(out.value, ['one', 'two'], 'call 2 still went to the resting model that answered');
      assert.equal(own.requests.length, 2, 'and the own model was not asked again for it');
      assert.equal(spare.requests.length, 4);
    });
  } finally { closeAll(own, spare); }
});

/** One provider server that answers by the model named in the request body: `byModel[model]` is the reply list for it. */
async function modelStub(byModel) {
  const seen = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const model = JSON.parse(body).model;
      (seen[model] ||= []).push(model);
      const replies = byModel[model] || [fail(404)];
      const reply = replies[Math.min(seen[model].length - 1, replies.length - 1)];
      res.writeHead(reply.status, {'Content-Type': 'application/json', ...(reply.headers || {})});
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {seen, count: m => (seen[m] || []).length, port: server.address().port, close: () => server.close()};
}
const saved = (port, model, extra) => chat(port, model, {providerId: 'prov-one', ...extra});

test('a model that hit a rate limit rests alone: a fallback on the same provider is still asked, and the own model comes back', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1.7e12});
  const p = await modelStub({big: [fail(429, {'Retry-After': '120'}), ok('big again')], small: [ok('from small')]});
  try {
    await quick(async () => {
      const config = saved(p.port, 'big', {fallbacks: [saved(p.port, 'small')]});
      assert.equal((await turn(config)).value, 'from small', 'the same-provider spare answers the own 429');
      assert.equal((await turn(config)).value, 'from small');
      assert.deepEqual([p.count('big'), p.count('small')], [1, 2], 'the resting model is skipped, the spare is asked');
      t.mock.timers.tick(121000);
      assert.equal((await turn(config)).value, 'big again', 'after the rest the own model is back');
      assert.deepEqual([p.count('big'), p.count('small')], [2, 2]);
    });
  } finally { p.close(); }
});

test('a quota or credit limit rests the whole provider: its other models are not asked', async () => {
  const p = await modelStub({big: [{status: 402, json: {error: {message: 'out of credit'}}}], small: [ok('never')]});
  try {
    await quick(async () => {
      const config = saved(p.port, 'big', {fallbacks: [saved(p.port, 'small')]});
      await assert.rejects(() => turn(config), /out of credit|402/);
      assert.equal(p.count('small'), 0, 'the same account has no credit for the spare either');
      // A second turn: every model rests, so the own one is asked anyway and the spare stays untouched.
      await assert.rejects(() => turn(config), /out of credit|402/);
      assert.deepEqual([p.count('big'), p.count('small')], [2, 0]);
    });
  } finally { p.close(); }
});

test('a success clears the model\'s own rest and the provider-wide one', async () => {
  const p = await modelStub({big: [{status: 402, json: {error: {message: 'out of credit'}}}, ok('big paid up')], small: [ok('small answers')]});
  const x = await stub([ok('from x')]);
  try {
    await quick(async () => {
      const bigFirst = saved(p.port, 'big', {fallbacks: [saved(p.port, 'small')]});
      const smallFirst = saved(p.port, 'small', {fallbacks: [chat(x.port, 'x')]});
      await assert.rejects(() => turn(bigFirst), /out of credit|402/);
      assert.equal((await turn(smallFirst)).value, 'from x', 'the provider rests, so its small model is stepped over');
      assert.equal((await turn(bigFirst)).value, 'big paid up', 'every model of this bot rests, so the own one is asked, and it answers');
      assert.equal((await turn(smallFirst)).value, 'small answers', 'big\'s success ended the provider\'s rest');
    });
  } finally { p.close(); x.close(); }
});

test('coolKey of no config is the environment provider\'s key, the same as envConfig()', () => {
  assert.equal(coolKey(null), coolKey(envConfig()));
  assert.equal(coolKey(undefined), coolKey(envConfig()));
});

test('a subscription CLI failure rests the whole CLI, whatever model it was run with', async () => {
  const asked = [];
  const cli = model => ({kind: 'local-cli', engine: 'claude', model, run: async () => { asked.push(model); throw Object.assign(new Error('limit reached'), {code: 'usage-limit'}); }});
  const spare = await stub([ok('from spare')]);
  try {
    await quick(async () => {
      assert.equal((await turn({...cli('opus'), fallbacks: [chat(spare.port, 'f1')]})).value, 'from spare');
      assert.equal((await turn({...cli('sonnet'), fallbacks: [chat(spare.port, 'f1')]})).value, 'from spare');
      assert.deepEqual(asked, ['opus'], 'the other model of the same CLI is stepped over');
    });
  } finally { spare.close(); }
});
