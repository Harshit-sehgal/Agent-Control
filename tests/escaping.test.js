import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validHttpUrl, cleanText} from '../shared/core.js';
import * as kit from '../shared/ui-kit.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The UI is app.js plus every ui-*.js module.
const uiFiles = ['app.js', ...(await readdir(path.join(root, 'shared'))).filter(f => /^ui-.+\.js$/.test(f)).sort()];
const sources = Object.fromEntries(await Promise.all(uiFiles.map(async f => [f, await readFile(path.join(root, 'shared', f), 'utf8')])));
const app = Object.values(sources).join('\n');

// The real escaping helper the UI uses (shared/ui-kit.js), imported so this test
// fails if the implementation is weakened rather than trusting a regex on the source.
const {esc} = kit;

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

// ---- static scan of every HTML-producing template ----------------------------------

/** Walk JS source and return every template literal with its static text and the
 * source of each ${...} expression (nested templates are returned as their own
 * entries too). Handles strings, comments and regex literals so a backtick or quote
 * inside them cannot desynchronise the scan. */
function scanTemplates(src) {
  const templates = [];
  let i = 0;
  const skipString = quote => { i++; while (i < src.length && src[i] !== quote) { if (src[i] === '\\') i++; i++; } i++; };
  function code(untilBrace) {
    let depth = 0, prev = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === "'" || c === '"') { skipString(c); prev = '"'; continue; }
      if (c === '`') { template(); prev = '`'; continue; }
      if (c === '/') {
        if (prev === '' || '(,=:[!&|?{};>'.includes(prev)) { // regex literal
          i++; let inClass = false;
          while (i < src.length && (src[i] !== '/' || inClass)) { if (src[i] === '\\') i++; else if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; i++; }
          i++; prev = '/'; continue;
        }
        prev = '/'; i++; continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (untilBrace && depth === 0) return; depth--; }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  function template() {
    const t = {start: i, statics: '', exprs: []};
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { t.statics += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; const from = i; code(true); t.exprs.push({at: from, text: src.slice(from, i)}); i++; continue; }
      t.statics += src[i++];
    }
    i++;
    templates.push(t);
  }
  code(false);
  return templates;
}

/** Remove balanced `name(...)` calls from `text`. */
function stripCalls(text, names) {
  const re = new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\(`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    let depth = 1, j = re.lastIndex;
    while (j < text.length && depth) { if (text[j] === '(') depth++; else if (text[j] === ')') depth--; j++; }
    out += text.slice(last, m.index); last = j; re.lastIndex = j;
  }
  return out + text.slice(last);
}

// Helpers that escape every user-text argument themselves. Each one is checked
// behaviorally in the next test, so an expression passed through them may name a
// user-text property without its own esc(). `pageHead` escapes title and sub; its
// `right` slot only ever receives iconBtn(...) markup.
const ESCAPING_HELPERS = ['esc', 'btn', 'iconBtn', 'tag', 'empty', 'avatar', 'groupAvatar', 'pageHead'];
const USER_TEXT = /\??\.(text|instructions|name|author|description|message|topic|claim|label|title|email|error)\b(?!\s*:)/;
// A property used only as a ternary / && condition is tested, not printed.
const CONDITION = /[\w$.\]\[?]+?\s*(?:\?(?!\.)|&&)/g;
const unsafeProp = expr => stripCalls(expr, ESCAPING_HELPERS).replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(CONDITION, ' ').match(USER_TEXT)?.[0];
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

// Interpolations that name a user-text property but are NOT user text or are escaped
// somewhere this scan cannot see. Each entry was verified by reading the code.
const EXCEPTIONS = [
  // ADMIN_PAGES is a module constant ('Team and access', ...), not user input.
  {file: 'ui-panel.js', includes: 'ADMIN_PAGES[p].title'},
];
const excepted = (file, expr) => EXCEPTIONS.some(x => x.file === file && expr.includes(x.includes));

test('the escaping helpers neutralize hostile text in every slot they accept', () => {
  // Backs the ESCAPING_HELPERS exception above: these are the helpers whose
  // arguments the static scan below trusts.
  const bad = '<img src=x onerror=alert(1)>"\'';
  const markup = [
    kit.btn(bad, bad, {id: bad, data: {x: bad}, glyph: 'plus'}),
    kit.iconBtn('plus', bad, bad, {id: bad, data: {x: bad}}),
    kit.tag(bad, bad.replace(/\W/g, '')),
    kit.empty(bad, bad),
    kit.avatar(bad, 0),
    kit.groupAvatar([{name: bad, tint: 0}, {name: bad, tint: 1}]),
    kit.pageHead(bad, {sub: bad}),
    kit.box('', bad),
    kit.field(bad, '', bad),
  ];
  for (const html of markup) {
    // Blank every quoted attribute value and every text node: whatever is left
    // is markup structure, which must not contain the payload's tag or handler.
    const structure = html.replace(/="[^"]*"/g, '=""').replace(/>[^<]*</g, '><');
    assert.doesNotMatch(structure, /<img|onerror/i, `Payload escaped its slot in: ${html}`);
  }
});

test('every HTML template escapes the user text it interpolates', () => {
  // Bot names, instructions, post text, authors, topics, claims and error messages
  // all originate from users or the network. For every template literal that
  // contains an HTML tag, each ${...} that names such a property must route it
  // through esc() (or a helper that escapes, see ESCAPING_HELPERS).
  const problems = [];
  let scanned = 0, interpolations = 0;
  for (const [file, src] of Object.entries(sources)) {
    for (const t of scanTemplates(src)) {
      if (!/<[a-zA-Z/!]/.test(t.statics)) continue;
      scanned++;
      for (const e of t.exprs) {
        interpolations++;
        const hit = unsafeProp(e.text);
        if (hit && !excepted(file, e.text)) problems.push(`shared/${file}:${lineOf(src, e.at)} unescaped ${hit} in \${${e.text.trim().slice(0, 80)}}`);
      }
    }
  }
  assert.ok(scanned > 40 && interpolations > 200, `Scanner looks broken (${scanned} templates, ${interpolations} interpolations).`);
  assert.deepEqual(problems, [], `Unescaped user text in an HTML template:\n${problems.join('\n')}`);
});

test('raw-HTML helper slots never receive unescaped user text', () => {
  // row({title, sub, right, lead}), note(text), actionRow(...) and fact(...) insert
  // their arguments as markup, so callers must escape. Same rule as above.
  const problems = [];
  let calls = 0;
  for (const [file, src] of Object.entries(sources)) {
    const re = /(?<![\w$.])(row|note|actionRow|fact)\(/g;
    let m;
    while ((m = re.exec(src))) {
      let depth = 1, j = re.lastIndex;
      while (j < src.length && depth) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; }
      const args = src.slice(re.lastIndex, j - 1);
      calls++;
      const hit = unsafeProp(args);
      if (hit && !excepted(file, args)) problems.push(`shared/${file}:${lineOf(src, m.index)} ${m[1]}(...) takes unescaped ${hit}`);
    }
  }
  assert.ok(calls > 40, `Scanner looks broken (${calls} helper calls).`);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the UI has no other HTML sinks', () => {
  // innerHTML is fed only by escaping template literals; these alternatives would
  // bypass that discipline entirely.
  assert.doesNotMatch(app, /document\.write\(|insertAdjacentHTML\(|\.outerHTML\s*=|new Function\(|\beval\(/);
  // Error text from the network is shown with textContent, never as markup.
  assert.match(app, /node\.textContent = message/);
  assert.match(app, /el\('main'\)\.querySelector\('p'\)\.textContent = e\.message/);
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
