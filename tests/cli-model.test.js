import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runCliModel, runModelTask, buildCommand, cliEnv, CliModelError} from '../agent/cli-model.mjs';

/* The real CLIs are never run here: that would spend the owner's subscription.
 * A fake executable named `claude` / `codex` sits first on PATH in a temp dir. It
 * records what it was given and misbehaves on request (FAKE_MODE). */
const FAKE = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const engine = path.basename(process.argv[1]);
const mode = process.env.FAKE_MODE || 'ok';
let stdin = '';
process.stdin.on('data', c => { stdin += c; });
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({engine, argv: process.argv.slice(2), stdin, cwd: process.cwd(), pid: process.pid, apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || null}) + '\\n');
  const out = line => process.stdout.write(JSON.stringify(line) + '\\n');
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'flood') {
    const chunk = 'x'.repeat(65536);
    const timer = setInterval(() => { for (let i = 0; i < 20; i++) process.stdout.write(chunk); }, 1);
    process.stdout.on('error', () => { clearInterval(timer); process.exit(0); });
    return;
  }
  if (mode === 'missing-reply') { process.stdout.write('not json at all\\n'); process.exit(0); }
  if (mode === 'boom') { process.stderr.write('segmentation fault in the fake cli\\n'); process.exit(2); }
  const said = {
    signedout: engine === 'claude' ? 'Invalid API key · Please run /login' : 'Not logged in. Please run codex login.',
    limit: engine === 'claude' ? 'Claude AI usage limit reached|1731000000' : "You've hit your usage limit. Try again at 3pm.",
    badmodel: engine === 'claude' ? "There's an issue with the selected model (claude-foo-9). It may not exist or you may not have access to it. Run --model to pick a different model." : 'The model gpt-foo-9 does not exist or you do not have access to it.',
  }[mode];
  if (engine === 'claude') {
    out({type: 'system', subtype: 'init', tools: []});
    if (said) { out({type: 'result', subtype: 'success', is_error: true, result: said}); process.exit(1); }
    out({type: 'assistant', message: {content: [{type: 'text', text: 'echo: ' + stdin}]}});
    out({type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + stdin});
    return;
  }
  out({type: 'thread.started', thread_id: 't'});
  out({type: 'turn.started'});
  if (said) { out({type: 'turn.failed', error: {message: said}}); process.exit(1); }
  out({type: 'item.completed', item: {id: 'i0', type: 'agent_message', text: 'echo: ' + stdin}});
  out({type: 'turn.completed', usage: {}});
});
`;

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(dir, name), FAKE, {mode: 0o755});
  const log = path.join(dir, 'log.jsonl');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const env = (extra = {}) => ({PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}`, HOME: os.tmpdir(), FAKE_LOG: log, ...extra});
  return {dir, calls, env};
}
const fails = async (promise, code) => {
  const error = await promise.then(() => null, e => e);
  assert.ok(error instanceof CliModelError, `expected a CliModelError, got ${error}`);
  assert.equal(error.code, code, `${error.code}: ${error.message}`);
  return error;
};

test('claude: the prompt goes through stdin, and the argv switches every built-in tool off', async t => {
  const {calls, env} = rig(t);
  const sentinel = 'SENTINEL-4f1c';
  const out = await runCliModel({engine: 'claude', model: 'sonnet', instructions: 'Be brief.', input: `{"message":"${sentinel}"}`, env: env({ANTHROPIC_API_KEY: 'sk-ant-must-not-reach-the-cli'})});
  assert.match(out.text, /^echo: /);
  assert.ok(out.text.includes(sentinel) && out.text.includes('Be brief.'), 'instructions and input both arrive');
  const [call] = calls();
  assert.equal(call.engine, 'claude');
  assert.ok(call.stdin.includes(sentinel));
  assert.equal(JSON.stringify(call.argv).includes(sentinel), false, 'the prompt is not in argv, so it cannot show in ps');
  assert.equal(JSON.stringify(call.argv).includes('Be brief.'), false);
  assert.deepEqual(call.argv.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--tools']);
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '', 'an empty tool list: no file, shell or web tool');
  assert.ok(call.argv.includes('--safe-mode') && call.argv.includes('--strict-mcp-config') && call.argv.includes('--no-session-persistence'));
  assert.equal(call.argv.includes('--bare'), false, '--bare would ignore the subscription login');
  assert.deepEqual(call.argv.slice(call.argv.indexOf('--model'), call.argv.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.equal(call.apiKey, null, 'an API key in the environment would bill the API instead of the plan; it is not passed on');
  assert.notEqual(call.cwd, process.cwd(), 'it runs in an empty scratch directory, not the owner\'s project');
  assert.equal(fs.existsSync(call.cwd), false, 'and the scratch directory is removed afterwards');
});

test('codex: read-only sandbox, an empty working root, no stored session, prompt on stdin', async t => {
  const {calls, env} = rig(t);
  const out = await runCliModel({engine: 'codex', model: 'gpt-5-codex', instructions: 'I', input: 'Hello there', env: env({OPENAI_API_KEY: 'sk-openai-must-not-reach-the-cli'})});
  assert.ok(out.text.includes('Hello there'));
  const [call] = calls();
  assert.deepEqual(call.argv.slice(0, 2), ['exec', '--json']);
  assert.equal(call.argv.at(-1), '-', 'the prompt is read from stdin');
  assert.equal(call.argv[call.argv.indexOf('-s') + 1], 'read-only');
  for (const flag of ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']) assert.ok(call.argv.includes(flag), flag);
  assert.equal(call.argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(call.argv[call.argv.indexOf('-m') + 1], 'gpt-5-codex');
  assert.equal(call.argv[call.argv.indexOf('-C') + 1], call.cwd);
  assert.equal(call.apiKey, null);
});

test('no model means no --model flag: the CLI uses its own default', async t => {
  const {calls, env} = rig(t);
  await runCliModel({engine: 'claude', instructions: '', input: 'x', env: env()});
  await runCliModel({engine: 'codex', instructions: '', input: 'x', env: env()});
  for (const call of calls()) assert.equal(call.argv.includes('--model') || call.argv.includes('-m'), false);
});

test('a prompt full of shell metacharacters and a leading dash is passed as plain text', async t => {
  const {calls, env, dir} = rig(t);
  const marker = path.join(dir, 'pwned');
  const nasty = `--dangerously-skip-permissions; touch ${marker}; $(touch ${marker}) \`touch ${marker}\` | cat > ${marker} && echo "'" \\n -p`;
  for (const engine of ['claude', 'codex']) {
    const out = await runCliModel({engine, instructions: '-rf', input: nasty, env: env()});
    assert.ok(out.text.includes(nasty), `${engine}: the text comes back untouched`);
  }
  assert.equal(fs.existsSync(marker), false, 'nothing was interpreted by a shell');
  for (const call of calls()) assert.equal(JSON.stringify(call.argv).includes('touch'), false);
});

test('a model that could be read as a flag is refused before anything is spawned', async t => {
  const {calls, env} = rig(t);
  for (const model of ['--bare', '-p', 'a b', '$(id)']) {
    assert.throws(() => buildCommand('claude', {model, dir: '/x'}), /model/i, model);
    await fails(runCliModel({engine: 'claude', model, input: 'x', env: env()}), 'bad-request');
  }
  assert.deepEqual(calls(), []);
});

test('not signed in is its own code, for both engines, and says what to do', async t => {
  const {env} = rig(t);
  for (const engine of ['claude', 'codex']) {
    const error = await fails(runCliModel({engine, input: 'x', env: env({FAKE_MODE: 'signedout'})}), 'not-signed-in');
    assert.match(error.message, new RegExp(`Run \`${engine}( login)?\``));
  }
});

test('a usage limit is its own code, for both engines', async t => {
  const {env} = rig(t);
  for (const engine of ['claude', 'codex']) {
    const error = await fails(runCliModel({engine, input: 'x', env: env({FAKE_MODE: 'limit'})}), 'usage-limit');
    assert.match(error.message, /limit/i);
  }
});

test('a model the CLI does not have is its own code, with app advice, not terminal flags', async t => {
  const {env} = rig(t);
  for (const engine of ['claude', 'codex']) {
    const error = await fails(runCliModel({engine, model: engine === 'claude' ? 'claude-foo-9' : 'gpt-foo-9', input: 'x', env: env({FAKE_MODE: 'badmodel'})}), 'model-not-found');
    assert.match(error.message, /foo-9/);
    assert.match(error.message, /pick another model on the bot's profile/i);
    assert.doesNotMatch(error.message, /Run --model/);
  }
});

test('a missing binary is a clear error, not a crash', async t => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cli-'));
  t.after(() => fs.rmSync(empty, {recursive: true, force: true}));
  for (const engine of ['claude', 'codex']) {
    const error = await fails(runCliModel({engine, input: 'x', env: {PATH: empty, HOME: os.tmpdir()}}), 'cli-missing');
    assert.match(error.message, new RegExp(`${engine}.*not found|could not find`, 'i'));
  }
});

test('a CLI that hangs is killed at the timeout and the run fails cleanly', async t => {
  const {calls, env} = rig(t);
  const started = Date.now();
  await fails(runCliModel({engine: 'claude', input: 'x', timeoutMs: 400, env: env({FAKE_MODE: 'hang'})}), 'timeout');
  assert.ok(Date.now() - started < 5000);
  const [{pid}] = calls();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the child process is gone');
});

test('a CLI that prints megabytes is cut off, killed, and the agent carries on', async t => {
  const {calls, env} = rig(t);
  await fails(runCliModel({engine: 'codex', input: 'x', maxBytes: 200000, timeoutMs: 10000, env: env({FAKE_MODE: 'flood'})}), 'output-too-large');
  const [{pid}] = calls();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const again = await runCliModel({engine: 'codex', input: 'still alive', env: env()});
  assert.ok(again.text.includes('still alive'));
});

test('two runs at once keep their own output', async t => {
  const {env} = rig(t);
  const runs = await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map((word, i) => runCliModel({engine: i % 2 ? 'codex' : 'claude', instructions: '', input: `only-${word}`, env: env()})));
  runs.forEach((run, i) => {
    const word = ['alpha', 'beta', 'gamma', 'delta'][i];
    assert.ok(run.text.includes(`only-${word}`));
    for (const other of ['alpha', 'beta', 'gamma', 'delta'].filter(w => w !== word)) assert.equal(run.text.includes(other), false, `${word} saw ${other}`);
  });
});

test('exit 0 with no reply, and a plain crash, are named failures rather than empty answers', async t => {
  const {env} = rig(t);
  await fails(runCliModel({engine: 'claude', input: 'x', env: env({FAKE_MODE: 'missing-reply'})}), 'empty-reply');
  const error = await fails(runCliModel({engine: 'codex', input: 'x', env: env({FAKE_MODE: 'boom'})}), 'cli-failed');
  assert.match(error.message, /segmentation fault/);
});

test('an enormous reply is trimmed, not failed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-big-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',is_error:false,result:'y'.repeat(500000)}));});\n`, {mode: 0o755});
  const out = await runCliModel({engine: 'claude', input: 'x', env: {PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}`}});
  // Cut to what the result route takes (48 KB, review I5), and it says so.
  assert.ok(Buffer.byteLength(JSON.stringify(out.text)) <= 48 * 1024 && out.text.length > 40000);
  assert.match(out.text, /\(cut: /);
});

test('runModelTask never throws: a bad request and a failure come back as a structured answer', async t => {
  const {env} = rig(t);
  const bad = await runModelTask({engine: 'gemini', input: 'x'}, {env: env()});
  assert.deepEqual([bad.ok, bad.code], [false, 'bad-request']);
  assert.equal((await runModelTask({engine: 'claude', model: '--bare', input: 'x'}, {env: env()})).code, 'bad-request');
  assert.equal((await runModelTask({engine: 'claude'}, {env: env()})).code, 'bad-request');
  assert.equal((await runModelTask(null, {env: env()})).code, 'bad-request');
  const limited = await runModelTask({engine: 'claude', input: 'x'}, {env: env({FAKE_MODE: 'limit'})});
  assert.deepEqual([limited.ok, limited.code], [false, 'usage-limit']);
  const good = await runModelTask({engine: 'codex', model: '', instructions: 'be nice', input: 'hi'}, {env: env()});
  assert.equal(good.ok, true);
  assert.equal(good.engine, 'codex');
  assert.ok(good.text.includes('hi') && good.text.includes('be nice'));
  assert.equal(typeof good.ms, 'number');
});

test('cliEnv drops the variables that would switch a CLI from the plan to a paid API key', () => {
  const env = cliEnv({PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', CODEX_API_KEY: 'd', CLAUDE_CODE_OAUTH_TOKEN: 'keep'});
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
});

test('codex: every tool that runs commands, drives a browser or the computer is switched off', async () => {
  const {buildCommand} = await import('../agent/cli-model.mjs');
  const {args} = buildCommand('codex', {dir: '/tmp/x'});
  const off = args.flatMap((a, i) => a === '-c' ? [args[i + 1]] : []);
  for (const feature of ['shell_tool', 'unified_exec', 'shell_snapshot', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'apps'])
    assert.ok(off.includes(`features.${feature}=false`), `${feature} must be off`);
});
