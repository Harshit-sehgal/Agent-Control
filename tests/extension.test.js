import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [manifest, popup, popupHtml] = await Promise.all([
  readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'),
  readFile(path.join(root, 'extension', 'popup.js'), 'utf8'),
  readFile(path.join(root, 'extension', 'popup.html'), 'utf8'),
]);

test('the capture extension stays minimal and requests origin access on demand', () => {
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.manifest_version, 3);
  // No broad <all_urls> grant: capture stays scoped to a dashboard the user picks.
  assert.ok(!(parsed.host_permissions || []).includes('<all_urls>'), 'Capture must not hold blanket host access.');
  // The server accepts any PORT, so extra origins are opt-in, not pre-granted.
  assert.deepEqual(parsed.optional_host_permissions, ['http://*/*', 'https://*/*']);
  for (const permission of parsed.permissions) {
    assert.ok(['activeTab', 'scripting', 'storage'].includes(permission), `Unexpected permission: ${permission}`);
  }
  assert.match(popup, /chrome\.permissions\.request/);
  assert.match(popup, /chrome\.permissions\.contains/);
  // The requested origin must be the exact configured host, never a wildcard.
  assert.match(popup, /const origin=`\$\{url\.protocol\}\/\/\$\{url\.host\}\/\*`/);
});

test('the capture extension refuses plaintext remote endpoints and empty tokens', () => {
  // HTTPS is required unless the host is explicitly loopback.
  assert.match(popup, /url\.protocol!=='https:'&&!\(\['127\.0\.0\.1','localhost'\]\.includes\(url\.hostname\)&&url\.protocol==='http:'\)/);
  assert.match(popup, /Use HTTPS or localhost HTTP\./);
  assert.match(popup, /if\(!token\)throw new Error\('Enter capture token/);
  // It must still read only the single selected post, never the whole feed.
  assert.match(popup, /window\.getSelection\(\)/);
  assert.match(popupHtml, /Capture one visible post/);
});
