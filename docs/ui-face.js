/** A bot's face: a small character drawn as one inline SVG, ported from the
 * approved mock (docs/superpowers/specs/2026-11-11-primary-bot-platform-mock.html).
 * Three-quarter view: eyes in the top fifth turned to the right, the far eye
 * narrower, blush between eyes and mouth, a catch-light in each eye, soft shade
 * on the far side and under the chin, and a star badge bottom left for the
 * primary. Pure string builder: no DOM, no globals. Motion is CSS only; this
 * file just names the classes (face--sway, face--nod, face--blink2, face--hop)
 * and the state (face--awake|asleep|working|waiting). Muting on dark is a CSS
 * filter on `.face`, since the theme is not known here. */
import {esc} from './ui-kit.js?v=8efaefd342';

export const SHAPES = ['rounded', 'circle', 'hexagon', 'pebble', 'drop', 'shield', 'arch', 'egg', 'blob', 'bean'];

/** The mock's ten pastel tints, in index order. `bot.settings.tint` indexes this list.
 * bot-settings validates tint against TINT_COUNT (10, ui-kit.js), so all ten are valid. */
export const COLORS = ['#9ee0e6', '#c6b7f7', '#f7b8a8', '#b5e3a1', '#f5d38a', '#f2a7c8', '#a9c8f5', '#d9c7a8', '#f6c49a', '#c9c7cf'];

let drawn = 0;
const STATES = ['awake', 'asleep', 'working', 'waiting'];
const INK = '#1b1a18';

// A CSS border-radius on a 100 box as a path: horizontal and vertical radii for
// the top-left, top-right, bottom-right and bottom-left corners.
const rr = (h, v) => `M${h[0]},0H${100 - h[1]}A${h[1]},${v[1]} 0 0 1 100,${v[1]}V${100 - v[2]}A${h[2]},${v[2]} 0 0 1 ${100 - h[2]},100H${h[3]}A${h[3]},${v[3]} 0 0 1 0,${100 - v[3]}V${v[0]}A${h[0]},${v[0]} 0 0 1 ${h[0]},0Z`;
const even = r => rr([r, r, r, r], [r, r, r, r]);
const PATHS = {
  rounded: even(30),
  circle: even(50),
  pebble: rr([58, 42, 52, 48], [48, 56, 44, 52]),
  drop: rr([50, 50, 50, 14], [50, 50, 50, 14]),
  shield: rr([22, 22, 50, 50], [22, 22, 50, 50]),
  arch: rr([50, 50, 16, 16], [50, 50, 16, 16]),
  egg: rr([50, 50, 50, 50], [60, 60, 40, 40]),
  blob: rr([63, 37, 54, 46], [55, 48, 52, 45]),
  bean: rr([46, 54, 40, 60], [60, 40, 60, 40]),
};
const HEX = '25,3 75,3 99,50 75,97 25,97 1,50';
const outline = (shape, cls, fill) => shape === 'hexagon'
  ? `<polygon class="${cls}" points="${HEX}" fill="${fill}"/>` : `<path class="${cls}" d="${PATHS[shape]}" fill="${fill}"/>`;

const mix = (hex, to, pct) => '#' + [1, 3, 5].map(i => {
  const a = parseInt(hex.slice(i, i + 2), 16), b = parseInt(to.slice(i, i + 2), 16);
  return Math.round(a + (b - a) * pct).toString(16).padStart(2, '0');
}).join('');

const EYES = {
  open: `<rect class="face-eye" x="37" y="19" width="12" height="19" rx="6" fill="${INK}"/><rect class="face-eye" x="71" y="20" width="10" height="17.5" rx="5" fill="${INK}"/><ellipse class="face-light" cx="41.2" cy="22.8" rx="1.8" ry="1.9" fill="#fff" fill-opacity=".7"/><ellipse class="face-light" cx="74.5" cy="23.5" rx="1.5" ry="1.75" fill="#fff" fill-opacity=".7"/><path class="face-joy" d="M37,34 Q43,21 49,34" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round"/><path class="face-joy" d="M71.5,33 Q76,22 80.5,33" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`,
  closed: `<rect class="face-eye" x="37" y="29" width="12" height="5" rx="2.5" fill="${INK}" fill-opacity=".6"/><rect class="face-eye" x="71" y="29.5" width="10" height="4.5" rx="2.25" fill="${INK}" fill-opacity=".6"/>`,
};
const MOUTHS = {
  awake: `<rect class="face-mouth" x="50" y="48" width="15" height="5" rx="2.5" fill="${INK}" fill-opacity=".5"/>`,
  working: `<rect class="face-mouth" x="53" y="44" width="11" height="9" rx="4.5" fill="${INK}" fill-opacity=".5"/>`,
  waiting: `<rect class="face-mouth" x="53" y="42" width="10" height="11" rx="5" fill="${INK}" fill-opacity=".6"/>`,
  asleep: '',
};
const SLEEP_Z = `<text class="face-z" x="80" y="16" aria-hidden="true">z</text>`;
const STAR = `<circle class="face-star" cx="16" cy="84" r="15" fill="#f5a524" style="stroke:var(--bg,#fff);stroke-width:3"/><path class="face-star-mark" transform="translate(6.7 74.7) scale(.775)" d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="#fff"/>`;

/** `bot` is a stored bot ({id, name, settings:{lead, shape, tint}}). Options:
 * size (px, default 40), state ('awake'|'asleep'|'working'|'waiting'), primary,
 * manager (role shape), index (the bot's position, used when settings.tint is
 * null, like tintOf), motion (default true), hop (play the happy hop once). */
export function face(bot, {size = 40, state = 'awake', primary = false, manager = false, index = 0, motion = true, hop = false} = {}) {
  const settings = bot?.settings || {};
  const isPrimary = Boolean(primary || settings.lead === true);
  const shape = SHAPES.includes(settings.shape) ? settings.shape : isPrimary ? 'circle' : manager ? 'hexagon' : 'rounded';
  const tint = Number.isInteger(settings.tint) ? settings.tint : Math.max(0, Math.trunc(Number(index)) || 0);
  const color = COLORS[Math.abs(tint) % COLORS.length];
  const px = Number(size) > 0 ? Math.round(Number(size)) : 40;
  const st = STATES.includes(state) ? state : 'awake';
  const name = String(bot?.name ?? '');
  const cls = ['face', `face--${st}`];
  if (motion) {
    if (st === 'awake') cls.push('face--sway');
    if (st === 'working') cls.push('face--nod');
    if (name.length % 2) cls.push('face--blink2');
    if (hop) cls.push('face--hop');
  }
  // Every face owns its gradient ids. Faces repeat on one page (the sidebar and the
  // phone list both draw Atlas), and a url(#id) that resolves to a gradient inside a
  // display:none svg paints nothing.
  const uid = (++drawn).toString(36), gid = `fb${uid}`, sid = `fs${uid}`, rid = `fr${uid}`;
  const eyes = st === 'asleep' ? EYES.closed : EYES.open;
  const look = st === 'waiting' ? ' transform="translate(7 7)"' : '';
  return `<svg class="${esc(cls.join(' '))}" data-shape="${esc(shape)}" viewBox="0 0 100 100" width="${px}" height="${px}" style="--d:${(name.length % 5) * 0.9}s" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="${gid}" x1=".37" y1="0" x2=".63" y2="1"><stop offset="0" stop-color="${mix(color, '#ffffff', 0.14)}"/><stop offset=".7" stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient>`
    // Light falls from the top left, so the head is shaded under the chin (fs) and down the far, right side (fr), like the mock's two inset shadows.
    + `<linearGradient id="${sid}" x1="0" y1="0" x2="0" y2="1"><stop offset=".78" stop-color="#000" stop-opacity="0"/><stop offset=".93" stop-color="#000" stop-opacity=".09"/><stop offset="1" stop-color="#000" stop-opacity=".14"/></linearGradient>`
    + `<linearGradient id="${rid}" x1="0" y1="0" x2="1" y2="0"><stop offset=".86" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".09"/></linearGradient></defs>`
    + outline(shape, 'face-body', `url(#${gid})`) + outline(shape, 'face-shade', `url(#${sid})`) + outline(shape, 'face-shade-far', `url(#${rid})`)
    + `<ellipse class="face-blush" cx="31" cy="44.5" rx="8" ry="4.5" fill="#ff6978" fill-opacity=".2"/><ellipse class="face-blush" cx="88.5" cy="44.5" rx="5.5" ry="4.5" fill="#ff6978" fill-opacity=".2"/>`
    + `<g class="face-eyes"${look}>${eyes}</g>${MOUTHS[st]}${st === 'asleep' && px >= 36 ? SLEEP_Z : ''}${isPrimary && px >= 40 ? STAR : ''}</svg>`;
}

/** The tint colour a bot is drawn in (and its bubbles are washed with): the
 * settings.tint index, else the bot's position, like `face`. */
export function botColor(bot, index = 0) {
  const tint = Number.isInteger(bot?.settings?.tint) ? bot.settings.tint : Math.max(0, Math.trunc(Number(index)) || 0);
  return COLORS[Math.abs(tint) % COLORS.length];
}

/** Each tint's accent for that bot's chat, in tint order: `accent` fills the send button and draws the focus ring and
 * the live line, `on` is what sits on it, `ink` writes the bot's name on its bubbles. Light is a mid tone of the face's
 * hue; dark is the face's own pastel. Every pair passes WCAG AA (tests/bot-accent.test.js). */
export const ACCENTS = [
  {light: {accent: '#389ca6', on: '#0d2426', ink: '#2c7a81'}, dark: {accent: '#9ee0e6', on: '#102b2e', ink: '#8ddbe2'}},
  {light: {accent: '#967fe1', on: '#130d26', ink: '#5630cf'}, dark: {accent: '#c6b7f7', on: '#160f2e', ink: '#af9bed'}},
  {light: {accent: '#d87258', on: '#26120d', ink: '#bc492c'}, dark: {accent: '#f7b8a8', on: '#2e150f', ink: '#ea9a86'}},
  {light: {accent: '#599e3b', on: '#15250e', ink: '#467c2e'}, dark: {accent: '#b5e3a1', on: '#192d11', ink: '#a8de91'}},
  {light: {accent: '#b2862a', on: '#261e0d', ink: '#8c6a21'}, dark: {accent: '#f5d38a', on: '#2e240f', ink: '#eaca86'}},
  {light: {accent: '#da699b', on: '#260d18', ink: '#c53071'}, dark: {accent: '#f2a7c8', on: '#2e0f1d', ink: '#ea88b3'}},
  {light: {accent: '#5e90d9', on: '#0d1726', ink: '#2f6cc6'}, dark: {accent: '#a9c8f5', on: '#0f1c2e', ink: '#86aeea'}},
  {light: {accent: '#aa8a53', on: '#221c11', ink: '#846b40'}, dark: {accent: '#d9c7a8', on: '#292114', ink: '#d4bf9c'}},
  {light: {accent: '#cf7a33', on: '#26180d', ink: '#a15e26'}, dark: {accent: '#f6c49a', on: '#2e1d0f', ink: '#eab386'}},
  {light: {accent: '#918ba2', on: '#18171c', ink: '#716b85'}, dark: {accent: '#c9c7cf', on: '#1d1b22', ink: '#b5b2bd'}},
];
/** The accent a bot's chat is drawn in: its saved tint, else its place, as `face` and `botColor` choose. */
export function botAccent(bot, index = 0) {
  const tint = Number.isInteger(bot?.settings?.tint) ? bot.settings.tint : Math.max(0, Math.trunc(Number(index)) || 0);
  return ACCENTS[Math.abs(tint) % ACCENTS.length];
}
/** The inline style a bot chat carries: both themes' values, so a theme switch needs no repaint (shell.css picks). */
export const accentStyle = a => (a ? `--acc-l:${a.light.accent};--acc-on-l:${a.light.on};--acc-ink-l:${a.light.ink};--acc-d:${a.dark.accent};--acc-on-d:${a.dark.on};--acc-ink-d:${a.dark.ink}` : '');
