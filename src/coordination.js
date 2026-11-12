/** Persistent Node group orchestrator. Model workers get no publication tool.
 * A bot holding `browser.use` may only ask for a page; the request runs on the
 * user's paired local agent after approval (see src/bot-browser.js). A bot
 * holding `subagent.spawn` may hand one small job to a helper model, which has
 * no tools at all (see src/subagents.js).
 */
import {scheduleRunEnded} from '../shared/schedules.js';
import {randomUUID} from 'node:crypto';
import {createRun,createEnvelope,declinedOf,runNote,planHandoffs,handoffTargets,instructLead,wakeBots,assessTask,summonableGuests,mayHandoff,chatKeyFor,chatIsBusy,rosterFor,previousFor,enlist,promisesAction,PROMISE_NOTE,MAX_HANDOFFS,INTERRUPT_STATUSES as INTERRUPT} from '../shared/coordination.js';
import {isThread,noteMember} from '../shared/threads.js';
import {isLead,companyBots} from '../shared/company.js';
import {extendLimits, ASK_CEILING} from '../shared/ask-limits.js';
import {noteBotWork,paused as botsPaused,resumeGuard} from '../shared/runaway.js';
import {parseOffJob,offJobMessage} from '../shared/off-job.js';
import {STOPPABLE_STATUSES} from '../shared/run-state.js';
import {botSettings,groupSettings,threadContext,MAX_STEPS_LIMIT} from '../shared/bot-settings.js';
import {stepsCap,limitsOf,FAIL_STREAK,runBudget} from '../shared/limits.js';
import {addChatMessages} from '../shared/chats.js';
import {assertContractOutput} from '../shared/contracts.js';
import {recordBrowserRequests,stripBrowserBlocks,isSearchPage,parseBrowserRequests,MAX_BROWSER_DEPTH} from '../shared/bot-browser.js';
import {orphanAsks} from '../shared/asks.js';
import {addAskCards,notifyAsks} from './ask-cards.js';
import {MAX_SUBAGENT_DEPTH} from '../shared/subagents.js';
import {autoDispatch,dispatchBrowserRequest,finishBrowserRequest} from './bot-browser.js';
import {recordConnectorCalls,parseConnectorCalls,stripConnectorBlocks,envelopeConnectors} from '../shared/connectors.js';
import {runConnectorCalls} from './connector-runs.js';
import {runBotTurn} from './bot-turn.js';
import {peek} from './sqlite-store.js';
import {memoryFor,rememberTurn,maybeConsolidate} from './memory.js';
import {rememberFromOwner} from '../shared/memory.js';
import {executeCustomBot} from './ai.js';
import {holdFollowUp} from './follow-ups.js';
import {resolveConfig,aiAvailable} from './ai-providers.js';
import {modelLimitLine} from './cli-model.js';
import {activity} from '../shared/core.js';
import {failAgentTasks,agentsBrief} from './agent.js';
import {workspaceBrief} from '../shared/setup.js';
const running=new Set();
const FAIL_WRITE_RETRY_MS=250;
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
/** Park a run at a step boundary because bots are paused. The run keeps its place:
 * Keep going starts it again at `nextStep`; Stop cancels it. */
function parkForGuard(s,live,{nextStep,previous}){
  live.status='awaiting_limit';
  live.limit={kind:'guard',at:stamp()};
  live.checkpoint={nextStep,previous,at:stamp()};
  say(s,live,runNote(live));
  activity(s,'group-run','Waiting: bots are paused',{runId:live.id});
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
export const SERVER_PAGE_RESTARTED='The server restarted while opening the page. Ask again.';
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
    // A page this server was opening itself has no device task and no deadline: the process that would have
    // finished it is gone, so it would read "dispatched" forever and hold the chat. Fail it and say so there.
    for(const request of s.browserRequests||[]){
      if(request.status!=='dispatched'||request.via!=='server')continue;
      request.status='failed';request.error=SERVER_PAGE_RESTARTED;request.updatedAt=stamp();
      say(s,{chatKey:request.chatKey,groupId:request.groupId},{id:randomUUID(),role:'system',kind:'browser-result',text:SERVER_PAGE_RESTARTED,at:stamp()});
    }
  });
  // Cleanup is best effort: the run flips above are already committed, and a
  // rejected device-task write must not reject `markInterrupted` - the caller only
  // logs that, and the workspace would then start with no scheduler, no queue and
  // no retention until the next restart.
  try{await failAgentTasks(store, [...taskIds], 'The server restarted before this group run completed.');}
  catch(error){console.error('Agent task cleanup after a restart:', error.message);}
}
/** Rounds with nothing new (FAIL_STREAK in a row) first earn the bot one last turn with browsing closed: it
 * answers the owner from what the run read. True when that last turn was already given, so the run stops. */
const LAST_CALL='Stop opening pages: do not ask for any page. The pages this run read are in this message. Answer the owner now with what they say, and say in one line what is still missing.';
function lastCallOrStop(live,state){
  if(live.failStreak<FAIL_STREAK)return false;
  if(live.lastCall)return true;
  // The pages this run read, newest last: the bot answers from them, so they ride along (the input bound cuts them to fit).
  const read=(state?.browserRequests||[]).filter(r=>r.runId===live.id&&r.status==='done'&&r.result?.page).slice(-6).map(r=>r.result.page);
  live.lastCall=true;live.browserDepth=1e6;live.browserPage=read.length?read.join('\n\n---\n\n'):null;live.connectorPage=null;live.browserNote=LAST_CALL;
  return false;
}
/** Pages one message may open before the bot is told to answer with what it has. */
export const PAGE_NUDGE=15;
export async function queueGroupRun(store,{groupId,message,directBotId=null,checkpoints=false,chatKey=null,browserDepth=0,confirmPlan,taskId=null,anyway=false,unattended=false,scheduleId=null,wait=false}={}){
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
  if(chatIsBusy(snapshot.groupRuns,probe,chatKeyFor(probe,{chatKey,directBotId}))){
    // A person's message waits for the bot to be free and then runs (src/follow-ups.js); a timer retries on its own.
    if(wait){let held=null;await store.update(s=>{held=holdFollowUp(s,{groupId,chatKey,directBotId,message:clean(message),checkpoints});});if(held)return {runId:held.runId,status:'waiting'};}
    else throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  }
  try{planHandoffs(probe,clean(message),{directBotId,guests:summonableGuests(snapshot.groups,groupId,{includeOff:true})});}catch(e){if(e.status)throw e;}
  if(!aiAvailable(store))throw Object.assign(new Error('No AI provider is configured. Connect one in Settings → Models and keys.'),{status:422});
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
    // What the owner typed and asked every bot to remember goes to the company notes before the run reads them.
    if(!taskId&&!scheduleId&&!unattended){const saved=rememberFromOwner(s,messageText);if(saved?.length)run.remembered=saved.map(r=>String(r?.text??r).slice(0,200));}
    if(taskId)run.taskId=taskId;
    // The schedule a timer run came from, so its end can count toward stopping a schedule that keeps failing.
    if(scheduleId)run.scheduleId=scheduleId;
    // Nobody typed in this run (a timer started it): an ask it makes lapses after 24 hours.
    if(unattended)run.unattended=true;
    if(run.status!=='awaiting_plan')wakeBots(group,run.task?.woke);
    if(run.task)say(s,run,{id:randomUUID(),role:'system',text:`${run.task.summary} ${run.task.doneWhen}${run.status==='awaiting_plan'?' Start it when you are ready.':''}`,runId:run.id,at:stamp()});
    // The owner's workspace limit on steps (Settings → Limits), when there is one, bounds every team.
    run.maxSteps=Math.min(run.maxSteps??MAX_HANDOFFS,stepsCap(s));
    if(run.recipients.length>run.maxSteps)run.recipients=run.recipients.slice(0,run.maxSteps);
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
  let status=peek(store).groupRuns.find(r=>r.id===id)?.status||'queued';
  // A plan the user asked to see first waits. Everything else starts now.
  if(status==='queued'){
    startRun(store,id);
    status=peek(store).groupRuns.find(r=>r.id===id)?.status||status;
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
  // A timer is bot-initiated work: it counts against the runaway guard and is
  // skipped, with a line in its chat, while bots are paused.
  if(await store.update(st=>noteBotWork(st,'run').paused)){await note(`Scheduled task "${label}" skipped: bots are paused.`);return {skipped:'paused'};}
  // Queue first. A 409 or a validation error must not leave a "Scheduled task"
  // line for a run that never started; the queue retries those.
  const result=await queue(store,{groupId,message,directBotId:botId,chatKey,confirmPlan:false,unattended:true,scheduleId:task.id});
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
  return runGroup(store,id,executor).catch(error=>{
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
    // A bot created during this run may take the work it was made for in this run, and may make bots of its own:
    // the step cap bounds how many turns that is, and MAX_BOTS_PER_GROUP how many bots.
    let i=start;
    while(true){
      // Calls a bot asked for that are cleared (an answer, or nothing to ask) are made now, before this step's turn,
      // so the same bot gets what came back. A run stopped meanwhile drops them.
      if(!await runConnectorCalls(store,id,{say}))return;
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
      // The runaway guard. The first step is the owner's own message; every step
      // after it is a bot handing work to a bot, and waits while bots are paused.
      if(i>0&&await store.update(s=>{
        const live=s.groupRuns.find(x=>x.id===id);
        if(!live||live.status!=='running')throw new Error('Run no longer active');
        if(!noteBotWork(s,'run').paused)return false;
        parkForGuard(s,live,{nextStep:i,previous});
        return true;
      }))return;
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
      // The owner said no to a page this bot asked for: this turn is its one closing turn.
      const declinedTurn=Boolean(declinedOf(r));
      const handed=previousFor(r,i,current.groups.flatMap(x=>x.bots||[]));
      if(handed)previous=handed;
      // This bot's own provider and its own rulebook, plus the company notebook.
      const config=resolveConfig(store,bot.id);
      const memory=memoryFor(store,{bot,config,chatKey:r.chatKey});
      // Context is automatic: the newest lines that fit; the stored recap, which is
      // in the memory block, stands in for whatever had to be cut.
      const thread=threadContext(current.chats?.[r.chatKey]);
      const envelope=createEnvelope({run:r,bot,previous,thread,team:closing?[]:rosterFor(current,bot,roster,{thread:isThread(g)}),company:everyone,memory,lead,closing,connectors:closing?[]:envelopeConnectors(current),
        // Every bot knows the workspace, so the owner can ask any of them to change a setting instead of learning Settings.
        workspace:!closing?workspaceBrief(current,{agents:agentsBrief(store),connectors:envelopeConnectors(current),speaker:bot}):null,budget:runBudget(current,r)});
      // Each bot runs on its own chosen model/provider, else the workspace
      // default. The turn itself is the one sequence every caller runs: a
      // sub-agent round, then a peer ask, then a new-bot block. A bot that
      // already spawned a helper in this run gets one more turn; that second
      // reply is its output. `runBotTurn` owns the order (see src/bot-turn.js).
      const home=current.groups.find(x=>(x.bots||[]).some(b=>b.id===bot.id));
      // The run's ask tally: each ask is written to the run as it happens, so the
      // thread shows it in flight, and a checkpoint can stop the step and keep it.
      const budget={asks:r.asks?structuredClone(r.asks):undefined,limitBase:r.limitBase,unlimitedAsks:r.unlimitedAsks??!limitsOf(current).askCheckpoints};
      const onEvent=event=>store.update(s=>{
        const live=s.groupRuns.find(x=>x.id===id);
        if(!live||live.status!=='running')throw new Error('Run no longer active');
        live.asks=structuredClone(budget.asks);
        live.trace.push(event.type==='ask'
          ?{botId:event.from,kind:'ask',to:event.to,task:event.task,at:stamp()}
          :{botId:event.from,kind:'peer',to:event.to,output:event.output||'',...(event.error?{error:event.error}:{}),at:stamp()});
        if(live.trace.length>400)live.trace=live.trace.slice(-400);
      });
      const gate=()=>store.update(s=>noteBotWork(s,'run').paused);
      const reply=await runBotTurn(store,{bot,envelope,executor,config,peers:everyone,configFor:peerId=>resolveConfig(store,peerId),memoryForPeer:(mate,mateConfig)=>memoryFor(store,{bot:mate,config:mateConfig,chatKey:r.chatKey}),handoffAllowed:mayHandoff(r,bot)&&!closing&&!declinedTurn,spawnRounds:(r.subagents||[]).some(spawn=>spawn.botId===bot.id)?MAX_SUBAGENT_DEPTH:0,budget,onEvent,gate,resume:resumed,stop:stopped,groupId:home?.id??null,runId:id,makeId:randomUUID,now:stamp});
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
      const connectorAsked=off?[]:parseConnectorCalls(body);
      const stripped=off?body:stripConnectorBlocks(stripBrowserBlocks(body));
      if(!stripped.trim()&&!asked.length&&!connectorAsked.length)throw new Error('Bot returned empty output.');
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
      let toBotId=null,auto=[],holdBrowser=false,newAsks=[],stuckStop=null;
      await store.update(s=>{coordinationState(s);const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='running')throw new Error('Run no longer active');
        const host=s.groups.find(x=>x.id===live.groupId);
        // File fences from the full reply, then hand the next bot the text around them.
        const priorUrls=Array.isArray(live.browserUrls)?live.browserUrls:String(live.browserUrl||'').split(' | ').filter(Boolean);
        const skip=priorUrls;
        const browsed=recordBrowserRequests(s,{bot,groupId:live.groupId,chatKey:live.chatKey||`team-${live.groupId}`,output:stripConnectorBlocks(body),depth:live.browserDepth||0,makeId:randomUUID,skipUrls:skip,runId:id,unattended:Boolean(live.unattended),declined:live.declinedAsks||[]});
        // Connector blocks in the same reply: a page goes first, one kind at a time.
        const conn=off?{text:'',calls:[],lines:[],asks:[]}:recordConnectorCalls(s,{bot,run:live,chatKey:live.chatKey||`team-${live.groupId}`,output:body,unattended:Boolean(live.unattended),declined:live.declinedAsks||[],blockedByPage:browsed.records.length>0,makeId:randomUUID,now:stamp()});
        newAsks=[...browsed.asks,...conn.asks];
        // Text around the browser fences is the browser helper's view of the
        // reply; with nothing to browse, the approved value is the output.
        // A reply that held a browser block (opened, refused or a repeat) is shown without it: a block is never chat text.
        const browsedAny=browsed.records.length||browsed.lines.length;
        previous.output=((browsedAny?browsed.text:gated).trim()?(browsedAny?browsed.text:gated):stripBrowserBlocks(conn.text)).slice(0,3600);
        // A page the owner is already fine with goes out at once. When any page in the reply needs an
        // answer the whole reply waits for it, so the pages come back together.
        if(!browsed.asks.length)auto=browsed.records;
        if(declinedTurn)delete live.declined;
        // A lead hands work to its team only and keeps a step back for its closing
        // reply; a plain bot hands to the group (in a thread, to no one). A closing
        // reply and an out-of-job reply hand nothing out.
        const reach=host?[...host.bots,...summonableGuests(s.groups,host.id)]:[];
        const leads=isLead(s,bot.id);
        // A bot made in this reply was made for this task: it gets the work even when the reply forgot to @mention it.
        const madeNow=(reply.created||[]).filter(r=>!new RegExp(`@${r.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(previous.output));
        const routed=madeNow.length?`${previous.output}\n${madeNow.map(r=>`@${r.name}`).join(' ')}`:previous.output;
        const added=host&&!closing&&!stopped&&!off&&!declinedTurn?handoffTargets({run:live,roster:rosterFor(s,bot,reach,{thread:isThread(host)}),fromBot:bot,output:routed,home:leads||isThread(host)?null:host.bots,reserve:leads&&live.closeAt==null?1:0}):[];
        enlist(live,{fromId:bot.id,added,output:previous.output,lead:leads});
        if(isThread(host))for(const id of added)noteMember(host,id);
        const guests=added.filter(x=>!host.bots.some(b=>b.id===x));
        if(guests.length)live.guestIds=[...(live.guestIds||[]),...guests];
        toBotId=live.recipients[i+1]??null;
        live.currentStep=i+1;live.trace.push({botId:bot.id,output:previous.output,toBotId,at:stamp()});
        const chat=s.groupMessages[live.groupId]??=[];
        // A reply that went to fetch pages or call apps is a working step: the run's live line covers it, and
        // only the answer it leads to belongs in the owner's chat.
        const step=Boolean(browsed.records.length||conn.calls.length||browsed.again?.length||(browsedAny&&/ asked to open a web page\.$/.test(browsed.text)));
        const said=offMsg?{...offMsg,toBotId}:{id:randomUUID(),runId:id,role:'bot',senderId:bot.id,senderName:bot.name,toBotId,text:previous.output,at:stamp(),...(step?{step:true}:{})};
        chat.push(said);
        s.groupMessages[live.groupId]=chat.slice(-300);
        // What the helper did runs before the reply that used it, so the thread
        // reads in the order the work happened.
        for(const line of reply.lines)say(s,live,{...line,runId:id});
        say(s,live,{...said,mode:'ai'});
        // Stamped now: a card made during the turn would otherwise sort above the reply it follows.
        for(const line of reply.after||[])say(s,live,{...line,runId:id,at:stamp()});
        for(const line of browsed.lines)say(s,live,line);
        for(const line of conn.lines)say(s,live,line);
        for(const a of browsed.asks)addAskCards(s,a,bot);
        for(const a of conn.asks)addAskCards(s,a,bot);
        if(reply.spawns.length)live.subagents=[...(live.subagents||[]),...reply.spawns.map(spawn=>({...spawn,botId:bot.id,at:stamp()}))].slice(-6);
        if(reply.asks.length)live.peerAsks=[...(live.peerAsks||[]),...reply.asks.map(ask=>({botId:bot.id,...ask,at:stamp()}))].slice(-6);
        // Nothing new to fetch: the rounds ran out, or every page asked for is one it already read. The bot gets a
        // turn to answer from what it has; doing it again and again (FAIL_STREAK rounds) stops the run.
        delete live.browserNote;
        // Searching again and again without opening a result is no progress: after three rounds the bot is told so.
        if(browsed.records.length){
          live.searchStreak=browsed.records.every(r=>isSearchPage(r.url))?(Number(live.searchStreak)||0)+1:0;
          if(live.searchStreak>=3)live.browserNote=`You have searched ${live.searchStreak} times in a row. Do not search again: open the result pages that fit from the Links list, or answer the owner now with what you found.`;
          // Many pages for one message is a sign it is circling: it is told once to answer with what it has.
          live.pagesRead=(Number(live.pagesRead)||0)+browsed.records.length;
          if(live.pagesRead>=PAGE_NUDGE&&!live.pageNudged){live.pageNudged=true;live.browserNote=`You have opened ${live.pagesRead} pages for this message. Answer the owner now with what you have found, and say in one line what is still missing; open another page only if the answer is impossible without it.`;}
        }
        const stuck=!browsed.records.length&&!conn.calls.length&&!declinedTurn&&!stopped&&!off&&(browsed.limited||browsed.repeated>0||browsed.invalid?.length>0);
        const reread=!stuck&&!browsed.records.length&&!conn.calls.length&&!declinedTurn&&!stopped&&!off&&browsed.again?.length>0;
        if(reread){
          // Pages the run already read: the same bot takes the step again with them. Asking only for those, round
          // after round (FAIL_STREAK), is no progress and stops the run.
          live.failStreak=(Number(live.failStreak)||0)+1;
          if(lastCallOrStop(live,s)){stuckStop=`${bot.name} kept asking for pages it already had, so the task stopped. Ask again with more detail, or name a different site.`;return;}
          if(!live.lastCall||live.failStreak<FAIL_STREAK){
            live.browserPage=browsed.again.join('\n\n---\n\n');live.connectorPage=null;
            live.browserNote=browsed.resent?.length?'You already submitted that form in this task, and it went through: its result is in this message. It is not sent twice. Tell the owner what the result says.'
              :'You asked again for a page you already have, so here it is again. Do not ask for it again: open a different page from its Links list, or answer the owner now with what you found.';
          }
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          live.status='queued';
          holdBrowser=true;
        } else if(stuck){
          live.failStreak=(Number(live.failStreak)||0)+1;
          if(lastCallOrStop(live,s)){stuckStop=browsed.invalid?.length?`${bot.name} kept sending page requests the app could not run (${browsed.invalid[0]}), so the task stopped.`:`${bot.name} kept asking for pages it already had, so the task stopped. Ask again with more detail, or name a different site.`;return;}
          if(!live.lastCall||live.failStreak<FAIL_STREAK)live.browserNote=browsed.limited?'You have used every round of pages for this message. Do not ask for more pages: answer the owner now with what you found, and say what is still missing.'
            :browsed.invalid?.length?`Your browser block was refused: ${browsed.invalid[0]} Fix the block and send it again, or answer the owner now with what you have.`
            :browsed.refused?.length?`${browsed.refused.join(' and ')} turned this browser away twice, so ${browsed.refused.length>1?'they are':'it is'} not opened again. Use other sites, or answer the owner now with what you found.`
            :'You asked again for pages you already read (a page can redirect to one you have). Do not ask for them again: open different pages, or answer the owner now with what you found.';
          if(!live.lastCall||live.failStreak<FAIL_STREAK){live.browserPage=null;live.connectorPage=null;}
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          live.status='queued';
          holdBrowser=true;
        } else if(browsed.records.length){
          // Parked on the owner (an ask) or on the page coming back. Either way it holds nothing.
          live.status=browsed.asks.length?'awaiting_ask':'awaiting_browser';
          if(browsed.asks.length)live.askIds=browsed.asks.map(a=>a.id);
          live.browserPage=null;
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          live.connectorPage=null;
          holdBrowser=true;
        } else if(conn.calls.length){
          // Parked on the owner (an ask), or about to make the calls it already may: either way this same bot takes
          // the step again with what comes back, the way a page does.
          live.browserPage=null;live.connectorPage=null;
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          if(conn.asks.length){live.status='awaiting_ask';live.askIds=conn.asks.map(a=>a.id);}
          else live.status='queued';
          holdBrowser=true;
        } else if(!toBotId&&!off&&!stopped&&!declinedTurn&&!live.lastCall&&!live.promiseNudged&&!reply.spawns.length&&!reply.asks.length&&!(reply.after||[]).some(line=>line.setup)&&promisesAction(previous.output)){
          // "I'll open the booking page" with no block opens nothing; the bot is asked once to do what it said.
          // A reply that made a setup card did what it said ("I'll propose…"), so it is not asked again.
          live.promiseNudged=true;live.browserNote=PROMISE_NOTE;
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          live.status='queued';
          holdBrowser=true;
        } else {
          // Extra turn consumed the page; later bots do not see it as `page`.
          live.browserPage=null;live.failStreak=0;
          live.connectorPage=null;live.connectorCalls=[];
        }
      });
      if(stuckStop)throw Object.assign(new Error(stuckStop),{stopped:true});
      if(newAsks.length)notifyAsks(store,newAsks,bot.name);
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
    await store.update(s=>{const r=s.groupRuns.find(x=>x.id===id);if(r.task)r.task.closing=assessTask(r).note;endRun(r,'completed');r.lastOutput=previous?.output??null;say(s,r,runNote(r));if(r.scheduleId)scheduleRunEnded(s,r.scheduleId,{ok:true});activity(s,'group-run','Completed bot coordination run',{runId:id});});
  // Only a run that was actually executing may be marked failed. A restart marks
  // live runs `interrupted`; overwriting that with `failed` would report a crash
  // the operator never saw as a model error and hide the explicit retry advice.
  }catch(e){
    let scheduled=null,failedNote=null;
    const markFailed=s=>{scheduled=null;failedNote=null;const r=s.groupRuns?.find(x=>x.id===id);if(r&&r.status==='running'){endRun(r,'failed',{error:clean(e.message)});const note=runNote(r);failedNote=note.text;say(s,r,note);say(s,r,modelLimitLine(s,e,{runId:id}));
      // A timer run fails with nobody watching: count it on its schedule (which stops itself when it keeps
      // failing) and tell the owner, instead of re-arming the same failure every period in silence.
      if(r.scheduleId){scheduled=scheduleRunEnded(s,r.scheduleId,{ok:false,error:{message:clean(e.message),code:e.code}});if(scheduled)say(s,r,{id:`${id}-schedule`.slice(0,64),role:'system',text:scheduled.text,runId:id});}
      activity(s,'group-error',`Coordination failed: ${clean(e.message)}`,{runId:id});}};
    // A refused write here leaves the run `running` with nothing behind it: the chat is busy until a restart.
    // One more try after a moment, and a loud line either way.
    try{await store.update(markFailed);}
    catch(writeError){
      console.error(`Run ${id} failed (${clean(e.message)}) and could not be marked failed: ${writeError.message}. Trying once more.`);
      await new Promise(resolve=>setTimeout(resolve,FAIL_WRITE_RETRY_MS));
      try{await store.update(markFailed);}
      catch(again){console.error(`RUN ${id} IS STILL MARKED RUNNING: the write marking it failed was refused twice (${again.message}). A restart marks it interrupted.`);return;}
    }
    if(scheduled)Promise.resolve().then(()=>store.notify?.({title:scheduled.paused?'A schedule stopped':'A scheduled task failed',body:scheduled.text,kind:'event',meta:{runId:id}})).catch(error=>console.error('Schedule notification:',error.message));
    // Any other run that stopped on an error tells the owner too, so a failure is never found only by looking.
    else if(failedNote)Promise.resolve().then(()=>store.notify?.({title:'A task stopped',body:failedNote,kind:'event',meta:{runId:id}})).catch(error=>console.error('Run notification:',error.message));
  }
  finally{
    running.delete(id);
    // A fast local agent can return while autoDispatch is still awaited above.
    // Its resume changes the run to queued, but runGroup's in-process lock
    // rejects that early restart. Pick it up once this invocation releases it.
    if(peek(store).groupRuns?.some(r=>r.id===id&&r.status==='queued'))queueMicrotask(()=>startRun(store,id,executor));
  }
}
/** A page the run asked for mid-step. Success gives that same bot another
 * turn with the page. Failure or a denial skips that extra turn and continues. */
export async function resumeBrowserRun(store,request,{ok,text='',executor}={}){
  const id=request?.runId;
  if(!id)return false;
  const cur=peek(store).groupRuns?.find(r=>r.id===id);
  if(!cur||cur.status!=='awaiting_browser')return false;
  const page=clean(text).trim();
  let stoppedRun=null;
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
    if(live.browserPage){live.browserDepth=Math.min(MAX_BROWSER_DEPTH,(Number(live.browserDepth)||0)+1);live.failStreak=0;}
    // Every page of the round failed. The bot gets a turn to try another page or answer with what it has; the
    // same thing FAIL_STREAK rounds in a row stops the run and tells the owner. A declined page is the owner's
    // answer, not a failure, and goes on as before.
    const why=!ok?clean(request?.error||text||'the page could not be opened.').slice(0,300):'';
    if(!live.browserPage&&!ok&&request?.status==='failed'){
      const step=Number.isInteger(live.checkpoint?.nextStep)?live.checkpoint.nextStep:live.currentStep;
      const who=s.groups.find(g=>g.id===live.groupId)?.bots.find(b=>b.id===live.recipients[step])?.name||'The bot';
      live.failStreak=(Number(live.failStreak)||0)+1;
      // A run that already read something answers from it first, with browsing closed, as the other stuck rounds do.
      const readSome=(s.browserRequests||[]).some(r=>r.runId===id&&r.status==='done'&&r.result?.page);
      if(live.failStreak>=FAIL_STREAK&&readSome&&!lastCallOrStop(live,s)){live.browserNote=`${LAST_CALL} The last page could not be opened (${why}).`;live.status='queued';return true;}
      if(live.failStreak>=FAIL_STREAK){
        endRun(live,'failed',{error:`${who}'s pages failed ${FAIL_STREAK} times in a row, so the task stopped. The last one said: ${why}`});
        say(s,live,runNote(live));
        stoppedRun={title:'A task stopped',body:live.error};
        return false;
      }
      live.browserNote=`The pages you asked for could not be opened (${why}). Try a different page or site, or answer the owner now with what you have.`;
      live.status='queued';
      return true;
    }
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
  if(stoppedRun)Promise.resolve().then(()=>store.notify?.({...stoppedRun,kind:'event',meta:{runId:id}})).catch(error=>console.error('Run notification:',error.message));
  if(start)startRun(store,id,executor);
  return true;
}
/** The last ask a run was parked on has been answered (or has lapsed). A page the owner allowed goes
 * out now, all of them together; if nothing is left to open, the same bot takes one closing turn
 * and is told what was declined. Does nothing for a run that is no longer waiting (stopped, deleted),
 * which is how an answer that comes too late is recorded without resuming anything. */
export async function resumeAfterAsks(store,runId,{executor,runtime,actor=null}={}){
  const plan=await store.update(s=>{
    const live=s.groupRuns?.find(r=>r.id===runId);
    if(!live||live.status!=='awaiting_ask')return null;
    const mine=(s.asks||[]).filter(a=>(live.askIds||[]).includes(a.id));
    if(mine.some(a=>a.status==='pending'))return null;
    const declined=mine.filter(a=>a.status==='declined').map(a=>a.expired?`${a.detail||a.action} (no answer in 24 hours)`:(a.detail||a.action));
    if(declined.length)live.declined=declined;
    // What was declined stays closed for the rest of the task, that action on that site or account only.
    const no=mine.filter(a=>a.status==='declined').map(a=>({action:a.action,scope:a.grantScope||''}));
    if(no.length)live.declinedAsks=[...(live.declinedAsks||[]),...no].slice(-50);
    live.askIds=[];
    // Each connector call waits on its own ask: an allowed one is cleared to run when the step starts, a declined one never runs.
    for(const call of live.connectorCalls||[]){
      if(call.status!=='pending')continue;
      call.status=mine.find(a=>a.id===call.askId)?.status==='allowed'?'go':'denied';
    }
    // A page the owner turned down will never come back, so it must not hold the others up: it counts
    // as handled, the same as a denied page in `resumeBrowserRun`.
    const handled=new Set(live.browserConsumed||[]);
    for(const r of s.browserRequests||[])if(r.runId===runId&&r.status==='denied')handled.add(r.id);
    live.browserConsumed=[...handled];
    const go=(s.browserRequests||[]).filter(r=>r.runId===runId&&r.status==='pending').map(r=>r.id);
    if(go.length){live.status='awaiting_browser';return {dispatch:go};}
    live.status='queued';
    return {start:true};
  });
  if(!plan)return false;
  if(plan.start){startRun(store,runId,executor);return true;}
  for(const requestId of plan.dispatch){
    // No browser to open it with: report it the way a failed page is reported, so the run goes on.
    try{await dispatchBrowserRequest(store,requestId,{actor:actor||'owner',...(runtime?{runtime}:{})});}
    catch(error){
      const request=store.read().browserRequests.find(r=>r.id===requestId);
      if(request)await finishBrowserRequest(store,request,{ok:false,error:error.message});
    }
  }
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
export async function cancelRun(store,id,{actor=null,note=null}={}){
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
    // Its asks stay answerable for a day (the owner's choice may still be worth keeping), then lapse.
    orphanAsks(s,a=>a.runId===id);
    say(s,r,{id:randomUUID(),role:'system',text:note||(midStep?'Stopped. The reply being written when you stopped it was discarded; nothing after it runs.':'Stopped before it started. Nothing ran.'),runId:id,at:stamp()});
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
  return {runId:result.runId,status:peek(store).groupRuns.find(r=>r.id===id)?.status||result.status};
}
/** Keep going (or Stop) for everything the runaway guard parked. Clears the pause
 * and starts a new window; each parked run starts again where it waited, or, with
 * `stop`, is cancelled. The resumed runs go on in the background; `done` settles
 * when they have. */
export async function resumeGuardedRuns(store,{stop=false,executor=executeCustomBot}={}){
  const ids=await store.update(s=>{
    coordinationState(s);
    resumeGuard(s);
    return s.groupRuns.filter(r=>r.status==='awaiting_limit'&&r.limit?.kind==='guard').map(r=>r.id);
  });
  if(stop){
    for(const id of ids)await cancelRun(store,id,{note:'Stopped. Bots were paused and nothing else ran.'});
    return {resumed:[],cancelled:ids,done:Promise.resolve()};
  }
  return {resumed:ids,cancelled:[],done:Promise.all(ids.map(id=>startRun(store,id,executor)))};
}
export async function resumeGroupRun(store,id,executor=executeCustomBot,{choice}={}){
  const r=store.read().groupRuns.find(x=>x.id===id);
  if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
  if(r.status==='awaiting_limit'){
    // Keep going (another round of the same size), Keep going without more
    // checkpoints for this task, or Stop: the asking bot reports what it has.
    if(!['more','unlimited','stop'].includes(choice))throw Object.assign(new Error('Choose more, unlimited or stop.'),{status:400});
    // A run parked by the runaway guard waits on the guard, not on a tally:
    // it goes on once bots are resumed, or it is stopped.
    if(r.limit?.kind==='guard'){
      if(choice==='stop')return cancelRun(store,id,{note:'Stopped. Bots were paused and nothing else ran.'});
      if(botsPaused(store.read()))throw Object.assign(new Error('Bots are paused. Resume them first.'),{status:409});
      return answerThenRun(store,id,executor);
    }
    // The ceiling is not a checkpoint: nothing lifts it, so Stop is the only answer.
    if(r.limit?.kind==='ceiling'&&choice!=='stop')throw Object.assign(new Error(`This task has sent ${ASK_CEILING} bot-to-bot messages, the most one task may. Stop it, then start a new one.`),{status:409});
    // The answer is written inside the same tracked call as the run, so a refused start (a workspace paused
    // for a restore) extends nothing, and pressing Keep going again does not extend the limits twice.
    return answerThenRun(store,id,executor,s=>{const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='awaiting_limit')throw Object.assign(new Error('This run is not waiting at a limit.'),{status:409});
      if(choice==='more')extendLimits(live,live.limit?.kind);
      else if(choice==='unlimited')live.unlimitedAsks=true;
      else live.checkpoint={...live.checkpoint,stop:true};
      activity(s,'group-run',`Bot-to-bot limit answered: ${choice}`,{runId:id});});
  }else if(r.status!=='awaiting_checkpoint')throw Object.assign(new Error('This run is not waiting for a checkpoint.'),{status:409});
  return answerThenRun(store,id,executor);
}
/** Write `answer` (what the person chose at the pause), then go on with the run, as one tracked piece of work in
 * the background, the way decidePlan starts one. Resolves as soon as the answer is written, so the request answers
 * at once instead of waiting out every bot; a refused answer or a refused start rejects. `done` (not sent to the
 * browser) settles when the run has gone as far as it goes. */
function answerThenRun(store,id,executor,answer=null){
  let settle;
  const answered=new Promise((resolve,reject)=>{settle={resolve,reject};});
  const work=async()=>{
    try{if(answer)await store.update(answer);}
    catch(error){settle.reject(error);return;}
    settle.resolve();
    await runGroupInner(store,id,executor);
  };
  const done=Promise.resolve()
    .then(()=>typeof store.trackWork==='function'?store.trackWork(work):work())
    .catch(error=>{settle.reject(error);console.error('Group execution:',error.message);});
  return answered.then(()=>Object.defineProperty({runId:id,status:peek(store).groupRuns.find(x=>x.id===id)?.status||'running'},'done',{value:done}));
}
