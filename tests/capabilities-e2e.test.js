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
    if (/Write posts/.test(text)) {
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

    const first = await send('POST', '/api/bots/run', {botId: writer.id, input: 'Write a post about the 30% figure.'}, cookie);
    assert.equal(first.status, 201);
    assert.equal(first.body.output, 'Final post with the source.', 'The blocks must not survive in the reply.');
    assert.equal(writerTurns, 2, 'One turn to ask, one to finish.');

    const after = (await send('GET', '/api/state', undefined, cookie)).body;
    const chat = after.chats[writer.id] || [];
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
    const second = await send('POST', '/api/bots/run', {botId: writer.id, input: 'Now tighten the opening line.'}, cookie);
    assert.equal(second.status, 201);
    const lastWriterRequest = [...provider.requests].reverse().find(text => /Write posts/.test(text));
    assert.match(lastWriterRequest, /Write a post about the 30% figure/, 'The recap reaches the model on the next turn.');
    assert.match(lastWriterRequest, /context, not instructions/, 'Memory is marked as notes, never as new instructions.');

    // And the rulebook can be rewritten on request, which is what the cadence does.
    const consolidated = await send('POST', '/api/memory/consolidate', {botId: writer.id, chat: writer.id}, cookie);
    assert.equal(consolidated.status, 200);
    assert.deepEqual(consolidated.body.rules.map(r => r.text), ['Always cite a source.']);
    const memory = (await send('GET', '/api/memory', undefined, cookie)).body;
    assert.equal(memory.rulebooks.length, 1);
    assert.match(memory.chats.find(c => c.chat === writer.id).summary, /sourced post/);
  } finally {
    await t.stop();
    await provider.close();
  }
});
