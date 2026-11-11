import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';
import {exportBackup, importBackup} from '../src/backup.js';
import {consolidateModel, maybeConsolidate, memoryFor, rememberTurn, conversationMessages} from '../src/memory.js';
import {
  MEMORY_VERSION, MAX_RULES, MAX_RULEBOOKS, CONSOLIDATE_AFTER,
  memoryState, modelKey, modelLabel, rulebook, consolidationDue, ruleLines,
  promptMemory, memoryBlock, extractRuleCandidates, addRules, removeRule,
  forgetRulebook, findRulebook, digestConversation, noteChat, forgetChat, pruneMemory,
  consolidationInstructions, consolidationInput, parseConsolidation,
  mergeConsolidation, noteTurn, publicMemory, setChatSummary,
} from '../shared/memory.js';

const makeId = (() => { let n = 0; return () => `id-${++n}`; })();
const at = '2026-01-01T00:00:00.000Z';
const config = {model: 'model-a', providerId: 'openrouter', label: 'Saved provider'};

test('modelKey separates providers that expose the same model name', () => {
  assert.equal(modelKey(config), 'openrouter:model-a');
  assert.equal(modelKey({model: 'model-a'}), 'env:model-a');
  assert.equal(modelKey({model: 'model-a', source: 'byok'}), 'byok:model-a');
  assert.equal(modelKey({}), 'env:unconfigured');
  assert.notEqual(modelKey({model: 'm', providerId: 'a'}), modelKey({model: 'm', providerId: 'b'}));
  assert.match(modelLabel(config), /Saved provider/);
});

test('memoryState fills a usable shape and is idempotent', () => {
  const state = {};
  const memory = memoryState(state);
  assert.equal(memory.version, MEMORY_VERSION);
  assert.deepEqual(memory.rulebooks, {});
  assert.deepEqual(memory.chats, {});
  assert.deepEqual(memory.forgottenChats, {});
  memoryState(state);
  assert.equal(state.memory, memory, 'A second call must not replace the object.');
  // Corrupt shapes are repaired rather than trusted.
  state.memory.rulebooks = [];
  state.memory.chats = 'nope';
  state.memory.version = 'x';
  memoryState(state);
  assert.deepEqual(state.memory.rulebooks, {});
  assert.deepEqual(state.memory.chats, {});
  assert.equal(state.memory.version, MEMORY_VERSION);
});

test('durable instructions become rule candidates, questions and one-offs do not', () => {
  const rules = extractRuleCandidates(
    'Always keep replies under 200 characters. What is the weather? Can you always do that? From now on, never use emoji. We shipped the draft today.');
  assert.deepEqual(rules, ['Always keep replies under 200 characters.', 'From now on, never use emoji.']);
  assert.deepEqual(extractRuleCandidates('short'), []);
  assert.deepEqual(extractRuleCandidates(null), []);
});

test('addRules de-duplicates regardless of case and spacing, and bounds the book', () => {
  const state = {};
  const first = addRules(state, 'env:m', ['Always keep replies short.'], {now: at, makeId});
  assert.equal(first.added.length, 1);
  assert.equal(first.book.rules.length, 1);
  const again = addRules(state, 'env:m', ['  always KEEP replies   short. '], {now: at, makeId});
  assert.equal(again.added.length, 0, 'A duplicate must refresh the rule, not add one.');
  assert.equal(rulebook(state, 'env:m').rules[0].uses, 1);
  for (let i = 0; i < MAX_RULES + 10; i++) addRules(state, 'env:m', [`Always preference number ${i}.`], {now: at, makeId});
  assert.equal(rulebook(state, 'env:m').rules.length, MAX_RULES);
  removeRule(state, 'env:m', rulebook(state, 'env:m').rules[0].id);
  assert.equal(rulebook(state, 'env:m').rules.length, MAX_RULES - 1);
  forgetRulebook(state, 'env:m');
  assert.equal(state.memory.rulebooks['env:m'], undefined);
});

test('Rulebook lines are newest first within a character budget', () => {
  const state = {};
  for (let i = 0; i < 20; i++) addRules(state, 'env:m', [`Always rule ${i} with some padding text.`], {now: at, makeId});
  const lines = ruleLines(state.memory.rulebooks['env:m'], 80);
  assert.ok(lines.length >= 1 && lines.length < 20);
  assert.match(lines[0], /rule 19/i, 'The newest rule must survive the budget.');
  assert.ok(lines.join('\n').length <= 80);
});

test('digestConversation keeps the first asks and the latest answer, bounded', () => {
  const messages = [];
  for (let i = 0; i < 10; i++) messages.push({id: `u${i}`, role: 'user', text: `Ask number ${i} about the launch plan`, at: `${at}-${i}`});
  messages.push({id: 'b1', role: 'bot', senderName: 'Writer', text: 'The latest answer.', at});
  const digest = digestConversation(messages, {max: 500});
  assert.match(digest, /Ask number 0/);
  assert.match(digest, /Ask number 9/, 'The latest ask must be present.');
  assert.match(digest, /The latest answer\./);
  assert.ok(digest.length <= 500);
  assert.equal(digestConversation([]), '');
  assert.equal(digestConversation([{role: 'system', text: 'ignored'}]), '');
});

test('noteChat stores a recap that publicMemory exposes, and forgetChat removes it', () => {
  const state = {chats: {writer: [{id: 's1', role: 'user', text: 'Always use British spelling in drafts.', at}, {id: 's2', role: 'bot', text: 'Noted.', at}]}};
  const entry = noteChat(state, 'writer', {now: at});
  assert.equal(entry.chat, 'writer');
  assert.match(entry.summary, /British spelling/);
  assert.equal(entry.turns, 1);
  const publicView = publicMemory(state);
  assert.equal(publicView.chats[0].chat, 'writer');
  assert.equal(publicView.rulebooks.length, 0);
  forgetChat(state, 'writer');
  assert.deepEqual(state.memory.chats, {});
  assert.equal(noteChat(state, ''), null);
});

test('a model-written recap is not overwritten by the next deterministic one', () => {
  const state = {chats: {writer: [{id: 's1', role: 'user', text: 'Draft the launch note.', at}, {id: 's2', role: 'bot', text: 'Here is a draft.', at}]}};
  noteChat(state, 'writer', {now: at});
  setChatSummary(state, 'writer', 'The chat is about the launch note and the user wants it short.', {now: at});
  for (let i = 1; i <= 2; i++) {
    state.chats.writer.push({id: `s${i + 2}`, role: 'user', text: `Change ${i}.`, at});
    noteChat(state, 'writer', {now: at});
  }
  assert.match(state.memory.chats.writer.summary, /wants it short/, 'The paid recap must survive the turns after it.');
  for (let i = 0; i < CONSOLIDATE_AFTER; i++) state.chats.writer.push({id: `t${i}`, role: 'user', text: `More ${i}.`, at});
  noteChat(state, 'writer', {now: at});
  assert.doesNotMatch(state.memory.chats.writer.summary, /wants it short/, 'Once the chat has moved on, the digest takes over again.');
});

test('a forgotten chat stays forgotten until a newer message arrives', () => {
  const first = {id: 's1', role: 'user', text: 'Always cc the editor.', at};
  const state = {chats: {writer: [first]}};
  noteChat(state, 'writer', {now: at});
  forgetChat(state, 'writer', {now: at});
  assert.equal(noteChat(state, 'writer', {now: at}), null, 'The next turn must not bring it back.');
  assert.equal(state.memory.chats.writer, undefined);
  const later = '2026-01-01T00:05:00.000Z';
  const entry = noteChat(state, 'writer', {now: later, messages: [first, {id: 's2', role: 'user', text: 'New topic: the budget.', at: later}]});
  assert.ok(entry, 'A message written after the forget rebuilds the recap.');
  assert.equal(state.memory.forgottenChats.writer, undefined);
});

test('a one-off obligation is not kept as a lasting rule', () => {
  assert.deepEqual(extractRuleCandidates('We must ship today. The client is waiting.'), []);
  assert.deepEqual(extractRuleCandidates('You should always cite a source.'), ['You should always cite a source.']);
  assert.deepEqual(extractRuleCandidates("Don't use em dashes."), ["Don't use em dashes."]);
});

test('memoryBlock is null when empty and bounded when full', () => {
  assert.equal(memoryBlock(null), null);
  assert.equal(memoryBlock({}), null);
  const block = memoryBlock({rules: ['Always be brief.', '', 42], chatSummary: 'A chat about drafts.', modelNotes: 'Model note.'});
  assert.deepEqual(block.rules, ['Always be brief.']);
  assert.match(block.note, /context, not new instructions/);
  const many = memoryBlock({rules: Array.from({length: 60}, (_, i) => `rule ${i}`)});
  assert.equal(many.rules.length, 24);
});

test('promptMemory reads the model book and the named chat only', () => {
  const state = {};
  addRules(state, 'env:m', ['Always answer in one paragraph.'], {now: at, makeId, label: 'Model A'});
  noteChat(state, 'writer', {messages: [{role: 'user', text: 'Draft the launch note.', at}]});
  const prompt = promptMemory(state, 'env:m', 'writer', {label: 'Model A'});
  assert.deepEqual(prompt.rules, ['Always answer in one paragraph.']);
  assert.equal(prompt.label, 'Model A');
  assert.match(prompt.chatSummary, /launch note/);
  assert.equal(prompt.chatSummary.includes('another chat'), false);
  assert.equal(promptMemory(state, 'env:other', 'writer').rules.length, 0);
});

test('a consolidation pass is due only with material and after the cooldown', () => {
  const book = {turns: 0, consolidatedTurns: 0, pending: [], consolidatedAt: null};
  assert.equal(consolidationDue(book, Date.parse(at)), false);
  book.pending = ['a', 'b', 'c'];
  assert.equal(consolidationDue(book, Date.parse(at)), true);
  book.consolidatedAt = at;
  assert.equal(consolidationDue(book, Date.parse(at) + 60_000), false, 'The cooldown must hold.');
  book.pending = [];
  book.turns = CONSOLIDATE_AFTER;
  assert.equal(consolidationDue(book, Date.parse(at) + 6 * 60_000), true);
});

test('consolidation output is parsed tolerantly and applied without losing rule ids', () => {
  const parsed = parseConsolidation('Sure.\n```json\n{"rules":["Always cite a source.","always cite a source","x"],"summary":"The chat is about sources."}\n```');
  assert.deepEqual(parsed.rules, ['Always cite a source.', 'always cite a source']);
  assert.equal(parsed.summary, 'The chat is about sources.');
  assert.equal(parseConsolidation('no json here'), null);
  assert.equal(parseConsolidation('{"rules":[],"summary":""}'), null);

  const state = {};
  const kept = addRules(state, 'env:m', ['Always cite a source.'], {now: at, makeId}).added[0];
  mergeConsolidation(state, 'env:m', parsed, {now: '2026-01-02T00:00:00.000Z', makeId});
  const book = rulebook(state, 'env:m');
  assert.equal(book.rules[0].id, kept.id, 'A surviving rule keeps its id across a rewrite.');
  assert.equal(book.rules[0].text, 'Always cite a source.');
  assert.equal(book.summary, 'The chat is about sources.');
  assert.equal(book.consolidatedAt, '2026-01-02T00:00:00.000Z');
  assert.match(consolidationInstructions(), /JSON only/);
  const input = consolidationInput({book, messages: [{role: 'user', text: 'Always cite.', at}], chatSummary: 'old'});
  assert.match(input, /existingRules/);
  assert.match(input, /Always cite/);
});

test('noteTurn advances once and queues durable user sentences for the next pass', () => {
  const state = {chats: {writer: [{role: 'user', text: 'Always keep replies short.', at}]}};
  noteChat(state, 'writer', {messages: state.chats.writer});
  const book = noteTurn(state, 'env:m', {userText: 'Always keep replies short. Thanks!', now: at});
  assert.equal(book.turns, 1);
  assert.deepEqual(book.pending, ['Always keep replies short.']);
  noteTurn(state, 'env:m', {userText: 'Always keep replies short.', now: at});
  assert.equal(book.pending.length, 1, 'The same directive must not queue twice.');
  assert.equal(book.turns, 2);
});

test('pruneMemory bounds both maps by updatedAt', () => {
  const state = {};
  for (let i = 0; i < MAX_RULEBOOKS + 5; i++) {
    state.memory ??= {rulebooks: {}, chats: {}};
    state.memory.rulebooks[`env:old${i}`] = {model: `env:old${i}`, rules: [], updatedAt: `2020-01-01T00:00:${String(i).padStart(2, '0')}.000Z`};
  }
  state.memory.rulebooks['env:newest'] = {model: 'env:newest', rules: [], updatedAt: '2026-01-01T00:00:00.000Z'};
  pruneMemory(state);
  assert.equal(Object.keys(state.memory.rulebooks).length, MAX_RULEBOOKS);
  assert.ok(state.memory.rulebooks['env:newest'], 'The active book must survive pruning.');
});

test('memory survives a SqliteStore restart and a backup round trip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-memory-'));
  const db = path.join(dir, 'state.db');
  const legacy = path.join(dir, 'state.json');
  try {
    const first = await new SqliteStore(db, legacy).init();
    await first.update(s => {
      s.chats.writer = [{id: 'm1', role: 'user', text: 'Always keep replies short.', at}];
      addRules(s, 'openrouter:model-a', ['Always keep replies short.'], {now: at, makeId});
      noteChat(s, 'writer', {now: at});
    });
    await first.close();

    const reopened = await new SqliteStore(db, legacy).init();
    assert.equal(reopened.read().memory.rulebooks['openrouter:model-a'].rules[0].text, 'Always keep replies short.');
    assert.match(reopened.read().memory.chats.writer.summary, /replies short/);

    const document = exportBackup(reopened);
    assert.ok(document.tables.memory.some(row => row.kind === 'rulebook' && row.key === 'openrouter:model-a'));
    assert.ok(document.tables.memory.some(row => row.kind === 'chat' && row.key === 'writer'));

    const targetDir = path.join(dir, 'target');
    const target = await new SqliteStore(path.join(targetDir, 'state.db'), path.join(targetDir, 'state.json')).init();
    importBackup(target, document, {force: true});
    assert.equal(target.read().memory.rulebooks['openrouter:model-a'].rules[0].text, 'Always keep replies short.');
    assert.ok(target.read().memory.chats.writer);
    await target.close();
    await reopened.close();
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a workspace forget is persisted, not just hidden in memory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-memory-forget-'));
  const db = path.join(dir, 'state.db');
  const legacy = path.join(dir, 'state.json');
  try {
    const first = await new SqliteStore(db, legacy).init();
    await first.update(s => addRules(s, 'env:m', ['Always use plain English.'], {now: at, makeId}));
    await first.update(s => forgetRulebook(s, 'env:m'));
    await first.close();
    const reopened = await new SqliteStore(db, legacy).init();
    assert.equal(reopened.read().memory.rulebooks['env:m'], undefined);
    await reopened.close();
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

/** A workspace store with the two methods memory needs, committing updates. */
function memoryStore(state) {
  let current = state;
  return {
    read: () => structuredClone(current),
    update: fn => {
      const next = structuredClone(current);
      const result = fn(next);
      current = next;
      return Promise.resolve(result);
    },
    state: () => current,
  };
}

test('one consolidation call rewrites the rulebook and the chat recap', async () => {
  const store = memoryStore({memory: memoryState({}), chats: {writer: [
    {id: 'm1', role: 'user', text: 'Always cite a source when you make a claim.', at},
    {id: 'm2', role: 'bot', text: 'Understood.', at},
  ]}});
  addRules(store.state(), 'env:m', ['Always cite a source.'], {now: at, makeId});
  noteChat(store.state(), 'writer', {now: at, messages: store.state().chats.writer});
  let seen = null;
  const result = await consolidateModel(store, {
    key: 'env:m', config: {model: 'm'}, chatKey: 'writer', now: at,
    executor: async (instructions, input, config) => {
      seen = {instructions, input, config};
      return '```json\n{"rules":["Always cite a source.","Prefer British spelling."],"summary":"The chat asks for sourced, British-spelled drafts."}\n```';
    },
  });
  assert.equal(result.skipped, false);
  assert.match(seen.instructions, /JSON only/);
  assert.match(seen.input, /Always cite a source/);
  assert.deepEqual(seen.config, {model: 'm'});
  const book = store.state().memory.rulebooks['env:m'];
  assert.deepEqual(book.rules.map(rule => rule.text), ['Always cite a source.', 'Prefer British spelling.']);
  assert.equal(book.pending.length, 0);
  assert.match(store.state().memory.chats.writer.summary, /British-spelled/);
});

test('an unusable consolidation reply keeps what the book already had', async () => {
  const store = memoryStore({memory: memoryState({}), chats: {}});
  addRules(store.state(), 'env:m', ['Always keep replies short.'], {now: at, makeId});
  const result = await consolidateModel(store, {
    key: 'env:m', config: {model: 'm'}, now: at,
    executor: async () => 'I could not do that.',
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no usable memory update/);
  assert.deepEqual(store.state().memory.rulebooks['env:m'].rules.map(rule => rule.text), ['Always keep replies short.']);
  assert.equal(consolidationDue(store.state().memory.rulebooks['env:m'], Date.parse(at) + 60_000), false, 'An unusable reply still spends the cooldown.');
});

test('consolidation needs a provider, and the background pass respects the cooldown', async () => {
  const store = memoryStore({memory: memoryState({}), chats: {}});
  addRules(store.state(), 'env:m', ['Always keep replies short.'], {now: at, makeId});
  await assert.rejects(() => consolidateModel(store, {key: 'env:m', config: null}), error => error.status === 422);
  const book = state => state.memory.rulebooks['env:m'];
  book(store.state()).pending = ['one', 'two', 'three'];
  book(store.state()).consolidatedAt = '2026-01-01T00:00:00.000Z';
  let calls = 0;
  const executor = async () => { calls++; return '{"rules":["Always keep replies short."],"summary":"Short replies."}'; };
  const first = await maybeConsolidate(store, {key: 'env:m', config: {model: 'm'}, now: Date.parse('2026-01-01T00:10:00.000Z'), executor});
  assert.equal(first.skipped, false);
  assert.equal(calls, 1);
  book(store.state()).pending = ['four', 'five', 'six'];
  const second = await maybeConsolidate(store, {key: 'env:m', config: {model: 'm'}, now: Date.parse('2026-01-01T00:11:00.000Z'), executor});
  assert.equal(second, null, 'The five-minute cooldown must stop a second rewrite.');
  assert.equal(calls, 1);
});

test('a bot with memory off neither reads nor writes it', async () => {
  const store = memoryStore({memory: memoryState({}), chats: {writer: [{id: 'm1', role: 'user', text: 'Always keep replies short.', at}]}});
  const config = {model: 'model-a'};
  const off = {id: 'writer', settings: {memory: false}};
  assert.equal(memoryFor(store, {bot: off, config, chatKey: 'writer'}), null);
  assert.equal(await rememberTurn(store, {bot: off, config, chatKey: 'writer', userText: 'Always keep replies short.'}), null);
  assert.deepEqual(store.state().memory.rulebooks, {});
  assert.deepEqual(store.state().memory.chats, {});

  const on = memoryFor(store, {bot: {id: 'writer'}, config, chatKey: 'writer'});
  assert.equal(on.key, 'bot:writer', 'the book is the bot\'s own');
  assert.equal(on.label, 'model-a', 'a bot with no name is labelled by its model');
  assert.deepEqual(on.rules, []);
  await rememberTurn(store, {bot: {id: 'writer'}, config, chatKey: 'writer', userText: 'Always keep replies short.', botText: 'Okay.', now: at});
  const book = store.state().memory.rulebooks['bot:writer'];
  assert.equal(book.turns, 1);
  assert.deepEqual(book.pending, ['Always keep replies short.']);
  assert.match(store.state().memory.chats.writer.summary, /replies short/);
});

test('a group conversation merges its run log with the chat record, in order', () => {
  const state = {
    chats: {'team-g1': [{id: 'b', role: 'bot', text: 'second', at: '2026-01-01T00:00:02.000Z'}]},
    groupMessages: {g1: [{id: 'a', role: 'bot', text: 'first', at: '2026-01-01T00:00:01.000Z'}, {id: 'b', role: 'bot', text: 'second', at: '2026-01-01T00:00:02.000Z'}]},
  };
  assert.deepEqual(conversationMessages(state, 'team-g1').map(m => m.text), ['first', 'second'], 'A message stored twice appears once.');
  assert.deepEqual(conversationMessages(state, 'writer'), []);
});

test('a model key cannot reach a prototype', () => {
  const state = {};
  // `rulebooks['__proto__']` *is* Object.prototype, so the old read-then-mutate
  // path wrote `rules` onto every object in the process.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => rulebook(state, key), error => error.status === 400, `${key} must be refused`);
    assert.throws(() => addRules(state, key, ['a durable rule']), error => error.status === 400);
    assert.throws(() => forgetRulebook(state, key), error => error.status === 400);
  }
  assert.equal(({}).rules, undefined, 'Object.prototype must be untouched');
  assert.equal(Object.hasOwn(Object.prototype, 'rules'), false);

  // A real key still works, and a look-up of a missing one does not create it.
  addRules(state, 'env:model-a', ['keep replies short']);
  assert.equal(findRulebook(state, 'env:missing'), null);
  assert.equal(Object.keys(state.memory.rulebooks).length, 1);

  // The chat recap goes through the same key guard.
  assert.throws(() => forgetChat(state, '__proto__'), error => error.status === 400);
  assert.deepEqual(Object.keys(state.memory.forgottenChats), [], 'nothing was recorded for the refused key');
});
