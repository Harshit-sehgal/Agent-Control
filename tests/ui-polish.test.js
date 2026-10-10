import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [html,css,js]=await Promise.all(['docs/index.html','docs/polish.css','docs/app.js'].map(file=>readFile(path.join(root,file),'utf8')));
test('Pages uses relative visual assets and an accessible command palette',()=>{
  assert.match(html,/href="\.\/polish\.css"/);
  assert.match(html,/id="command"/);
  assert.match(js,/role="dialog" aria-modal="true" aria-label="Quick navigation"/);
  assert.match(js,/function openCommandPalette\(/);
  assert.match(js,/function closeCommandPalette\(/);
  assert.match(js,/function chooseCommand\(/);
  assert.match(js,/ctrlKey\|\|ev\.metaKey/);
  assert.match(js,/aria-selected/);
});
test('polish preserves truthful Pages limitations and manual publishing',()=>{
  assert.match(html,/No real AI or remote backend/);
  assert.match(js,/Browser-only prototype/);
  assert.match(js,/The final Post click stays with you/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/focus-visible/);
  assert.match(css,/@media\(max-width:500px\)/);
  assert.doesNotMatch(js,/OPENAI_API_KEY\s*=/);
});
