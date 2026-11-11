import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRun,planHandoffs,createEnvelope,assertValidHandoff,runNote,MAX_HANDOFFS} from '../shared/coordination.js';
import {simulateGroup} from '../shared/group-simulator.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {coordinationState,runGroup,markInterrupted} from '../src/coordination.js';
const group={id:'home',name:'Home',bots:['scout','ranker','researcher','writer','reviewer','handoff'].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),instructions:`Act as ${id}`,type:'custom'}))};
// An explicit pipeline stands in for the retired seed: five bots run in order, the sixth is a manual stop.
group.settings={pipeline:['scout','ranker','researcher','writer','reviewer']};

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

test('the envelope prefers the newest page and bounds the bot role',()=>{
  const r=createRun({group,message:'Handle this post',makeId:randomUUID});
  r.task={feedText:'old feed text from home'};
  r.browserPage='the docs you just opened';
  const env=createEnvelope({run:r,bot:{...group.bots[0],instructions:'x'.repeat(5000)}});
  assert.equal(env.page,'the docs you just opened');
  assert.equal(env.botRole.length,3600);
  assert.match(env.restrictions.join(' '),/Do not request that page again/);
});

test('server-side agent execution persists messages and real previous outputs',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-'));
  try{
    const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    await store.update(s=>{s.groups=[group];coordinationState(s);s.groupRuns.push(createRun({group,message:'Coordinate',makeId:()=> 'run-1'}));});
    const contexts=[];
    await runGroup(store,'run-1',async(bot,input)=>{const e=JSON.parse(input);contexts.push(e);return `Response from ${bot.name}`;});
    const s=store.read();const run=s.groupRuns[0];
    assert.equal(run.status,'completed');assert.equal(s.groupMessages['home'].length,5);
    assert.equal(contexts[1].previous.output,'Response from Scout');
    assert.equal(s.groupMessages['home'][0].toBotId,'ranker');
    assert.equal(s.groupMessages['home'][4].toBotId,null);
    const persisted=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    assert.equal(persisted.read().groupRuns[0].status,'completed');
    await persisted.update(s=>{s.groupRuns[0].status='running';});
    await markInterrupted(persisted);assert.equal(persisted.read().groupRuns[0].status,'interrupted');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a checkpointed run pauses between steps and resumes on human approval',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-cp-'));
  try{
    const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    const three={id:'home',name:'Home',bots:group.bots.slice(0,3)};
    await store.update(s=>{s.groups=[three];coordinationState(s);s.groupRuns.push(createRun({group:three,message:'Coordinate',makeId:()=> 'run-cp',checkpoints:true}));});
    const {resumeGroupRun}=await import('../src/coordination.js');
    await runGroup(store,'run-cp',async bot=>`Response from ${bot.name}`);
    let run=store.read().groupRuns[0];
    assert.equal(run.status,'awaiting_checkpoint');
    assert.equal(run.trace.length,1,'Only the first step runs before the gate.');
    assert.equal(run.checkpoint.nextStep,1);
    const responder=async bot=>`Response from ${bot.name}`;
    const first=await resumeGroupRun(store,'run-cp',responder);
    run=store.read().groupRuns[0];
    assert.equal(run.status,'awaiting_checkpoint','It pauses again before the last handoff.');
    assert.equal(first.status,run.status,'The continue route reports the pause, not a fake running.');
    assert.equal(run.trace.length,2);
    const last=await resumeGroupRun(store,'run-cp',responder);
    run=store.read().groupRuns[0];
    assert.equal(run.status,'completed');
    assert.equal(last.status,run.status);
    assert.equal(run.trace.length,3);
    assert.equal(run.checkpoint,null);
    // A run that is not paused cannot be resumed.
    await assert.rejects(resumeGroupRun(store,'run-cp'),error=>error.status===409);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('orchestrator records execution failure and never publishes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-fail-'));
  try{
    const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    await store.update(s=>{s.groups=[group];coordinationState(s);s.groupRuns.push(createRun({group,message:'Coordinate',makeId:()=> 'run-2'}));});
    await runGroup(store,'run-2',async()=>{throw Error('Model unavailable');});
    const s=store.read();assert.equal(s.groupRuns[0].status,'failed');assert.match(s.groupRuns[0].error,/Model unavailable/);
    assert.equal(s.groupMessages['home']?.length||0,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('queuing a run reports a missing group before complaining about the AI key',async()=>{
  // Without OPENAI_API_KEY the old code returned 422 for everything, so a typo
  // in the group id told the user to set a key instead of telling them the group
  // does not exist. Validation order matters.
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-404-'));
  try{
    const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    await store.update(s=>{coordinationState(s);s.groups=[group];});
    const {queueGroupRun:queue}=await import('../src/coordination.js');
    await assert.rejects(queue(store,{groupId:'missing',message:'hi'}),error=>error.status===404);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a run writes its messages and outcome into the conversation it was started from',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ac-coord-'));
  try{
    const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();
    await store.update(s=>{s.groups=[group];coordinationState(s);
      s.groupRuns.push(createRun({group,message:'@scout @writer go',makeId:()=> 'run-chat',chatKey:'writer',checkpoints:true}));});
    assert.equal(store.read().groupRuns[0].chatKey,'writer');
    await runGroup(store,'run-chat',async bot=>`Response from ${bot.name}`);
    let chat=store.read().chats.writer;
    assert.deepEqual(chat.map(m=>m.role),['bot','system'],'The first step and the pause must be in the conversation without any browser open.');
    assert.equal(chat[0].id,store.read().groupMessages['home'][0].id,'The conversation reuses the run-log id, so a client that mirrors it adds no duplicate.');
    assert.equal(chat[0].senderName,'Scout');assert.equal(chat[0].runId,'run-chat');
    assert.deepEqual(chat[1],{...chat[1],...runNote(store.read().groupRuns[0])});
    assert.match(chat[1].text,/Paused after step 1/);
    await runGroup(store,'run-chat',async bot=>`Response from ${bot.name}`);
    chat=store.read().chats.writer;
    assert.deepEqual(chat.map(m=>m.role),['bot','system','bot','system']);
    assert.match(chat[3].text,/Done in 2 step/);
    // A failure and a restart are reported there too.
    await store.update(s=>{s.groupRuns.unshift(createRun({group,message:'again',makeId:()=> 'run-fail'}));});
    await runGroup(store,'run-fail',async()=>{throw Error('Model unavailable');});
    assert.match(store.read().chats['team-home'].at(-1).text,/The run failed: Model unavailable/);
    await store.update(s=>{s.groupRuns.unshift({...createRun({group,message:'later',makeId:()=> 'run-cut'}),status:'running'});});
    await markInterrupted(store);
    assert.match(store.read().chats['team-home'].at(-1).text,/Server restarted before the run completed/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a run can only be attached to a conversation inside its own group',()=>{
  assert.equal(createRun({group,message:'hi',makeId:()=> 'r'}).chatKey,'team-home');
  assert.equal(createRun({group,message:'hi',makeId:()=> 'r',chatKey:'team-home'}).chatKey,'team-home');
  assert.equal(createRun({group,message:'hi',makeId:()=> 'r',chatKey:'someone-else'}).chatKey,'team-home');
  assert.equal(createRun({group,message:'hi',makeId:()=> 'r',chatKey:'team-other'}).chatKey,'team-home');
  assert.equal(createRun({group,message:'hi',makeId:()=> 'r',directBotId:'writer'}).chatKey,'writer');
});
