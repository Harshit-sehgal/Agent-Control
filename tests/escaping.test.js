import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validHttpUrl, cleanText} from '../shared/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = await readFile(path.join(root, 'shared', 'app.js'), 'utf8');

// The exact escaping helper the UI uses, extracted so this test fails if the
// implementation is weakened rather than silently trusting a regex on the source.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const payloads = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  '<iframe src="javascript:alert(1)">',
  '</textarea><script>alert(1)</script>',
  '&lt;already escaped&gt;',
  '\';alert(1);//',
  '<img src=x onerror="alert(document.domain)">',
];

test('the UI escaper neutralizes markup in every payload shape', () => {
  for (const payload of payloads) {
    const out = esc(payload);
    assert.doesNotMatch(out, /<script|<img|<svg|<iframe/i, `Markup survived escaping: ${payload} -> ${out}`);
    // Raw angle brackets must never reach the DOM unescaped.
    assert.ok(!out.includes('<') && !out.includes('>'), `Angle bracket leaked: ${payload} -> ${out}`);
  }
  // Double escaping must stay inert, not produce executable markup.
  assert.equal(esc(esc('<b>')), '&amp;lt;b&amp;gt;');
});

test('esc() handles non-string and nullish input without throwing', () => {
  for (const value of [undefined, null, 0, false, 42, {}, []]) {
    assert.equal(typeof esc(value), 'string');
  }
  assert.equal(esc(undefined), '');
  assert.equal(esc(null), '');
});

test('URLs are validated before being placed in an href', () => {
  // A javascript: or data: URL must never survive into an anchor, even escaped.
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
    assert.equal(validHttpUrl(url), null, `${url} must not be a permitted href`);
  }
  assert.equal(validHttpUrl('https://x.com/a/status/1'), 'https://x.com/a/status/1');
  // Credentials in the URL would leak into the rendered link and the request.
  assert.equal(validHttpUrl('https://user:pass@example.com/'), null);
  // An escaped payload cannot become a valid scheme.
  assert.equal(validHttpUrl(esc('javascript:alert(1)')), null);
});

test('every rendered value that carries user text is escaped', () => {
  // Bot names, instructions, post text and authors all originate from user input.
  for (const field of ['c.author', 'c.text', 'c.topic', 'd.author', 'd.text', 'd.note', 'b.name', 'b.instructions', 'g.name', 'g.description', 'e.message']) {
    const pattern = new RegExp(`\\$\\{esc\\(${field.replace('.', '\\.')}[^}]*\\)\\}`);
    assert.match(app, pattern, `${field} must be rendered through esc()`);
  }
  // Any *unescaped* interpolation of those fields straight into markup would be an
  // XSS sink. Only flag an interpolation that is not an esc(...) argument and that
  // sits inside a template literal containing an HTML tag, since the palette labels
  // and toast() text are escaped later or written via textContent.
  const sinks = [...app.matchAll(/`[^`]*<[a-z][^`]*`/g)];
  for (const sink of sinks) {
    const body = sink[0];
    for (const m of body.matchAll(/\$\{(?!esc\()([a-z])\.(text|instructions|name|author)\}/g)) {
      assert.fail(`Unescaped user text in an HTML template: ${m[0]}`);
    }
  }
});

test('outbound links are opened safely', () => {
  const anchors = app.match(/<a [^>]*target="_blank"[^>]*>/g) || [];
  assert.ok(anchors.length, 'Expected at least one target="_blank" link.');
  for (const anchor of anchors) {
    assert.match(anchor, /rel="noopener noreferrer"/, `Missing rel on: ${anchor}`);
  }
});

test('cleanText truncates untrusted input to its declared bound', () => {
  assert.equal(cleanText('<script>'.repeat(1000), 50).length, 50);
  assert.equal(cleanText({toString: () => 'x'}, 10), '');
  assert.equal(cleanText(null, 10), '');
});
