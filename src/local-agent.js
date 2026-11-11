/** The local agent on the server's own computer, started by the server.
 *
 * A bot reaches a browser, the owner's `claude` and `codex` sign-in and stdio MCP servers through a paired
 * local agent (agent/agent.mjs). On a personal install that agent runs on the same computer as the server,
 * so asking the owner to make a pairing code and keep a second terminal open is a step for nothing. Here
 * the server pairs "This computer" once, keeps its secret in `local-agent.json` beside the database (mode
 * 0600, like agent.config.json), and runs `agent.mjs run` as a child it restarts after a crash and stops
 * on shutdown.
 *
 * It starts when the server listens on this computer only (HOST 127.0.0.1 or localhost); `LOCAL_AGENT=1`
 * starts it anyway and `LOCAL_AGENT=0` never. An agent the owner revoked in Settings stays revoked: it is
 * not paired again behind their back.
 *
 * The child gets the shared browser (`AGENT_BROWSER=1`) and any public site (`AGENT_BROWSER_ALLOWLIST=*`)
 * unless the operator set either. That allowlist adds nothing on a device the server itself starts, and
 * every page still waits for the owner's ask, while the agent's egress guard still refuses private and
 * local addresses. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn as nodeSpawn} from 'node:child_process';
import {AGENT_ACTIONS, createPairing, redeemPairing} from './agent.js';
import {DEFAULT_WORKSPACE} from './auth.js';

const AGENT_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'agent.mjs');
const NAME = 'This computer';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Should this server start an agent on itself? */
export function localAgentWanted(env = process.env) {
  const flag = String(env.LOCAL_AGENT ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  return LOOPBACK.has(String(env.HOST || '127.0.0.1').trim().toLowerCase());
}

const configPathFor = dataFile => path.join(path.dirname(path.resolve(dataFile)), 'local-agent.json');
function readConfig(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const fd = fs.openSync(file, 'w', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(config, null, 2)); } finally { fs.closeSync(fd); }
}

/** Pair this computer once, or reuse the pairing, and point it at `server`.
 * @returns {{agentId: string, configPath: string}|null} null when the owner revoked it. */
export function ensureLocalAgent(store, {dataFile, server}) {
  const configPath = configPathFor(dataFile);
  const saved = readConfig(configPath);
  const row = saved?.agentId ? store.get('SELECT id,revoked_at FROM agents WHERE id=?', saved.agentId) : null;
  if (row?.revoked_at) return null;
  if (row && saved.secret) {
    if (saved.server !== server) writeConfig(configPath, {...saved, server});
    return {agentId: row.id, configPath};
  }
  const {code} = createPairing(store, DEFAULT_WORKSPACE, {label: NAME, createdBy: null, permissions: AGENT_ACTIONS, ttlMs: 60_000});
  const made = redeemPairing(store, {code, name: NAME, permissions: AGENT_ACTIONS});
  writeConfig(configPath, {server, agentId: made.agentId, secret: made.secret, permissions: made.permissions, name: NAME, pairedAt: new Date().toISOString(), startedBy: 'server'});
  return {agentId: made.agentId, configPath};
}

/** Start the agent as a child process and keep it running.
 * @returns {{agentId: string, configPath: string, stop: () => Promise<void>}|null} */
export function startLocalAgent(store, {dataFile, server, env = process.env, spawn = nodeSpawn, log = console, restartMs = 2000}) {
  let paired;
  try { paired = ensureLocalAgent(store, {dataFile, server}); }
  catch (error) { log.warn?.(`local agent: could not pair this computer: ${error.message}`); return null; }
  if (!paired) { log.log?.('Local agent: revoked in Settings, so not started. Pair a device under Settings → Local agents to use a browser.'); return null; }
  const childEnv = {...env, AGENT_CONFIG: paired.configPath, AGENT_PARENT_PID: String(process.pid), AGENT_BROWSER: env.AGENT_BROWSER ?? '1', AGENT_BROWSER_ALLOWLIST: env.AGENT_BROWSER_ALLOWLIST || '*'};
  let child = null, stopped = false, timer = null, wait = restartMs;
  const relay = (stream, write) => stream?.on?.('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) write(`[agent] ${line}`); });
  const launch = () => {
    timer = null;
    if (stopped) return;
    const started = Date.now();
    child = spawn(process.execPath, [AGENT_SCRIPT, 'run'], {env: childEnv, stdio: ['ignore', 'pipe', 'pipe']});
    relay(child.stdout, line => log.log?.(line));
    relay(child.stderr, line => log.warn?.(line));
    child.on('error', error => log.warn?.(`local agent: ${error.message}`));
    child.on('exit', code => {
      child = null;
      if (stopped) return;
      // A run that lasted a while resets the back-off; one that dies at once waits longer each time, up to a minute.
      wait = Date.now() - started > 60_000 ? restartMs : Math.min(wait * 2, 60_000);
      log.warn?.(`local agent: stopped (${code ?? 'signal'}); starting it again in ${Math.round(wait / 1000) || 1}s.`);
      timer = setTimeout(launch, wait);
    });
  };
  launch();
  return {
    ...paired,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const running = child;
      if (!running) return;
      await new Promise(resolve => { running.once?.('exit', resolve); running.kill('SIGTERM'); setTimeout(resolve, 3000).unref?.(); });
    },
  };
}
