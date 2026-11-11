/** The hand-written MCP client (JSON-RPC 2.0, no SDK).
 *
 * A connector that is an MCP server is reached one of two ways: a streamable-HTTP
 * server is called from here, and a stdio server runs inside the paired local
 * agent (`mcp.call`, see `agent/mcp-stdio.mjs`). Both speak the messages in
 * `shared/mcp-protocol.js`.
 *
 * Every call is its own short session: initialize, notifications/initialized, then
 * the one request, so there is nothing to keep alive and nothing left open on the
 * server. Whatever the server does, the call ends: the whole exchange has a time
 * limit, the bytes read have a cap, an answer is accepted as plain JSON or as an
 * event stream (read until our own answer arrives, then the stream is closed), a
 * redirect is not followed, and a result is cut to what a bot is shown. A header
 * value, the owner's secret, is removed from every error before it leaves.
 */
import {fail} from '../shared/errors.js';
import {enqueueAgentTask, failAgentTasks} from './agent.js';
import {PROTOCOL_VERSION, MAX_TOOLS, MAX_RESULT_CHARS, initializeRequest, initializedNotification, toolsListRequest, toolsCallRequest, rpcResult, cleanTools, readTools, resultText} from '../shared/mcp-protocol.js';

export const MCP_TIMEOUT_MS = 30000;
export const MCP_MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 10;

/** The address of an HTTP MCP server: http or https, with no password and no # part. The path and query
 * may be the secret (some servers put a key in them), which is why the whole address lives in the vault. */
export function checkMcpUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { fail('That is not an address this app can use. Give an http or https address.'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) fail('Use an http or https address with no password and no # part in it.');
  return url.href;
}

/** Everything in this exchange that must never appear in a message: each header value, the address and its query. */
function secretsOf(url, headers) {
  const list = Object.values(headers).filter(v => typeof v === 'string' && v.length >= 6);
  try { const u = new URL(url); list.push(u.href); if (u.search.length > 6) list.push(u.search.slice(1)); } catch { /* Checked before. */ }
  return list.sort((a, b) => b.length - a.length);
}
const redactWith = secrets => text => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text ?? ''));

export class TooLarge extends Error {}

/** The whole body as text, or TooLarge once it passes `limit` bytes. */
export async function readText(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let total = 0, text = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return text + decoder.decode();
      total += value.length;
      if (total > limit) throw new TooLarge();
      text += decoder.decode(value, {stream: true});
    }
  } finally { reader.cancel().catch(() => {}); }
}

/** The answer to request `id` from an event stream, as soon as it arrives. The rest of the stream is dropped. */
async function readStream(res, id, limit) {
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let total = 0, buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new TooLarge();
      buffer += decoder.decode(value, {stream: true}).replace(/\r\n?/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let message; try { message = JSON.parse(data); } catch { continue; }
        const answer = rpcResult(message, id);
        if (answer) return answer;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  fail('The MCP server ended its answer without replying.', 502);
}

/** One HTTP exchange: `work(request)` may call `request(message)` for each JSON-RPC request it makes. */
async function httpSession(target, work, {timeoutMs = MCP_TIMEOUT_MS, maxBytes = MCP_MAX_BYTES} = {}) {
  const url = checkMcpUrl(target.url);
  const custom = target.headers && typeof target.headers === 'object' ? target.headers : {};
  const redact = redactWith(secretsOf(url, custom));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let version = null, sessionId = null, nextId = 1;
  const send = async message => {
    // The protocol's own headers come last, so a custom header cannot change what is being said.
    const res = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: controller.signal, body: JSON.stringify(message),
      headers: {...custom, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(version ? {'mcp-protocol-version': version} : {}), ...(sessionId ? {'mcp-session-id': sessionId} : {})},
    });
    if (res.status >= 300 && res.status < 400) { res.body?.cancel().catch(() => {}); fail(`The MCP server redirected the request (${res.status}). Redirects are not followed; use the final address.`, 502); }
    if (res.status === 401 || res.status === 403) { res.body?.cancel().catch(() => {}); fail(`The MCP server refused the credentials (${res.status}). Check the headers you gave it.`, 502); }
    if (!res.ok) {
      const body = await readText(res, 2000).catch(() => '');
      fail(`The MCP server answered ${res.status}${body ? `: ${body.replace(/\s+/g, ' ').trim().slice(0, 200)}` : '.'}`, 502);
    }
    return res;
  };
  const request = async message => {
    const res = await send(message);
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) return {res, answer: await readStream(res, message.id, maxBytes)};
    const text = await readText(res, maxBytes);
    let body; try { body = JSON.parse(text); } catch { fail('The MCP server answered with something that is not JSON-RPC.', 502); }
    for (const item of Array.isArray(body) ? body : [body]) { const answer = rpcResult(item, message.id); if (answer) return {res, answer}; }
    fail('The MCP server answered without replying to the request.', 502);
  };
  try {
    const {res, answer} = await request(initializeRequest(nextId++));
    sessionId = res.headers.get('mcp-session-id') || null;
    version = typeof answer.result?.protocolVersion === 'string' && answer.result.protocolVersion ? answer.result.protocolVersion : PROTOCOL_VERSION;
    const ready = await send(initializedNotification());
    await readText(ready, maxBytes);
    return await work(async message => (await request({...message, id: nextId++})).answer);
  } catch (error) {
    if (controller.signal.aborted) fail('The MCP server did not answer in time.', 504);
    if (error instanceof TooLarge) fail('The MCP server sent more than this app reads (the answer was too large).', 502);
    if (error.status) throw Object.assign(error, {message: redact(error.message)});
    fail(`Could not reach the MCP server: ${redact(error.cause?.code || error.cause?.message || error.message)}`, 502);
  } finally {
    clearTimeout(timer);
    if (sessionId && !controller.signal.aborted) fetch(url, {method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(2000), headers: {...custom, 'mcp-session-id': sessionId, ...(version ? {'mcp-protocol-version': version} : {})}}).then(r => r.body?.cancel(), () => {});
  }
}

/** The tools of a server, cleaned: `{tools: [{name, description, write}]}`. */
export async function mcpList(target, options = {}) {
  if (target?.transport === 'stdio') return viaAgent(target, {op: 'list'}, options);
  return httpSession(target, async request => {
    const raw = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES && raw.length < MAX_TOOLS; page++) {
      const {result} = await request(toolsListRequest(0, cursor));
      raw.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return {tools: cleanTools(raw)};
  }, options);
}

/** One tool call: `{ok, text}`. A tool that reports its own error is a result (`ok: false`); a protocol
 * error, a refusal or a timeout is thrown. */
export async function mcpCall(target, tool, args = {}, options = {}) {
  if (target?.transport === 'stdio') return viaAgent(target, {op: 'call', tool, args}, options);
  return httpSession(target, async request => resultText((await request(toolsCallRequest(0, String(tool), args))).result), options);
}

// --- a stdio server, through the paired local agent ------------------------------------------------------
const ONLINE_MS = 180000; // the window the agent list calls "online"
const AGENT_WAIT_MS = 90000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const problem = (message, status, code) => Object.assign(new Error(message), {status, code});

/** The agent to use: paired, not revoked, allowed to run MCP servers and seen lately. */
function pickAgent(store, nowMs = Date.now()) {
  const rows = store.all('SELECT * FROM agents WHERE revoked_at IS NULL ORDER BY last_seen_at DESC');
  if (!rows.length) throw problem('No computer is connected for an MCP server that runs on your computer. A server started on your own computer connects it by itself; otherwise pair one in Settings → Local agents.', 422, 'no-agent');
  const may = rows.filter(row => { try { return JSON.parse(row.permissions || '[]').includes('mcp.call'); } catch { return false; } });
  if (!may.length) throw problem('Your paired agent is not allowed to run MCP servers. Allow mcp.call for it, then try again.', 422, 'no-permission');
  const live = may.find(row => row.last_seen_at && Date.parse(row.last_seen_at) > nowMs - ONLINE_MS);
  if (!live) throw problem('Your computer\'s agent is offline. A server on your own computer restarts it within a few seconds; on another machine, start it there (`node agent/agent.mjs run`), then try again.', 422, 'agent-offline');
  return live;
}

/** One `mcp.call` task for the agent, and its answer. The command that runs is in the agent's own config. */
async function viaAgent(target, {op, tool, args}, {timeoutMs = AGENT_WAIT_MS, pollMs = 250} = {}) {
  const device = pickAgent(target.store);
  // The agent stops its server before this side stops waiting, leaving room for pickup and the report back.
  const agentMs = Math.max(2000, Math.min(60000, timeoutMs - 45000));
  // `notAfter` is when this side stops waiting: a device that picks the task up later skips it instead of running a call nobody will read.
  const deadline = Date.now() + timeoutMs;
  const {task} = enqueueAgentTask(target.store, device.id, {kind: 'mcp.call', payload: {server: target.server, op, ...(op === 'call' ? {tool, args} : {}), timeoutMs: agentMs, notAfter: deadline}, createdBy: 'connector'});
  for (;;) {
    const row = target.store.get('SELECT status,result,error FROM agent_tasks WHERE id=?', task.id);
    if (!row) throw problem('The MCP task disappeared before it finished.', 502, 'agent-failed');
    if (row.status === 'failed') throw problem(`The paired agent could not run the MCP server: ${row.error || 'it reported a failure'}`, 502, 'agent-failed');
    if (row.status === 'done') {
      let result = null;
      try { result = JSON.parse(row.result); } catch { /* Handled below. */ }
      if (result?.ok === false && typeof result.code === 'string') throw problem(String(result.message || 'The MCP server failed.').slice(0, 300), result.code === 'timeout' ? 504 : 502, result.code);
      if (op === 'list' && result?.ok === true) return {tools: readTools(result.tools)};
      if (op === 'call' && typeof result?.ok === 'boolean' && typeof result.text === 'string') return {ok: result.ok, text: result.text.length > MAX_RESULT_CHARS ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n[cut: the result was longer than ${MAX_RESULT_CHARS} characters]` : result.text};
      throw problem('The paired agent returned an answer this app could not read.', 502, 'agent-failed');
    }
    if (Date.now() >= deadline) {
      failAgentTasks(target.store, [task.id], 'The MCP call timed out waiting for the agent.');
      throw problem('The MCP server did not answer in time. Check that the agent is running.', 504, 'timeout');
    }
    await sleep(pollMs);
  }
}
