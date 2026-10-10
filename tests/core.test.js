import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {candidateInput,scoreCandidate,delayWindow,scheduleApproval,markDue,initialState,validHttpUrl,templateDraft,DEMO_SAMPLES} from '../shared/core.js';

test('initial state has X-engage group with expected bots',()=>{const s=initialState();assert.equal(s.groups[0].id,'x-engage');assert.equal(s.groups[0].bots.length,6);assert.ok(s.captureToken.length>25);});
test('score ranks matching technical conversation higher',()=>{
  const a=scoreCandidate({text:'How can a new robotics model perform more reliably? Which benchmarks count?',topic:'robotics'},['robotics']);
  const b=scoreCandidate({text:'Today I went to the store to buy bread.',topic:'other'},['robotics']);
  assert.ok(a.score>b.score);assert.ok(a.matched.includes('robotics'));
});
test('candidate input refuses javascript URL and short text',()=>{
  assert.throws(()=>candidateInput({url:'javascript:alert(1)',text:'this is a normal post with words'}));
  assert.throws(()=>candidateInput({url:'https://x.com/a/status/1',text:'short'}));
  assert.ok(validHttpUrl('https://x.com/example/status/1'));
});
test('random range respects boundaries including zero',()=>{
  assert.equal(delayWindow(0,0),0);
  assert.equal(delayWindow(2,10,()=>0),120000);
  assert.equal(delayWindow(2,10,()=>0.999999999),600000);
  assert.throws(()=>delayWindow(10,2));
  assert.throws(()=>delayWindow(-1,10));
});
test('approval locks exact revision and becomes ready when due',()=>{
  const draft={id:'1',text:'Approved copy',revision:3,status:'pending'};
  scheduleApproval(draft,2,10,100000,()=>0);
  assert.equal(draft.approvedRevision,3);assert.equal(draft.approvedText,'Approved copy');
  assert.equal(markDue(draft,219999),false);assert.equal(markDue(draft,220000),true);assert.equal(draft.status,'ready');
  assert.throws(()=>scheduleApproval(draft,0,0,100000));
});

test('template draft is stable and records a requested rewrite direction',()=>{
  const c={text:'Which robotics benchmarks actually predict production reliability?',topic:'robotics'};
  const s={opinions:''};
  const base=templateDraft(c,s);
  assert.equal(templateDraft(c,s),base,'template output is deterministic without a direction');
  const directed=templateDraft(c,s,'focus on the reliability angle');
  assert.notEqual(directed,base,'a requested direction changes the template text');
  assert.match(directed,/Requested angle \(not yet applied\): focus on the reliability angle/);
  assert.ok(directed.length<=1700);
});
test('markDue ignores a scheduled draft with a missing or invalid dueAt',()=>{
  const now=Date.now();
  // `new Date(null).getTime()` is 0 and `new Date(undefined).getTime()` is NaN --
  // both are <= now, so a corrupt state file would otherwise release the draft
  // instantly instead of waiting for its real time.
  assert.equal(markDue({status:'scheduled',dueAt:null},now),false);
  assert.equal(markDue({status:'scheduled',dueAt:undefined},now),false);
  assert.equal(markDue({status:'scheduled',dueAt:''},now),false);
  assert.equal(markDue({status:'scheduled',dueAt:0},now),false);
  assert.equal(markDue({status:'scheduled',dueAt:'not-a-date'},now),false);
  // A valid due time still transitions, and a pending draft never does.
  assert.equal(markDue({status:'scheduled',dueAt:new Date(now+60000).toISOString()},now),false);
  assert.equal(markDue({status:'pending',dueAt:new Date(now-1000).toISOString()},now),false);
  const real={status:'scheduled',dueAt:new Date(now-1000).toISOString()};
  assert.equal(markDue(real,now),true);assert.equal(real.status,'ready');
});

test('the demo fixtures live in one place and both backends load them',async()=>{
  // The Node /api/demo/seed route used to restate the samples inline, so an edit
  // to one demo silently diverged from the other. Both must read DEMO_SAMPLES.
  assert.equal(DEMO_SAMPLES.length,3);
  for(const s of DEMO_SAMPLES){
    assert.ok(s.url&&s.text&&s.author&&s.topic,'Fixture incomplete: '+JSON.stringify(s));
    assert.ok(validHttpUrl(s.url),'Fixture URL invalid: '+s.url);
    assert.ok(s.text.length>=12,'Fixture text too short: '+s.url);
  }
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverJs=await readFile(path.join(root,'src','server.js'),'utf8');
  const localApi=await readFile(path.join(root,'shared','local-api.js'),'utf8');
  assert.match(serverJs,/seedDemo\(s,DEMO_SAMPLES\)/,'The Node seed route must use the shared fixtures.');
  assert.match(localApi,/seedDemo\(state, DEMO_SAMPLES\)/,'The browser-local transport must use the shared fixtures.');
  // And neither file may carry its own restated copy of the fixtures.
  assert.doesNotMatch(serverJs,/robotics-demo/,'The Node server restated the demo fixtures inline.');
  assert.doesNotMatch(localApi,/const samples\s*=\s*\[/,'local-api.js restated the demo fixtures inline.');
});
