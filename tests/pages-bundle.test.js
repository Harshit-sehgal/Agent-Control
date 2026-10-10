import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildScript = await readFile(path.join(root, 'scripts/build-pages.js'), 'utf8');

// Derive the bundle file list straight from the build script so this test can
// never disagree with `npm run build:pages` about what ships to Pages.
const listMatch = buildScript.match(/const files\s*=\s*\[([\s\S]*?)\]/);
assert.ok(listMatch, 'Could not locate the bundle file list in scripts/build-pages.js.');
const bundleFiles = [...listMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
assert.ok(bundleFiles.includes('index.html') && bundleFiles.includes('app.js'), 'Unexpected bundle file list.');

/** Undo the two build-time transformations so docs/ and shared/ are comparable:
 *  content-hash cache-busting (`?v=<hex>`) and the backend marker swap. */
const normalize = (name, body) => {
  const stripped = body.replace(/\?v=[0-9a-f]+/g, '');
  return name === 'index.html' ? stripped.replace('content="static"', 'content="server"') : stripped;
};

test('the shipped docs/ Pages bundle is regenerated from shared/ (no drift)', async () => {
  for (const name of bundleFiles) {
    const [src, built] = await Promise.all([
      readFile(path.join(root, 'shared', name), 'utf8'),
      readFile(path.join(root, 'docs', name), 'utf8'),
    ]);
    assert.equal(normalize(name, built), normalize(name, src), `${name} is stale: run "npm run build:pages"`);
  }
});

test('the Pages bundle keeps its Jekyll bypass marker', async () => {
  await access(path.join(root, 'docs', '.nojekyll'));
});

test('the Pages index is marked browser-local and cache-busted', async () => {
  const built = await readFile(path.join(root, 'docs/index.html'), 'utf8');
  assert.match(built, /<meta name="agent-backend" content="static">/);
  assert.match(built, /\.\/app\.js\?v=[0-9a-f]+/);
});
