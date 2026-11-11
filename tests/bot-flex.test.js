import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {planHandoffs,createRun,createEnvelope,handoffTargets,instructLead,wakeBots,planTracked,leadShouldRunGroup,assessTask,summonableGuests,mentionedBots,MAX_HANDOFFS,BUSY_STATUSES,INTERRUPT_STATUSES} from '../shared/coordination.js';
import {MAX_STEPS_LIMIT,REPLY_LENGTHS} from '../shared/bot-settings.js';
import {simulateGroup} from '../shared/group-simulator.js';
import * as wf from '../shared/workflow.js';
import {enqueueTask,claimTasks,completeTask,buildPayload} from '../shared/tasks.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {coordinationState,runGroup,runBotTask,queueGroupRun,decidePlan,markInterrupted} from '../src/coordination.js';
import {executeCustomBot} from '../src/ai.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bot=(id,extra={})=>({id,name:id[0].toUpperCase()+id.slice(1),instructions:`Act as ${id}`,type:'custom',...extra});
const team=(id,ids,extra={})=>({id,name:id,bots:ids.map(x=>typeof x==='string'?bot(x):x),...extra});
const off={settings:{enabled:false}};
const status=code=>error=>error.status===code;

async function tempStore(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ac-flex-'));
  try{const store=await new SqliteStore(path.join(dir,'state.db'),path.join(dir,'state.json')).init();return await fn(store);}
  finally{await fs.rm(dir,{recursive:true,force:true});}
}

test('routing follows the group setting when nobody is mentioned',()=>{
  const g=team('g',['a','b','c'],{settings:{pipeline:['c','a']}});
  assert.deepEqual(planHandoffs(g,'go'),{recipients:['c','a'],mode:'pipeline'});
  assert.deepEqual(planHandoffs({...g,settings:{...g.settings,routing:'mentions'}},'go'),{recipients:['c'],mode:'lead'});
  assert.deepEqual(planHandoffs({...g,settings:{routing:'everyone'}},'go'),{recipients:['a','b','c'],mode:'everyone'});
  assert.deepEqual(planHandoffs(team('g',['a','b','c','d']),'go').recipients,['a','b','c','d'],'The default pipeline is every bot, not the first three.');
});

test('switched-off bots are never recipients',()=>{
  const g=team('g',['a',bot('b',off),'c']);
  assert.deepEqual(planHandoffs(g,'go').recipients,['a','c']);
  assert.deepEqual(planHandoffs(g,'@everyone hi').recipients,['a','c']);
  assert.deepEqual(planHandoffs(g,'@a @b hi').recipients,['a']);
  assert.throws(()=>planHandoffs(g,'hi',{directBotId:'b'}),e=>e.status===409&&e.message==='B is switched off. Turn it on in its profile.');
  assert.throws(()=>planHandoffs(team('g',[bot('a',off)]),'go'),e=>e.status===409&&/No bot in this group is switched on/.test(e.message));
});

test('a run built from an explicit plan wakes only the bots it names and can wait for Start',()=>{
  const g=team('g',[bot('lead',{settings:{lead:true}}),bot('sleepy',off),'worker','spare'],{settings:{coordination:'tracked'}});
  const task={botIds:['sleepy','worker'],doneWhen:'The worker has answered.',summary:'Lead will ask Sleepy, Worker.'};
  const run=createRun({group:g,message:'do the work',directBotId:'lead',makeId:()=>'r',chatKey:'lead',task});
  assert.deepEqual(run.recipients,['sleepy','worker']);
  assert.deepEqual(run.task.woke,['sleepy'],'Only a switched-off bot the plan names is listed to switch on.');
  assert.equal(run.mode,'tracked');
  assert.equal(run.chatKey,'lead');
  assert.equal(run.task.doneWhen,'The worker has answered.');
  assert.equal(run.status,'queued');
  assert.equal(g.bots.find(b=>b.id==='sleepy').settings.enabled,false,'Building the run does not switch a bot on.');
  assert.equal(g.bots.find(b=>b.id==='spare').settings,undefined);
  assert.deepEqual(wakeBots(g,run.task.woke),['sleepy']);
  assert.equal(g.bots.find(b=>b.id==='sleepy').settings.enabled,true);
  assert.deepEqual(wakeBots(g,['nope']),[]);
  const waiting=createRun({group:g,message:'do the work',makeId:()=>'p',task:{...task,confirm:true}});
  assert.equal(waiting.status,'awaiting_plan');
});

test('a tracked group keeps a plain message with the primary bot until routing picks workers',()=>{
  const lead=bot('lead',{settings:{lead:true}});
  const tracked=team('lab',[lead,bot('worker')],{settings:{coordination:'tracked'}});
  const plan=planTracked(tracked,'anything at all');
  assert.deepEqual(plan.botIds,[]);
  assert.equal(plan.matched,false);
  const told=instructLead(tracked,'anything at all','lead');
  assert.equal(told.expanded,false);
  assert.equal(told.directBotId,'lead');
  assert.equal(leadShouldRunGroup(tracked,'anything at all','lead'),false);
  const direct=team('lab',[lead,bot('worker')],{settings:{coordination:'direct'}});
  assert.equal(instructLead(direct,'anything at all','lead').expanded,false,'Direct mode leaves the message with the one bot.');
  const named=team('lab',[lead,bot('worker',off)],{settings:{coordination:'tracked'}});
  assert.equal(instructLead(named,'@worker only you','lead').expanded,false);
  assert.equal(named.bots.find(b=>b.id==='worker').settings.enabled,false);
});

test('a group has one primary bot',()=>{
  const state=wf.migrate({groups:[{id:'g',name:'G',bots:[bot('a',{settings:{lead:true}}),bot('b',{settings:{lead:true}})]}]});
  wf.updateBot(state,'g','b',{settings:{lead:true}});
  assert.equal(state.groups[0].bots.find(b=>b.id==='a').settings.lead,false);
  assert.equal(state.groups[0].bots.find(b=>b.id==='b').settings.lead,true);
});

test('a tracked owner that said nothing is asked again only while the run has a step left',()=>{
  const silent={maxSteps:1,recipients:['writer'],task:{botIds:['writer'],doneWhen:'The writer answers.',retried:false},trace:[{botId:'writer',output:'  '}]};
  assert.equal(assessTask(silent).retryBotId,null,'A full run closes with the missing outcome instead of asking again.');
  assert.equal(assessTask({...silent,maxSteps:6}).retryBotId,'writer');
  assert.equal(assessTask({...silent,maxSteps:6,task:{...silent.task,retried:true}}).retryBotId,null,'The one retry is spent.');
  const spoke=assessTask({...silent,trace:[{botId:'writer',output:'Here you go.'}]});
  assert.equal(spoke.done,true);
  assert.equal(assessTask({recipients:['a'],trace:[]}).done,true,'A run with no plan has nothing to finish.');
});

test('the Pages simulator pauses at a checkpoint and continues from that step', async () => {
  const g = team('g', [bot('lead', {settings: {lead: true}}), bot('writer', {type: 'writing'})], {settings: {checkpoints: true}});
  const idle = {chats: {}};
  const first = [];
  const paused = await simulateGroup({group: g, message: '@lead @writer go', chatKey: 'team-g', state: idle, api: async () => { throw new Error('unused'); }, makeId: randomUUID, emit: m => first.push(m)});
  assert.equal(paused.status, 'awaiting_checkpoint');
  assert.equal(paused.checkpoint.nextStep, 1);
  assert.equal(paused.trace.length, 1);
  assert.ok(first.some(m => /Paused after step/.test(m.text || '')));
  const rest = [];
  const done = await simulateGroup({group: g, message: '@lead @writer go', resume: paused, state: idle, api: async () => { throw new Error('unused'); }, makeId: randomUUID, emit: m => rest.push(m)});
  assert.equal(done.status, 'completed');
  assert.ok(done.trace.some(step => step.botId === 'writer'));
  assert.ok(rest.some(m => m.senderId === 'writer'));
  const three = team('g', [bot('a'), bot('b'), bot('c')], {settings: {checkpoints: true}});
  const firstOfThree = await simulateGroup({group: three, message: '@a @b @c go', chatKey: 'team-g', state: idle, api: async () => { throw new Error('unused'); }, makeId: randomUUID, emit: () => {}});
  const stored = {id: firstOfThree.id, status: firstOfThree.status, checkpoint: firstOfThree.checkpoint, recipients: firstOfThree.recipients, trace: firstOfThree.trace, input: firstOfThree.input};
  const second = await simulateGroup({group: three, message: stored.input, resume: stored, state: idle, api: async () => { throw new Error('unused'); }, makeId: randomUUID, emit: () => {}});
  assert.equal(second.status, 'awaiting_checkpoint');
  assert.equal(second.checkpoint.nextStep, 2);
});

test('a restart leaves a shown plan and a checkpoint in place',async()=>tempStore(async store=>{
  assert.ok(BUSY_STATUSES.includes('awaiting_plan'));
  assert.ok(BUSY_STATUSES.includes('awaiting_checkpoint'));
  assert.ok(!INTERRUPT_STATUSES.includes('awaiting_plan'));
  assert.ok(!INTERRUPT_STATUSES.includes('awaiting_checkpoint'));
  await store.update(s=>{
    coordinationState(s);
    s.groups=[team('g',['a'])];
    s.groupRuns.push(
      {id:'plan',groupId:'g',status:'awaiting_plan',input:'plan it',recipients:['a'],mode:'lead'},
      {id:'gate',groupId:'g',status:'awaiting_checkpoint',checkpoint:{nextStep:1},input:'gate it',recipients:['a'],mode:'lead'},
      {id:'live',groupId:'g',status:'running',input:'live',recipients:['a'],mode:'lead'},
    );
  });
  await markInterrupted(store);
  const runs=Object.fromEntries(store.read().groupRuns.map(r=>[r.id,r.status]));
  assert.equal(runs.plan,'awaiting_plan');
  assert.equal(runs.gate,'awaiting_checkpoint');
  assert.equal(runs.live,'interrupted');
}));

test('a plan that is shown first can be cancelled before any bot runs',async()=>tempStore(async store=>{
  const g=team('g',[bot('writer',off)]);
  const task={botIds:['writer'],doneWhen:'The writer has answered.',summary:'Handoff will ask Writer.',confirm:true};
  await store.update(s=>{s.groups=[g];coordinationState(s);s.groupRuns.push(createRun({group:g,message:'write a reply',makeId:()=>'plan-1',task}));});
  assert.equal(store.read().groupRuns[0].status,'awaiting_plan');
  assert.deepEqual(await decidePlan(store,'plan-1',{approve:false}),{runId:'plan-1',status:'cancelled'});
  assert.equal(store.read().groupRuns[0].status,'cancelled');
  await assert.rejects(decidePlan(store,'plan-1',{approve:true}),status(409));
  assert.match(store.read().chats['team-g'].at(-1).text,/Plan cancelled/);
  assert.equal(store.read().groups[0].bots[0].settings.enabled,false,'Cancel leaves the bot off.');
  await store.update(s=>{s.groupRuns.push(createRun({group:g,message:'write a reply',makeId:()=>'plan-2',chatKey:'team-g',task}));});
  await decidePlan(store,'plan-2',{approve:true});
  assert.equal(store.read().groups[0].bots[0].settings.enabled,true,'Start switches the planned bot on.');
  const done=['completed','failed','cancelled','awaiting_browser','awaiting_checkpoint'];
  for(let i=0;i<50&&!done.includes(store.read().groupRuns.find(r=>r.id==='plan-2')?.status);i++)await new Promise(r=>setTimeout(r,20));
  assert.notEqual(store.read().groupRuns.find(r=>r.id==='plan-2').status,'awaiting_plan');
}));

test('mentions win over a direct recipient, and the step cap applies',()=>{
  const g=team('g',['a','b','c']);
  assert.deepEqual(planHandoffs(g,'@c take this',{directBotId:'a'}),{recipients:['c'],mode:'mention'});
  assert.deepEqual(planHandoffs(g,'plain',{directBotId:'a'}),{recipients:['a'],mode:'direct'});
  assert.deepEqual(mentionedBots(g.bots,'@c then @a'),['c','a']);
  const named=[bot('ann',{name:'Ann'}),bot('bob',{name:'Bob'})];
  assert.deepEqual(mentionedBots(named,'see a@bob.com then @ann then @bob'),['ann','bob'],'An email is not an earlier @mention.');
  assert.deepEqual(mentionedBots(named,'Email a@bob.com'),[]);
  const many=team('m',Array.from({length:20},(_,i)=>`bot-${i}`));
  assert.equal(planHandoffs(many,'go').recipients.length,MAX_HANDOFFS);
  assert.equal(planHandoffs({...many,settings:{maxSteps:2}},'@everyone').recipients.length,2);
  assert.equal(planHandoffs({...many,settings:{maxSteps:99}},'@everyone').recipients.length,MAX_STEPS_LIMIT,'A stored value past the ceiling is still capped.');
});

test('a bot from another group can be summoned by @mention unless it is private or off',()=>{
  const host=team('host',['a']);
  const other=team('other',['expert',bot('hidden',{settings:{summonable:false}}),bot('sleepy',off)]);
  const guests=summonableGuests([host,other],'host');
  assert.deepEqual(guests.map(b=>b.id),['expert']);
  assert.deepEqual(planHandoffs(host,'@a ask @expert',{guests}).recipients,['a','expert']);
  assert.deepEqual(planHandoffs(host,'@hidden help',{guests}).recipients,['a'],'A private bot is not reachable, so the default route runs.');
  assert.deepEqual(planHandoffs(host,'@everyone hi',{guests}).recipients,['a'],'@everyone is the host group only.');
  const planning=summonableGuests([host,other],'host',{includeOff:true});
  assert.deepEqual(planning.map(b=>b.id),['expert','sleepy']);
  assert.throws(()=>planHandoffs(host,'@sleepy wake up',{directBotId:'a',guests:planning}),e=>e.status===409&&/Sleepy is switched off/i.test(e.message),'A mention of a switched-off guest is refused by name, not rerouted.');
  const run=createRun({group:host,message:'@expert check',guests,makeId:()=> 'r',chatKey:'team-host'});
  assert.deepEqual(run.guestIds,['expert']);
  assert.equal(run.chatKey,'team-host');
  assert.equal(run.maxSteps,6);assert.equal(run.botHandoffs,true);
  assert.equal(createRun({group:{...host,settings:{checkpoints:true}},message:'x',makeId:()=> 'r'}).checkpointsEnabled,true);
});

test('handoff targets come only from revalidated @mentions in a bot reply',()=>{
  const g=team('g',['a','b','c',bot('d',off)]);
  const run={recipients:['a'],maxSteps:3,botHandoffs:true};
  const [a]=g.bots;
  assert.deepEqual(handoffTargets({run,roster:g.bots,fromBot:a,output:'@a @d @c then @b and @c'}),['c','b']);
  assert.deepEqual(handoffTargets({run:{...run,maxSteps:2},roster:g.bots,fromBot:a,output:'@b @c'}),['b']);
  assert.deepEqual(handoffTargets({run:{recipients:['a','b']},roster:g.bots,fromBot:a,output:'@b @c'}),['c'],'An already-scheduled bot is not added twice.');
  assert.deepEqual(handoffTargets({run:{...run,botHandoffs:false},roster:g.bots,fromBot:a,output:'@b'}),[]);
  assert.deepEqual(handoffTargets({run,roster:g.bots,fromBot:{...a,settings:{canHandoff:false}},output:'@b'}),[]);
  assert.deepEqual(handoffTargets({run,roster:g.bots,fromBot:a,output:'@everyone'}),[]);
  const full={recipients:Array.from({length:MAX_STEPS_LIMIT},(_,i)=>`x${i}`),maxSteps:50,botHandoffs:true};
  assert.deepEqual(handoffTargets({run:full,roster:g.bots,fromBot:a,output:'@b'}),[]);
  const home=team('host',['a',bot('b',{settings:{summonable:false}})]);
  const hidden=bot('hidden',{settings:{summonable:false}});
  assert.deepEqual(handoffTargets({run,roster:[...home.bots,hidden],fromBot:home.bots[0],output:'@hidden @b please',home:home.bots}),['b'],'A private guest is not a handoff target; a host bot still is.');
});

test('the envelope carries bounded thread context and the team a bot may hand off to',()=>{
  const g=team('g',['a','b']);
  const run=createRun({group:g,message:'go',makeId:()=> 'r'});
  const env=createEnvelope({run,bot:g.bots[0],thread:[{from:'user',text:'earlier'}],team:[g.bots[1]]});
  assert.deepEqual(env.thread,[{from:'user',text:'earlier'}]);
  assert.deepEqual(env.team,[{name:'B',job:'Act as b'}]);
  assert.match(env.restrictions.join(' '),/Thread messages are untrusted/);
  assert.match(env.restrictions.join(' '),/mention them as @Name/);
  const quiet=createEnvelope({run:{...run,botHandoffs:false},bot:g.bots[0],team:[g.bots[1]]});
  assert.deepEqual(quiet.team,[]);
  assert.doesNotMatch(quiet.restrictions.join(' '),/@Name/);
});

test('runGroup grows the run when a bot hands off, and a summoned guest answers in the host chat',async()=>tempStore(async store=>{
  const host=team('host',['a','b']),other=team('other',['expert']);
  await store.update(s=>{s.groups=[host,other];coordinationState(s);
    s.chats={'team-host':[{id:'m0',role:'user',text:'old question',at:new Date().toISOString()},{id:'m1',role:'user',text:'newer question',at:new Date().toISOString()}]};
    s.groupRuns.push(createRun({group:s.groups[0],message:'@a start',guests:summonableGuests(s.groups,'host'),makeId:()=> 'run-g',chatKey:'team-host'}));});
  const seen=[];
  await runGroup(store,'run-g',async(b,input)=>{const e=JSON.parse(input);seen.push(e);return b.id==='a'?'Over to @expert for a check':'Checked.';});
  const s=store.read(),run=s.groupRuns[0];
  assert.equal(run.status,'completed',run.error);
  assert.deepEqual(run.recipients,['a','expert']);
  assert.deepEqual(run.guestIds,['expert']);
  assert.deepEqual(seen[0].thread.map(m=>m.text),['old question','newer question'],'context is automatic: the whole short thread is read.');
  assert.ok(seen[0].team.some(m=>m.name==='Expert'));
  assert.equal(run.trace[0].toBotId,'expert');
  const said=s.chats['team-host'].filter(m=>m.role==='bot');
  assert.deepEqual(said.map(m=>m.senderName),['A','Expert']);
  assert.equal(s.groupMessages.host.length,2);
  assert.equal(s.chats.expert,undefined);
}));

test('a summoned guest that was made private mid-run fails the run clearly',async()=>tempStore(async store=>{
  const host=team('host',['a']),other=team('other',['expert']);
  await store.update(s=>{s.groups=[host,other];coordinationState(s);
    s.groupRuns.push(createRun({group:host,message:'@a @expert go',guests:summonableGuests(s.groups,'host'),makeId:()=> 'run-x'}));});
  await runGroup(store,'run-x',async b=>{if(b.id==='a')await store.update(s=>{s.groups[1].bots[0].settings={summonable:false};});return 'done';});
  const run=store.read().groupRuns[0];
  assert.equal(run.status,'failed');
  assert.match(run.error,/Expert can no longer be summoned/);
}));

test('a checkpoint pause resumes over a recipient list that grew',async()=>tempStore(async store=>{
  const g=team('g',['a','b']);
  await store.update(s=>{s.groups=[g];coordinationState(s);s.groupRuns.push(createRun({group:g,message:'@a go',makeId:()=> 'run-c',checkpoints:true}));});
  const reply=async b=>b.id==='a'?'@b your turn':'finished';
  await runGroup(store,'run-c',reply);
  let run=store.read().groupRuns[0];
  assert.equal(run.status,'awaiting_checkpoint');
  assert.deepEqual(run.recipients,['a','b']);
  await runGroup(store,'run-c',reply);
  run=store.read().groupRuns[0];
  assert.equal(run.status,'completed');assert.equal(run.trace.length,2);
}));

test('queueGroupRun surfaces a switched-off direct bot as 409 before the AI key check',async()=>tempStore(async store=>{
  await store.update(s=>{s.groups=[team('g',['a',bot('b',off)])];coordinationState(s);});
  await assert.rejects(queueGroupRun(store,{groupId:'g',message:'hi',directBotId:'b'}),status(409));
}));

test('executeCustomBot sends temperature, reply length and style',async()=>{
  const requests=[];
  const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}],output:[{content:[{type:'output_text',text:'ok'}]}]}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  try{
    const tuned=bot('a',{settings:{temperature:0.3,replyLength:'short',style:'dry wit'}});
    await executeCustomBot(tuned,'task',{baseUrl,apiKey:'k',model:'m',style:'chat'});
    await executeCustomBot(tuned,'task',{baseUrl,apiKey:'k',model:'m',style:'responses'});
    await executeCustomBot(bot('b'),'task',{baseUrl,apiKey:'k',model:'m',style:'chat'});
    const envelope=JSON.stringify({objective:'o'.repeat(3000),previous:{output:'p'.repeat(3600)},thread:[{from:'user',text:'t'.repeat(3600)}]});
    await executeCustomBot(bot('c'),envelope,{baseUrl,apiKey:'k',model:'m',style:'chat'});
    const huge=JSON.stringify({objective:'o'.repeat(3000),page:'x'.repeat(3600),previous:{from:'scout',output:'p'.repeat(3600)},thread:[{from:'user',text:'t'.repeat(3600)},{from:'bot',text:'u'.repeat(3600)}]});
    assert.ok(huge.length>12000);
    await executeCustomBot(bot('d'),huge,{baseUrl,apiKey:'k',model:'m',style:'chat'});
  }finally{server.close();}
  assert.deepEqual(JSON.parse(requests[3].messages[1].content).thread[0].text.length,3600,'A full envelope reaches the model whole.');
  assert.doesNotThrow(()=>JSON.parse(requests[4].messages[1].content),'An oversized envelope stays valid JSON.');
  assert.equal(requests[0].temperature,0.3);assert.equal(requests[0].max_tokens,REPLY_LENGTHS.short);
  assert.match(requests[0].messages[0].content,/\nTone and style: dry wit$/);
  assert.equal(requests[1].temperature,0.3);assert.equal(requests[1].max_output_tokens,REPLY_LENGTHS.short);
  assert.equal('temperature' in requests[2],false);assert.equal(requests[2].max_tokens,1500);
  assert.doesNotMatch(requests[2].messages[0].content,/Tone and style/);
});

test('bots and groups are edited, removed and cleaned up through the workflow',()=>{
  const s=wf.migrate({groups:[team('keep',['k']),team('g',['a','b'],{settings:{pipeline:['b','a']}})]});
  s.ai.bots.a={model:'m'};s.chats={a:[{id:'1',role:'user',text:'hi'}],'team-g':[{id:'2',role:'user',text:'hi'}]};
  const made=wf.addBot(s,'g',{name:'C',instructions:'Do c',settings:{replyLength:'long'}});
  assert.equal(made.settings.replyLength,'long');
  assert.equal(wf.addBot(s,'g',{name:'D',instructions:'Do d'}).settings,undefined);
  const a=wf.updateBot(s,'g','a',{settings:{temperature:1}});
  assert.equal(a.name,'A');assert.equal(a.settings.temperature,1);
  assert.equal(wf.updateBot(s,'g','a',{settings:{style:'warm'}}).settings.temperature,1,'A partial save keeps other settings.');
  assert.throws(()=>wf.updateBot(s,'g','a',{name:'  '}),/name and instructions required/);
  assert.throws(()=>wf.updateBot(s,'g','a',{settings:{temperature:5}}),status(400));
  const g=wf.updateGroup(s,'g',{name:'Renamed',description:'New',settings:{routing:'everyone'}});
  assert.equal(g.name,'Renamed');assert.equal(g.settings.routing,'everyone');assert.deepEqual(g.settings.pipeline,['b','a']);
  const k=wf.updateGroup(s,'keep',{settings:{confirmPlan:true}});
  assert.equal(k.settings.confirmPlan,true);
  assert.equal(k.settings.pipeline,null,'A partial save must not write an explicit pipeline over the every-bot default.');
  s.groups[1].bots.find(b=>b.id==='a').settings={lead:true};
  const copy=wf.addBot(s,'g',{name:'Lead copy',instructions:'Also keep it on track.',settings:{lead:true}});
  assert.equal(copy.settings.lead,true);
  assert.equal(s.groups[1].bots.find(b=>b.id==='a').settings.lead,false,'A group has one primary bot.');
  assert.throws(()=>wf.updateGroup(s,'g',{name:''}),status(400));
  assert.throws(()=>wf.updateGroup(s,'g',{settings:{pipeline:['zzz']}}),status(400));
  assert.throws(()=>wf.updateGroup(s,'nope',{}),status(404));
  const task=enqueueTask(s,{kind:'bot-task',payload:{groupId:'g',botId:'a',message:'daily',kind:'interval',intervalMinutes:60}}).task;
  assert.deepEqual(wf.removeBot(s,'g','a'),{ok:true});
  assert.equal(s.groups[1].bots.some(b=>b.id==='a'),false);
  assert.deepEqual(s.groups[1].settings.pipeline,['b']);
  assert.equal(s.ai.bots.a,undefined);assert.equal(s.chats.a,undefined);
  assert.equal(task.status,'cancelled');
  assert.throws(()=>wf.removeBot(s,'g','a'),status(404));
  const teamTask=enqueueTask(s,{kind:'bot-task',payload:{groupId:'g',message:'weekly',kind:'interval',intervalMinutes:60}}).task;
  s.ai.bots.b={model:'m'};
  assert.deepEqual(wf.removeGroup(s,'g'),{ok:true});
  assert.equal(s.groups.length,1);assert.equal(s.chats['team-g'],undefined);assert.equal(s.ai.bots.b,undefined);
  assert.equal(teamTask.status,'cancelled');
  s.groups.push(team('h',['z'],{settings:{pipeline:['z','gone']}}));
  wf.migrate(s);assert.deepEqual(s.groups[1].settings.pipeline,['z']);
});

test('bot-task payloads validate, check their target, and an interval re-arms',()=>{
  const s=wf.migrate({groups:[team('g',['a'])]});
  assert.throws(()=>buildPayload('bot-task',{message:'x',kind:'interval',intervalMinutes:5}),status(400));
  assert.throws(()=>buildPayload('bot-task',{groupId:'g',kind:'interval',intervalMinutes:5}),status(400));
  assert.throws(()=>buildPayload('bot-task',{groupId:'g',message:'x'.repeat(2001),kind:'interval',intervalMinutes:5}),status(400));
  assert.throws(()=>buildPayload('bot-task',{groupId:'g',message:'x',kind:'interval',intervalMinutes:0}),status(400));
  assert.throws(()=>buildPayload('bot-task',{groupId:'g',message:'x',kind:'once',nextAt:'2000-01-01'}),status(400));
  assert.throws(()=>enqueueTask(s,{kind:'bot-task',payload:{groupId:'g',botId:'nope',message:'x',kind:'interval',intervalMinutes:5}}),e=>e.status===404&&e.message==='That bot or group no longer exists.');
  assert.throws(()=>enqueueTask(s,{kind:'bot-task',payload:{groupId:'nope',message:'x',kind:'interval',intervalMinutes:5}}),status(404));
  const once=enqueueTask(s,{kind:'bot-task',payload:{groupId:'g',botId:'a',message:'Summarise the day',kind:'once',nextAt:new Date(Date.now()+3600000).toISOString()}}).task;
  assert.equal(once.runAt,once.payload.nextAt);assert.equal(once.intervalMinutes,null);
  assert.equal(once.payload.label,'Summarise the day');assert.equal(once.title,'Scheduled: Summarise the day');
  const every=enqueueTask(s,{kind:'bot-task',payload:{groupId:'g',botId:null,message:'Check in',label:'Standup',kind:'interval',intervalMinutes:30}}).task;
  assert.equal(every.intervalMinutes,30);assert.equal(every.payload.botId,null);
  const now=Date.now()+1000;
  claimTasks(s,{workerId:'w',now});completeTask(s,every.id,null,now);
  assert.equal(every.status,'queued');assert.equal(Date.parse(every.runAt),now+30*60000);
});

test('runBotTask posts into the chat and queues a run, or explains why it skipped',async()=>tempStore(async store=>{
  await store.update(s=>{wf.migrate(s);s.groups=[team('g',['a',bot('b',off)])];});
  const task=(payload)=>({id:'t',payload:{groupId:'g',botId:null,message:'Report',label:'Daily report',kind:'interval',intervalMinutes:60,...payload}});
  const calls=[];
  const queue=async(_s,args)=>{calls.push(args);return {runId:'r1',status:'queued'};};
  await assert.rejects(runBotTask(store,task({groupId:'gone'}),{queue,available:()=>true}),e=>e.status===404&&e.permanent===true&&/no longer exists/.test(e.message));
  assert.deepEqual(await runBotTask(store,task({botId:'b'}),{queue,available:()=>true}),{skipped:'disabled'});
  assert.match(store.read().chats.b.at(-1).text,/Scheduled task "Daily report" skipped: B is switched off\./);
  assert.deepEqual(await runBotTask(store,task({botId:'a'}),{queue,available:()=>false}),{skipped:'no-ai'});
  assert.match(store.read().chats.a.at(-1).text,/skipped: no AI provider is configured/);
  assert.deepEqual(await runBotTask(store,task({}),{queue,available:()=>true}),{runId:'r1',status:'queued'});
  assert.equal(store.read().chats['team-g'].at(-1).text,'Scheduled task: Report');
  assert.deepEqual(calls,[{groupId:'g',message:'Report',directBotId:null,chatKey:'team-g',confirmPlan:false}]);
  const posted=store.read().chats['team-g'].filter(m=>m.text==='Scheduled task: Report').length;
  await assert.rejects(runBotTask(store,task({}),{queue:async()=>{throw Object.assign(new Error('A group run is already active.'),{status:409});},available:()=>true}),status(409));
  assert.equal(store.read().chats['team-g'].filter(m=>m.text==='Scheduled task: Report').length,posted,'A failed queue must not post another Scheduled task line.');
}));

test('a guest @mention is not replaced by the tracked plan and answers in the host chat',async()=>tempStore(async store=>{
  const host=team('host',[bot('lead',{settings:{lead:true}}),bot('writer',{type:'writing'})],{settings:{coordination:'tracked',confirmPlan:true}});
  const expert=bot('expert'),guests=[expert];
  assert.equal(leadShouldRunGroup(host,'@expert draft a reply','lead',guests),false);
  assert.equal(instructLead(host,'@expert draft a reply','lead',guests).expanded,false);
  const planned=createRun({group:host,message:'@expert draft a reply',directBotId:'lead',guests,makeId:()=>'r',chatKey:'lead'});
  assert.deepEqual(planned.recipients,['expert']);
  assert.equal(planned.chatKey,'lead');
  assert.notEqual(planned.status,'awaiting_plan');
  await store.update(s=>{s.groups=[host,team('other',[expert])];s.ai={providers:[{id:'p'}],defaultProviderId:'p'};});
  const queued=await queueGroupRun(store,{groupId:'host',message:'@expert draft a reply',directBotId:'lead',chatKey:'lead'});
  const run=()=>store.read().groupRuns.find(r=>r.id===queued.runId);
  assert.deepEqual(run().recipients,['expert']);
  assert.equal(run().chatKey,'lead');
  assert.notEqual(run().status,'awaiting_plan');
  for(let i=0;i<40&&!['completed','failed'].includes(run().status);i++)await new Promise(r=>setTimeout(r,20));
  const saved=store.read();
  assert.equal(saved.chats.expert,undefined);
  assert.ok(saved.chats.lead.some(m=>m.runId===queued.runId));
  const out=[];
  const demo=await simulateGroup({group:host,message:'@expert draft a reply',directBotId:'lead',guests,chatKey:'lead',state:{chats:{}},api:async()=>{throw new Error('the writer must not run');},makeId:()=>'m',emit:m=>out.push(m)});
  assert.deepEqual(demo.recipients,['expert']);
  assert.equal(demo.chatKey,'lead');
  assert.equal(demo.status,'completed');
  assert.deepEqual(out.filter(m=>m.role==='bot').map(m=>m.senderId),['expert']);
}));

test('a reply cannot hand a private guest into the run',async()=>{
  const hidden=bot('hidden',{settings:{summonable:false}});
  const host=team('host',['a']);
  const run=await simulateGroup({group:host,message:'@a ask @hidden',guests:[hidden],state:{chats:{}},api:async()=>{throw new Error('unused');},makeId:()=>'m',emit:()=>{}});
  assert.deepEqual(run.recipients,['a']);
  assert.ok(!run.trace.some(step=>step.botId==='hidden'));
});

test('the offline simulator follows handoffs and summoned guests',async()=>{
  const host=team('host',['a','b']),guest=bot('expert');
  const out=[];
  const run=await simulateGroup({group:host,message:'@a @expert go',guests:[guest],state:{chats:{}},api:async()=>{throw new Error('unused');},makeId:randomUUID,emit:m=>out.push(m)});
  assert.equal(run.status,'completed');
  assert.deepEqual(out.filter(m=>m.role==='bot').map(m=>m.senderName),['A','Expert']);
});

test('bot and group settings survive a SQLite restart',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ac-flex-sql-'));
  try{
    const db=path.join(dir,'state.db'),legacy=path.join(dir,'state.json');
    const first=await new SqliteStore(db,legacy).init();
    await first.update(s=>{wf.updateGroup(s,'home',{settings:{routing:'mentions'}});const w=wf.addBot(s,'home',{name:'Writer',instructions:'Write replies.'});wf.updateBot(s,'home',w.id,{settings:{replyLength:'short'}});});
    await first.close();
    const again=await new SqliteStore(db,legacy).init();
    const g=again.read().groups.find(x=>x.id==='home');
    assert.equal(g.settings.routing,'mentions');
    assert.equal(g.bots.find(b=>b.name==='Writer').settings.replyLength,'short');
    assert.equal(g.bots.find(b=>b.id==='atlas').settings.replyLength,undefined);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});s.on('error',reject);});}

test('group and bot edit routes enforce roles over HTTP',{timeout:40000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ac-flex-http-')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,AGENT_SKIP_DOTENV:'1',AI_API_KEY:'',OPENAI_API_KEY:'',AI_BASE_URL:'',OPENAI_BASE_URL:'',DASHBOARD_PASSWORD:'test-password-1234',HOST:'127.0.0.1',PORT:String(port),DATA_FILE:path.join(dir,'state.json')},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  try{
    let live=false;
    for(let i=0;i<90&&!live;i++){try{live=(await fetch(base+'/api/health')).ok;}catch{}if(!live)await new Promise(r=>setTimeout(r,70));}
    assert.ok(live,'Server did not start: '+log);
    const call=async(method,url,body,cookie)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>null),cookie:r.headers.get('set-cookie')};};
    const login=async(email,password)=>(await call('POST','/api/login',{email,password})).cookie?.split(';')[0];
    const owner=await login(undefined,'test-password-1234');
    for(const [email,role] of [['member@f.test','member'],['viewer@f.test','viewer']])assert.equal((await call('POST','/api/users',{email,password:'long-enough-pass',role},owner)).status,201);
    const member=await login('member@f.test','long-enough-pass'),viewer=await login('viewer@f.test','long-enough-pass');
    const g=(await call('POST','/api/groups',{name:'Flex'},member)).body;
    const b=(await call('POST',`/api/groups/${g.id}/bots`,{name:'Helper',instructions:'Help'},member)).body;
    assert.equal((await call('PATCH',`/api/groups/${g.id}`,{settings:{routing:'everyone'}},viewer)).status,403);
    const patched=await call('PATCH',`/api/groups/${g.id}`,{name:'Flexible',settings:{routing:'everyone'}},member);
    assert.equal(patched.status,200);assert.equal(patched.body.settings.routing,'everyone');
    assert.equal((await call('PATCH',`/api/groups/${g.id}`,{settings:{routing:'chaos'}},member)).status,400);
    assert.equal((await call('PATCH',`/api/groups/${g.id}/bots/${b.id}`,{settings:{enabled:false}},member)).body.settings.enabled,false);
    assert.equal((await call('POST','/api/bots/run',{botId:b.id,input:'hi'},member)).status,409);
    const scout=await call('POST','/api/bots/run',{botId:'atlas',input:'hello'},member);
    assert.equal(scout.status,422);
    assert.match(scout.body.error,/No AI provider/);
    assert.equal((await call('DELETE',`/api/groups/${g.id}/bots/${b.id}`,undefined,viewer)).status,403);
    assert.equal((await call('DELETE',`/api/groups/${g.id}/bots/${b.id}`,undefined,member)).status,200);
    assert.equal((await call('DELETE',`/api/groups/${g.id}`,undefined,member)).status,403);
    assert.equal((await call('DELETE',`/api/groups/${g.id}`,undefined,owner)).status,200);
    assert.equal((await call('GET','/api/state',undefined,owner)).body.groups.some(x=>x.id===g.id),false);
  }finally{child.kill('SIGINT');await new Promise(r=>child.once('exit',r));await fs.rm(dir,{recursive:true,force:true});}
});

test('a person cannot grow a group past the bot limit or reuse a name',()=>{
  const many=Array.from({length:500},(_,i)=>bot(`b${i}`));
  const s=wf.migrate({groups:[team('g',['a','b']),team('full',many)]});
  assert.throws(()=>wf.addBot(s,'g',{name:'A',instructions:'Do what A does, please.'}),/already in this group/);
  assert.throws(()=>wf.addBot(s,'full',{name:'One more',instructions:'Do one more thing.',}),/already has 500 bots/);
  assert.equal(s.groups[0].bots.length,2);
  const added=wf.addBot(s,'g',{name:'C',instructions:'Do c'});
  assert.equal(added.name,'C');
});

test('a count setting refuses a boolean or an array, whatever Number() makes of it', () => {
  const state = {groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'Bot', instructions: 'Act as a bot', settings: {}}]}], events: []};
  // `Number(true)` is 1 and `Number([3])` is 3, so these reached the stored
  // settings as counts: a body with `maxSteps: true` became a one-step run.
  for (const bad of [true, false, [3], []]) {
    assert.throws(() => wf.updateBot(state, 'g', 'b', {settings: {order: bad}}), error => error.status === 400 && /whole number/.test(error.message), JSON.stringify(bad));
  }
  assert.equal(wf.updateBot(state, 'g', 'b', {settings: {order: '4'}}).settings.order, 4, 'a numeric string is still a count');
});
