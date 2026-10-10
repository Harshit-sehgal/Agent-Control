import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CSP} from '../shared/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [indexHtml, serverJs, css] = await Promise.all([
  readFile(path.join(root, 'shared', 'index.html'), 'utf8'),
  readFile(path.join(root, 'src', 'server.js'), 'utf8'),
  readFile(path.join(root, 'shared', 'app.css'), 'utf8'),
]);

test('the Node header and the Pages meta tag declare one identical CSP', () => {
  const meta = indexHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta, 'The Pages index must declare a CSP meta tag.');
  assert.equal(meta[1], CSP, 'shared/index.html CSP drifted from shared/core.js CSP.');
  // The server must source the policy from the shared constant rather than
  // restating it, so the two can never diverge again.
  assert.match(serverJs, /'Content-Security-Policy':CSP/, 'The server must send the shared CSP constant.');
  assert.doesNotMatch(serverJs, /default-src 'self'/, 'The server must not inline its own copy of the CSP.');
});

test('the CSP denies framing and cross-origin embedding', () => {
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /base-uri 'none'/);
  assert.match(CSP, /form-action 'self'/);
  // No wildcard or https: fallback that would re-open framing or script injection.
  assert.doesNotMatch(CSP, /frame-ancestors \*/);
  assert.doesNotMatch(CSP, /script-src [^;]*(https:|\*)/);
});

test('the server sends clickjacking and sniffing headers on every response', () => {
  assert.match(serverJs, /'X-Frame-Options':'DENY'/);
  assert.match(serverJs, /'X-Content-Type-Options':'nosniff'/);
  // Both the JSON and the static-asset paths must carry them.
  assert.match(serverJs, /function send\(res,status,value,headers=\{\}\)\{[^}]*\.\.\.SECURITY/);
  assert.match(serverJs, /'Content-Security-Policy':CSP,\.\.\.SECURITY/);
});

test('the declared webfont origins are actually the ones used', () => {
  const imported = css.match(/@import url\('([^']+)'\)/g) || [];
  for (const line of imported) {
    assert.match(line, /https:\/\/fonts\.googleapis\.com\//, `Unexpected font origin in app.css: ${line}`);
  }
  assert.ok(imported.length, 'app.css should still import the declared webfonts.');
});
