/** Persistent Node group orchestrator. Model workers get no publication tool.
 * A bot holding `browser.use` may only ask for a page; the request runs on the
 * user's paired local agent after approval (see src/bot-browser.js). A bot
 * holding `subagent.spawn` may hand one small job to a helper model, which has
 * no tools at all (see src/subagents.js).
 */
import {randomUUID} from 'node:crypto';
import {createRun,createEnvelope,runNote,planHandoffs,handoffTargets,instructLead,wakeBots,assessTask,summonableGuests,mayHandoff,chatKeyFor,chatIsBusy,rosterFor,previousFor,enlist,MAX_HANDOFFS,INTERRUPT_STATUSES as INTERRUPT} from '../shared/coordination.js';
import {isThread,noteMember} from '../shared/threads.js';
import {isLead,companyBots} from '../shared/company.js';
import {extendLimits} from '../shared/ask-limits.js';
import {parseOffJob,offJobMessage} from '../shared/off-job.js';
import {STOPPABLE_STATUSES} from '../shared/run-state.js';
import {botSettings,groupSettings,threadContext,MAX_STEPS_LIMIT} from '../shared/bot-settings.js';
import {addChatMessages} from '../shared/chats.js';
import {assertContractOutput} from '../shared/contracts.js';
import {recordBrowserRequests,stripBrowserBlocks,parseBrowserRequests,MAX_BROWSER_DEPTH} from '../shared/bot-browser.js';
import {MAX_SUBAGENT_DEPTH} from '../shared/subagents.js';
import {autoDispatch} from './bot-browser.js';
import {runBotTurn} from './bot-turn.js';
import {memoryFor,rememberTurn,maybeConsolidate} from './memory.js';
import {executeCustomBot} from './ai.js';
import {resolveConfig,aiAvailable} from './ai-providers.js';
import {activity} from '../shared/core.js';
import {failAgentTasks} from './agent.js';
const running=new Set();
const clean=v=>String(v??'').slice(0,4000);
const stamp=()=>new Date().toISOString();
export function coordinationState(s){s.groupMessages??={};s.groupRuns??=[];}
// The roster a run may summon is part of the shared run model; the server route
// layer picks guests with it, so keep one import for it rather than two paths.
export {summonableGuests};
/** Put a line into the run's conversation. The server writes these itself, so a
 * run still shows up in the chat when the tab that started it was closed. A
 * conversation that no longer exists is skipped: the run log keeps the record. */
function say(s,run,entry){
  if(!entry)return;
  try{addChatMessages(s,run.chatKey||`team-${run.groupId}`,[entry],{trusted:true});}catch{/* Conversation removed mid-run. */}
}
/** End a run here. One place writes what every finished run carries — the
 * status, when it ended, and no checkpoint left behind (a checkpoint on a
 * finished run would offer Continue for something already over) — so
 * `completed`, `failed`, `cancelled` and `interrupted` cannot disagree about the
 * shape of a finished run. The caller still owns the reason, the thread note and
 * the activity line, because those differ per ending. */
function endRun(run,status,{error=null}={}){
  run.status=status;
  run.completedAt=stamp();
  run.checkpoint=null;
  if(error!==null)run.error=error;
  return run;
}
/** Deny the pages a run still has open and return the device tasks those pages
 * had already been sent as. A run that stops, or that a restart cuts, must not
 * leave the paired browser holding work for a run nobody is waiting on. The
 * request row and its device task are two records that have to move together,
 * which is why this is one function and not two loops that can drift. */
function denyRunPages(state,runId,reason=''){
  const ids=[];
  for(const request of state.browserRequests||[]){
    if(request.runId!==runId||!['pending','dispatched'].includes(request.status))continue;
    if(request.status==='dispatched')for(const id of request.agentTaskIds||[])ids.push(id);
    request.status='denied';request.updatedAt=stamp();
    if(reason)request.error=reason;
  }
  return ids;
}
export async function markInterrupted(store){
  const taskIds = new Set();
  await store.update(s=>{
    coordinationState(s);
    for(const r of s.groupRuns){
      if(!INTERRUPT.includes(r.status))continue;
      const page=r.status==='awaiting_browser';
      const reason=page?'Server restarted while waiting for a page. Ask again.':'Server restarted before the run completed. Retry explicitly to avoid duplicate model calls.';
      endRun(r,'interrupted',{error:reason});
      if(page)for(const id of denyRunPages(s,r.id))taskIds.add(id);
      say(s,r,runNote(r));
    }
  });
  // Cleanup is best effort: the run flips above are already committed, and a
  // rejected device-task write must not reject `markInterrupted` - the caller only
  // logs that, and the workspace would then start with no scheduler, no queue and
  // no retention until the next restart.
  try{await failAgentTasks(store, [...taskIds], 'The server restarted before this group run completed.');}
  catch(error){console.error('Agent task cleanup after a restart:', error.message);}
}
export async function queueGroupRun(store,{groupId,message,directBotId=null,checkpoints=false,chatKey=null,browserDepth=0,confirmPlan,taskId=null,anyway=false}={}){
  // Validate the request against the store first so a missing group reports 404
  // and a busy group reports 409, instead of the AI-key check shadowing them
  // with a misleading 422 on an instance that simply has no key yet.
  const snapshot=store.read();
  const probe=snapshot.groups.find(g=>g.id===groupId);
  if(!probe)throw Object.assign(new Error('Group not found'),{status:404});
  // One task, one run. A crash between the run's first write and the task's own
  // completion re-arms the task, and the retry used to queue the same message a
  // second time - a duplicate line in the chat and a second paid run.
  if(taskId){const prior=snapshot.groupRuns?.find(r=>r.taskId===taskId);if(prior)return {runId:prior.id,status:prior.status,deduped:true};}
  if(chatIsBusy(snapshot.groupRuns,probe,chatKeyFor(probe,{chatKey,directBotId})))throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  try{planHandoffs(probe,clean(message),{directBotId,guests:summonableGuests(snapshot.groups,groupId,{includeOff:true})});}catch(e){if(e.status)throw e;}
  if(!aiAvailable(store))throw Object.assign(new Error('No AI provider is configured. Add one under You → AI and models, or set AI_API_KEY on the server. GitHub Pages runs a labeled simulation.'),{status:422});
  const id=await store.update(s=>{
    coordinationState(s);
    const group=s.groups.find(g=>g.id===groupId);
    if(!group)throw Object.assign(new Error('Group not found'),{status:404});
    if(taskId){const prior=s.groupRuns.find(r=>r.taskId===taskId);if(prior)return prior.id;}
    if(chatIsBusy(s.groupRuns,group,chatKeyFor(group,{chatKey,directBotId})))throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
    const messageText=clean(message);
    const guests=summonableGuests(s.groups,groupId,{includeOff:true});
    const instructed=instructLead(group,messageText,directBotId,guests);
    if(instructed.empty)throw Object.assign(new Error('No other bot can take that.'),{status:409,permanent:true});
    // A caller can force the plan gate off. A scheduled task does that: the
    // timer was already the approval, so it must not sit on Start.
    const confirm=confirmPlan===undefined?groupSettings(group).confirmPlan:Boolean(confirmPlan);
    const task=instructed.task?{...instructed.task,confirm}:null;
    const run=createRun({group,message:messageText,directBotId:instructed.directBotId,makeId:randomUUID,checkpoints:Boolean(checkpoints),chatKey,guests,task,anyway:anyway===true});
    if(taskId)run.taskId=taskId;
    if(run.status!=='awaiting_plan')wakeBots(group,run.task?.woke);
    if(run.task)say(s,run,{id:randomUUID(),role:'system',text:`${run.task.summary} ${run.task.doneWhen}${run.status==='awaiting_plan'?' Start it when you are ready.':''}`,runId:run.id,at:stamp()});
    if(run.recipients.length>Math.min(run.maxSteps??MAX_HANDOFFS,MAX_STEPS_LIMIT))throw Object.assign(new Error('Run too long.'),{status:400});
    run.browserDepth=Math.max(0,Math.min(MAX_BROWSER_DEPTH,Number(browserDepth)||0));
    s.groupRuns.unshift(run);s.groupRuns=s.groupRuns.slice(0,100);
    s.groupMessages[groupId]??=[];
    s.groupMessages[groupId].push({id:randomUUID(),runId:run.id,role:'user',text:run.input,at:stamp()});
    // The run log belongs to the group and every message adds one line to it.
    // Cap it here as well as at the step write, or the queue is the one path
    // that can grow it without a limit.
    s.groupMessages[groupId]=s.groupMessages[groupId].slice(-300);
    activity(s,'group-run',`Queued ${group.name} coordination run`,{runId:run.id});return run.id;
  });
  let status=store.read().groupRuns.find(r=>r.id===id)?.status||'queued';
  // A plan the user asked to see first waits. Everything else starts now.
  if(status==='queued'){
    startRun(store,id);
    status=store.read().groupRuns.find(r=>r.id===id)?.status||status;
  }
  return {runId:id,status};
}
/** A recipient from the host group, or a guest summoned from another group that
 * is still switched on and summonable. */
function resolveBot(state,group,run,botId){
  const own=group.bots.find(x=>x.id===botId);
  if(own)return own;
  if(!(run.guestIds||[]).includes(botId))throw new Error('Bot or group was removed during execution.');
  const guest=summonableGuests(state.groups,group.id).find(x=>x.id===botId);
  if(guest)return guest;
  const name=state.groups.flatMap(g=>g.bots||[]).find(x=>x.id===botId)?.name||'A summoned bot';
  throw new Error(`${name} can no longer be summoned. It was switched off, made private or removed.`);
}
/** One due 'bot-task': post the scheduled message into its conversation and
 * queue a run, or record in that conversation why it was skipped. A busy group
 * throws 409 so the queue retries with backoff. */
export async function runBotTask(store,task,{queue=queueGroupRun,available=aiAvailable}={}){
  const {groupId,botId=null,message,label}=task.payload||{};
  const s=store.read();const group=s.groups.find(g=>g.id===groupId);const bot=botId?group?.bots.find(b=>b.id===botId):null;
  // Gone for good. A normal return would complete the task and re-arm an interval
  // against a target that will never exist. The queue fails this immediately.
  if(!group||(botId&&!bot))throw Object.assign(new Error('That bot or group no longer exists.'),{status:404,permanent:true});
  const chatKey=botId||`team-${groupId}`;
  const note=text=>store.update(st=>{addChatMessages(st,chatKey,[{role:'system',text}],{trusted:true});});
  if(bot&&!botSettings(bot).enabled){await note(`Scheduled task "${label}" skipped: ${bot.name} is switched off.`);return {skipped:'disabled'};}
  if(!available(store)){await note(`Scheduled task "${label}" skipped: no AI provider is configured.`);return {skipped:'no-ai'};}
  if(chatIsBusy(s.groupRuns,group,chatKey))throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  // Queue first. A 409 or a validation error must not leave a "Scheduled task"
  // line for a run that never started; the queue retries those.
  const result=await queue(store,{groupId,message,directBotId:botId,chatKey,confirmPlan:false});
  // The run is queued and durable; the line in the conversation is not. A failed
  // note used to reject the handler, which the queue retried - and the retry
  // queued the same message again, so one reminder cost two model runs. Only a
  // refused queue may fail the task.
  // A deduplicated retry already announced the run; announcing it again is the
  // duplicate this whole path exists to prevent.
  if(result?.deduped)return result;
  try{await note(`Scheduled task: ${message}`);}
  catch(error){console.error('Scheduled task note:', error.message);}
  return result;
}
export function runGroup(store,id,executor=executeCustomBot){
  const run = () => runGroupInner(store,id,executor);
  return typeof store.trackWork === 'function' ? store.trackWork(run) : run();
}
/** Start a run in the background, and make sure a start that never happened does
 * not stay `queued`. `store.trackWork` refuses while its workspace is paused for
 * a restore, and `queued` is a busy status: the group would answer 409 to every
 * later message with no Start button to press and no way out until a restart. */
function startRun(store,id,executor){
  void runGroup(store,id,executor).catch(error=>{
    console.error('Group execution:',error.message);
    return failRunStart(store,id,error);
  });
}
/** Record on the run that it never began. Only a run that was about to start
 * moves: a run paused at a plan or a checkpoint has its own way forward, and a
 * finished one keeps the outcome it already reported. */
function failRunStart(store,id,error){
  const message=clean(error?.message)||'The run could not start.';
  return Promise.resolve(store.update(s=>{
    const r=s.groupRuns?.find(x=>x.id===id);
    if(!r||r.status!=='queued')return;
    endRun(r,'failed',{error:message});
    say(s,r,runNote(r));
  })).catch(updateError=>console.error('A run that could not start was not marked failed:',updateError.message));
}
async function runGroupInner(store,id,executor){
  if(running.has(id))return;running.add(id);
  try{
    // Resume support: a run paused at a checkpoint restarts from where it
    // stopped, carrying the previous bot's output into the next envelope.
    const before=store.read().groupRuns.find(x=>x.id===id);
    const start=before?.checkpoint?.nextStep||0;
    let previous=before?.checkpoint?.previous||null;
    // A run that stopped at an ask limit carries the bots still waiting on an
    // answer; the first step picks the conversation up from there.
    const resume=before?.checkpoint?.resume||null;
    const stopNow=Boolean(before?.checkpoint?.stop);
    await store.update(s=>{coordinationState(s);const r=s.groupRuns.find(x=>x.id===id);if(!r||!['queued','running','awaiting_checkpoint','awaiting_limit'].includes(r.status))throw new Error('Run is not runnable');r.status='running';r.startedAt=r.startedAt||stamp();r.checkpoint=null;delete r.limit;});
    // The recipient list is read live each step: a bot's reply may append to it.
    // A bot created during this run is not a recipient of it: it has no settings
    // a person has checked yet, and handing it work the same minute it exists is
    // how a loop of fresh bots starts. It becomes available from the next run.
    const fledglings=new Set();
    let i=start;
    while(true){
      const current=store.read();const r=current.groupRuns.find(x=>x.id===id);
      if(!r||r.status!=='running')throw new Error('Run no longer active');
      if(i>=r.recipients.length){
        const gap=assessTask(r);
        if(gap.retryBotId){
          await store.update(s=>{const live=s.groupRuns.find(x=>x.id===id);if(!live)return;live.task={...live.task,retried:true};live.recipients.push(gap.retryBotId);
            const name=s.groups.find(g=>g.id===live.groupId)?.bots.find(b=>b.id===gap.retryBotId)?.name||'That bot';
            say(s,live,{id:randomUUID(),role:'system',text:`${name} has not finished its part. Asking once more.`,runId:id,at:stamp()});});
          continue;
        }
        break;
      }
      const g=current.groups.find(x=>x.id===r.groupId);
      if(!g)throw new Error('Bot or group was removed during execution.');
      const bot=resolveBot(current,g,r,r.recipients[i]);
      r.currentStep=i;
      const roster=[...g.bots,...summonableGuests(current.groups,g.id)];
      // Any bot may ask any bot, so asking reaches the whole company, not the roster.
      const everyone=companyBots(current);
      const resumed=i===start?resume:null;
      const stopped=stopNow&&Boolean(resumed);
      // A lead is told about its team and a plain bot about the group. A lead's
      // closing step reports what the team said and hands nothing out.
      const lead=isLead(current,bot.id);
      const closing=r.closeAt===i;
      const handed=previousFor(r,i,current.groups.flatMap(x=>x.bots||[]));
      if(handed)previous=handed;
      const thread=threadContext(current.chats?.[r.chatKey],botSettings(bot).contextMessages);
      // This bot's own model, so its rulebook and the chat recap are the right ones.
      const config=resolveConfig(store,bot.id);
      const memory=memoryFor(store,{bot,config,chatKey:r.chatKey});
      const envelope=createEnvelope({run:r,bot,previous,thread,team:closing?[]:rosterFor(current,bot,roster,{thread:isThread(g)}),company:everyone,memory,lead,closing});
      // Each bot runs on its own chosen model/provider, else the workspace
      // default. The turn itself is the one sequence every caller runs: a
      // sub-agent round, then a peer ask, then a new-bot block. A bot that
      // already spawned a helper in this run gets one more turn; that second
      // reply is its output. `runBotTurn` owns the order (see src/bot-turn.js).
      const home=current.groups.find(x=>(x.bots||[]).some(b=>b.id===bot.id));
      // The run's ask tally: each ask is written to the run as it happens, so the
      // thread shows it in flight, and a checkpoint can stop the step and keep it.
      const budget={asks:r.asks?structuredClone(r.asks):undefined,limitBase:r.limitBase,unlimitedAsks:r.unlimitedAsks};
      const onEvent=event=>store.update(s=>{
        const live=s.groupRuns.find(x=>x.id===id);
        if(!live||live.status!=='running')throw new Error('Run no longer active');
        live.asks=structuredClone(budget.asks);
        live.trace.push(event.type==='ask'
          ?{botId:event.from,kind:'ask',to:event.to,task:event.task,at:stamp()}
          :{botId:event.from,kind:'peer',to:event.to,output:event.output||'',...(event.error?{error:event.error}:{}),at:stamp()});
        if(live.trace.length>400)live.trace=live.trace.slice(-400);
      });
      const reply=await runBotTurn(store,{bot,envelope,executor,config,peers:everyone,configFor:peerId=>resolveConfig(store,peerId),memoryForPeer:(mate,mateConfig)=>memoryFor(store,{bot:mate,config:mateConfig,chatKey:r.chatKey}),handoffAllowed:mayHandoff(r,bot)&&!closing,spawnRounds:(r.subagents||[]).some(spawn=>spawn.botId===bot.id)?MAX_SUBAGENT_DEPTH:0,budget,onEvent,resume:resumed,stop:stopped,groupId:home?.id??null,runId:id,makeId:randomUUID,now:stamp});
      if(reply.limit){
        // A checkpoint, not a failure: what was said stays said, the bots still
        // waiting on an answer are kept, and the owner picks what happens next.
        await store.update(s=>{coordinationState(s);const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='running')throw new Error('Run no longer active');
          for(const line of reply.lines)say(s,live,{...line,runId:id});
          live.asks=structuredClone(budget.asks);
          live.status='awaiting_limit';
          live.limit={kind:reply.limit.kind,at:stamp()};
          live.checkpoint={nextStep:i,previous,resume:{frames:reply.frames,spawns:reply.spawns},at:stamp()};
          say(s,live,runNote(live));
          activity(s,'group-run',`Paused at a bot-to-bot limit (${reply.limit.kind})`,{runId:id});});
        return;
      }
      for(const record of reply.created||[])fledglings.add(record.id);
      const output=reply.output;
      if(typeof output!=='string'||!output.trim())throw new Error('Bot returned empty output.');
      // A plain bot in its own chat may answer that the request is not its job.
      // That reply is not gated by its contract (a structured bot could not say
      // it), files no page and hands nothing on; the chat shows it with its choices.
      const off=!lead&&r.chatKey===bot.id&&!r.anyway?parseOffJob(output):null;
      const offMsg=off?offJobMessage({bot,reason:off.reason,request:r.input,id:randomUUID(),runId:id,at:stamp()}):null;
      const body=offMsg?offMsg.text:output;
      // Strip browser fences before the contract gate: a structured bot may
      // still ask for a page, and the next bot must not see the fences.
      const asked=off?[]:parseBrowserRequests(body);
      const stripped=off?body:stripBrowserBlocks(body);
      if(!stripped.trim()&&!asked.length)throw new Error('Bot returned empty output.');
      // The gate returns the value it validated. Passing the raw text on left a
      // structured result as its fenced JSON, while the object the contract
      // approved is what every downstream reader (sources, trace, the next
      // envelope) should see. A text contract returns the same string.
      const validated=off?stripped:stripped.trim()?assertContractOutput(bot,stripped):stripped;
      // What the contract approved, as text: the string for a text contract, the
      // object as JSON for a structured one. Both of these feed the next bot, so
      // neither keeps the fences the model happened to wrap around them.
      const gated=typeof validated==='string'?validated:JSON.stringify(validated);
      previous={botId:bot.id,output:gated.slice(0,3600)};
      let toBotId=null,auto=[],holdBrowser=false;
      await store.update(s=>{coordinationState(s);const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='running')throw new Error('Run no longer active');
        const host=s.groups.find(x=>x.id===live.groupId);
        // File fences from the full reply, then hand the next bot the text around them.
        const priorUrls=Array.isArray(live.browserUrls)?live.browserUrls:String(live.browserUrl||'').split(' | ').filter(Boolean);
        const skip=priorUrls;
        const browsed=recordBrowserRequests(s,{bot,groupId:live.groupId,chatKey:live.chatKey||`team-${live.groupId}`,output:body,depth:live.browserDepth||0,makeId:randomUUID,skipUrls:skip,runId:id});
        // Text around the browser fences is the browser helper's view of the
        // reply; with nothing to browse, the approved value is the output.
        previous.output=(browsed.records.length?browsed.text:gated).slice(0,3600);
        if(botSettings(bot).browserApproval==='auto')auto=browsed.records;
        // A lead hands work to its team only and keeps a step back for its closing
        // reply; a plain bot hands to the group (in a thread, to no one). A closing
        // reply and an out-of-job reply hand nothing out.
        const reach=host?[...host.bots.filter(b=>!fledglings.has(b.id)),...summonableGuests(s.groups,host.id)]:[];
        const leads=isLead(s,bot.id);
        const added=host&&!closing&&!stopped&&!off?handoffTargets({run:live,roster:rosterFor(s,bot,reach,{thread:isThread(host)}),fromBot:bot,output:previous.output,home:leads||isThread(host)?null:host.bots,reserve:leads&&live.closeAt==null?1:0}):[];
        enlist(live,{fromId:bot.id,added,output:previous.output,lead:leads});
        if(isThread(host))for(const id of added)noteMember(host,id);
        const guests=added.filter(x=>!host.bots.some(b=>b.id===x));
        if(guests.length)live.guestIds=[...(live.guestIds||[]),...guests];
        toBotId=live.recipients[i+1]??null;
        live.currentStep=i+1;live.trace.push({botId:bot.id,output:previous.output,toBotId,at:stamp()});
        const chat=s.groupMessages[live.groupId]??=[];
        const said=offMsg?{...offMsg,toBotId}:{id:randomUUID(),runId:id,role:'bot',senderId:bot.id,senderName:bot.name,toBotId,text:previous.output,at:stamp()};
        chat.push(said);
        s.groupMessages[live.groupId]=chat.slice(-300);
        // What the helper did runs before the reply that used it, so the thread
        // reads in the order the work happened.
        for(const line of reply.lines)say(s,live,{...line,runId:id});
        say(s,live,{...said,mode:'ai'});
        for(const line of browsed.lines)say(s,live,line);
        if(reply.spawns.length)live.subagents=[...(live.subagents||[]),...reply.spawns.map(spawn=>({...spawn,botId:bot.id,at:stamp()}))].slice(-6);
        if(reply.asks.length)live.peerAsks=[...(live.peerAsks||[]),...reply.asks.map(ask=>({botId:bot.id,...ask,at:stamp()}))].slice(-6);
        if(browsed.records.length){
          live.status='awaiting_browser';
          live.browserPage=null;
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          holdBrowser=true;
        } else {
          // Extra turn consumed the page; later bots do not see it as `page`.
          live.browserPage=null;
        }
      });
      if(auto.length)await autoDispatch(store,auto);
      // Keep what this model learned. The reply is already stored, so a memory
      // failure is logged and never turns a finished step into a failed run.
      if(memory)try{
        await rememberTurn(store,{bot,config,chatKey:r.chatKey,userText:r.input,botText:previous.output});
        void maybeConsolidate(store,{key:memory.key,config,chatKey:r.chatKey,label:memory.label});
      }catch(error){console.error('Memory update:',error.message);}
      if(holdBrowser)return;
      // Human checkpoint: pause before the next handoff until a person approves,
      // so a multi-step run never advances unattended when enabled.
      // Stop ends the task: the asking bot has reported, so nothing else is woken.
      if(stopped)break;
      if(r.checkpointsEnabled&&toBotId){
        await store.update(s=>{const live=s.groupRuns.find(x=>x.id===id);live.status='awaiting_checkpoint';live.checkpoint={nextStep:i+1,previous,at:stamp()};say(s,live,runNote(live));activity(s,'group-run',`Paused for a checkpoint after step ${i+1}`,{runId:id});});
        return;
      }
      i++;
    }
    await store.update(s=>{const r=s.groupRuns.find(x=>x.id===id);if(r.task)r.task.closing=assessTask(r).note;endRun(r,'completed');r.lastOutput=previous?.output??null;say(s,r,runNote(r));activity(s,'group-run','Completed bot coordination run',{runId:id});});
  // Only a run that was actually executing may be marked failed. A restart marks
  // live runs `interrupted`; overwriting that with `failed` would report a crash
  // the operator never saw as a model error and hide the explicit retry advice.
  }catch(e){await store.update(s=>{const r=s.groupRuns?.find(x=>x.id===id);if(r&&r.status==='running'){endRun(r,'failed',{error:clean(e.message)});say(s,r,runNote(r));activity(s,'group-error',`Coordination failed: ${clean(e.message)}`,{runId:id});}});}
  finally{
    running.delete(id);
    // A fast local agent can return while autoDispatch is still awaited above.
    // Its resume changes the run to queued, but runGroup's in-process lock
    // rejects that early restart. Pick it up once this invocation releases it.
    if(store.read().groupRuns?.some(r=>r.id===id&&r.status==='queued'))queueMicrotask(()=>startRun(store,id,executor));
  }
}
/** A page the run asked for mid-step. Success gives that same bot another
 * turn with the page. Failure or a denial skips that extra turn and continues. */
export async function resumeBrowserRun(store,request,{ok,text='',executor}={}){
  const id=request?.runId;
  if(!id)return false;
  const cur=store.read().groupRuns?.find(r=>r.id===id);
  if(!cur||cur.status!=='awaiting_browser')return false;
  const page=clean(text).trim();
  const start=await store.update(s=>{
    const live=s.groupRuns.find(r=>r.id===id);
    if(!live)return false;
    // Consume the page inside this update, so the append and the wait-decision
    // land atomically. A mark-done that commits before its append ("left"
    // check by status) would resume the run too early and drop this page.
    const consumed=new Set(Array.isArray(live.browserConsumed)?live.browserConsumed:[]);
    if(!consumed.has(request.id)){
      if(ok&&page){
        live.browserPage=live.browserPage?`${live.browserPage}\n\n---\n\n${page}`:page;
        const priorUrls=Array.isArray(live.browserUrls)?live.browserUrls:String(live.browserUrl||'').split(' | ').filter(Boolean);
        live.browserUrls=[...new Set([...priorUrls,request.url,request.result?.finalUrl].filter(Boolean))];
        delete live.browserUrl;
      }
      consumed.add(request.id);
      live.browserConsumed=[...consumed];
    }
    // Two fences in one reply are two requests. Stay paused until the last
    // one comes back, so the second page is not dropped on the floor.
    // A request not consumed into this run yet is still outstanding, even if
    // its status flip already committed.
    const left=(s.browserRequests||[]).some(r=>r.runId===id&&!consumed.has(r.id));
    if(left)return false;
    // A duplicate delivery after the first one already resumed has nothing to do.
    if(live.status!=='awaiting_browser')return false;
    // A reply may ask for more than one page. Count the round if any request
    // succeeded, even when the final request in the batch was denied or failed.
    if(live.browserPage)live.browserDepth=Math.min(MAX_BROWSER_DEPTH,(Number(live.browserDepth)||0)+1);
    if(!live.browserPage){
      const after=live.checkpoint?.afterStep;
      const next=Number.isInteger(after)?after:(live.checkpoint?.nextStep||0)+1;
      live.checkpoint={...live.checkpoint,nextStep:next};
      if(live.checkpointsEnabled&&live.recipients[next]){
        live.status='awaiting_checkpoint';
        live.checkpoint={nextStep:next,previous:live.checkpoint?.previous,at:stamp()};
        say(s,live,runNote(live));
        return false;
      }
    }
    live.status='queued';
    return true;
  });
  if(start)startRun(store,id,executor);
  return true;
}
/** A run a person can stop: it is queued or working, or it is waiting on a
 * person. The set is declared with the other run-status categories in
 * `shared/run-state.js`. */

/** Stop a run.
 *
 * The loop reads the run's status between steps and refuses to write a step of a
 * run that is no longer `running`, so the flip takes effect at the next boundary:
 * a model call already in flight is not aborted (the HTTP client owns it) and its
 * reply is discarded rather than appended to a run somebody stopped. Nothing
 * already said is removed - the thread would lose the reasoning that led here -
 * and the note says what happened so the thread does not just go quiet.
 */
export async function cancelRun(store,id,{actor=null}={}){
  const result=await store.update(s=>{
    const r=s.groupRuns?.find(x=>x.id===id);
    if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
    if(!STOPPABLE_STATUSES.includes(r.status))throw Object.assign(new Error(`A ${r.status} run cannot be stopped.`),{status:409});
    const midStep=r.status==='running';
    endRun(r,'cancelled');
    // A run stopped while a page was out still had that page in flight: the local
    // device would open it after the person pressed Stop, and the approval card
    // would enqueue work for a run that no longer exists.
    const taskIds=denyRunPages(s,id,'The run was stopped before this page was opened.');
    say(s,r,{id:randomUUID(),role:'system',text:midStep?'Stopped. The reply being written when you stopped it was discarded; nothing after it runs.':'Stopped before it started. Nothing ran.',runId:id,at:stamp()});
    activity(s,'group-run','Stopped a bot coordination run',{runId:id,by:actor});
    return {runId:id,status:'cancelled',taskIds};
  });
  if(result.taskIds.length)try{failAgentTasks(store, result.taskIds, 'The run was stopped before this page was opened.');}
  catch(error){console.error('Agent task cleanup after a stop:', error.message);}
  return {runId:result.runId,status:result.status};
}

/** Start or drop a tracked plan that was shown before any bot ran. */
export async function decidePlan(store,id,{approve}){
  const result=await store.update(s=>{
    const r=s.groupRuns.find(x=>x.id===id);
    if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
    if(r.status!=='awaiting_plan')throw Object.assign(new Error('This run is not waiting on a plan.'),{status:409});
    if(!approve){endRun(r,'cancelled');say(s,r,{id:randomUUID(),role:'system',text:'Plan cancelled. Nothing ran.',runId:id,at:stamp()});return {runId:id,status:'cancelled'};}
    const group=s.groups.find(g=>g.id===r.groupId);
    if(group)wakeBots(group,r.task?.woke);
    r.status='queued';say(s,r,{id:randomUUID(),role:'system',text:'Starting.',runId:id,at:stamp()});
    return {runId:id,status:'queued',start:true};
  });
  if(result.start)startRun(store,id);
  return {runId:result.runId,status:store.read().groupRuns.find(r=>r.id===id)?.status||result.status};
}
export async function resumeGroupRun(store,id,executor=executeCustomBot,{choice}={}){
  const r=store.read().groupRuns.find(x=>x.id===id);
  if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
  if(r.status==='awaiting_limit'){
    // Keep going (another round of the same size), Keep going without more
    // checkpoints for this task, or Stop: the asking bot reports what it has.
    if(!['more','unlimited','stop'].includes(choice))throw Object.assign(new Error('Choose more, unlimited or stop.'),{status:400});
    await store.update(s=>{const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='awaiting_limit')throw Object.assign(new Error('This run is not waiting at a limit.'),{status:409});
      if(choice==='more')extendLimits(live,live.limit?.kind);
      else if(choice==='unlimited')live.unlimitedAsks=true;
      else live.checkpoint={...live.checkpoint,stop:true};
      activity(s,'group-run',`Bot-to-bot limit answered: ${choice}`,{runId:id});});
  }else if(r.status!=='awaiting_checkpoint')throw Object.assign(new Error('This run is not waiting for a checkpoint.'),{status:409});
  await runGroup(store,id,executor);
  return {runId:id,status:store.read().groupRuns.find(x=>x.id===id)?.status||'running'};
}
