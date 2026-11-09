/** `.env` loading (src/env.js) behaviour, which the suite never executed: every
 * other test runs with AGENT_SKIP_DOTENV=1, so only the early return ran and the
 * parser/restore path was unverified.
 *
 * `loadDotEnv(root)` takes the directory, so each case gets a temp dir; no test
 * touches the repository's own `.env` and no secret value is ever printed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Import the module with loading switched off: importing it runs
// `loadDotEnv()` against the repository root, and a developer's .env must not
// change this process.
const previousSkip = process.env.AGENT_SKIP_DOTENV;
process.env.AGENT_SKIP_DOTENV = '1';
const {loadDotEnv} = await import('../src/env.js');
if (previousSkip === undefined) delete process.env.AGENT_SKIP_DOTENV;
else process.env.AGENT_SKIP_DOTENV = previousSkip;

/** Call loadDotEnv with the global skip unset, then put the flag back, so these
 * cases work under `AGENT_SKIP_DOTENV=1 node --test` and under plain `npm test`. */
async function load(dir){
  const saved = process.env.AGENT_SKIP_DOTENV;
  delete process.env.AGENT_SKIP_DOTENV;
  try { return loadDotEnv(dir); }
  finally {
    if (saved === undefined) delete process.env.AGENT_SKIP_DOTENV;
    else process.env.AGENT_SKIP_DOTENV = saved;
  }
}

async function tempDir(){
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agent-env-'));
}

/** Names only: an assertion message must never paste the environment (this
 * machine's shell exports real tokens), and a name diff is what "unchanged"
 * means here. Values are asserted one key at a time. */
const envNames = () => Object.keys(process.env).sort();

/** A key nothing else uses, so "was it added" is unambiguous. */
const NEW_KEY = 'AGENT_ENV_TEST_NEW_SETTING';
const REAL_KEY = 'AGENT_ENV_TEST_REAL_SETTING';

test('real environment variables win over .env, and only new settings count', async () => {
  const dir = await tempDir();
  const before = {...process.env};
  try {
    process.env[REAL_KEY] = 'from-the-real-environment';
    delete process.env[NEW_KEY];
    await fs.writeFile(path.join(dir, '.env'), `${REAL_KEY}=from-the-dotenv-file\n${NEW_KEY}=only-in-the-file\n`);

    const {loaded} = await load(dir);

    assert.equal(process.env[REAL_KEY], 'from-the-real-environment',
      'an exported variable must not be overwritten by .env');
    assert.equal(process.env[NEW_KEY], 'only-in-the-file', '.env must contribute settings that are not already set');
    assert.equal(loaded, 1, 'loaded must count the settings this file added, not every key it mentions');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    for (const [key, value] of Object.entries(before)) process.env[key] = value;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a directory with no .env changes nothing and reports zero', async () => {
  const dir = await tempDir();
  const before = {...process.env};
  try {
    const result = await load(dir);
    assert.deepEqual(result, {loaded: 0});
    assert.deepEqual(envNames(), Object.keys(before).sort(), 'a missing .env must not add or remove a variable');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('junk in .env does not throw and does not clobber a real value', async () => {
  const dir = await tempDir();
  const before = {...process.env};
  try {
    process.env[REAL_KEY] = 'must-survive';
    delete process.env[NEW_KEY];
    await fs.writeFile(path.join(dir, '.env'), [
      'this line is not an assignment',
      '###',
      '=no-name',
      `${NEW_KEY}=dotenv-must-not-win`,
      'NO_EQUALS_SIGN',
      `${REAL_KEY}=dotenv-must-not-win`,
      '',
    ].join('\n'));

    const result = await load(dir);

    assert.equal(process.env[REAL_KEY], 'must-survive', 'junk must not overwrite a real variable');
    assert.equal(typeof result.loaded, 'number', 'a junk file still has to report a count');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    for (const [key, value] of Object.entries(before)) process.env[key] = value;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a loader failure mid-write is rolled back instead of left half-applied', async () => {
  const dir = await tempDir();
  const PARTIAL_KEY = 'AGENT_ENV_TEST_PARTIAL_SETTING';
  const namesBefore = envNames();
  const warnings = [];
  const realWarn = console.warn;
  const realLoader = process.loadEnvFile;
  try {
    console.warn = message => warnings.push(String(message));
    // The native loader can fail after touching the environment (a corrupt
    // value, a permission problem on a later line). The module's snapshot and
    // restore is the only thing that keeps that from being half a boot.
    process.loadEnvFile = () => {
      process.env[PARTIAL_KEY] = 'written-before-the-failure';
      throw Object.assign(new Error('simulated parse failure'), {code: 'EBOOM'});
    };

    const result = await load(dir);

    assert.deepEqual(result, {loaded: 0});
    assert.equal(process.env[PARTIAL_KEY], undefined, 'a setting written by a failed load must be removed again');
    assert.deepEqual(envNames(), namesBefore, 'a failed load must restore the exact previous environment');
    assert.equal(warnings.length, 1, 'a failure other than a missing .env must be reported once');
    assert.match(warnings[0], /could not load \.env/);
  } finally {
    process.loadEnvFile = realLoader;
    console.warn = realWarn;
    delete process.env[PARTIAL_KEY];
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a .env that cannot be read is warned about and leaves the environment untouched', async () => {
  const dir = await tempDir();
  const warnings = [];
  const realWarn = console.warn;
  const before = {...process.env};
  process.env[REAL_KEY] = 'must-survive';
  const namesBefore = envNames();
  try {
    // A directory where the file should be: the loader throws, and the module's
    // catch/restore path is the only thing standing between a partial load and
    // a half-configured process environment.
    await fs.mkdir(path.join(dir, '.env'));
    console.warn = message => warnings.push(String(message));

    const result = await load(dir);

    assert.deepEqual(result, {loaded: 0});
    assert.deepEqual(envNames(), namesBefore, 'a failed load must not add or remove a variable');
    assert.equal(process.env[REAL_KEY], 'must-survive', 'a failed load must not change a value');
    assert.equal(warnings.length, 1, 'a failure other than a missing .env must be reported once');
    assert.match(warnings[0], /could not load \.env/);
  } finally {
    console.warn = realWarn;
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    for (const [key, value] of Object.entries(before)) process.env[key] = value;
    await fs.rm(dir, {recursive: true, force: true});
  }
});
