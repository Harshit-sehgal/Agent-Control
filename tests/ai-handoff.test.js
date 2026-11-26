import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {executeCustomBot, handoffInput, keptLines, boundBotInput, clearCoolOff} from '../src/ai.js';
import {meterTurn, turnNote} from '../src/usage.js';

// A call answered by a model other than the bot's own is sent a prompt rebuilt for the handoff. Pure cut rules
// first, then the real wire bodies of loopback providers.

beforeEach(() => clearCoolOff());

async function stub(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      requests.push({url: req.url, body: body ? JSON.parse(body) : null});
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(reply.status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}
const ok = text => ({status: 200, json: {choices: [{message: {content: text}}], usage: {prompt_tokens: 7, completion_tokens: 3}}});
const okAnthropic = text => ({status: 200, json: {content: [{type: 'text', text}], usage: {input_tokens: 7, output_tokens: 3}}});
const down = status => ({status, json: {error: {message: 'trouble'}}});
const cfg = (port, model, extra) => ({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key-123456', model, protocol: 'openai-chat', ...extra});
const memStore = (state = {}) => ({read: () => state, update: async fn => fn(state), state});
async function quick(fn) {
  const prev = process.env.AI_RETRY_MS; process.env.AI_RETRY_MS = '0';
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AI_RETRY_MS; else process.env.AI_RETRY_MS = prev; }
}
const thread = n => Array.from({length: n}, (_, i) => ({from: 'user', text: `line ${i} ` + 'x'.repeat(700)}));
const userContentOf = req => req.body.messages.find(m => m.role === 'user').content;

test('a handoff keeps the job, says which model and why, offers search_chat, and keeps the newest lines that fit', () => {
  const env = {objective: 'o', contract: 'c', botRole: 'r', thread: thread(30), tools: {browser: 'b'}};
  const out = JSON.parse(handoffInput(JSON.stringify(env), {from: 'main', to: 'spare', why: 'rate limited'}, 12000));
  assert.deepEqual(out.handoff, {from: 'main', to: 'spare', why: 'rate limited'});
  assert.match(out.tools.search_chat, /search_chat block/); assert.equal(out.tools.browser, 'b');
  assert.equal(out.thread.at(-1).text.startsWith('line 29'), true, 'the newest line is kept');
  assert.ok(out.thread.length < 30 && JSON.stringify(out).length <= 12000);
  assert.deepEqual(Object.keys(out).slice(0, 4), ['objective', 'contract', 'botRole', 'thread'], 'the existing keys keep their order');
  assert.equal(Object.keys(out).at(-1), 'handoff', 'handoff comes after the existing keys');
  // The kept lines are the newest ones, in order, with no gap.
  const first = Number(out.thread[0].text.match(/^line (\d+)/)[1]);
  assert.deepEqual(out.thread.map(m => Number(m.text.match(/^line (\d+)/)[1])), Array.from({length: 30 - first}, (_, i) => first + i));
});

test('the thread is cut to the lines that fit, not the four boundBotInput would leave', () => {
  const env = {objective: 'o', thread: thread(30)};
  const out = JSON.parse(handoffInput(JSON.stringify(env), {from: 'a', to: 'b', why: ''}, 12000));
  assert.ok(out.thread.length > 4, `kept ${out.thread.length}`);
  assert.ok(out.thread.every(m => m.text.length > 700), 'no line is shortened');
  assert.equal(keptLines(JSON.stringify(out)), out.thread.length);
});

test('a short thread is kept whole, and an envelope with no tools gets just the search tool', () => {
  const env = {objective: 'o', thread: thread(2)};
  const out = JSON.parse(handoffInput(JSON.stringify(env), {from: 'a', to: 'b', why: 'x'}));
  assert.equal(out.thread.length, 2);
  assert.deepEqual(Object.keys(out.tools), ['search_chat']);
});

test('input that is not a JSON envelope comes back as boundBotInput gives it', () => {
  for (const input of ['hello there', '[1,2]', '"x"', 'z'.repeat(200)]) {
    assert.equal(handoffInput(input, {from: 'a', to: 'b', why: 'x'}, 100), boundBotInput(input, 100));
  }
  assert.equal(keptLines('hello there'), null);
  assert.equal(keptLines(JSON.stringify({objective: 'o'})), 0);
  assert.equal(keptLines(JSON.stringify({thread: thread(3)}) + '\n\nfile text'), 3, 'text after the envelope is not part of it');
});

test('a thread too big for any line leaves none, and the job is still whole', () => {
  const env = {objective: 'o', botRole: 'r', thread: [{from: 'user', text: 'y'.repeat(5000)}]};
  const out = JSON.parse(handoffInput(JSON.stringify(env), {from: 'a', to: 'b', why: 'x'}, 1500));
  assert.deepEqual(out.thread, []);
  assert.equal(out.objective, 'o');
});

test('the fallback model is sent the handoff prompt and the bot\'s own model the usual one', async () => {
  const bot = {id: 'b1', name: 'Scout', instructions: 'Find things.'};
  const env = JSON.stringify({botId: 'b1', objective: 'o', thread: thread(100), tools: {browser: 'b'}});
  const own = await stub([down(503), down(503), ok('own again')]);
  const spare = await stub([ok('from spare')]);
  try {
    await quick(async () => {
      const config = cfg(own.port, 'main', {fallbacks: [cfg(spare.port, 'spare')]});
      const first = await meterTurn(memStore({}), {}, async () => {
        const text = await executeCustomBot(bot, env, config);
        const note = turnNote('b1');
        const sent = JSON.parse(userContentOf(spare.requests[0]));
        assert.deepEqual(sent.handoff, {from: 'main', to: 'spare', why: 'the provider is having trouble'});
        assert.match(sent.tools.search_chat, /search_chat block/);
        assert.equal(sent.tools.browser, 'b');
        assert.equal(note.kept, sent.thread.length, 'the note says how many lines the model was given');
        assert.ok(note.kept > 4 && note.kept < 100, `kept ${note.kept}`);
        assert.equal(sent.thread.at(-1).text.startsWith('line 99'), true);
        return text;
      });
      assert.equal(first.value, 'from spare');
      const ownBody = JSON.parse(userContentOf(own.requests[0]));
      assert.equal(ownBody.handoff, undefined, 'the own model was asked first with the usual prompt');
      assert.equal(ownBody.tools.search_chat, undefined);
      assert.deepEqual(ownBody, JSON.parse(boundBotInput(env)), 'the own model is given what it always was');
      // A later turn answered by the own model has neither.
      clearCoolOff();
      const second = await meterTurn(memStore({}), {}, async () => {
        const text = await executeCustomBot(bot, env, config);
        assert.equal(turnNote('b1').kept, null);
        return text;
      });
      assert.equal(second.value, 'own again');
      const last = JSON.parse(userContentOf(own.requests.at(-1)));
      assert.equal(last.handoff, undefined);
      assert.equal(last.tools.search_chat, undefined);
      assert.equal(spare.requests.length, 1);
    });
  } finally { own.close(); spare.close(); }
});

test('a later call in a moved turn is handed over the same way, with the same words', async () => {
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  const env = JSON.stringify({botId: 'b1', objective: 'o', thread: thread(3)});
  const own = await stub([down(429)]);
  const spare = await stub([ok('one'), ok('two')]);
  try {
    await quick(async () => {
      const config = cfg(own.port, 'main', {fallbacks: [cfg(spare.port, 'spare')]});
      const out = await meterTurn(memStore({}), {}, async () => [await executeCustomBot(bot, env, config), await executeCustomBot(bot, env, config)]);
      assert.deepEqual(out.value, ['one', 'two']);
      const [a, b] = spare.requests.map(r => JSON.parse(userContentOf(r)).handoff);
      assert.deepEqual(a, {from: 'main', to: 'spare', why: 'rate limited'});
      assert.deepEqual(b, a);
    });
  } finally { own.close(); spare.close(); }
});

test('text after the envelope (an attached file) still follows the handoff envelope', async () => {
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  const env = JSON.stringify({botId: 'b1', objective: 'o', thread: [{from: 'user', text: 'see file', files: [{id: 'file-0001', name: 'a.txt', type: 'text/plain', size: 5}]}]});
  const own = await stub([down(503)]);
  const spare = await stub([ok('seen')]);
  try {
    await quick(async () => {
      const config = cfg(own.port, 'main', {fallbacks: [cfg(spare.port, 'spare')]});
      const readFile = () => ({name: 'a.txt', type: 'text/plain', data: Buffer.from('hello file')});
      const out = await meterTurn(memStore({}), {}, async () => {
        const text = await executeCustomBot(bot, env, config, {readFile});
        assert.equal(turnNote('b1').kept, 1);
        return text;
      });
      assert.equal(out.value, 'seen');
      const sent = userContentOf(spare.requests[0]);
      const [json, ...rest] = sent.split('\n\n');
      assert.equal(JSON.parse(json).handoff.to, 'spare');
      assert.match(rest.join('\n\n'), /hello file/);
    });
  } finally { own.close(); spare.close(); }
});

test('an Anthropic fallback keeps its cache breakpoints, with handoff after the stable keys', async () => {
  const bot = {id: 'b1', name: 'Scout', instructions: 'x'};
  const env = JSON.stringify({botId: 'b1', botRole: 'Researcher', tools: {browser: 'x'.repeat(3000)}, objective: 'o', now: {iso: '2026-11-27'}, thread: thread(3)});
  const own = await stub([down(503)]);
  const spare = await stub([okAnthropic('from claude')]);
  try {
    await quick(async () => {
      const config = cfg(own.port, 'main', {fallbacks: [cfg(spare.port, 'claude', {protocol: 'anthropic'})]});
      const out = await meterTurn(memStore({}), {}, () => executeCustomBot(bot, env, config));
      assert.equal(out.value, 'from claude');
      const body = spare.requests[0].body;
      assert.deepEqual(body.system.map(b => !!b.cache_control), [true]);
      const content = body.messages[0].content;
      assert.equal(content.length, 2);
      assert.deepEqual(content[0].cache_control, {type: 'ephemeral'});
      assert.equal(content[1].cache_control, undefined);
      assert.deepEqual(Object.keys(JSON.parse(content[0].text)), ['botId', 'botRole', 'tools'], 'the stable head holds only the stable keys');
      assert.match(JSON.parse(content[0].text).tools.search_chat, /search_chat block/);
      const rest = Object.keys(JSON.parse(content[1].text));
      assert.deepEqual(rest, ['objective', 'now', 'thread', 'handoff'], 'handoff follows the per-turn keys');
      assert.equal(JSON.stringify(body).match(/cache_control/g).length, 2, 'two breakpoints: system and the stable head');
    });
  } finally { own.close(); spare.close(); }
});
