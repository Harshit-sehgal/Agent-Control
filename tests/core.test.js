import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initialState,validHttpUrl,cleanText} from '../shared/core.js';

test('validHttpUrl accepts web addresses only',()=>{
  assert.ok(validHttpUrl('https://x.com/example/status/1'));
  assert.equal(validHttpUrl('javascript:alert(1)'),null);
  assert.equal(validHttpUrl('https://user:pw@example.com/'),null,'credentials in the address are refused');
  assert.equal(validHttpUrl('not a url'),null);
});
test('cleanText trims, caps and ignores non-strings',()=>{
  assert.equal(cleanText('  hello  '),'hello');
  assert.equal(cleanText('abcdef',3),'abc');
  assert.equal(cleanText(42),'');
});

test('core fails fast with an actionable message when Web Crypto is missing',async()=>{
  // On Node 18 (below the engines floor) the old code died with a bare
  // "crypto is not defined" inside initialState. The guard must name the fix.
  const source=await readFile(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'shared','core.js'),'utf8');
  assert.match(source,/typeof crypto === 'undefined'/);
  assert.match(source,/requires Node\.js 22\.5\+/);
});
test('the starting workspace is one Atlas bot and nothing from X',()=>{
  const s=initialState();
  assert.equal(s.groups.length,1);
  assert.equal(s.groups[0].id,'home');
  assert.deepEqual(s.groups[0].bots.map(b=>b.id),['atlas']);
  assert.equal(s.groups[0].bots[0].settings.lead,true);
  for(const key of ['candidates','drafts','captureToken','topics','schedules']){
    assert.equal(key in s,false,`state still has ${key}`);
    assert.equal(key in s.settings,false,`settings still has ${key}`);
  }
});
