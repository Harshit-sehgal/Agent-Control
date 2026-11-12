import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILT_IN_TEMPLATES, templateChips, addTemplate, removeTemplate, hasMailApp, MAX_TEMPLATES} from '../shared/templates.js';
import {BRIEFING_KEY} from '../shared/briefing.js';

// Starter templates are tappable chips: most fill the composer for the owner to edit, the
// daily briefing makes its schedule. The owner's own saved messages sit beside them.

const base = () => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], tasks: [], connectors: []});
const ids = chips => chips.map(c => c.id);

test('the built-in set is small, each with a title and the text it fills in', () => {
  assert.ok(BUILT_IN_TEMPLATES.length >= 5 && BUILT_IN_TEMPLATES.length <= 8);
  for (const t of BUILT_IN_TEMPLATES) {
    assert.ok(t.id && t.title && (t.action === 'briefing' || t.text), t.id);
    assert.ok(['fill', 'briefing'].includes(t.action), t.id);
  }
  assert.deepEqual(ids(templateChips(base())), ['daily-briefing', 'watch-page', 'research-digest', 'draft-reply']);
});

test('summarise my inbox shows only once a mail app is connected and ready', () => {
  const s = base();
  s.connectors = [{id: 'gmail', kind: 'site', app: 'google', name: 'Gmail', status: 'setup'}];
  assert.equal(hasMailApp(s), false);
  s.connectors[0].status = 'ready';
  assert.equal(hasMailApp(s), true);
  assert.ok(ids(templateChips(s)).includes('inbox'));
  assert.equal(hasMailApp({connectors: [{id: 'google', kind: 'google', name: 'Google', status: 'ready'}]}), true);
  assert.equal(hasMailApp({connectors: [{id: 'notion', kind: 'mcp', name: 'Notion', status: 'ready'}]}), false);
});

test('the briefing chip goes once the briefing is on', () => {
  const s = base();
  s.tasks.push({id: 'b', kind: 'bot-task', status: 'queued', idempotencyKey: BRIEFING_KEY, payload: {brief: 'daily', botId: 'atlas', message: 'x'}});
  assert.ok(!ids(templateChips(s)).includes('daily-briefing'));
});

test('a saved message is kept with a short title and listed after the built-ins', () => {
  const s = base();
  const t = addTemplate(s, {text: '  Check the   flight prices to Lisbon for next month and list the three cheapest  '}, {makeId: () => 'tp-1', now: '2026-11-12T08:00:00.000Z'});
  assert.deepEqual(t, {id: 'tp-1', title: 'Check the flight prices to Lisbon for…', text: 'Check the   flight prices to Lisbon for next month and list the three cheapest', createdAt: '2026-11-12T08:00:00.000Z'});
  const chips = templateChips(s);
  assert.deepEqual(chips.at(-1), {id: 'tp-1', title: t.title, text: t.text, action: 'fill', saved: true});
  assert.equal(addTemplate(s, {title: 'Flights', text: 'Check the   flight prices to Lisbon for next month and list the three cheapest'}).id, 'tp-1', 'the same text is not saved twice');
});

test('a template needs text, stays short, and the list has a limit', () => {
  const s = base();
  assert.throws(() => addTemplate(s, {text: '   '}), e => e.status === 400);
  assert.throws(() => addTemplate(s, {text: 'x'.repeat(4001)}), e => e.status === 400);
  for (let i = 0; i < MAX_TEMPLATES; i++) addTemplate(s, {text: `task ${i}`}, {makeId: () => `t${i}`});
  assert.throws(() => addTemplate(s, {text: 'one more'}), e => e.status === 409);
});

test('deleting removes a saved template; a built-in or unknown id is not found', () => {
  const s = base();
  addTemplate(s, {text: 'Hello'}, {makeId: () => 'tp-1'});
  assert.deepEqual(removeTemplate(s, 'tp-1'), {ok: true});
  assert.deepEqual(s.templates, []);
  assert.throws(() => removeTemplate(s, 'tp-1'), e => e.status === 404);
  assert.throws(() => removeTemplate(s, 'draft-reply'), e => e.status === 404);
});
