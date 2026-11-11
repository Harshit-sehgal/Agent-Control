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
 * unless the operator set either, and polls every 2s (`AGENT_POLL_MS`) so an Allow is picked up at once. That allowlist adds nothing on a device the server itself starts, and
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

/** The agent this server started, if any: the stdio MCP routes restart it after a config change. */
let running = null;

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
  const childEnv = {...env, AGENT_CONFIG: paired.configPath, AGENT_PARENT_PID: String(process.pid), AGENT_BROWSER: env.AGENT_BROWSER ?? '1', AGENT_BROWSER_ALLOWLIST: env.AGENT_BROWSER_ALLOWLIST || '*', AGENT_POLL_MS: env.AGENT_POLL_MS || '2000'};
  let child = null, stopped = false, timer = null, wait = restartMs, asked = false;
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
      if (asked) { asked = false; timer = setTimeout(launch, 0); return; }
      wait = Date.now() - started > 60_000 ? restartMs : Math.min(wait * 2, 60_000);
      log.warn?.(`local agent: stopped (${code ?? 'signal'}); starting it again in ${Math.round(wait / 1000) || 1}s.`);
      timer = setTimeout(launch, wait);
    });
  };
  launch();
  const handle = {
    ...paired,
    dataFile,
    /** Stop the child so it starts again and reads its config afresh. */
    restart() { if (!child) return; asked = true; child.kill('SIGTERM'); },
    async stop() {
      stopped = true;
      if (running === handle) running = null;
      if (timer) clearTimeout(timer);
      const live = child;
      if (!live) return;
      await new Promise(resolve => { live.once?.('exit', resolve); live.kill('SIGTERM'); setTimeout(resolve, 3000).unref?.(); });
    },
  };
  running = handle;
  return handle;
}

/* ---------- stdio MCP servers on this computer ----------
 * A stdio MCP server's command lives only in the agent config of the machine that runs it
 * (agent/mcp-stdio.mjs). On this computer the server writes that config, so the owner adds the command in
 * Settings → Connectors instead of editing a file they never made. Only the owner may (the route checks):
 * it runs a program on this computer. The command is split into words and started without a shell. */
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function localConfig(dataFile) {
  const file = configPathFor(dataFile), config = readConfig(file);
  if (!config?.secret) throw Object.assign(new Error('The local agent is not running on this computer, so there is nowhere to add the server. Pair a device in Settings → Local agents and add it to that device\'s config.'), {status: 409});
  return {file, config};
}

/** Words of a command line: quotes group, nothing is expanded. */
export function commandWords(line) {
  return [...String(line).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

/** The data file of the agent this server runs, or null: what the routes pass to the functions below. */
export const runningAgentDataFile = () => running?.dataFile ?? null;

export const localMcpServers = ({dataFile}) => Object.keys(localConfig(dataFile).config.mcpServers || {}).sort();

/** Add or replace a server; the running agent restarts to read it. Returns the server names. */
export function addLocalMcpServer({dataFile, name, command}) {
  const label = String(name ?? '').trim(), line = String(command ?? '');
  if (!SERVER_NAME.test(label)) throw Object.assign(new Error('Name the server with lowercase letters, digits and dashes (up to 40), like files.'), {status: 400});
  if (/[\r\n]/.test(line)) throw Object.assign(new Error('Give the command on one line.'), {status: 400});
  const words = commandWords(line.trim());
  if (!words.length || line.length > 1000) throw Object.assign(new Error('Give the command that starts the server, like npx -y some-mcp-server.'), {status: 400});
  const {file, config} = localConfig(dataFile);
  const [cmd, ...args] = words;
  writeConfig(file, {...config, mcpServers: {...(config.mcpServers || {}), [label]: {command: cmd, args}}});
  if (running?.configPath === file) running.restart();
  return localMcpServers({dataFile});
}

export function removeLocalMcpServer({dataFile, name}) {
  const {file, config} = localConfig(dataFile);
  const servers = {...(config.mcpServers || {})};
  delete servers[String(name ?? '')];
  writeConfig(file, {...config, mcpServers: servers});
  if (running?.configPath === file) running.restart();
  return localMcpServers({dataFile});
}
