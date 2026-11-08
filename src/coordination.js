/** Persistent Node group orchestrator. Model workers get no publication tool.
 * A bot holding `browser.use` may only ask for a page; the request runs on the
 * user's paired local agent after approval (see src/bot-browser.js).
 */
import {randomUUID} from 'node:crypto';
import {createRun,createEnvelope,runNote,planHandoffs,handoffTargets,instructLead,wakeBots,assessTask,summonableGuests,MAX_HANDOFFS,BUSY_STATUSES as BUSY,INTERRUPT_STATUSES as INTERRUPT} from '../shared/coordination.js';
import {botSettings,groupSettings,threadContext,MAX_STEPS_LIMIT} from '../shared/bot-settings.js';
import {addChatMessages} from '../shared/chats.js';
import {assertContractOutput} from '../shared/contracts.js';
import {recordBrowserRequests,queueFeedRead,stripBrowserBlocks,parseBrowserRequests,HOME_FEED_URL,MAX_BROWSER_DEPTH} from '../shared/bot-browser.js';
import {autoDispatch} from './bot-browser.js';
import {executeCustomBot} from './ai.js';
import {resolveConfig,aiAvailable} from './ai-providers.js';
import {activity} from '../shared/core.js';
import {attachRunDraft} from '../shared/workflow.js';
import {failAgentTasks} from './agent.js';
const running=new Set();
const clean=v=>String(v??'').slice(0,4000);
const stamp=()=>new Date().toISOString();
export function coordinationState(s){s.groupMessages??={};s.groupRuns??=[];}
/** Put a line into the run's conversation. The server writes these itself, so a
 * run still shows up in the chat when the tab that started it was closed. A
 * conversation that no longer exists is skipped: the run log keeps the record. */
function say(s,run,entry){
  if(!entry)return;
  try{addChatMessages(s,run.chatKey||`team-${run.groupId}`,[entry],{trusted:true});}catch{/* Conversation removed mid-run. */}
}
export async function markInterrupted(store){
  const taskIds = new Set();
  await store.update(s=>{
    coordinationState(s);
    for(const r of s.groupRuns){
      if(!INTERRUPT.includes(r.status))continue;
      const feed=r.status==='awaiting_feed', page=r.status==='awaiting_browser';
      r.status='interrupted';
      r.error=feed?'Server restarted while waiting for the home feed. Ask again.':page?'Server restarted while waiting for a page. Ask again.':'Server restarted before the run completed. Retry explicitly to avoid duplicate model calls.';
      if(feed||page)for(const request of s.browserRequests||[])if(request.runId===r.id&&['pending','dispatched'].includes(request.status)){
        if(request.status==='dispatched')for(const id of request.agentTaskIds||[])taskIds.add(id);
        request.status='denied';
        request.updatedAt=stamp();
      }
      say(s,r,runNote(r));
    }
  });
  failAgentTasks(store, [...taskIds], 'The server restarted before this group run completed.');
}
export async function queueGroupRun(store,{groupId,message,directBotId=null,checkpoints=false,chatKey=null,browserDepth=0,confirmPlan}={}){
  // Validate the request against the store first so a missing group reports 404
  // and a busy group reports 409, instead of the AI-key check shadowing them
  // with a misleading 422 on an instance that simply has no key yet.
  const snapshot=store.read();
  const probe=snapshot.groups.find(g=>g.id===groupId);
  if(!probe)throw Object.assign(new Error('Group not found'),{status:404});
  if(snapshot.groupRuns?.filter(r=>r.groupId===groupId&&BUSY.includes(r.status)).length>=1)throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  try{planHandoffs(probe,clean(message),{directBotId,guests:summonableGuests(snapshot.groups,groupId,{includeOff:true})});}catch(e){if(e.status)throw e;}
  if(!aiAvailable(store))throw Object.assign(new Error('No AI provider is configured. Add one under You → AI and models, or set AI_API_KEY on the server. GitHub Pages runs a labeled simulation.'),{status:422});
  const id=await store.update(s=>{
    coordinationState(s);
    const group=s.groups.find(g=>g.id===groupId);
    if(!group)throw Object.assign(new Error('Group not found'),{status:404});
    if(s.groupRuns.filter(r=>r.groupId===groupId&&BUSY.includes(r.status)).length>=1)throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
    const messageText=clean(message);
    const guests=summonableGuests(s.groups,groupId,{includeOff:true});
    const instructed=instructLead(group,messageText,directBotId,guests);
    if(instructed.empty)throw Object.assign(new Error('No other bot can take that.'),{status:409,permanent:true});
    // A caller can force the plan gate off. A scheduled task does that: the
    // timer was already the approval, so it must not sit on Start.
    const confirm=confirmPlan===undefined?groupSettings(group).confirmPlan:Boolean(confirmPlan);
    const task=instructed.task?{...instructed.task,confirm}:null;
    const run=createRun({group,message:messageText,directBotId:instructed.directBotId,makeId:randomUUID,checkpoints:Boolean(checkpoints),chatKey,guests,task});
    if(run.status!=='awaiting_plan')wakeBots(group,run.task?.woke);
    if(run.task)say(s,run,{id:randomUUID(),role:'system',text:`${run.task.summary} ${run.task.doneWhen}${run.status==='awaiting_plan'?' Start it when you are ready.':''}`,runId:run.id,at:stamp()});
    if(run.recipients.length>Math.min(run.maxSteps??MAX_HANDOFFS,MAX_STEPS_LIMIT))throw Object.assign(new Error('Run too long.'),{status:400});
    run.browserDepth=Math.max(0,Math.min(MAX_BROWSER_DEPTH,Number(browserDepth)||0));
    s.groupRuns.unshift(run);s.groupRuns=s.groupRuns.slice(0,100);
    s.groupMessages[groupId]??=[];
    s.groupMessages[groupId].push({id:randomUUID(),runId:run.id,role:'user',text:run.input,at:stamp()});
    activity(s,'group-run',`Queued ${group.name} coordination run`,{runId:run.id});return run.id;
  });
  let status=store.read().groupRuns.find(r=>r.id===id)?.status||'queued';
  // A plan the user asked to see first waits. A feed read files its page request
  // before any bot runs, so the reply can say it is waiting. Everything else starts now.
  if(status==='queued'){
    const held=await holdForFeed(store,id);
    if(!held)void runGroup(store,id).catch(error=>console.error('Group execution:',error.message));
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
  if(s.groupRuns?.some(r=>r.groupId===groupId&&BUSY.includes(r.status)))throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  // Queue first. A 409 or a validation error must not leave a "Scheduled task"
  // line for a run that never started; the queue retries those.
  const result=await queue(store,{groupId,message,directBotId:botId,chatKey,confirmPlan:false});
  await note(`Scheduled task: ${message}`);
  return result;
}
export function runGroup(store,id,executor=executeCustomBot){
  const run = () => runGroupInner(store,id,executor);
  return typeof store.trackWork === 'function' ? store.trackWork(run) : run();
}
async function runGroupInner(store,id,executor){
  if(running.has(id))return;running.add(id);
  try{
    // Resume support: a run paused at a checkpoint restarts from where it
    // stopped, carrying the previous bot's output into the next envelope.
    const before=store.read().groupRuns.find(x=>x.id===id);
    const start=before?.checkpoint?.nextStep||0;
    let previous=before?.checkpoint?.previous||null;
    await store.update(s=>{coordinationState(s);const r=s.groupRuns.find(x=>x.id===id);if(!r||!['queued','running','awaiting_checkpoint'].includes(r.status))throw new Error('Run is not runnable');r.status='running';r.startedAt=r.startedAt||stamp();r.checkpoint=null;});
    if(await holdForFeed(store,id))return;
    // The recipient list is read live each step: a bot's reply may append to it.
    let i=start;
    while(true){
      const current=store.read();const r=current.groupRuns.find(x=>x.id===id);
      if(!r||r.status!=='running')throw new Error('Run no longer active');
      if(i>=r.recipients.length){
        const gap=assessTask(r,{drafts:current.drafts||[]});
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
      const thread=threadContext(current.chats?.[r.chatKey],botSettings(bot).contextMessages);
      const envelope=createEnvelope({run:r,bot,previous,thread,team:roster});
      // Each bot runs on its own chosen model/provider, else the workspace default.
      const output=await executor(bot,JSON.stringify(envelope),resolveConfig(store,bot.id));
      if(typeof output!=='string'||!output.trim())throw new Error('Bot returned empty output.');
      // Strip browser fences before the contract gate: a structured bot may
      // still ask for a page, and the next bot must not see the fences.
      const asked=parseBrowserRequests(output);
      const stripped=stripBrowserBlocks(output);
      if(!stripped.trim()&&!asked.length)throw new Error('Bot returned empty output.');
      if(stripped.trim())assertContractOutput(bot,stripped);
      previous={botId:bot.id,output:stripped.slice(0,3600)};
      let toBotId=null,auto=[],holdBrowser=false;
      await store.update(s=>{coordinationState(s);const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='running')throw new Error('Run no longer active');
        const host=s.groups.find(x=>x.id===live.groupId);
        // File fences from the full reply, then hand the next bot the text around them.
        const priorUrls=Array.isArray(live.browserUrls)?live.browserUrls:String(live.browserUrl||'').split(' | ').filter(Boolean);
        const skip=[...(live.task?.feedText?[HOME_FEED_URL]:[]),...priorUrls];
        const browsed=recordBrowserRequests(s,{bot,groupId:live.groupId,chatKey:live.chatKey||`team-${live.groupId}`,output,depth:live.browserDepth||0,makeId:randomUUID,skipUrls:skip,runId:id});
        previous.output=browsed.text.slice(0,3600);
        const actor=host?.bots.find(b=>b.id===bot.id)||bot;
        const sources=[live.input,...live.trace.map(step=>step.output),previous.output].filter(Boolean).join('\n');
        // A refused browser-only reply has no answer to draft. The browser
        // helper supplies a placeholder for display; do not count it as work.
        if(!browsed.records.length&&(stripped.trim()||!asked.length))attachRunDraft(s,{bot:actor,output:previous.output,sources,runId:id});
        if(botSettings(bot).browserApproval==='auto')auto=browsed.records;
        const added=host?handoffTargets({run:live,roster:[...host.bots,...summonableGuests(s.groups,host.id)],fromBot:bot,output:previous.output,home:host.bots}):[];
        live.recipients.push(...added);
        const guests=added.filter(x=>!host.bots.some(b=>b.id===x));
        if(guests.length)live.guestIds=[...(live.guestIds||[]),...guests];
        toBotId=live.recipients[i+1]??null;
        live.currentStep=i+1;live.trace.push({botId:bot.id,output:previous.output,toBotId,at:stamp()});
        const chat=s.groupMessages[live.groupId]??=[];
        const said={id:randomUUID(),runId:id,role:'bot',senderId:bot.id,senderName:bot.name,toBotId,text:previous.output,at:stamp()};
        chat.push(said);
        s.groupMessages[live.groupId]=chat.slice(-300);
        say(s,live,{...said,mode:'ai'});
        for(const line of browsed.lines)say(s,live,line);
        if(browsed.records.length){
          live.status='awaiting_browser';
          live.browserPage=null;
          live.checkpoint={nextStep:i,afterStep:i+1,previous,at:stamp()};
          holdBrowser=true;
        } else {
          // Extra turn consumed the page. Later bots must see the home feed,
          // not this article, as `page`.
          live.browserPage=null;
        }
      });
      if(auto.length)await autoDispatch(store,auto);
      if(holdBrowser)return;
      // Human checkpoint: pause before the next handoff until a person approves,
      // so a multi-step run never advances unattended when enabled.
      if(r.checkpointsEnabled&&toBotId){
        await store.update(s=>{const live=s.groupRuns.find(x=>x.id===id);live.status='awaiting_checkpoint';live.checkpoint={nextStep:i+1,previous,at:stamp()};say(s,live,runNote(live));activity(s,'group-run',`Paused for a checkpoint after step ${i+1}`,{runId:id});});
        return;
      }
      i++;
    }
    await store.update(s=>{const r=s.groupRuns.find(x=>x.id===id);if(r.task)r.task.closing=assessTask(r,{drafts:s.drafts||[]}).note;r.status='completed';r.completedAt=stamp();r.checkpoint=null;r.lastOutput=previous?.output??null;say(s,r,runNote(r));activity(s,'group-run','Completed bot coordination run',{runId:id});});
  // Only a run that was actually executing may be marked failed. A restart marks
  // live runs `interrupted`; overwriting that with `failed` would report a crash
  // the operator never saw as a model error and hide the explicit retry advice.
  }catch(e){await store.update(s=>{const r=s.groupRuns?.find(x=>x.id===id);if(r&&r.status==='running'){r.status='failed';r.error=clean(e.message);r.completedAt=stamp();say(s,r,runNote(r));activity(s,'group-error',`Coordination failed: ${clean(e.message)}`,{runId:id});}});}
  finally{
    running.delete(id);
    // A fast local agent can return while autoDispatch is still awaited above.
    // Its resume changes the run to queued, but runGroup's in-process lock
    // rejects that early restart. Pick it up once this invocation releases it.
    if(store.read().groupRuns?.some(r=>r.id===id&&r.status==='queued'))queueMicrotask(()=>void runGroup(store,id,executor).catch(error=>console.error('Group execution:',error.message)));
  }
}
/** A tracked feed read pauses before any bot runs. The source bot's request
 * must come back as page text; a missing permission or a later denial stops
 * the run instead of drafting as if the feed had been read. */
async function holdForFeed(store,id){
  const filed=await store.update(s=>{
    const live=s.groupRuns.find(x=>x.id===id);
    // A bot or group can be removed between the run starting and this
    // transaction. Never let feed setup revive a run that was cancelled.
    if(!live||!['queued','running'].includes(live.status))return {held:true,auto:[]};
    if(!live?.task?.needsFeed||live.task.feedText)return null;
    if(live.status==='awaiting_feed'||live.task.feedRequestId)return {held:true,auto:[]};
    const group=s.groups.find(g=>g.id===live.groupId);
    const bot=group?.bots.find(b=>b.id===live.task.feedBotId);
    const now=stamp();
    if(!bot){live.status='failed';live.error='No bot can read the feed.';live.completedAt=now;say(s,live,runNote(live));return {held:true,auto:[]};}
    const result=queueFeedRead(s,{bot,groupId:live.groupId,chatKey:live.chatKey||`team-${live.groupId}`,runId:id,makeId:randomUUID,now});
    say(s,live,result.line);
    if(!result.record){live.status='failed';live.error=result.line?.text||'The feed was not opened, so nothing else ran.';live.completedAt=now;return {held:true,auto:[]};}
    live.task={...live.task,feedRequestId:result.record.id};
    live.status='awaiting_feed';
    return {held:true,auto:botSettings(bot).browserApproval==='auto'?[result.record]:[]};
  });
  if(!filed)return false;
  if(filed.auto?.length)await autoDispatch(store,filed.auto);
  return true;
}
/** The home-feed page came back, or it did not. Only a run still waiting on
 * that page moves. A denial or a failure does not start the other bots. */
export async function resumeFeedRun(store,request,{ok,text='',executor}={}){
  const id=request?.runId;
  if(!id)return false;
  const cur=store.read().groupRuns?.find(r=>r.id===id);
  if(!cur||cur.status!=='awaiting_feed')return false;
  const page=clean(text).trim();
  if(!ok||page.length<80){
    const error=!ok?'The feed was not opened, so nothing else ran.':'The home feed came back without posts. Sign in once in the browser profile, allow x.com on the device, and ask again. Nothing else ran.';
    await store.update(s=>{const live=s.groupRuns.find(r=>r.id===id);if(!live||live.status!=='awaiting_feed')return;live.status='failed';live.error=error;live.completedAt=stamp();say(s,live,runNote(live));});
    return true;
  }
  await store.update(s=>{const live=s.groupRuns.find(r=>r.id===id);if(!live||live.status!=='awaiting_feed')return;live.task={...live.task,feedText:page};live.status='queued';});
  void runGroup(store,id,executor).catch(error=>console.error('Group execution:',error.message));
  return true;
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
    // its status flip already committed (feed reads are the other run path).
    const left=(s.browserRequests||[]).some(r=>r.runId===id&&r.purpose!=='feed'&&!consumed.has(r.id));
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
  if(start)void runGroup(store,id,executor).catch(error=>console.error('Group execution:',error.message));
  return true;
}
/** Start or drop a tracked plan that was shown before any bot ran. */
export async function decidePlan(store,id,{approve}){
  const result=await store.update(s=>{
    const r=s.groupRuns.find(x=>x.id===id);
    if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
    if(r.status!=='awaiting_plan')throw Object.assign(new Error('This run is not waiting on a plan.'),{status:409});
    if(!approve){r.status='cancelled';r.completedAt=stamp();say(s,r,{id:randomUUID(),role:'system',text:'Plan cancelled. Nothing ran.',runId:id,at:stamp()});return {runId:id,status:'cancelled'};}
    const group=s.groups.find(g=>g.id===r.groupId);
    if(group)wakeBots(group,r.task?.woke);
    r.status='queued';say(s,r,{id:randomUUID(),role:'system',text:'Starting.',runId:id,at:stamp()});
    return {runId:id,status:'queued',start:true};
  });
  if(result.start){
    const held=await holdForFeed(store,id);
    if(!held)void runGroup(store,id).catch(error=>console.error('Group execution:',error.message));
  }
  return {runId:result.runId,status:store.read().groupRuns.find(r=>r.id===id)?.status||result.status};
}
export async function resumeGroupRun(store,id,executor=executeCustomBot){
  const r=store.read().groupRuns.find(x=>x.id===id);
  if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
  if(r.status!=='awaiting_checkpoint')throw Object.assign(new Error('This run is not waiting for a checkpoint.'),{status:409});
  await runGroup(store,id,executor);
  return {runId:id,status:store.read().groupRuns.find(x=>x.id===id)?.status||'running'};
}
