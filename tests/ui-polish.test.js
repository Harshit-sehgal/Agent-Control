import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared=path.join(root,'shared');
// The UI is app.js plus every ui-*.js module.
const uiFiles=['app.js',...(await readdir(shared)).filter(f=>/^ui-.+\.js$/.test(f)).sort()];
const [html,css]=await Promise.all(['index.html','app.css'].map(f=>readFile(path.join(shared,f),'utf8')));
const js=(await Promise.all(uiFiles.map(f=>readFile(path.join(shared,f),'utf8')))).join('\n');
test('Pages uses relative visual assets and an accessible command palette',()=>{
  assert.match(html,/href="\.\/app\.css"/);
  assert.match(html,/id="command"/);
  assert.match(js,/role="dialog" aria-modal="true" aria-label="Quick navigation"/);
  assert.match(js,/function openCommandPalette\(/);
  assert.match(js,/function closeCommandPalette\(/);
  assert.match(js,/function chooseCommand\(/);
  assert.match(js,/ev\.ctrlKey \|\| ev\.metaKey/);
  assert.match(js,/aria-selected/);
});
test('hash routes respond to browser Back and Forward',()=>{
  // Navigation goes through go(), which pushes a hash; popstate re-parses it
  // through parseRoute so Back/Forward and reload land on the same screen.
  assert.match(js,/export function go\(/);
  assert.match(js,/history\[replace \? 'replaceState' : 'pushState'\]/);
  assert.match(js,/addEventListener\('popstate'/);
  assert.match(js,/parseRoute\(location\.hash/);
});
test('polish preserves truthful Pages limitations and manual publishing',()=>{
  assert.match(html,/No real AI or remote backend/);
  assert.match(js,/Browser-only prototype/);
  assert.match(js,/final Post click stays with you/i);
  assert.match(js,/Bots draft\. You post\. Always\./);
  assert.doesNotMatch(js,/OPENAI_API_KEY\s*=/);
});
test('the single stylesheet keeps motion, focus and small-screen rules',()=>{
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/focus-visible/);
  assert.match(css,/@media\(max-width:850px\)/);
  assert.match(css,/@media\(max-width:500px\)/);
});
