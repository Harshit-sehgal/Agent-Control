import test from 'node:test';
import assert from 'node:assert/strict';
import {face, botColor, SHAPES, COLORS} from '../shared/ui-face.js';
import {TINT_COUNT} from '../shared/ui-kit.js';

const bot = (settings = {}, extra = {}) => ({id: 'b1', name: 'Mailroom', settings, ...extra});
const shapeOf = html => /data-shape="([^"]*)"/.exec(html)?.[1];

test('there are ten shapes, in the order the new-bot page draws them', () => {
  assert.deepEqual(SHAPES, ['rounded', 'circle', 'hexagon', 'pebble', 'drop', 'shield', 'arch', 'egg', 'blob', 'bean']);
});

test('colours are ten pastel hex tints, indexed by the bot tint setting', () => {
  assert.equal(COLORS.length, 10);
  assert.ok(COLORS.every(c => /^#[0-9a-f]{6}$/i.test(c)));
  assert.equal(COLORS[0], '#9ee0e6');
  // bot-settings accepts 0..TINT_COUNT-1, so every colour the palette draws must be a valid tint.
  assert.equal(COLORS.length, TINT_COUNT);
});

test('face is an svg sized by opts.size, 40 by default', () => {
  assert.match(face(bot()), /^<svg [^>]*width="40" height="40"/);
  assert.match(face(bot(), {size: 88}), /width="88" height="88"/);
});

test('the primary defaults to a circle', () => {
  assert.equal(shapeOf(face(bot({lead: true}))), 'circle');
  assert.equal(shapeOf(face(bot(), {primary: true})), 'circle');
});

test('a manager defaults to a hexagon', () => {
  assert.equal(shapeOf(face(bot(), {manager: true})), 'hexagon');
});

test('any other bot defaults to a rounded square', () => {
  assert.equal(shapeOf(face(bot())), 'rounded');
});

test('a valid settings.shape wins over the role default', () => {
  assert.equal(shapeOf(face(bot({lead: true, shape: 'bean'}))), 'bean');
  assert.equal(shapeOf(face(bot({shape: 'egg'}), {manager: true})), 'egg');
});

test('an unknown settings.shape falls back to the role default', () => {
  assert.equal(shapeOf(face(bot({shape: 'star'}), {manager: true})), 'hexagon');
});

test('every shape draws a body', () => {
  for (const shape of SHAPES) assert.match(face(bot({shape})), /class="face-body"/);
});

test('the tint index picks the colour', () => {
  assert.ok(face(bot({tint: 3})).includes(COLORS[3]));
  assert.ok(!face(bot({tint: 3})).includes(COLORS[0]));
});

test('a null tint is picked from the bot position, like tintOf', () => {
  assert.ok(face(bot({tint: null}), {index: 2}).includes(COLORS[2]));
  assert.ok(face(bot({tint: null})).includes(COLORS[0]));
});

test('an out-of-range tint wraps instead of breaking', () => {
  assert.ok(face(bot({tint: 12})).includes(COLORS[2]));
});

test('an awake face sways and a working face nods', () => {
  assert.match(face(bot(), {state: 'awake'}), /face--sway/);
  assert.match(face(bot(), {state: 'working'}), /face--nod/);
  assert.doesNotMatch(face(bot(), {state: 'working'}), /face--sway/);
});

test('an asleep face has closed eyes, no mouth and no animation', () => {
  const html = face(bot(), {state: 'asleep'});
  assert.match(html, /face--asleep/);
  assert.doesNotMatch(html, /face--sway|face--nod/);
  assert.doesNotMatch(html, /face-mouth/);
  assert.doesNotMatch(html, /face-light/);
});

test('a waiting face is its own state', () => {
  assert.match(face(bot(), {state: 'waiting'}), /face--waiting/);
});

test('an unknown state is treated as awake', () => {
  assert.match(face(bot(), {state: 'evil"onload="x'}), /face--awake/);
});

test('some bots blink twice, chosen by name length', () => {
  assert.match(face(bot({}, {name: 'Odd'})), /face--blink2/);
  assert.doesNotMatch(face(bot({}, {name: 'Even'})), /face--blink2/);
});

test('motion:false drops every animation class but keeps the state', () => {
  const html = face(bot({}, {name: 'Odd'}), {state: 'working', motion: false});
  assert.doesNotMatch(html, /face--nod|face--sway|face--blink2/);
  assert.match(html, /face--working/);
});

test('a face has two eyes with catch-lights, blush and a far eye narrower than the near one', () => {
  const html = face(bot());
  assert.equal(html.match(/class="face-eye"/g).length, 2);
  assert.equal(html.match(/class="face-light"/g).length, 2);
  assert.equal(html.match(/class="face-blush"/g).length, 2);
  const [near, far] = [...html.matchAll(/class="face-eye" x="[\d.]+" y="[\d.]+" width="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(far < near);
});

test('eyes sit in the top fifth, the mouth just below the middle', () => {
  const html = face(bot());
  const eyeY = Number(/class="face-eye" x="[\d.]+" y="([\d.]+)"/.exec(html)[1]);
  const mouthY = Number(/class="face-mouth" x="[\d.]+" y="([\d.]+)"/.exec(html)[1]);
  assert.ok(eyeY >= 15 && eyeY <= 22);
  assert.ok(mouthY >= 45 && mouthY <= 55);
});

test('the face is turned: eyes, blush and mouth all sit right of centre, the highlights high in each eye', () => {
  const html = face(bot());
  const eyes = [...html.matchAll(/class="face-eye" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(m => m.slice(1).map(Number));
  // The middle of the pair, not of the head, is what reads as a turn.
  const centre = (eyes[0][0] + eyes[1][0] + eyes[1][2]) / 2;
  assert.ok(centre > 55, `eye pair centre ${centre}`);
  const mouth = /class="face-mouth" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(html);
  assert.ok(Number(mouth[1]) + Number(mouth[2]) / 2 > 50, 'mouth right of centre');
  const [near, far] = [...html.matchAll(/class="face-light" cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.ok(near[1] < eyes[0][1] + eyes[0][3] / 3 && far[1] < eyes[1][1] + eyes[1][3] / 3, 'catch-lights in the upper third of each eye');
});

test('a soft shade sits under the chin and a second one on the far (right) side', () => {
  const html = face(bot());
  assert.equal(html.match(/class="face-shade"/g).length, 1);
  assert.equal(html.match(/class="face-shade-far"/g).length, 1);
  const chin = /<linearGradient id="fs[\w]+" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(html).slice(1).map(Number);
  assert.ok(chin[1] === 0 && chin[3] === 1 && Math.abs(chin[0] - chin[2]) < 0.05, 'chin shade runs top to bottom');
  const far = /<linearGradient id="fr[\w]+" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(html).slice(1).map(Number);
  assert.ok(far[0] < far[2] && far[1] === far[3], 'far shade runs left to right, so it darkens the right edge');
});

test('the primary gets a star badge at size 40 and up', () => {
  assert.match(face(bot({lead: true}), {size: 40}), /class="face-star"/);
  assert.match(face(bot(), {primary: true, size: 88}), /class="face-star"/);
});

test('no star badge below size 40 or on other bots', () => {
  assert.doesNotMatch(face(bot({lead: true}), {size: 24}), /face-star/);
  assert.doesNotMatch(face(bot(), {size: 88}), /face-star/);
});

test('the star sits at the bottom left so it never covers the mouth', () => {
  const m = /class="face-star"[^>]*cx="([\d.]+)" cy="([\d.]+)"/.exec(face(bot({lead: true})));
  assert.ok(Number(m[1]) < 25 && Number(m[2]) > 75);
});

test('the face is decorative for assistive tech', () => {
  assert.match(face(bot()), /aria-hidden="true"/);
});

test('hostile strings never reach the markup', () => {
  const evil = '"><script>alert(1)</script>';
  const html = face({id: evil, name: evil, settings: {shape: evil, tint: evil, lead: false}}, {state: evil, size: evil});
  assert.doesNotMatch(html, /<script|alert\(1\)/);
  assert.match(html, /width="40"/);
});

test('face copes with a missing bot', () => {
  assert.match(face(undefined), /^<svg /);
  assert.match(face(null, {}), /data-shape="rounded"/);
});

test('every face owns its gradient ids, so a face inside a hidden sidebar never starves a visible one', () => {
  // A url(#id) that resolves to a gradient inside a display:none svg paints nothing.
  const ids = html => [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(m => m[1]);
  const a = ids(face(bot({tint: 0}))), b = ids(face(bot({tint: 0})));
  assert.equal(a.length, 3);
  assert.ok(a.every(id => !b.includes(id)));
});

test('a face draws the happy-eyes paths and, asleep at 36px or more, a small z', () => {
  assert.match(face(bot()), /class="face-joy"/);
  assert.match(face(bot(), {state: 'asleep', size: 40}), /class="face-z"/);
  assert.doesNotMatch(face(bot(), {state: 'asleep', size: 24}), /class="face-z"/);
  assert.doesNotMatch(face(bot(), {state: 'awake', size: 40}), /class="face-z"/);
});

test('botColor gives the colour a face is drawn in', () => {
  assert.equal(botColor(bot({tint: 3})), COLORS[3]);
  assert.equal(botColor(bot({tint: null}), 2), COLORS[2]);
  assert.equal(botColor(undefined), COLORS[0]);
});

test('hop adds the happy-hop class only when motion is on', () => {
  assert.match(face(bot(), {hop: true}), /face--hop/);
  assert.doesNotMatch(face(bot()), /face--hop/);
  assert.doesNotMatch(face(bot(), {hop: true, motion: false}), /face--hop/);
});
