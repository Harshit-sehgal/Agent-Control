/** One accent colour per bot through its chat: the send button, its name on its bubbles, the composer's focus
 * ring and the live line all take the bot's tint, in both themes, at WCAG AA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {botAccent, accentStyle, ACCENTS, COLORS} from '../shared/ui-face.js';
import {TINT_COUNT} from '../shared/ui-kit.js';

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const lum = hex => { const [r, g, b] = rgb(hex).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, p) => `#${rgb(a).map((v, i) => Math.round((v * p + rgb(b)[i] * (1 - p)) * 255).toString(16).padStart(2, '0')).join('')}`;
// The grounds of app.css: light bg and surface, dark bg and surface; a bot bubble is its tint at 14% over the surface.
const LIGHT = ['#fbfaf8', '#ffffff'], DARK = ['#1a1a1d', '#222226'];

test('there is one accent for every tint, in both themes', () => {
  assert.equal(ACCENTS.length, TINT_COUNT);
  assert.equal(COLORS.length, TINT_COUNT);
  for (const a of ACCENTS) for (const theme of ['light', 'dark']) for (const key of ['accent', 'on', 'ink']) assert.match(a[theme][key], /^#[0-9a-f]{6}$/);
});

test('every accent passes WCAG AA: words on the button, the name on its bubble, the button against the ground', () => {
  ACCENTS.forEach((a, i) => {
    const pastel = COLORS[i];
    assert.ok(contrast(a.light.on, a.light.accent) >= 4.5, `tint ${i}: light button text`);
    assert.ok(contrast(a.dark.on, a.dark.accent) >= 4.5, `tint ${i}: dark button text`);
    for (const ground of [...LIGHT, mix(pastel, LIGHT[1], 0.14)]) assert.ok(contrast(a.light.ink, ground) >= 4.5, `tint ${i}: light name on ${ground}`);
    for (const ground of [...DARK, mix(pastel, DARK[1], 0.14)]) assert.ok(contrast(a.dark.ink, ground) >= 4.5, `tint ${i}: dark name on ${ground}`);
    // A control and a focus ring need 3:1 against what is next to them.
    for (const ground of LIGHT) assert.ok(contrast(a.light.accent, ground) >= 3, `tint ${i}: light button on ${ground}`);
    for (const ground of DARK) assert.ok(contrast(a.dark.accent, ground) >= 3, `tint ${i}: dark button on ${ground}`);
  });
});

test('a bot takes the accent of its saved tint, else of its place, like its face', () => {
  assert.equal(botAccent({settings: {tint: 3}}), ACCENTS[3]);
  assert.equal(botAccent({settings: {}}, 4), ACCENTS[4]);
  assert.equal(botAccent({settings: {tint: 13}}), ACCENTS[3]);
  assert.equal(botAccent(null), ACCENTS[0]);
});

test('the style sets both themes as custom properties, for app.css to pick from', () => {
  const style = accentStyle(ACCENTS[1]);
  assert.equal(style, `--acc-l:${ACCENTS[1].light.accent};--acc-on-l:${ACCENTS[1].light.on};--acc-ink-l:${ACCENTS[1].light.ink};--acc-d:${ACCENTS[1].dark.accent};--acc-on-d:${ACCENTS[1].dark.on};--acc-ink-d:${ACCENTS[1].dark.ink}`);
  assert.equal(accentStyle(null), '');
});
