/** Is each CLI signed in on this machine? Asked of the CLI itself.
 *
 * The only commands run are the ones each CLI documents for this:
 *   claude auth status --json     ("Show authentication status")
 *   codex login status            ("Show login status")
 * Neither makes a model call, so checking costs nothing on the plan. Only the
 * word they imply is kept (`signed-in`, `signed-out`, `missing`, `unknown`); the
 * command's output, which may name an account, is read in memory and dropped.
 * This file never opens a credential file.
 *
 * The heartbeat asks for a snapshot every few seconds, so `cliStatusReporter`
 * answers at once from a cache, refreshes in the background when the answer is
 * ten minutes old, and never runs two checks at the same time.
 */
import {spawn} from 'node:child_process';
import os from 'node:os';
import {cliEnv, kill} from './cli-model.mjs';
import {LOCAL_CLI_ENGINE_IDS} from '../shared/ai-presets.js';

export const STATUS_VALUES = ['signed-in', 'signed-out', 'missing', 'unknown'];
export const STATUS_TTL_MS = 10 * 60000;
const STATUS_COMMANDS = {claude: ['auth', 'status', '--json'], codex: ['login', 'status']};
const MAX_OUTPUT = 16 * 1024;

const SIGNED_OUT = /not (logged|signed) in|logged out|no (active )?(login|credentials|auth)/i;
const SIGNED_IN = /(logged|signed) in/i;

/** What a status command's exit code and words mean. Anything not clear is unknown. */
function interpret(engine, {code, out}) {
  if (engine === 'claude') {
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed.loggedIn === 'boolean') return parsed.loggedIn ? 'signed-in' : 'signed-out';
    } catch { /* Not JSON: fall through to the words. */ }
  }
  if (SIGNED_OUT.test(out)) return 'signed-out';
  if (code === 0 && SIGNED_IN.test(out)) return 'signed-in';
  return 'unknown';
}

/** Ask one CLI whether it is signed in. Never throws. */
export function checkCli(engine, {env = process.env, timeoutMs = 10000} = {}) {
  const args = STATUS_COMMANDS[engine];
  if (!args) return Promise.resolve('unknown');
  return new Promise(resolve => {
    let child, out = '', settled = false;
    const done = value => { if (settled) return; settled = true; clearTimeout(timer); if (child) kill(child); resolve(value); };
    const timer = setTimeout(() => done('unknown'), timeoutMs);
    try { child = spawn(engine, args, {cwd: os.tmpdir(), env: cliEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'}); }
    catch { return done('unknown'); }
    const take = chunk => { out = (out + chunk).slice(-MAX_OUTPUT); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', e => done(e.code === 'ENOENT' ? 'missing' : 'unknown'));
    child.once('close', code => done(interpret(engine, {code, out})));
  });
}

/** A cached, single-flight view of every engine's status for the heartbeat.
 * `env` may be an object or a function returning one (tests change it). */
export function cliStatusReporter({env = process.env, now = Date.now, ttlMs = STATUS_TTL_MS, timeoutMs = 10000} = {}) {
  let status = Object.fromEntries(LOCAL_CLI_ENGINE_IDS.map(id => [id, 'unknown']));
  let checkedAt = null, flight = null, stale = false;
  const refresh = () => {
    flight = Promise.all(LOCAL_CLI_ENGINE_IDS.map(id => checkCli(id, {env: typeof env === 'function' ? env() : env, timeoutMs}))).then(values => {
      status = Object.fromEntries(LOCAL_CLI_ENGINE_IDS.map((id, i) => [id, values[i]]));
      checkedAt = now();
      stale = false;
    }).finally(() => { flight = null; });
  };
  return {
    /** The last known status; starts a background check first when it is old. */
    snapshot() {
      if (!flight && (stale || checkedAt === null || now() - checkedAt >= ttlMs)) refresh();
      return {...status};
    },
    /** Resolves when the check in flight (if any) is finished. */
    refreshed: () => flight || Promise.resolve(),
    /** Check again at the next snapshot: the owner may just have signed in. */
    invalidate() { stale = true; },
  };
}
