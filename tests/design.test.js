import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [html, css, app] = await Promise.all(
  ['shared/index.html', 'shared/app.css', 'shared/app.js'].map(f => readFile(path.join(root, f), 'utf8')),
);

test('the redesign is one dark monochrome system, not the old light theme', () => {
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /content="#000000"/);
  assert.match(css, /color-scheme:dark/);
  assert.match(css, /--bg:#000000/);
  // The retired light-theme pastel avatar palette must not return; the identity
  // tiles now use dark, tint-matched pairs that keep their glyphs legible.
  assert.doesNotMatch(app, /#eeebff/);
  assert.doesNotMatch(app, /#f7f8fb/);
});

test('home starts a group run from a Grok-style intent prompt', () => {
  assert.match(app, /id="home-prompt"/);
  assert.match(app, /function startGroupChat\(/);
  assert.match(app, /case 'home-prompt'/);
});

test('navigation marks the current page and dialogs return focus', () => {
  assert.match(app, /aria-current="page"/);
  assert.match(app, /function captureFocus\(/);
  assert.match(app, /function restoreFocus\(/);
});
