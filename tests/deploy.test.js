// The deployment files are code: compose reads variables, the Dockerfile picks
// the runtime and the docs tell an operator what to type. They drifted once
// already — `deploy/compose.yaml` required DOMAIN while `.env.example` had no
// such key, so the documented first command failed and the image on the host
// went four weeks stale. These checks are cheap and they run in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const compose = read('deploy/compose.yaml');
const example = read('.env.example');
const dockerfile = read('Dockerfile');
const deployment = read('docs/DEPLOYMENT.md');

/** `${VAR:?message}` — compose refuses to start without these. */
const requiredVars = [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)].map(m => m[1]);

/** Every `KEY=` line in a dotenv file, mapped to its value. A commented line is
 * not a definition. */
const envKeys = source => new Map(
  source.split('\n')
    .map(line => line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map(m => [m[1], m[2].trim()]),
);

test('every variable compose requires is offered by .env.example', () => {
  assert.ok(requiredVars.length, 'compose no longer requires any variable — did the check go stale?');
  const offered = envKeys(example);
  for (const name of requiredVars) {
    assert.ok(offered.has(name), `.env.example is missing ${name}, which deploy/compose.yaml requires, so \`cp ../.env.example .env\` produces a file compose rejects`);
    // ${NAME:?} rejects an empty value as well as a missing key, so a bare
    // `NAME=` in the example reproduces the same broken first run.
    assert.ok(offered.get(name), `.env.example sets ${name} to nothing; compose refuses to start on an empty value, so give the example a visible placeholder`);
  }
});

test('the deploy recipe names the same source file compose reads', () => {
  // `cp ../.env.example .env` inside deploy/ is the documented first step.
  assert.match(compose, /cp \.\.\/\.env\.example \.env/, 'the compose header should still show the copy step');
  assert.match(deployment, /cp \.\.\/\.env\.example \.env/, 'the deployment guide should show the same copy step');
  assert.match(compose, /env_file:\s*\.env/, 'compose should load deploy/.env');
});

test('the data volume and DATA_FILE agree on one directory', () => {
  const dataFile = compose.match(/DATA_FILE:\s*(\S+)/)?.[1];
  assert.ok(dataFile, 'compose should set DATA_FILE');
  const mount = compose.match(/-\s*(\w+):(\/[^\s]+)/);
  assert.ok(mount, 'compose should mount a volume for the database');
  const [, volume, target] = mount;
  assert.equal(volume, 'data', `the database volume should be named data, not ${volume}`);
  assert.ok(dataFile.startsWith(target.endsWith('/') ? target : `${target}/`),
    `DATA_FILE ${dataFile} is outside the mounted volume ${target}, so the database would not survive a restart`);
  assert.match(compose, /^volumes:\s*\n\s+data:/m, 'the data volume should be declared');
});

test('the container runs the same sqlite-enabled entrypoint as npm start', () => {
  const pkg = JSON.parse(read('package.json'));
  const start = pkg.scripts.start;
  assert.match(start, /--experimental-sqlite/, 'npm start should enable node:sqlite');
  assert.match(dockerfile, /--experimental-sqlite/, 'the image should enable node:sqlite');
  assert.match(dockerfile, /src\/server\.js/, 'the image should start the server');
  // Node 22 is the supported floor in .nvmrc; the image must not drift below it.
  const image = dockerfile.match(/^FROM\s+node:(\d+)/m)?.[1];
  const pinned = read('.nvmrc').trim().replace(/^v/, '');
  assert.ok(image, 'the Dockerfile should start FROM a node image');
  assert.ok(Number(image) >= Number(pinned.split('.')[0]),
    `the image uses Node ${image} but the project floor is ${pinned}`);
});
