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
