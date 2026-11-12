/** The hand-written MCP client over streamable HTTP (Phase 6, Task 1).
 *
 * Against a fake local server that can answer as JSON or as an event stream and
 * can misbehave: answer forever, answer with a huge body, hang, refuse, echo a
 * secret, redirect. Whatever it does, the call ends, the app keeps running and a
 * header value never appears in an error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mcpList, mcpCall, checkMcpUrl} from '../src/mcp-client.js';
import {MAX_RESULT_CHARS, MAX_TOOLS} from '../shared/mcp-protocol.js';
import {fakeMcpHttp, TOOLS} from './mcp-fixture.js';

const SECRET = 'Bearer SECRET-TOKEN-1234567890';
const serve = async (t, options) => { const server = await fakeMcpHttp(options); t.after(() => server.close()); return server; };
const target = (server, extra = {}) => ({transport: 'http', url: server.url, headers: {Authorization: SECRET}, ...extra});

test('the handshake runs in order: initialize, initialized, tools/list; the headers the spec asks for are sent', async t => {
  const server = await serve(t);
  const {tools} = await mcpList(target(server));
  assert.deepEqual(server.calls.map(c => c.message?.method), ['initialize', 'notifications/initialized', 'tools/list']);
  const [init, ready, list] = server.calls;
  assert.match(init.headers.accept, /application\/json/);
  assert.match(init.headers.accept, /text\/event-stream/);
  assert.equal(init.headers.authorization, SECRET, 'the owner\'s header goes to the server');
  assert.equal(init.headers['mcp-protocol-version'], undefined, 'not before the server has agreed on one');
  assert.equal(ready.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(list.headers['mcp-protocol-version'], '2025-06-18');
  assert.deepEqual(tools.map(x => [x.name, x.write]), [['search_notes', false], ['add_note', true], ['wipe_notes', true], ['ping', true]]);
  assert.ok(tools.every(x => !('annotations' in x) && !('inputSchema' in x)), 'only what a bot needs');
});

test('a server that hands out a session id gets it back on every later message', async t => {
  const server = await serve(t, {mode: 'session'});
  await mcpList(target(server));
  const later = server.calls.slice(1).filter(c => c.method === 'POST');
  assert.ok(later.length >= 2);
  for (const call of later) assert.equal(call.headers['mcp-session-id'], 's-1');
});

test('an answer sent as an event stream is read, past keepalives and notifications', async t => {
  const server = await serve(t, {mode: 'sse'});
  assert.equal((await mcpList(target(server))).tools.length, TOOLS.length);
  const result = await mcpCall(target(server), 'ping', {a: 1});
  assert.equal(result.ok, true);
  assert.match(result.text, /ping ran with \{"a":1\}/);
});

test('a tool list that comes in pages is read to the end and capped', async t => {
  const server = await serve(t, {mode: 'paged', pageSize: 2});
  assert.equal((await mcpList(target(server))).tools.length, TOOLS.length);
  const many = await serve(t, {mode: 'paged', pageSize: 50, tools: Array.from({length: 400}, (_, i) => ({name: `t${i}`}))});
  assert.equal((await mcpList(target(many))).tools.length, MAX_TOOLS);
});

test('a call returns text; a tool error is a result, a protocol error is thrown', async t => {
  const server = await serve(t);
  const ok = await mcpCall(target(server), 'add_note', {text: 'hi'});
  assert.deepEqual([ok.ok, ok.text], [true, 'add_note ran with {"text":"hi"}\n[image omitted]']);
  assert.deepEqual(await mcpCall(target(server), 'boom', {}), {ok: false, text: 'It broke.'});
  await assert.rejects(mcpCall(target(server), 'missing', {}), /Unknown tool: missing/);
});

test('a result is cut to the cap and says so', async t => {
  const server = await serve(t, {mode: 'huge'});
  const result = await mcpCall(target(server), 'anything', {}, {maxBytes: 4 * 1024 * 1024});
  assert.ok(result.text.length <= MAX_RESULT_CHARS + 80);
  assert.match(result.text, /\[cut:/);
});

test('a server that answers forever is stopped at the time limit, and the app and the server carry on', async t => {
  const server = await serve(t, {mode: 'endless'});
  const started = Date.now();
  await assert.rejects(mcpList(target(server), {timeoutMs: 300}), /did not answer in time|timed out/i);
  assert.ok(Date.now() - started < 3000);
  const fine = await serve(t);
  assert.equal((await mcpList(target(fine))).tools.length, TOOLS.length, 'the next call works');
});

test('a body that never ends is stopped at the size cap, long before the time limit', async t => {
  const server = await serve(t, {mode: 'huge'});
  const started = Date.now();
  await assert.rejects(mcpList(target(server), {maxBytes: 200000, timeoutMs: 20000}), /too large/i);
  assert.ok(Date.now() - started < 5000, 'the cap stops it, not the clock');
});

test('a server that never answers times out', async t => {
  const server = await serve(t, {mode: 'slow'});
  await assert.rejects(mcpCall(target(server), 'ping', {}, {timeoutMs: 300}), /did not answer in time/i);
});

test('a refusal says so without the header, and a server that echoes the header cannot get it into an error', async t => {
  const refuse = await serve(t, {mode: 'refuse'});
  await assert.rejects(mcpList(target(refuse)), error => /refused/i.test(error.message) && !error.message.includes('SECRET-TOKEN'));
  const echo = await serve(t, {mode: 'echo'});
  await assert.rejects(mcpList(target(echo)), error => /500/.test(error.message) && !error.message.includes('SECRET-TOKEN') && /\[redacted\]/.test(error.message));
});

test('a redirect is not followed', async t => {
  const server = await serve(t, {mode: 'redirect'});
  await assert.rejects(mcpList(target(server)), /redirect/i);
  assert.equal(server.calls.length, 1, 'nothing was sent anywhere else');
});

test('the address is checked: http or https, no password in it, no fragment', () => {
  assert.equal(checkMcpUrl('https://mcp.example.com/path?key=abc'), 'https://mcp.example.com/path?key=abc');
  for (const bad of ['', 'ftp://x.example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@x.example.com/', 'not a url', 'https://x.example.com/#frag']) {
    assert.throws(() => checkMcpUrl(bad), /address|http/i, bad);
  }
});
