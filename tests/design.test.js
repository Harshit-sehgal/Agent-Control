import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = path.join(root, 'shared');
// The UI is app.js plus every ui-*.js module.
const uiFiles = ['app.js', ...(await readdir(shared)).filter(f => /^ui-.+\.js$/.test(f)).sort()];
const [html, css] = await Promise.all(['index.html', 'app.css'].map(f => readFile(path.join(shared, f), 'utf8')));
const app = (await Promise.all(uiFiles.map(f => readFile(path.join(shared, f), 'utf8')))).join('\n');

test('colour is a themed token system: a light and a dark theme, following the system', () => {
  // Both schemes are declared so form controls and scrollbars match either theme.
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  // The default (light) theme's ground is also the initial browser chrome colour.
  const ground = /:root\{[^}]*--bg:(#[0-9a-f]{6})/.exec(css)?.[1];
  assert.ok(ground, 'the default theme must define --bg');
  assert.match(html, new RegExp(`<meta name="theme-color" content="${ground}">`));
  // Every theme must define every colour role, or a pane falls back to the
  // other theme's value and the scheme stops being one family.
  const roles = ['--bg', '--surface', '--raised', '--control', '--line', '--text', '--muted', '--brand', '--on-brand', '--me', '--on-me', '--them', '--wait', '--on-wait', '--wait-bg', '--good', '--good-bg', '--bad', '--bad-bg', '--shade', '--t0-bg', '--t0', '--t0-soft', '--t5-bg', '--t5', '--t5-soft'];
  const themes = [...css.matchAll(/:root(?:\[data-theme="([a-z]+)"\])?\{([^}]*)\}/g)].filter(m => m[2].includes('--surface:'));
  assert.deepEqual(themes.map(m => m[1] || 'cream'), ['cream', 'cocoa']);
  for (const [, name = 'cream', body] of themes) for (const role of roles) assert.ok(body.includes(`${role}:`), `theme ${name} is missing ${role}`);
  assert.match(css, /:root\{\s*color-scheme:light/);
  assert.match(css, /:root\[data-theme="cocoa"\]\{\s*color-scheme:dark/);
  // The picker offers both themes plus "follow the system", which is the default.
  for (const id of ['system', 'cream', 'cocoa']) assert.match(app, new RegExp(`id: '${id}'`));
  assert.match(app, /loadLocal\(THEME_KEY, 'system'\)/);
  assert.match(app, /prefers-color-scheme: dark/);
  // Outside the theme blocks nothing hardcodes a colour, so a theme cannot be bypassed.
  const rest = css.replace(/:root(?:\[data-theme="[a-z]+"\])?\{[^}]*\}/g, '').replace(/@media\(prefers-color-scheme:dark\)\{[^}]*\}\}/, '').replace(/url\("[^"]*"\)/g, '');
  assert.doesNotMatch(rest, /#[0-9a-f]{3,8}\b/i, 'use a colour token instead of a hex value');
});

test('there is exactly one stylesheet and the retired ones are not linked', () => {
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]), ['./app.css']);
  assert.doesNotMatch(html, /polish\.css|usability\.css/);
});

test('home starts a group run from a Grok-style intent prompt', () => {
  assert.match(app, /id="home-prompt"/);
  assert.match(app, /function startGroupChat\(/);
  // The submit handler is keyed by the form id in the forms table.
  assert.match(app, /'home-prompt': \(form, f\) => startGroupChat\(f\.prompt\)/);
});

test('navigation marks the current page and dialogs return focus', () => {
  assert.match(app, /aria-current="page"/);
  assert.match(app, /function captureFocus\(/);
  assert.match(app, /function restoreFocus\(/);
});

/* ---------- phone: the six layout defects the mobile pass fixed ---------- */

test('phone panes use the visible height, not the layout viewport', () => {
  // .app already used 100dvh. A pane pinned with inset:0 is sized by the layout
  // viewport, which is taller than the screen while a phone's toolbars are out,
  // so the composer ended up behind the collapsed toolbar.
  assert.match(css, /\.pane\{position:fixed;inset:0 0 auto;height:100dvh/);
  assert.doesNotMatch(css, /\.pane\{position:fixed;inset:0;/, 'no fixed pane may be pinned to the layout viewport');
});

test('headers step down out of the notch and the status bar', () => {
  // viewport-fit=cover (index.html) draws the page under both; only the toast
  // used the top inset, so "Chats" and the thread's back button rendered under
  // the status bar on a notched phone.
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /\.list-head\{padding-top:calc\(18px \+ env\(safe-area-inset-top\)\)\}/);
  assert.match(css, /\.thread-head,\.pane-head\{min-height:calc\(64px \+ env\(safe-area-inset-top\)\);padding-top:calc\(8px \+ env\(safe-area-inset-top\)\)\}/);
});

test('every text field is 16px so iOS does not zoom on focus', () => {
  // Safari zooms the page for any focused field under 16px, and chat search was
  // the one field that broke the rule.
  assert.match(css, /\.search input\{[^}]*font-size:16px/);
  assert.doesNotMatch(css, /\.search input\{[^}]*font-size:1[0-5]px/);
});

test('touch targets are 44px on a coarse pointer', () => {
  const start = css.indexOf('@media (pointer:coarse)');
  assert.ok(start >= 0, 'the coarse-pointer block must exist');
  const block = css.slice(start, start + 500);
  // Desktop has mouse-sized controls; a finger needs the 44px the file already
  // commits to for .btn, .check-row and .chip.
  for (const rule of [/\.chip\{height:44px/, /\.btn\.small\{min-height:44px\}/, /\.filter\{height:44px/, /\.contract-fieldset \.check-row\{min-height:44px/]) assert.match(block, rule);
});

test('the phone FAB floats above the footer instead of over it', () => {
  // It used to be a sibling pinned at bottom:64px, which covered .list-foot as
  // soon as the two footer lines wrapped. It is now the footer's last child and
  // is anchored above it, so no footer copy can slide under it at any height.
  assert.match(css, /\.list-foot\{position:relative/);
  assert.match(css, /\.fab\{position:absolute;right:18px;bottom:calc\(100% \+ 12px\)/);
  assert.match(app, /<footer class="list-foot">[\s\S]*?data-action="new-chat"[\s\S]*?<\/footer>/);
  // The list keeps room so the last chat can scroll clear of the button.
  assert.match(css, /\.chat-list\{padding-bottom:78px\}/);
});

test('the select chevron follows the theme instead of a hard-coded colour', () => {
  // The chevron was an inline SVG data-URI, and a URL image cannot read a custom
  // property, so the stroke stayed #9a9aa2 in the dark theme.
  assert.doesNotMatch(css, /%239a9aa2/);
  assert.doesNotMatch(css, /select\.input\{[^}]*url\("data:/);
  assert.match(css, /select\.input\{appearance:none;padding-right:34px;background-image:linear-gradient\(45deg,transparent 50%,var\(--muted\) 50%\)/);
  // A `background` shorthand on a select would wipe the image back out, which is
  // why the host selectors below set the colour only.
  assert.match(css, /\.box \.input,\.draft \.input,\.sheet \.input\{background-color:var\(--raised\)\}/);
  assert.match(css, /\.sheet \.input\{background-color:var\(--surface\)\}/);
});
