/** Persistent Node group orchestrator. All execution is local, read/compose only.
 * No browser or external-action tools are given to model workers.
 */
import {randomUUID} from 'node:crypto';
import {createRun,createEnvelope,runNote,MAX_HANDOFFS} from '../shared/coordination.js';
import {addChatMessages} from '../shared/chats.js';
import {assertContractOutput} from '../shared/contracts.js';
import {executeCustomBot,aiEnabled} from './ai.js';
import {activity} from '../shared/core.js';
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
  await store.update(s=>{coordinationState(s);for(const r of s.groupRuns){if(r.status==='running'||r.status==='queued'){r.status='interrupted';r.error='Server restarted before the run completed. Retry explicitly to avoid duplicate model calls.';say(s,r,runNote(r));}}});
}
export async function queueGroupRun(store,{groupId,message,directBotId=null,checkpoints=false,chatKey=null}){
  // Validate the request against the store first so a missing group reports 404
  // and a busy group reports 409, instead of the AI-key check shadowing them
  // with a misleading 422 on an instance that simply has no key yet.
  const snapshot=store.read();
  const probe=snapshot.groups.find(g=>g.id===groupId);
  if(!probe)throw Object.assign(new Error('Group not found'),{status:404});
  if(snapshot.groupRuns?.filter(r=>r.groupId===groupId&&['running','queued'].includes(r.status)).length>=1)throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  if(!aiEnabled())throw Object.assign(new Error('No AI provider is configured on the Node server (set AI_API_KEY and AI_BASE_URL). GitHub Pages runs a labeled simulation.'),{status:422});
  const id=await store.update(s=>{
    coordinationState(s);
    const group=s.groups.find(g=>g.id===groupId);
    if(!group)throw Object.assign(new Error('Group not found'),{status:404});
    if(s.groupRuns.filter(r=>r.groupId===groupId&&['running','queued'].includes(r.status)).length>=1)throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
    const run=createRun({group,message:clean(message),directBotId,makeId:randomUUID,checkpoints:Boolean(checkpoints),chatKey});
    if(run.recipients.length>MAX_HANDOFFS)throw Object.assign(new Error('Run too long.'),{status:400});
    s.groupRuns.unshift(run);s.groupRuns=s.groupRuns.slice(0,100);
    s.groupMessages[groupId]??=[];
    s.groupMessages[groupId].push({id:randomUUID(),runId:run.id,role:'user',text:run.input,at:stamp()});
    activity(s,'group-run',`Queued ${group.name} coordination run`,{runId:run.id});return run.id;
  });
  // The API response is not blocked by model inference. The execution is bounded.
  void runGroup(store,id).catch(error=>console.error('Group execution:',error.message));
  return {runId:id,status:'queued'};
}
export async function runGroup(store,id,executor=executeCustomBot){
  if(running.has(id))return;running.add(id);
  try{
    // Resume support: a run paused at a checkpoint restarts from where it
    // stopped, carrying the previous bot's output into the next envelope.
    const before=store.read().groupRuns.find(x=>x.id===id);
    const start=before?.checkpoint?.nextStep||0;
    let previous=before?.checkpoint?.previous||null;
    await store.update(s=>{coordinationState(s);const r=s.groupRuns.find(x=>x.id===id);if(!r||!['queued','running','awaiting_checkpoint'].includes(r.status))throw new Error('Run is not runnable');r.status='running';r.startedAt=r.startedAt||stamp();r.checkpoint=null;});
    const original=store.read().groupRuns.find(x=>x.id===id);
    for(let i=start;i<original.recipients.length;i++){
      const current=store.read();const g=current.groups.find(x=>x.id===original.groupId);const r=current.groupRuns.find(x=>x.id===id);
      if(!r||r.status!=='running')throw new Error('Run no longer active');
      const bot=g?.bots.find(x=>x.id===r.recipients[i]);
      if(!g||!bot)throw new Error('Bot or group was removed during execution.');
      r.currentStep=i;
      const envelope=createEnvelope({run:r,bot,previous});
      const output=await executor(bot,JSON.stringify(envelope));
      if(typeof output!=='string'||!output.trim())throw new Error('Bot returned empty output.');
      // The output contract is the gate: a step that returns the wrong shape
      // fails the run here instead of handing a payload the next bot (or the
      // human reading the transcript) never asked for.
      assertContractOutput(bot,output);
      const toBotId=r.recipients[i+1]??null;
      previous={botId:bot.id,output:output.slice(0,3600)};
      await store.update(s=>{coordinationState(s);const live=s.groupRuns.find(x=>x.id===id);if(!live||live.status!=='running')throw new Error('Run no longer active');
        live.currentStep=i+1;live.trace.push({botId:bot.id,output:previous.output,toBotId,at:stamp()});
        const chat=s.groupMessages[live.groupId]??=[];
        const said={id:randomUUID(),runId:id,role:'bot',senderId:bot.id,senderName:bot.name,toBotId,text:previous.output,at:stamp()};
        chat.push(said);
        s.groupMessages[live.groupId]=chat.slice(-300);
        say(s,live,{...said,mode:'ai'});
      });
      // Human checkpoint: pause before the next handoff until a person approves,
      // so a multi-step run never advances unattended when enabled.
      if(original.checkpointsEnabled&&toBotId){
        await store.update(s=>{const live=s.groupRuns.find(x=>x.id===id);live.status='awaiting_checkpoint';live.checkpoint={nextStep:i+1,previous,at:stamp()};say(s,live,runNote(live));activity(s,'group-run',`Paused for a checkpoint after step ${i+1}`,{runId:id});});
        return;
      }
    }
    await store.update(s=>{const r=s.groupRuns.find(x=>x.id===id);r.status='completed';r.completedAt=stamp();r.checkpoint=null;r.lastOutput=previous?.output??null;say(s,r,runNote(r));activity(s,'group-run','Completed bot coordination run',{runId:id});});
  // Only a run that was actually executing may be marked failed. A restart marks
  // live runs `interrupted`; overwriting that with `failed` would report a crash
  // the operator never saw as a model error and hide the explicit retry advice.
  }catch(e){await store.update(s=>{const r=s.groupRuns?.find(x=>x.id===id);if(r&&r.status==='running'){r.status='failed';r.error=clean(e.message);r.completedAt=stamp();say(s,r,runNote(r));activity(s,'group-error',`Coordination failed: ${clean(e.message)}`,{runId:id});}});}
  finally{running.delete(id);}
}
/** Resume a run paused at a checkpoint, after a person approved the next step. */
export async function resumeGroupRun(store,id,executor=executeCustomBot){
  const r=store.read().groupRuns.find(x=>x.id===id);
  if(!r)throw Object.assign(new Error('Run not found.'),{status:404});
  if(r.status!=='awaiting_checkpoint')throw Object.assign(new Error('This run is not waiting for a checkpoint.'),{status:409});
  await runGroup(store,id,executor);
  return {runId:id,status:'running'};
}
