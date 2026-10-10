import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRun,planHandoffs,createEnvelope,assertValidHandoff,MAX_HANDOFFS} from '../shared/coordination.js';
import {simulateGroup} from '../shared/group-simulator.js';
import {JsonStore} from '../src/store.js';
import {coordinationState,runGroup,markInterrupted} from '../src/coordination.js';
const group={id:'x-engage',name:'X-engage',bots:['scout','ranker','researcher','writer','reviewer','handoff'].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),instructions:`Act as ${id}`,type:({scout:'source',ranker:'scoring',researcher:'context',writer:'writing',reviewer:'review',handoff:'manual'})[id]}))};

test('Grok-like group chat supports targeted mentions and bounded default pipeline',()=>{
  assert.deepEqual(planHandoffs(group,'Please coordinate these bots').recipients,['scout','ranker','researcher','writer','reviewer']);
  assert.deepEqual(planHandoffs(group,'@Writer @Reviewer please check').recipients,['writer','reviewer']);
  assert.deepEqual(planHandoffs(group,'@everyone test').recipients.map(Boolean),Array(6).fill(true));
  assert.equal(planHandoffs(group,'Ask scout',{directBotId:'scout'}).recipients[0],'scout');
  assert.throws(()=>planHandoffs(group,'Hi',{directBotId:'other'}),/does not belong/);
  assert.throws(()=>assertValidHandoff(group,'scout','outsider'),/Cross-group/);
  assert.throws(()=>assertValidHandoff(group,'scout','scout'),/itself/);
  const crowded={id:'other',bots:Array.from({length:30},(_,i)=>({id:`bot-${i}`,name:`Bot ${i}`}))};
  assert.equal(planHandoffs(crowded,'@everyone').recipients.length,MAX_HANDOFFS);
});

test('each handoff includes bounded previous bot output, not new instructions',()=>{
  const r=createRun({group,message:'Handle this post',makeId:randomUUID});r.currentStep=1;
  const env=createEnvelope({run:r,bot:group.bots[1],previous:{botId:'scout',output:'A'.repeat(10000)}});
  assert.equal(env.previous.output.length,3600);
  assert.match(env.restrictions.join(' '),/untrusted/);
  assert.deepEqual(r.recipients,['scout','ranker','researcher','writer','reviewer']);
});

test('browser simulation passes steps between real bot identities and creates pending draft only',async()=>{
  const messages=[],drafts=[];
  const state={settings:{topics:['robotics']},candidates:[{id:'c1',text:'New robotics architecture published, what do you think?',url:'https://example.com',author:'Demo'}],drafts};
  const run=await simulateGroup({group,message:'Coordinate X-engage',state,makeId:randomUUID,emit:m=>messages.push(m),api:async(url,method)=>{
    assert.match(url,/candidates\/c1\/process/);assert.equal(method,'POST');return {id:'d1',candidateId:'c1',author:'Demo',text:'Template draft',status:'pending'};
  }});
  assert.equal(run.status,'completed');assert.equal(run.trace.length,5);
  assert.deepEqual(messages.filter(m=>m.role==='bot').map(m=>m.senderName),['Scout','Ranker','Researcher','Writer','Reviewer']);
  assert.equal(messages.find(m=>m.senderId==='scout').toBotId,'ranker');
  assert.equal(drafts[0].status,'pending');
  assert.match(messages.find(m=>m.senderId==='reviewer').text,/approval/i);
});

test('server-side agent execution persists messages and real previous outputs',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-'));
  try{
    const store=await new JsonStore(path.join(dir,'state.json')).init();
    await store.update(s=>{s.groups=[group];coordinationState(s);s.groupRuns.push(createRun({group,message:'Coordinate',makeId:()=> 'run-1'}));});
    const contexts=[];
    await runGroup(store,'run-1',async(bot,input)=>{const e=JSON.parse(input);contexts.push(e);return `Response from ${bot.name}`;});
    const s=store.read();const run=s.groupRuns[0];
    assert.equal(run.status,'completed');assert.equal(s.groupMessages['x-engage'].length,5);
    assert.equal(contexts[1].previous.output,'Response from Scout');
    assert.equal(s.groupMessages['x-engage'][0].toBotId,'ranker');
    assert.equal(s.groupMessages['x-engage'][4].toBotId,null);
    const persisted=await new JsonStore(path.join(dir,'state.json')).init();
    assert.equal(persisted.read().groupRuns[0].status,'completed');
    await persisted.update(s=>{s.groupRuns[0].status='running';});
    await markInterrupted(persisted);assert.equal(persisted.read().groupRuns[0].status,'interrupted');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('orchestrator records execution failure and never publishes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-fail-'));
  try{
    const store=await new JsonStore(path.join(dir,'state.json')).init();
    await store.update(s=>{s.groups=[group];coordinationState(s);s.groupRuns.push(createRun({group,message:'Coordinate',makeId:()=> 'run-2'}));});
    await runGroup(store,'run-2',async()=>{throw Error('Model unavailable');});
    const s=store.read();assert.equal(s.groupRuns[0].status,'failed');assert.match(s.groupRuns[0].error,/Model unavailable/);
    assert.equal(s.drafts.length,0);assert.equal(s.groupMessages['x-engage']?.length||0,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a repeated group run does not create a second draft for the same candidate',async()=>{
  const drafts=[],messages=[];
  const state={settings:{topics:['robotics']},candidates:[{id:'c1',text:'New robotics architecture published, what do you think?',url:'https://example.com',author:'Demo'}],drafts};
  let calls=0;
  const api=async(url)=>{calls++;return {id:`d${calls}`,candidateId:'c1',author:'Demo',text:'Template draft',status:'pending'};};
  const first=await simulateGroup({group,message:'Coordinate X-engage',state,makeId:randomUUID,emit:m=>messages.push(m),api});
  assert.equal(drafts.length,1);
  // The simulator must consult the drafts it already recorded, not call the API
  // again, so the approval inbox cannot fill with duplicates of one post.
  const second=await simulateGroup({group,message:'Coordinate X-engage',state,makeId:randomUUID,emit:m=>messages.push(m),api});
  assert.equal(calls,1,'The second run must not create another draft.');
  assert.equal(drafts.length,1);
  assert.match(messages.filter(m=>m.senderId==='writer').pop().text,/already exists/);
  // Reviewer must report the real pending count, not merely "some drafts exist".
  assert.match(messages.filter(m=>m.senderId==='reviewer').pop().text,/1 pending draft/);
  assert.equal(first.status,'completed');assert.equal(second.status,'completed');
});

