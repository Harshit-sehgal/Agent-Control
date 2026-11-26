/** The reply popover's rules: what it offers to whom, the text Ask about this and Start a thread send, the question a
 * reply answered, message pins, where the popover sits, and which reply carries the one-time hint. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {menuItems, showFeedback, quoteText, askText, threadText, askedBefore, togglePin, isPinned, pinsOf, placePopover,
  hintFor, pinsStripHtml, hintHtml, MAX_MSG_PINS, MARGIN} from '../shared/reply-menu.js';

const ids = items => items.map(i => i.id);

test('a writer gets every action in order; a viewer only what changes nothing', () => {
  assert.deepEqual(ids(menuItems({canWrite: true, touch: false, canRetry: true, canTemplate: true, pinned: false})), ['copy', 'retry', 'share', 'pin', 'thread', 'template']);
  assert.deepEqual(ids(menuItems({canWrite: true, touch: true, canRetry: true, canTemplate: true})), ['copy', 'retry', 'share', 'pin', 'thread', 'template', 'select']);
  assert.deepEqual(ids(menuItems({canWrite: false, touch: true, canRetry: true, canTemplate: true})), ['copy', 'share', 'pin', 'select']);
  assert.deepEqual(ids(menuItems({canWrite: true, touch: false, canRetry: false, canTemplate: false})), ['copy', 'share', 'pin', 'thread'], 'nothing to resend or save');
  assert.equal(menuItems({canWrite: true, pinned: true}).find(i => i.id === 'pin').label, 'Unpin');
  assert.equal(menuItems({canWrite: true, pinned: false}).find(i => i.id === 'pin').label, 'Pin');
  assert.ok(menuItems({canWrite: true}).every(i => i.label && i.glyph));
  assert.equal(showFeedback({canWrite: true, memoryOn: true}), true);
  assert.equal(showFeedback({canWrite: false, memoryOn: true}), false);
  assert.equal(showFeedback({canWrite: true, memoryOn: false}), false);
});

test('a quote is a Markdown blockquote, cut with an ellipsis; ask and thread text put the owner\'s words after it', () => {
  assert.equal(quoteText('Line one\n\nLine two'), '> Line one\n>\n> Line two');
  const long = quoteText('x'.repeat(2000));
  assert.ok(long.length <= 1204 && long.endsWith('…'));
  assert.equal(askText('> hi', 'Why?'), '> hi\n\nWhy?');
  assert.equal(askText('> hi', '  '), '> hi');
  assert.equal(threadText('> hi', ''), '> hi\n\nFollow up on this.');
  assert.equal(threadText('> hi', 'Plan it'), '> hi\n\nPlan it');
});

test('the question a reply answered is the owner line before it, across its own run but not another reply', () => {
  const chat = [
    {id: 'u1', role: 'user', text: 'Price the plan'},
    {id: 'h1', role: 'bot', senderId: 'plan', runId: 'r1', text: 'helper line'},
    {id: 's1', role: 'system', text: 'note'},
    {id: 'b1', role: 'bot', senderId: 'atlas', runId: 'r1', text: 'It costs 5.'},
    {id: 'b2', role: 'bot', senderId: 'atlas', text: 'And a follow-up.'},
  ];
  assert.equal(askedBefore(chat, 'b1'), 'Price the plan');
  assert.equal(askedBefore(chat, 'b2'), '', 'another reply sits between');
  assert.equal(askedBefore(chat, 'missing'), '');
  assert.equal(askedBefore([{id: 'b9', role: 'bot', text: 'hello'}], 'b9'), '', 'a greeting answers nothing');
});

test('the question is found by time, not by where the line sits in the list', () => {
  // The browser keeps a sent line after the run's lines that synced in first; the feed sorts by time.
  const chat = [
    {id: 's1', role: 'system', runId: 'r1', text: 'Passing this through 1 bot(s).', at: '2026-11-26T10:00:01Z'},
    {id: 'b1', role: 'bot', senderId: 'atlas', runId: 'r1', text: 'I can do a lot.', at: '2026-11-26T10:00:02Z'},
    {id: 'u1', role: 'user', text: 'What can you do?', at: '2026-11-26T10:00:00Z'},
  ];
  assert.equal(askedBefore(chat, 'b1'), 'What can you do?');
});

test('pins are per chat, newest first, capped, and stale ones drop', () => {
  let pins = {};
  for (let i = 0; i < 25; i++) pins = togglePin(pins, 'scout', `m${i}`);
  assert.equal(pins.scout.length, MAX_MSG_PINS);
  assert.equal(pins.scout[0], 'm24');
  assert.equal(isPinned(pins, 'scout', 'm24'), true);
  pins = togglePin(pins, 'scout', 'm24');
  assert.equal(isPinned(pins, 'scout', 'm24'), false, 'a second tap unpins');
  assert.deepEqual(pinsOf({scout: ['a', 'gone', 'b']}, 'scout', ['a', 'b', 'c']), ['a', 'b']);
  assert.deepEqual(pinsOf(null, 'scout', ['a']), []);
  assert.deepEqual(pinsOf({scout: 'junk'}, 'scout', ['a']), []);
});

test('the popover sits below the reply when it fits, above when not, inside the margins and above the composer', () => {
  const view = {w: 400, h: 800}, size = {w: 300, h: 320};
  const below = placePopover({top: 100, bottom: 200, left: 40, right: 360}, size, view, 720);
  assert.deepEqual(below, {left: 40, top: 208, below: true});
  const above = placePopover({top: 500, bottom: 600, left: 40, right: 360}, size, view, 720);
  assert.equal(above.below, false);
  assert.equal(above.top, 500 - 8 - 320);
  const squeezed = placePopover({top: 120, bottom: 700, left: 380, right: 400}, size, view, 720);
  assert.ok(squeezed.top >= MARGIN && squeezed.top + size.h <= 720 - MARGIN, 'clamped above the composer');
  assert.equal(squeezed.left, view.w - size.w - MARGIN, 'clamped to the right margin');
  const atPoint = placePopover({top: 100, bottom: 200, left: 40, right: 360}, size, view, 720, {x: 390, y: 150});
  assert.equal(atPoint.left, view.w - size.w - MARGIN);
  assert.equal(atPoint.top, 150);
});

test('the hint goes on the first reply that answers something, until it has been seen', () => {
  const entries = [{kind: 'day'}, {kind: 'bot', message: {id: 'hello'}}, {kind: 'me', message: {id: 'q'}}, {kind: 'bot', message: {id: 'a'}}];
  assert.equal(hintFor(entries, false), 'a');
  assert.equal(hintFor(entries, true), null);
  assert.equal(hintFor([{kind: 'bot', message: {id: 'hello'}}], false), null);
});

test('the pins strip and the hint are plain, escaped markup', () => {
  assert.equal(pinsStripHtml([]), '');
  const strip = pinsStripHtml([{id: 'm1', text: 'Price <b>is</b> 5\nmore', at: '2026-11-26T10:00:00Z'}]);
  assert.match(strip, /📌 1 pinned/);
  assert.match(strip, /data-action="pins-toggle"/);
  assert.match(strip, /data-action="pin-jump" data-m="m1"/);
  assert.doesNotMatch(strip, /<b>is<\/b>/);
  assert.match(hintHtml(), /Tip: hold a reply for more\. On a computer, right-click it\./);
  assert.match(hintHtml(), /data-action="hint-close"/);
});
