import test from 'node:test';import assert from 'node:assert/strict';
import {candidateInput,scoreCandidate,delayWindow,scheduleApproval,markDue,initialState,validHttpUrl} from '../shared/core.js';

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
