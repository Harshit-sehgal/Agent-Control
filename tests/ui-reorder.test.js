import test from 'node:test';
import assert from 'node:assert/strict';
import {pinned, withPin, withoutPin, slotAmong, pinSlot, mergeOrder, unitOf, stepUnit, stepPin, hitZone} from '../shared/ui-reorder.js';

// ---- pins ----

test('pinning puts a bot at the slot it was dropped on, once', () => {
  assert.deepEqual(withPin(['a', 'b'], 'c', 1), ['a', 'c', 'b']);
  assert.deepEqual(withPin(['a', 'b'], 'a', 2), ['b', 'a'], 'a bot already pinned moves, it is not repeated');
  assert.deepEqual(withPin([], 'c', 9), ['c'], 'a slot past the end is the end');
  assert.deepEqual(withPin(['a'], 'c', -3), ['c', 'a']);
});

test('unpinning removes the bot and leaves the others in order', () => {
  assert.deepEqual(withoutPin(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(withoutPin(['a'], 'z'), ['a']);
});

test('a saved pin list that is not a list falls back to the default', () => {
  assert.deepEqual(pinned(['x'], ['atlas']), ['x']);
  assert.deepEqual(pinned(null, ['atlas']), ['atlas']);
  assert.deepEqual(pinned('nonsense', ['atlas']), ['atlas']);
});

// ---- where the pointer is among a row of faces or a column of rows ----

const box = (id, left, top, w = 80, h = 90) => ({id, left, top, right: left + w, bottom: top + h});

test('a pinned slot counts the faces whose middle the pointer has passed, reading in rows', () => {
  const faces = [box('a', 0, 0), box('b', 100, 0), box('c', 200, 0)];
  assert.equal(pinSlot(faces, {x: 10, y: 40}), 0, 'before the middle of the first face');
  assert.equal(pinSlot(faces, {x: 60, y: 40}), 1, 'past the first middle');
  assert.equal(pinSlot(faces, {x: 160, y: 40}), 2);
  assert.equal(pinSlot(faces, {x: 400, y: 40}), 3);
  // a second line of faces: anything on the first line is before a pointer on the second
  const wrapped = [...faces, box('d', 0, 110), box('e', 100, 110)];
  assert.equal(pinSlot(wrapped, {x: 10, y: 150}), 3);
  assert.equal(pinSlot(wrapped, {x: 130, y: 150}), 4);
  assert.equal(pinSlot([], {x: 5, y: 5}), 0);
});

test('a row slot counts the sibling blocks whose middle is above the pointer', () => {
  const blocks = [box('a', 0, 0, 200, 60), box('b', 0, 60, 200, 60), box('c', 0, 120, 200, 60)];
  assert.equal(slotAmong(blocks, 20), 0);
  assert.equal(slotAmong(blocks, 31), 1, 'only once the pointer is past the middle of the first');
  assert.equal(slotAmong(blocks, 29), 0, 'not yet');
  assert.equal(slotAmong(blocks, 500), 3);
});

// ---- blocks: a manager moves with its reports ----

const rows = [
  {id: 'a', team: 'atlas'}, {id: 'm', team: 'atlas'}, {id: 'm1', team: 'm'}, {id: 'm2', team: 'm'}, {id: 'z', team: 'atlas'},
];

test('a row and the rows under it are one block', () => {
  assert.deepEqual(unitOf(rows, 'a'), ['a']);
  assert.deepEqual(unitOf(rows, 'm'), ['m', 'm1', 'm2']);
  assert.deepEqual(unitOf(rows, 'm1'), ['m1']);
  assert.deepEqual(unitOf(rows, 'nope'), []);
});

test('Alt+arrow steps a block past its neighbour on the same team, never out of it', () => {
  assert.deepEqual(stepUnit(rows, 'a', 1), ['m', 'm1', 'm2', 'a', 'z'], 'down past a whole manager block');
  assert.deepEqual(stepUnit(rows, 'z', -1), ['a', 'z', 'm', 'm1', 'm2']);
  assert.deepEqual(stepUnit(rows, 'm', 1), ['a', 'z', 'm', 'm1', 'm2'], 'the manager carries its reports');
  assert.deepEqual(stepUnit(rows, 'm1', 1), ['a', 'm', 'm2', 'm1', 'z']);
  assert.equal(stepUnit(rows, 'm2', 1), null, 'the last report cannot leave its team');
  assert.equal(stepUnit(rows, 'a', -1), null, 'nothing above the first');
  assert.equal(stepUnit(rows, 'missing', 1), null);
});

test('Alt+arrow steps a pinned face left or right', () => {
  assert.deepEqual(stepPin(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
  assert.deepEqual(stepPin(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.equal(stepPin(['a', 'b'], 'a', -1), null);
  assert.equal(stepPin(['a', 'b'], 'b', 1), null);
  assert.equal(stepPin(['a', 'b'], 'z', 1), null);
});

// ---- the saved order ----

test('the saved order is the visible order, and keeps bots that are not on screen', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'a']), ['c', 'a', 'b'], 'hidden or filtered bots keep their place after');
  assert.deepEqual(mergeOrder([], ['x', 'y']), ['x', 'y']);
  assert.deepEqual(mergeOrder(['a', 'gone'], ['a', 'a', 'b']), ['a', 'b', 'gone'], 'no id twice');
  assert.deepEqual(mergeOrder(null, ['a']), ['a']);
});

// ---- what a drop would do ----

const zones = {
  shelf: {left: 0, top: 0, right: 300, bottom: 110},
  list: {left: 0, top: 120, right: 300, bottom: 600},
  rows: [
    {id: 'm', team: 'atlas', left: 0, top: 130, right: 300, bottom: 190, manager: true},
    {id: 'm1', team: 'm', left: 0, top: 190, right: 300, bottom: 250, manager: false},
  ],
};

test('over the shelf a row pins and a face reorders', () => {
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', x: 50, y: 50}), {kind: 'pin'});
  assert.deepEqual(hitZone({...zones, from: 'shelf', id: 'x', x: 50, y: 50}), {kind: 'pins'});
});

test('a face dragged out of the shelf unpins, a row in the list stays a reorder', () => {
  assert.deepEqual(hitZone({...zones, from: 'shelf', id: 'x', x: 50, y: 400}), {kind: 'unpin'});
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', x: 50, y: 400}), {kind: 'rows'});
});

test('the middle of a manager row moves the bot to that team, its edges reorder', () => {
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', team: 'atlas', x: 50, y: 160}), {kind: 'team', team: 'm'});
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', team: 'atlas', x: 50, y: 134}), {kind: 'rows'}, 'near the top edge');
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', team: 'm', x: 50, y: 160}), {kind: 'rows'}, 'already on that team');
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'm', team: 'atlas', x: 50, y: 160}), {kind: 'rows'}, 'not onto itself');
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', team: 'atlas', x: 50, y: 220}), {kind: 'rows'}, 'a plain bot is not a team');
});

test('a block cannot be dropped onto a team inside itself', () => {
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'm1', team: 'm', inside: ['m1'], x: 50, y: 160}), {kind: 'rows'});
  const drop = hitZone({...zones, from: 'list', id: 'q', team: 'atlas', inside: ['m'], x: 50, y: 160});
  assert.deepEqual(drop, {kind: 'rows'}, 'the manager is part of the block being dragged');
});

test('with no shelf there is nothing to pin onto, and outside both areas nothing happens', () => {
  assert.deepEqual(hitZone({shelf: null, list: zones.list, rows: [], from: 'list', id: 'x', x: 50, y: 400}), {kind: 'rows'});
  assert.deepEqual(hitZone({...zones, from: 'list', id: 'x', x: 900, y: 400}), {kind: 'none'});
  assert.deepEqual(hitZone({...zones, from: 'shelf', id: 'x', x: 900, y: 400}), {kind: 'none'});
});
