/** A stdio MCP server, run for the app by the paired agent (`mcp.call` tasks).
 *
 * The server's command lives only in this machine's agent config (`mcpServers`):
 *
 *   "mcpServers": {"files": {"command": "npx", "args": ["-y", "some-mcp-server"], "env": {"TOKEN": "..."}, "cwd": "/home/me/notes"}}
 *
 * A task carries only the server's NAME, an operation (`list` or `call`), a tool
 * and its arguments, so nothing the app sends can choose what program runs. The
 * server is started fresh for each task, spoken to in newline-delimited JSON-RPC
 * (the same messages as the HTTP client, from `shared/mcp-protocol.js`) and killed
 * when the task is done, when it is slow or when it says too much. Its stderr is
 * thrown away and the program line is never reported: the config may hold a token.
 *
 * It starts with a small environment (PATH, HOME and the config's own `env`), not
 * this agent's, and from `cwd` or the system temp directory.
 */
import {spawn} from 'node:child_process';
import os from 'node:os';
import {initializeRequest, initializedNotification, toolsListRequest, toolsCallRequest, rpcResult, cleanTools, resultText, MAX_TOOLS} from '../shared/mcp-protocol.js';

export const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 120000;
export const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE'];

const failure = (code, message) => ({ok: false, code, message});
class Stop extends Error { constructor(code, message) { super(message); this.code = code; } }

const configOf = (servers, name) => {
  if (typeof name !== 'string' || !servers || typeof servers !== 'object' || !Object.hasOwn(servers, name)) return null;
  const c = servers[name];
  if (!c || typeof c !== 'object' || typeof c.command !== 'string' || !c.command) return null;
  return {
    command: c.command,
    args: Array.isArray(c.args) ? c.args.filter(a => typeof a === 'string') : [],
    env: Object.fromEntries(Object.entries(c.env && typeof c.env === 'object' ? c.env : {}).filter(([, v]) => typeof v === 'string')),
    cwd: typeof c.cwd === 'string' && c.cwd ? c.cwd : os.tmpdir(),
  };
};

/** Run one task. Never throws: every outcome is a result the server can read. A list is `{ok: true, tools}`,
 * a call is `{ok, text}` (ok false: the tool reported an error), anything else is `{ok: false, code, message}`. */
export async function runMcpTask(payload, servers, {timeoutMs, maxBytes = MAX_STDOUT_BYTES} = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const name = typeof p.server === 'string' ? p.server : '';
  const config = configOf(servers, name);
  if (!config) return failure('not-configured', `No MCP server called "${name.slice(0, 40)}" is configured on this agent. Add it to mcpServers in the agent config.`);
  if (p.op !== 'list' && p.op !== 'call') return failure('bad-request', 'An MCP task is a list or a call.');
  if (p.op === 'call' && (typeof p.tool !== 'string' || !p.tool)) return failure('bad-request', 'A call needs a tool name.');
  const limit = timeoutMs ?? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(p.timeoutMs) || DEFAULT_TIMEOUT_MS));

  const env = Object.fromEntries(KEEP_ENV.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, config.env);
  let child;
  // Why it would not start, in words an owner can act on: a missing program is usually npx (Node.js) or uvx (uv).
  // Only the program's own name: the full command line stays on this machine.
  const program = String(config.command).split(/[\\/]/).at(-1).slice(0, 40);
  const startFailed = error => error?.code === 'ENOENT'
    ? `The MCP server "${name}" could not start: "${program}" was not found on this computer. Install it (npx comes with Node.js, uvx with uv), then try again.`
    : `The MCP server "${name}" could not be started${error?.code ? ` (${error.code})` : ''}. Check its command in the agent config.`;
  try { child = spawn(config.command, config.args, {cwd: config.cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true}); }
  catch (error) { return failure('cannot-start', startFailed(error)); }

  const pending = new Map();
  let stopped = null, timer = null, nextId = 1, bytes = 0, buffer = '';
  const end = error => { if (stopped) return; stopped = error; for (const {reject} of pending.values()) reject(error); pending.clear(); };
  const killGroup = () => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
  };
  child.stdin.on('error', () => {});
  child.on('error', error => end(new Stop('cannot-start', startFailed(error))));
  // Only the exit code and the program's name: stderr can hold anything, a token included, so it stays here.
  child.on('close', code => end(new Stop('exited', `The MCP server "${name}" (${program}) stopped before it answered${Number.isInteger(code) ? ` (exit ${code})` : ''}. A wrong token or a missing folder is the usual cause: check what it needs, then try again.`)));
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { end(new Stop('output-too-large', `The MCP server "${name}" sent more than this agent reads.`)); killGroup(); return; }
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message?.id);
      if (!waiter) continue;
      pending.delete(message.id);
      try { waiter.resolve(rpcResult(message, message.id)); } catch (error) { waiter.reject(error); }
    }
    if (buffer.length > maxBytes) { end(new Stop('output-too-large', `The MCP server "${name}" sent more than this agent reads.`)); killGroup(); }
  });
  const write = message => { if (!stopped) child.stdin.write(JSON.stringify(message) + '\n'); };
  const request = message => new Promise((resolve, reject) => {
    if (stopped) return reject(stopped);
    const id = nextId++;
    pending.set(id, {resolve, reject});
    write({...message, id});
  });
  const clock = new Promise((_, reject) => { timer = setTimeout(() => { const error = new Stop('timeout', `The MCP server "${name}" did not answer in time.`); end(error); reject(error); }, limit); });
  clock.catch(() => {});

  try {
    return await Promise.race([clock, (async () => {
      await request(initializeRequest(0));
      write(initializedNotification());
      if (p.op === 'list') {
        const raw = [];
        let cursor;
        for (let page = 0; page < 10 && raw.length < MAX_TOOLS; page++) {
          const answer = await request(toolsListRequest(0, cursor));
          raw.push(...(Array.isArray(answer.result?.tools) ? answer.result.tools : []));
          cursor = typeof answer.result?.nextCursor === 'string' && answer.result.nextCursor ? answer.result.nextCursor : null;
          if (!cursor) break;
        }
        return {ok: true, tools: cleanTools(raw)};
      }
      const answer = await request(toolsCallRequest(0, p.tool, p.args));
      return resultText(answer.result);
    })()]);
  } catch (error) {
    if (error instanceof Stop) return failure(error.code, error.message);
    return failure('mcp-error', String(error?.message || 'The MCP server reported an error.').slice(0, 300));
  } finally {
    clearTimeout(timer);
    killGroup();
  }
}
