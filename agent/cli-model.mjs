/** Model runs on the owner's own subscription: the `model.run` agent task.
 *
 * The agent spawns the unmodified `claude` or `codex` CLI that the owner signed
 * in to in their own terminal. This file never reads a credential file or a
 * token; it only starts the program, hands it the prompt, and reads its answer.
 *
 * - The prompt goes in through stdin. It is never an argument, so it cannot show
 *   in `ps` and a prompt that begins with `-` or holds shell characters is just
 *   text. There is no shell: `spawn` is given an argument list.
 * - The CLI's own file, shell and web tools are switched off, and it runs in an
 *   empty scratch directory, so a bot cannot touch the owner's files.
 * - A run has a timeout (the whole process group is killed) and an output cap, so
 *   a hung or runaway CLI fails that one run and the agent carries on.
 * - Failures get a clear code: `not-signed-in`, `usage-limit`, `cli-missing`,
 *   `timeout`, `output-too-large`, `empty-reply`, `bad-request`, `cli-failed`.
 *
 * Flags, each read from the local `claude --help` / `codex exec --help`:
 *   claude -p --output-format stream-json --verbose --tools "" --safe-mode
 *          --strict-mcp-config --permission-prompts none --no-session-persistence
 *          --system-prompt <fixed text> [--model <m>]
 *   codex  exec --json --ephemeral --skip-git-repo-check --ignore-user-config
 *          --ignore-rules -s read-only -C <scratch> -c features.shell_tool=false
 *          [-m <m>] -          (the trailing `-` reads the prompt from stdin)
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cliEngineById, cleanCliModel, cleanEffort} from '../shared/ai-presets.js';

export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
/** The most reply a result carries, in UTF-8 bytes once JSON-escaped: the server reads a device's
 * result with a 64 KB body limit (src/app.js), and the rest of the result needs room too. */
export const MAX_REPLY_BYTES = 48 * 1024;
const CUT_NOTE = '\n\n(cut: the reply was longer than 48 KB, so the rest was not sent)';
const jsonBytes = text => Buffer.byteLength(JSON.stringify(text), 'utf8');

/** The reply, or as much of it as fits in MAX_REPLY_BYTES with a note saying it was cut. Never splits
 * a character. */
export function capReplyText(text, max = MAX_REPLY_BYTES) {
  if (jsonBytes(text) <= max) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, mid) + CUT_NOTE) <= max) low = mid; else high = mid - 1;
  }
  // A high surrogate at the end would be half a character.
  const end = low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]) ? low - 1 : low;
  return text.slice(0, end) + CUT_NOTE;
}
const MAX_PROMPT_CHARS = 200000;
const MAX_STDERR = 16 * 1024;
export const DEFAULT_TIMEOUT_MS = 180000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 600000;

/** Variables that would switch a CLI from the owner's plan to a paid API key. A
 * subscription provider means the plan, so they are not passed on. A long-lived
 * `claude setup-token` token (CLAUDE_CODE_OAUTH_TOKEN) is a plan login and stays. */
const BILLING_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
export function cliEnv(base = process.env) {
  const env = {...base};
  for (const key of BILLING_KEYS) delete env[key];
  return env;
}

export class CliModelError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'CliModelError';
    this.code = code;
    this.detail = detail;
  }
}

const SYSTEM_TEXT = 'You are answering as a text-only model. You have no tools: do not run commands, read or write files, or browse. Reply with text only, following the instructions in the message.';

/** The program and argument list for one run. `dir` is the empty scratch directory. */
const CODEX_FEATURES_OFF = ['shell_tool', 'unified_exec', 'shell_snapshot', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'apps'];

export function buildCommand(engine, {model = '', effort = '', dir}) {
  const spec = cliEngineById(engine);
  if (!spec) throw new CliModelError('bad-request', 'Unknown engine. Use claude or codex.');
  const chosen = cleanCliModel(model);
  if (chosen === null) throw new CliModelError('bad-request', 'That model name is not valid for a CLI.');
  const level = cleanEffort(effort);
  if (level === null) throw new CliModelError('bad-request', 'That effort level is not valid. Use low, medium or high.');
  if (spec.id === 'claude') {
    return {command: 'claude', spec, args: [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--tools', '',
      '--safe-mode', '--strict-mcp-config', '--permission-prompts', 'none', '--no-session-persistence',
      '--system-prompt', SYSTEM_TEXT,
      ...(chosen ? ['--model', chosen] : []),
      ...(level ? ['--effort', level] : []),
    ]};
  }
  return {command: 'codex', spec, args: [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-s', 'read-only', '-C', dir,
    // Every codex feature that runs a command, drives a browser or the computer
    // (names from `codex features list`). Read-only still lets a shell read
    // files, so none of them may be reachable from a bot's prompt.
    ...CODEX_FEATURES_OFF.flatMap(f => ['-c', `features.${f}=false`]),
    ...(chosen ? ['-m', chosen] : []),
    // codex reads a -c value as TOML; the quotes keep it a string.
    ...(level ? ['-c', `model_reasoning_effort="${level}"`] : []),
    '-',
  ]};
}

/** What the model is sent, as one text: the bot's instructions, then its input. */
const promptText = ({instructions, input}) => [instructions && String(instructions).trim(), String(input ?? '')].filter(Boolean).join('\n\n');

const lines = text => String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
const textOf = blocks => (Array.isArray(blocks) ? blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('') : '');

/** claude stream-json: the closing `result` event holds the answer. */
function readClaude(raw) {
  let result = null, assistant = '', error = '';
  for (const line of lines(raw)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'result') result = event;
    else if (event?.type === 'assistant') {
      assistant = textOf(event.message?.content) || assistant;
      if (typeof event.error === 'string') error = error || event.error;
    }
  }
  if (result?.is_error) return {text: '', error: String(result.result || result.subtype || error || 'The CLI reported an error.')};
  return {text: typeof result?.result === 'string' ? result.result : assistant, error: ''};
}

/** codex --json: `item.completed` carries the agent's message; an `error` event
 * can be a transient "reconnecting", so only a failed turn or no answer counts. */
function readCodex(raw) {
  let text = '', failed = '', last = '';
  for (const line of lines(raw)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
    else if (event?.msg?.type === 'agent_message' && typeof event.msg.message === 'string') text = event.msg.message;
    else if (event?.type === 'turn.failed') failed = String(event.error?.message || 'The turn failed.');
    else if (event?.type === 'error' && typeof event.message === 'string') last = event.message;
  }
  return {text, error: failed || (text ? '' : last)};
}

const LIMIT = /usage limit|limit reached|rate.?limit|too many requests|quota|out of (extra )?usage|credit balance|hit your (usage|weekly|5-hour|daily)/i;
const SIGNED_OUT = /not (logged|signed) in|please (run )?\/?log ?in|run [`'"]?\/login|invalid api key|authentication|unauthori[sz]ed|\b401\b|sign in|log in|login required|token (has )?(expired|been revoked|invalid)/i;
const tidy = (text, n = 300) => String(text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Name what the CLI said it could not do. */
const NO_MODEL = /issue with the selected model|model[^.]{0,80}(does not exist|not found|not available|no access|do not have access)|(unknown|invalid|unsupported) model/i;
function classify(said, spec, model = '') {
  const detail = tidy(said);
  // Before the sign-in check: "you do not have access" is about the model, not the login.
  if (NO_MODEL.test(said)) return new CliModelError('model-not-found', `${spec.label.replace(/ \(.*/, '')} does not offer ${model || 'that model'}. Pick another model on the bot's profile.`, detail);
  if (LIMIT.test(said)) return new CliModelError('usage-limit', `${spec.label.replace(/ \(.*/, '')} subscription has reached its usage limit.`, detail);
  if (SIGNED_OUT.test(said)) return new CliModelError('not-signed-in', `${spec.label.replace(/ \(.*/, '')} is not signed in on this machine. ${spec.signIn}`, detail);
  return new CliModelError('cli-failed', `The ${spec.binary} command failed${detail ? `: ${detail}` : '.'}`, detail);
}

/** Kill the process group, so a CLI's own children go too. */
export function kill(child) {
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
}

/** Run one prompt through a CLI and return `{text, engine, model, ms}`, or throw a CliModelError.
 * An older CLI that does not know the effort flag fails naming it; that run is
 * made once more without the effort rather than failing the bot's turn. */
export async function runCliModel(options = {}) {
  try { return await runCliOnce(options); } catch (error) {
    if (options.effort && error instanceof CliModelError && error.code === 'cli-failed' && /effort/i.test(`${error.message} ${error.detail || ''}`)) return runCliOnce({...options, effort: ''});
    throw error;
  }
}
async function runCliOnce({engine, model = '', effort = '', instructions = '', input = '', timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_STDOUT_BYTES, env = process.env} = {}) {
  const prompt = promptText({instructions, input});
  if (!prompt.trim()) throw new CliModelError('bad-request', 'There is nothing to send to the model.');
  if (prompt.length > MAX_PROMPT_CHARS) throw new CliModelError('bad-request', 'The prompt is too long to send to a CLI.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-'));
  try {
    const {command, args, spec} = buildCommand(engine, {model, effort, dir});
    const started = Date.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {cwd: dir, env: cliEnv(env), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'});
      const out = []; let bytes = 0, err = '', settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        kill(child);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => done(new CliModelError('timeout', `The ${spec.binary} command did not answer within ${Math.round(timeoutMs / 1000)}s and was stopped.`)), timeoutMs);
      child.once('error', e => done(e.code === 'ENOENT'
        ? new CliModelError('cli-missing', `The ${spec.binary} command was not found on this machine. Install it, then run \`${spec.binary}\` to sign in.`)
        : new CliModelError('cli-failed', `The ${spec.binary} command could not be started: ${tidy(e.message)}`)));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) return done(new CliModelError('output-too-large', `The ${spec.binary} command printed more than ${Math.round(maxBytes / 1048576)} MB and was stopped.`));
        out.push(chunk);
      });
      child.stderr.on('data', chunk => { err = (err + chunk).slice(-MAX_STDERR); });
      child.stdin.on('error', () => { /* The CLI exited before reading its prompt; its exit says why. */ });
      child.once('close', code => {
        const raw = Buffer.concat(out).toString('utf8');
        const read = spec.id === 'claude' ? readClaude(raw) : readCodex(raw);
        const text = read.text.trim();
        if (code === 0 && !read.error && text) return done(null, {text: capReplyText(text), engine: spec.id, model: cleanCliModel(model) || null, ms: Date.now() - started});
        const said = [read.error, err].filter(Boolean).join('\n');
        if (code === 0 && !said.trim()) return done(new CliModelError('empty-reply', `The ${spec.binary} command finished without an answer.`));
        done(classify(said, spec, cleanCliModel(model) || ''));
      });
      // codex has no system-prompt flag, so it gets the same fixed words as a lead-in.
      child.stdin.end(spec.id === 'codex' ? `${SYSTEM_TEXT}\n\n${prompt}` : prompt);
    });
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

/** The `model.run` task: validate the payload, run it, and answer in a plain
 * structure. It never throws, so one bad run cannot take the agent loop down.
 * `{ok: true, text, engine, model, ms}` or `{ok: false, code, message, detail}`. */
export async function runModelTask(payload, {env = process.env} = {}) {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!cliEngineById(p.engine)) throw new CliModelError('bad-request', 'Unknown engine. Use claude or codex.');
    if (typeof p.input !== 'string' || !p.input.trim()) throw new CliModelError('bad-request', 'There is nothing to send to the model.');
    if (p.instructions !== undefined && typeof p.instructions !== 'string') throw new CliModelError('bad-request', 'Instructions must be text.');
    const asked = Number(p.timeoutMs);
    const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, asked)) : DEFAULT_TIMEOUT_MS;
    const done = await runCliModel({engine: cliEngineById(p.engine).id, model: p.model || '', effort: p.effort || '', instructions: p.instructions || '', input: p.input, timeoutMs, env});
    return {ok: true, ...done};
  } catch (error) {
    if (error instanceof CliModelError) return {ok: false, code: error.code, message: error.message, detail: error.detail};
    return {ok: false, code: 'cli-failed', message: `The model run failed: ${tidy(error?.message)}`, detail: ''};
  }
}
