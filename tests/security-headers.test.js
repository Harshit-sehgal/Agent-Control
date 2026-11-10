import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CSP, META_CSP} from '../shared/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [indexHtml, serverJs, appJs, httpJs, css] = await Promise.all([
  readFile(path.join(root, 'shared', 'index.html'), 'utf8'),
  readFile(path.join(root, 'src', 'server.js'), 'utf8'),
  readFile(path.join(root, 'src', 'app.js'), 'utf8'),
  readFile(path.join(root, 'src', 'http.js'), 'utf8'),
  readFile(path.join(root, 'shared', 'app.css'), 'utf8'),
]);

test('the Node header and the Pages meta tag declare one identical CSP', () => {
  const meta = indexHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta, 'The Pages index must declare a CSP meta tag.');
  assert.equal(meta[1], META_CSP, 'shared/index.html CSP drifted from shared/core.js META_CSP.');
  // A CSP in a <meta> element cannot enforce frame-ancestors: browsers ignore
  // that directive there, so the Pages tag must not claim it. Framing is still
  // denied on the Node build by the header (CSP + X-Frame-Options), and the
  // Pages build is a static file host with nothing to protect behind it.
  assert.doesNotMatch(meta[1], /frame-ancestors/, 'A meta CSP cannot enforce frame-ancestors; do not claim it there.');
  assert.equal(META_CSP, CSP.replace("; frame-ancestors 'none'", ''), 'META_CSP must be the header CSP minus frame-ancestors, never a weaker policy.');
  // The server must source the policy from the shared constant rather than
  // restating it, so the two can never diverge again. The dispatcher that sends
  // it lives in `src/app.js`; `server.js` is now only the listener.
  assert.match(appJs, /'Content-Security-Policy':\s*CSP/, 'The dispatcher must send the shared CSP constant.');
  assert.doesNotMatch(serverJs + appJs, /default-src 'self'/, 'The server must not inline its own copy of the CSP.');
});

test('the CSP denies framing and cross-origin embedding', () => {
  // The header copy, which browsers do obey for this directive.
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
  assert.match(appJs, /'Content-Security-Policy':\s*CSP,\s*\.\.\.SECURITY/);
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

test('HSTS spelled the way every other flag is spelled turns the header on', async () => {
  // `HSTS=true` used to mean "off" while `SMTP_REQUIRE_TLS=false` was the one
  // that meant off: an operator asking for the control silently got none.
  const saved = {HSTS: process.env.HSTS, PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN};
  try {
    delete process.env.PUBLIC_ORIGIN;
    for (const [value, expected] of [['true', true], ['TRUE', true], ['1', true], ['on', true], ['yes', true], ['0', false], ['', false], ['maybe', false]]) {
      if (value === '') delete process.env.HSTS; else process.env.HSTS = value;
      const mod = await import(`../src/http.js?hsts=${encodeURIComponent(value)}`);
      assert.equal(mod.HSTS_ENABLED, expected, `HSTS=${JSON.stringify(value)}`);
      assert.equal(mod.SECURITY['Strict-Transport-Security'] !== undefined, expected, `header for HSTS=${JSON.stringify(value)}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
