import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CSP} from '../shared/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [indexHtml, serverJs, httpJs, css] = await Promise.all([
  readFile(path.join(root, 'shared', 'index.html'), 'utf8'),
  readFile(path.join(root, 'src', 'server.js'), 'utf8'),
  readFile(path.join(root, 'src', 'http.js'), 'utf8'),
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
  assert.match(httpJs, /'X-Frame-Options':'DENY'/);
  assert.match(httpJs, /'X-Content-Type-Options':'nosniff'/);
  // Both the JSON and the static-asset paths must carry them.
  assert.match(httpJs, /function send\(res,status,value,headers=\{\}\)\{[^}]*\.\.\.SECURITY/);
  assert.match(serverJs, /'Content-Security-Policy':CSP,\.\.\.SECURITY/);
});

test('no external font or stylesheet origin is imported and the CSP declares none', () => {
  // The redesign dropped web fonts for the system font stack, so nothing may
  // load from a third-party origin and the policy must not leave one open.
  assert.doesNotMatch(css, /@import/, 'app.css must not import anything.');
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)].map(m => m[2]);
  for (const url of urls) assert.match(url, /^data:/, `app.css may only reference inline data: URLs, found ${url}`);
  assert.doesNotMatch(css, /@font-face/, 'No custom font files are shipped.');
  assert.doesNotMatch(indexHtml, /<link[^>]+href="https?:/i, 'index.html must not link an external stylesheet or font.');
  assert.doesNotMatch(indexHtml, /<(script|link)[^>]+(src|href)="(https?:)?\/\//i, 'index.html must load only same-origin assets.');
  assert.doesNotMatch(css + indexHtml, /googleapis|gstatic/i);
  assert.doesNotMatch(CSP, /googleapis|gstatic|https?:/i, 'The CSP must not whitelist an external origin.');
  assert.match(CSP, /font-src 'self'/);
  assert.match(CSP, /style-src 'self' 'unsafe-inline'/);
  assert.match(css, /--font:system-ui,/, 'app.css should use the system font stack.');
});
