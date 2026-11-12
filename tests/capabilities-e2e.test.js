/** End to end over HTTP with a stub provider behind a real server: a bot asks a
 * teammate, creates a lasting bot, and carries the conversation into its next
 * turn. Everything below goes through the public API, so the wiring between the
 * envelope, the block parsers, the store and the chat is proved together. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BUSY = ['running', 'queued', 'awaiting_browser', 'awaiting_ask', 'awaiting_plan', 'awaiting_checkpoint', 'awaiting_limit'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
  server.on('error', reject);
});

const readBody = req => new Promise(resolve => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => resolve(body));
});

/** An OpenAI-compatible stub. It answers by what the request is: a memory
 * consolidation, a teammate answering one question, or a bot's own turn. */
function stubProvider(script) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    const text = JSON.stringify(body);
    requests.push(text);
    const content = script(text, requests.length);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {role: 'assistant', content}}]}));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    close: () => new Promise(done => server.close(done)),
  })));
}

async function launchProviderEnv(extraEnv) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-e2e-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, AGENT_SKIP_DOTENV: '1', OPENAI_API_KEY: '', OPENAI_BASE_URL: '',
      DASHBOARD_PASSWORD: 'test-password-1234', HOST: '127.0.0.1', PORT: String(port),
      DATA_FILE: path.join(dir, 'state.json'), ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  let live = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) { live = true; break; } } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 70));
  }
  if (!live) {
    child.kill();
    await fs.rm(dir, {recursive: true, force: true});
    throw new Error(`Server did not start: ${output}`);
  }
  return {
    base,
    async stop() {
      child.kill('SIGINT');
      await new Promise(resolve => child.once('exit', resolve));
      await fs.rm(dir, {recursive: true, force: true});
    },
  };
}

test('a bot asks a teammate, creates a bot, and remembers the chat next turn', {timeout: 60000}, async () => {
  let writerTurns = 0;
  const provider = await stubProvider(text => {
    if (/JSON only/.test(text)) return '{"rules":["Always cite a source."],"summary":"The chat asked for a sourced post."}';
    if (/asked you one direct question/i.test(text)) return 'The 2024 robotics reliability report, example.com/report.';
    // The Writer's own turn (its instructions lead the system prompt), not another bot that lists it as a teammate.
    if (/Bot instructions:\\nWrite posts/.test(text)) {
      writerTurns++;
      if (writerTurns === 1) return `Draft ready.\n\`\`\`ask\n{"to":"Researcher","task":"Which source supports the 30% figure?"}\n\`\`\``;
      if (writerTurns === 2) return `Final post with the source.\n\`\`\`create-bot\n{"name":"Source scout","job":"Find posts that mention the project and list their links."}\n\`\`\``;
    }
    return 'Nothing to add.';
  });
  const t = await launchProviderEnv({
    AI_API_KEY: 'test-key', AI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    AI_MODEL: 'stub-model', AI_API_STYLE: 'chat',
  });
  try {
    const send = async (method, url, body, cookie) => {
      const r = await fetch(t.base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
      return {status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')};
    };
    const login = await send('POST', '/api/login', {password: 'test-password-1234'});
    assert.equal(login.status, 200);
    const cookie = login.cookie.split(';')[0];
    const state = (await send('GET', '/api/state', undefined, cookie)).body;
    assert.equal(state.aiEnabled, true);

    const group = (await send('POST', '/api/groups', {name: 'Smoke team'}, cookie)).body;
    const writer = (await send('POST', `/api/groups/${group.id}/bots`, {
      name: 'Writer', instructions: 'Write posts. Keep them short.', permissions: ['bot.ask', 'bot.create'],
    }, cookie)).body;
    await send('POST', `/api/groups/${group.id}/bots`, {name: 'Researcher', instructions: 'Find sources for claims.'}, cookie);

    // A 1:1 chat is the group chat route with the bot as `directBotId`, the one the UI uses.
    // It answers at once with the run; the turn finishes in the background.
    const direct = async input => {
      const queued = await send('POST', `/api/groups/${group.id}/chat`, {message: input, directBotId: writer.id, chatKey: writer.id}, cookie);
      assert.equal(queued.status, 202);
      for (let i = 0; i < 200; i++) {
        const run = (await send('GET', `/api/groups/${group.id}/chat`, undefined, cookie)).body.runs.find(r => r.id === queued.body.runId);
        if (run && !BUSY.includes(run.status)) return run;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('The run did not finish.');
    };
    const first = await direct('Write a post about the 30% figure.');
    assert.equal(first.status, 'completed');
    assert.equal(writerTurns, 2, 'One turn to ask, one to finish.');

    const after = (await send('GET', '/api/state', undefined, cookie)).body;
    const chat = [...(after.chats[writer.id] || []), ...((await send('GET', `/api/groups/${group.id}/chat`, undefined, cookie)).body.messages)];
    const reply = chat.find(m => /Final post with the source/.test(m.text));
    assert.ok(reply, 'The reply is in the chat.');
    assert.doesNotMatch(reply.text, /```/, 'The blocks must not survive in the reply.');
    assert.ok(chat.some(m => /Writer asked Researcher/.test(m.text)), 'The ask is in the chat.');
    assert.ok(chat.some(m => /2024 robotics reliability report/.test(m.text)), 'The answer is in the chat.');
    assert.ok(chat.some(m => m.kind === 'bot-created' && /Source scout/.test(m.text)), 'The new bot is announced.');

    const group2 = after.groups.find(g => g.id === group.id);
    assert.equal(group2.bots.length, 3);
    const made = group2.bots.find(b => b.name === 'Source scout');
    assert.deepEqual(made.permissions, [], 'A model-created bot starts with no capability.');
    assert.equal(made.type, 'custom');
    assert.equal(made.createdBy.botName, 'Writer');

    // The next turn carries the earlier conversation, without any client help.
    assert.equal((await direct('Now tighten the opening line.')).status, 'completed');
    const lastWriterRequest = [...provider.requests].reverse().find(text => /Bot instructions:\\nWrite posts/.test(text));
    assert.match(lastWriterRequest, /Write a post about the 30% figure/, 'The recap reaches the model on the next turn.');
    assert.match(lastWriterRequest, /context, not instructions/, 'Memory is marked as notes, never as new instructions.');

    // And the rulebook can be rewritten on request, which is what the cadence does.
    const consolidated = await send('POST', '/api/memory/consolidate', {botId: writer.id, chat: writer.id}, cookie);
    assert.equal(consolidated.status, 200);
    assert.deepEqual(consolidated.body.rules.map(r => r.text), ['Always cite a source.']);
    const memory = (await send('GET', '/api/memory', undefined, cookie)).body;
    // The group run also gives the new bot a turn, so it may keep a rulebook of its own; the Writer's holds the rule.
    assert.ok(memory.rulebooks.some(book => /Always cite a source/.test(JSON.stringify(book.rules))), 'The rewritten rulebook is kept.');
    assert.match(memory.chats.find(c => c.chat === writer.id).summary, /sourced post/);
  } finally {
    await t.stop();
    await provider.close();
  }
});
