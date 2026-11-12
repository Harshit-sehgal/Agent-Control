import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = path.join(root, 'shared');
// The UI is app.js plus every ui-*.js module.
const uiFiles = ['app.js', ...(await readdir(shared)).filter(f => /^ui-.+\.js$/.test(f)).sort()];
const [html, css, shell, profile] = await Promise.all(['index.html', 'app.css', 'shell.css', 'profile.css'].map(f => readFile(path.join(shared, f), 'utf8')));
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

test('there are exactly three stylesheets (tokens and forms, the shell, then the profile screens) and the retired ones are not linked', () => {
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]), ['./app.css', './shell.css', './profile.css']);
  assert.doesNotMatch(html, /polish\.css|usability\.css/);
});

test('the new thread page starts a thread run by Atlas from one box', () => {
  assert.match(app, /id="new-thread-form"/);
  assert.match(app, /export async function startThread\(/);
  // The submit handler is keyed by the form id in the forms table.
  assert.match(app, /'new-thread-form': \(form, f\) => startThread\(f\.message\)/);
  assert.match(app, /api\('\/api\/threads', 'POST', \{message[,}]/);
});

test('navigation marks the current page and dialogs return focus', () => {
  assert.match(app, /aria-current="page"/);
  assert.match(app, /function captureFocus\(/);
  assert.match(app, /function restoreFocus\(/);
});

/* ---------- phone: the six layout defects the mobile pass fixed ---------- */

test('the shell uses the visible height, not the layout viewport', () => {
  // A frame sized by the layout viewport is taller than the screen while a phone's
  // toolbars are out, so the composer ended up behind the collapsed toolbar. The
  // shell is 100dvh, and the old fixed panes are gone.
  assert.match(shell, /\.shell\{height:100dvh/);
  assert.doesNotMatch(css, /\.pane\{/);
});

test('headers step down out of the notch and the status bar', () => {
  // viewport-fit=cover (index.html) draws the page under both; only the toast
  // used the top inset, so the back button rendered under the status bar on a
  // notched phone. Every header takes --pad-t, which is the inset.
  assert.match(html, /viewport-fit=cover/);
  assert.match(shell, /--pad-t:env\(safe-area-inset-top,0px\)/);
  assert.match(shell, /\.cv-head\{[^}]*padding:calc\(12px \+ var\(--pad-t\)\)/);
  assert.match(profile, /\.pr-bar\{[^}]*padding:calc\(14px \+ var\(--pad-t\)\)/);
});

test('every text field is 16px so iOS does not zoom on focus', () => {
  // Safari zooms the page for any focused field under 16px: the phone search, the
  // composer and the shared .input (every form, the memory box, the name boxes).
  assert.match(shell, /\.ch-find input\{[^}]*font-size:16px/);
  assert.match(shell, /\.cv-box textarea\{[^}]*font-size:16px/);
  assert.match(css, /\.input\{[^}]*font-size:16px/);
  assert.match(profile, /\.nb-name\{[^}]*font:500 17px/);
  assert.doesNotMatch(shell + profile, /(?:input|textarea)\{[^}]*font-size:1[0-5]px/);
});

test('touch targets are 44px on a coarse pointer', () => {
  const start = css.indexOf('@media (pointer:coarse)');
  assert.ok(start >= 0, 'the coarse-pointer block must exist');
  const block = css.slice(start, start + 500);
  // Desktop has mouse-sized controls; a finger needs the 44px the file already
  // commits to for .btn, .check-row and .chip.
  for (const rule of [/\.btn\.small\{min-height:44px\}/, /\.contract-fieldset \.check-row\{min-height:44px/, /\.box>form \.check-row\{min-height:44px/]) assert.match(block, rule);
});

test('the phone bottom bar sits 16px from each edge with a fade behind it, and the chrome hides on desktop', () => {
  // Pinned with max(16px, ...) so it cannot run off a narrow phone; the fade stops
  // list rows showing through the search pill.
  assert.match(shell, /\.ch-bar\{position:absolute;left:max\(16px,calc\(50% - 360px\)\);right:max\(16px,calc\(50% - 360px\)\)/);
  assert.match(shell, /\.ch-bar::before\{[^}]*linear-gradient\(to bottom,transparent,var\(--bg\) 45%\)/);
  assert.match(shell, /@media\(min-width:1024px\)\{[\s\S]*?\.chrome\{display:none\}/);
  assert.match(app, /class="ch-thread" data-action="new-thread" aria-label="New thread"/);
});

test('the select chevron follows the theme instead of a hard-coded colour', () => {
  // The chevron was an inline SVG data-URI, and a URL image cannot read a custom
  // property, so the stroke stayed #9a9aa2 in the dark theme.
  assert.doesNotMatch(css, /%239a9aa2/);
  assert.doesNotMatch(css, /select\.input\{[^}]*url\("data:/);
  assert.match(css, /select\.input\{appearance:none;padding-right:34px;background-image:linear-gradient\(45deg,transparent 50%,var\(--muted\) 50%\)/);
  // A `background` shorthand on a select would wipe the image back out, which is
  // why the host selectors below set the colour only.
  assert.match(css, /\.box \.input,\.sheet \.input\{background-color:var\(--raised\)\}/);
  assert.match(css, /\.sheet \.input\{background-color:var\(--surface\)\}/);
});
