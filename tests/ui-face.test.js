import test from 'node:test';
import assert from 'node:assert/strict';
import {face, SHAPES, COLORS} from '../shared/ui-face.js';
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
  // bot-settings only accepts 0..TINT_COUNT-1 today; the palette covers all of those.
  assert.ok(COLORS.length >= TINT_COUNT);
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

test('gradient ids are per colour, so two faces on one page never borrow each other\'s tint', () => {
  const id = html => /<linearGradient id="([^"]+)"/.exec(html)[1];
  assert.notEqual(id(face(bot({tint: 0}))), id(face(bot({tint: 1}))));
  assert.equal(id(face(bot({tint: 0}))), id(face(bot({tint: 0}, {id: 'other'}))));
});

test('hop adds the happy-hop class only when motion is on', () => {
  assert.match(face(bot(), {hop: true}), /face--hop/);
  assert.doesNotMatch(face(bot()), /face--hop/);
  assert.doesNotMatch(face(bot(), {hop: true, motion: false}), /face--hop/);
});
