/** Bots learn from the chat: a plain correction ("no, too long") and the owner's 👍 / 👎 reach the next memory pass,
 * which keeps only lasting preferences. What a pass learned from a correction is announced (at most 3), a rewording
 * of something the bot already knew is not, and a rule the owner switched off stays off when a pass rewords it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isCorrection, correctionFrom, noteCorrection, noteLiked, consolidationDue, consolidationInput, consolidationInstructions,
  mergeConsolidation, rulebook, CONSOLIDATE_MIN_MS} from '../shared/memory.js';
import {openStore} from '../src/sqlite-store.js';

const KEY = 'bot:scout', NOW = '2026-11-26T12:00:00.000Z';
let n = 0;
const makeId = () => `r${++n}`;

test('a correction is told from a task, a question and a polite no', () => {
  for (const yes of ['No, too long', 'nope, use rupees', "Wrong, it's Tuesday", "That's not what I asked", 'That’s not it',
    'I meant the other file', 'Too formal', 'Use bullet points instead', 'Stop doing that', 'Not like that'])
    assert.equal(isCorrection(yes), true, yes);
  for (const no of ['No problem', 'no worries, thanks', 'Is that wrong?', 'Find the invoice', '', null, 'Nobody replied yet',
    '> That is not ideal, use the other one instead\n> too long', '> Wrong date\nThanks, send it'])
    assert.equal(isCorrection(no), false, String(no));
  assert.equal(isCorrection('> the old reply\nNo, shorter please'), true, 'the owner\'s own words after a quote still count');
});

test('a correction answers the bot reply just before it', () => {
  const chat = [
    {id: 'u1', role: 'user', text: 'Summarise the report'},
    {id: 'b1', role: 'bot', senderId: 'scout', text: 'Here is a long summary of the report.'},
    {id: 's1', role: 'system', text: 'Scout read 1 page.'},
  ];
  assert.deepEqual(correctionFrom(chat, 'No, too long', 'scout'), {said: 'No, too long', reply: 'Here is a long summary of the report.'});
  // The owner's line may already be stored by the time the route reads the chat.
  assert.deepEqual(correctionFrom([...chat, {id: 'u2', role: 'user', text: 'No, too long'}], 'No, too long', 'scout')?.reply, 'Here is a long summary of the report.');
  assert.equal(correctionFrom(chat, 'Find the invoice', 'scout'), null, 'not a correction');
  assert.equal(correctionFrom(chat, 'No, too long', 'atlas'), null, 'another bot wrote that reply');
  assert.equal(correctionFrom([{id: 'u1', role: 'user', text: 'hi'}], 'No, too long', 'scout'), null, 'nothing to correct');
  assert.equal(correctionFrom([], 'No', 'scout'), null);
  // "No" to a question the bot asked is an answer, not a correction; a stated fix still is.
  const asked = [{id: 'b2', role: 'bot', senderId: 'scout', text: 'Shall I send it now?'}];
  assert.equal(correctionFrom(asked, 'No', 'scout'), null);
  assert.ok(correctionFrom(asked, 'No, and stop doing that', 'scout'));
});

test('corrections and liked replies are kept, bounded, and make a pass due', () => {
  const state = {};
  for (let i = 0; i < 15; i++) noteCorrection(state, KEY, {said: `No, try ${i}`, reply: 'x'.repeat(500), chat: 'scout'}, {now: NOW});
  const book = rulebook(state, KEY);
  assert.equal(book.corrections.length, 12, 'the newest 12');
  assert.equal(book.corrections.at(-1).said, 'No, try 14');
  assert.equal(book.corrections[0].reply.length <= 300, true);
  assert.equal(book.corrections[0].chat, 'scout');
  for (let i = 0; i < 9; i++) noteLiked(state, KEY, {reply: `good ${i} ${'y'.repeat(400)}`, chat: 'scout'}, {now: NOW});
  assert.equal(book.liked.length, 6);
  assert.equal(book.liked[0].reply.length <= 300, true);

  const fresh = {};
  noteCorrection(fresh, KEY, {said: 'No, shorter', reply: 'long', chat: 'scout'}, {now: NOW});
  const one = rulebook(fresh, KEY);
  assert.equal(consolidationDue(one, Date.parse(NOW)), true, 'one correction is enough');
  one.consolidatedAt = NOW;
  assert.equal(consolidationDue(one, Date.parse(NOW) + CONSOLIDATE_MIN_MS - 1000), false, 'still behind the cooldown');
  const liked = {};
  noteLiked(liked, KEY, {reply: 'nice', chat: 'scout'}, {now: NOW});
  assert.equal(consolidationDue(rulebook(liked, KEY), Date.parse(NOW)), true);
});

test('the pass is handed the corrections, the liked replies and the rules the owner switched off', () => {
  const state = {};
  const book = rulebook(state, KEY);
  book.rules = [{id: 'a', text: 'Write in British English.', enabled: true}, {id: 'b', text: 'Always add emoji to every reply.', enabled: false}];
  noteCorrection(state, KEY, {said: 'No, too long', reply: 'A long reply', chat: 'scout'}, {now: NOW});
  noteLiked(state, KEY, {reply: 'Short and clear.', chat: 'scout'}, {now: NOW});
  const input = JSON.parse(consolidationInput({book}));
  assert.deepEqual(input.corrections, [{said: 'No, too long', reply: 'A long reply'}]);
  assert.deepEqual(input.likedReplies, ['Short and clear.']);
  assert.deepEqual(input.rejectedRules, ['Always add emoji to every reply.']);
  const brief = consolidationInstructions();
  assert.match(brief, /lasting preference/);
  assert.match(brief, /rejectedRules/);
});

function seeded() {
  const state = {};
  const book = rulebook(state, KEY);
  book.rules = [
    {id: 'old', text: 'Write in British English for every reply.', source: 'model', enabled: true},
    {id: 'off', text: 'Always add emoji to every single reply.', source: 'model', enabled: false},
  ];
  noteCorrection(state, KEY, {said: 'No, too long', reply: 'A long reply', chat: 'scout'}, {now: '2026-11-26T11:00:00.000Z'});
  noteCorrection(state, KEY, {said: 'No, use rupees', reply: 'It costs $5', chat: 'team-g1'}, {now: '2026-11-26T11:30:00.000Z'});
  return {state, book};
}

test('a pass announces what it learned from a correction, in the chat of the newest one', () => {
  const {state, book} = seeded();
  const sentCorrections = [...book.corrections];
  // A correction that arrives while the model answers was not sent and must survive.
  noteCorrection(state, KEY, {said: 'Wrong, it is Friday', reply: 'Tuesday', chat: 'scout'}, {now: NOW});
  mergeConsolidation(state, KEY, {rules: [
    'Write in British English in every reply.',      // a rewording of a rule it had: not new
    'Add emoji to every single reply, always.',     // a rewording of a rule the owner switched off: stays off
    'Keep replies under five lines.',
    'Give prices in rupees.',
    'Name the source of every figure.',
    'Use the 24-hour clock.',
  ]}, {now: NOW, makeId, sentCorrections});
  const after = rulebook(state, KEY);
  assert.deepEqual(after.corrections.map(c => c.said), ['Wrong, it is Friday'], 'only what was sent is cleared');
  const off = after.rules.filter(r => r.enabled === false);
  assert.equal(off.length, 1, 'the switched-off rule is kept once, still off');
  assert.equal(after.rules.some(r => r.enabled !== false && /emoji/i.test(r.text)), false, 'and not switched back on by a rewording');
  assert.equal(after.announce.length, 3, 'at most 3');
  assert.deepEqual(after.announce.map(a => a.text), ['Keep replies under five lines.', 'Give prices in rupees.', 'Name the source of every figure.']);
  assert.ok(after.announce.every(a => a.chat === 'team-g1'), 'said in the chat of the newest sent correction');
  assert.ok(after.announce.every(a => after.rules.some(r => r.id === a.id)), 'each names a kept rule');
});

test('a pass with no correction announces nothing, and liked replies are cleared once sent', () => {
  const state = {};
  noteLiked(state, KEY, {reply: 'Short and clear.', chat: 'scout'}, {now: NOW});
  const sentLiked = [...rulebook(state, KEY).liked];
  mergeConsolidation(state, KEY, {rules: ['Keep replies short.']}, {now: NOW, makeId, sentCorrections: [], sentLiked});
  const book = rulebook(state, KEY);
  assert.deepEqual(book.announce || [], []);
  assert.deepEqual(book.liked, []);
});

test('corrections and liked replies survive a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-learning-'));
  try {
    const store = await openStore(path.join(dir, 'state.json'));
    await store.update(s => { noteCorrection(s, KEY, {said: 'No, too long', reply: 'long', chat: 'scout'}, {now: NOW}); noteLiked(s, KEY, {reply: 'nice', chat: 'scout'}, {now: NOW}); });
    await store.close();
    const again = await openStore(path.join(dir, 'state.json'));
    const book = again.read().memory.rulebooks[KEY];
    assert.equal(book.corrections[0].said, 'No, too long');
    assert.equal(book.liked[0].reply, 'nice');
    await again.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
