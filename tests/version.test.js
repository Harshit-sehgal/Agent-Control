import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('package.json, the extension manifest and the health endpoint agree on the version', async () => {
  // The version used to be restated as a literal in src/server.js, so a release
  // bump to package.json silently drifted from /api/health.
  const [pkg, manifest, serverJs] = await Promise.all([
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')),
    JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8')),
    readFile(path.join(root, 'src', 'server.js'), 'utf8'),
  ]);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version must be semver.');
  assert.equal(manifest.version, pkg.version, 'The extension manifest drifted from package.json.');
  // The health endpoint must read the package version, not restate a literal.
  assert.match(serverJs, /version:VERSION/, 'The health endpoint must serve the shared VERSION constant.');
  assert.doesNotMatch(serverJs, /version:'\d+\.\d+\.\d+'/, 'The server restates the version as a literal.');
});
