// Teach from a reply: under each bot reply, Copy and Teach. Teach asks what the bot should do differently from now
// on and keeps the answer as that bot's own rule (POST /api/memory/rules), so a wrong reply becomes a fix in one tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {teachPrompt, teachRule} from '../shared/ui-model.js';

test('the sheet names the bot and says the rule lasts', () => {
  const p = teachPrompt({botName: 'Scout'});
  assert.equal(p.title, 'Teach Scout');
  assert.match(p.sub, /from now on/);
  assert.ok(p.placeholder);
  assert.equal(teachPrompt().title, 'Teach this bot');
});

test('what the owner types becomes one rule line, or nothing', () => {
  assert.equal(teachRule('  Keep replies\n under five lines.  '), 'Keep replies under five lines.');
  assert.equal(teachRule('ok'), null, 'too short to be a rule');
  assert.equal(teachRule(null), null);
  assert.equal(teachRule('x'.repeat(500)).length, 240, 'no longer than the rule route keeps');
});

test('each bot reply carries Copy and Teach, and Teach saves to that bot\'s book', () => {
  const view = fs.readFileSync(new URL('../shared/ui-conversation.js', import.meta.url), 'utf8');
  assert.match(view, /btn\('Copy', 'copy-reply'/);
  assert.match(view, /btn\('Teach', 'teach-reply'/);
  assert.match(view, /'copy-reply':/);
  assert.match(view, /'teach-reply':[\s\S]*\/api\/memory\/rules/);
  // The route's `label` names the rule book the first time; it must be the bot's name, never the reply.
  assert.match(view, /\/api\/memory\/rules', 'POST', \{bot: bot\.id, text, label: bot\.name\}/);
});
