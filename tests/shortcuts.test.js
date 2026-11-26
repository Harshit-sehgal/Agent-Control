// The keyboard shortcuts sheet (press ? anywhere outside a text box, or Settings → Look → Keyboard shortcuts)
// lists the keys the app really answers to, with the Mac's ⌘ where a PC says Ctrl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {shortcutRows} from '../shared/ui-model.js';

test('the sheet names each shortcut with its keys, and ⌘ on a Mac', () => {
  const pc = shortcutRows(false), mac = shortcutRows(true);
  const find = (rows, what) => rows.find(r => r.what.includes(what));
  assert.deepEqual(find(pc, 'Search').keys, ['Ctrl', 'K']);
  assert.deepEqual(find(mac, 'Search').keys, ['⌘', 'K']);
  assert.deepEqual(find(pc, 'Send').keys, ['Enter']);
  assert.deepEqual(find(pc, 'new line').keys, ['Shift', 'Enter']);
  assert.deepEqual(find(pc, 'Settings').keys, [',']);
  assert.deepEqual(find(pc, 'these shortcuts').keys, ['?']);
  assert.ok(pc.every(r => r.keys.length && r.what));
});

test('every key the sheet lists is one the shell or app listens for', () => {
  const shell = fs.readFileSync(new URL('../shared/ui-shell.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../shared/app.js', import.meta.url), 'utf8');
  assert.match(shell, /ev\.key === '\?'/);
  assert.match(shell, /ev\.key === ','/);
  assert.match(shell, /toLowerCase\(\) === 'k'/);
  assert.match(app, /ev\.key === 'Enter' && !ev\.shiftKey/);
});
