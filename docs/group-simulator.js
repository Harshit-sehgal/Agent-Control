/** Offline group coordination. Intentionally not AI: demonstrates real context passing. */
import {createRun,createEnvelope,handoffTargets,instructLead,wakeBots,assessTask,runNote,rosterFor,previousFor,enlist} from './coordination.js?v=6e65d8c448';
import {isLead} from './company.js?v=6e65d8c448';
import {botSettings,groupSettings,threadContext} from './bot-settings.js?v=6e65d8c448';
import {normalizeBot} from './contracts.js?v=6e65d8c448';
import {isThread,noteMember} from './threads.js?v=6e65d8c448';

export async function simulateGroup({group, message, directBotId=null, guests=[], state, api, makeId, emit, chatKey=null, started=false, resume=null, shouldStop=()=>false, anyway=false}) {
  let run, previous, i;
  if (resume) {
    // Only a pause resumes. A finished, failed or cancelled record handed back by
    // a stale tab or a double click would otherwise be pushed back to `running`
    // and repeat steps the trace says already ran. The server's continue route
    // refuses the same way.
    if (resume.status !== 'awaiting_checkpoint') throw Object.assign(new Error('Only a run paused at a checkpoint can be continued.'), {status: 409});
    // Deep: a resumed run pushes into `trace`/`recipients` while it works, and a
    // shallow copy meant those pushes landed in the caller's object, which still
    // claimed to be awaiting a checkpoint.
    run = {...structuredClone(resume), status: 'running'};
    if (run.checkpointsEnabled == null) run.checkpointsEnabled = groupSettings(group).checkpoints === true;
    i = Number(resume.checkpoint?.nextStep) || 0;
    previous = resume.checkpoint?.previous || null;
    // The pause this run resumed from is spent. Keeping it would persist a stale
    // checkpoint on a finished run (shared/local-api.js stores whatever comes back).
    run.checkpoint = null;
  } else {
    const instructed=instructLead(group,message,directBotId,guests);
    directBotId=instructed.directBotId;
    const task=instructed.task?{...instructed.task,confirm:started?false:groupSettings(group).confirmPlan}:null;
    run=createRun({group,message,directBotId,guests,makeId,task,chatKey,anyway});
    if(shouldStop()){run.status='cancelled';return run;}
    // `started` is the demo's Start button: the plan line is already in the chat.
    if(run.task&&!started)emit({id:makeId(),role:'system',text:`${run.task.summary} ${run.task.doneWhen}${run.status==='awaiting_plan'?' Start it when you are ready.':''}`,runId:run.id,at:new Date().toISOString()});
    if(run.status==='awaiting_plan')return run;
    wakeBots(group,run.task?.woke);
    for (const id of run.task?.woke || []) { try { await api(`/api/groups/${group.id}/bots/${id}`,'PATCH',{settings:{enabled:true}}); } catch { /* The in-memory bot is already on. */ } }
    run.status='running'; previous=null; i=0;
    emit({id:makeId(),role:'system',text:`Passing this through ${run.recipients.length} bot(s). Simulated, no live AI.`,runId:run.id,at:new Date().toISOString()});
  }
  // The caller snapshots the guest list when the plan is made, and includeOff
  // hands us guests that were already switched off (their mention is refused by
  // name rather than silently re-routed). A run outlives that snapshot, so a
  // guest switched off in the meantime must drop out here exactly like the
  // server's per-step resolveBot refuses it.
  // A thread's guests are the whole company, so a bot's own sharing flag does not apply.
  const open=b=>isThread(group)||botSettings(b).summonable;
  const roster=[...group.bots,...(guests||[]).filter(g=>open(g)&&botSettings(g).enabled!==false&&!group.bots.some(b=>b.id===g.id))];
  // A guest lives in another group and can be switched off, un-shared or removed
  // between two steps. When the caller's state carries the groups, read the
  // guest's current record and treat "no longer summonable" as gone — the server
  // re-resolves every recipient per step (src/coordination.js:102) and must not
  // agree with a snapshot taken before the switch. A caller that only passes a
  // `guests` list keeps that list, which is how the offline demos are driven.
  const liveGroups=Array.isArray(state?.groups)&&state.groups.length?state.groups:null;
  // Who leads whom is read from the whole company; a caller with no state of its
  // own has only this group to go on.
  const world=liveGroups?state:{groups:[group]};
  try {
    while(i<run.recipients.length){
      if(shouldStop()){run.status='cancelled';return run;}
      run.currentStep=i;
      const id=run.recipients[i];
      const isGuest=!group.bots.some(b=>b.id===id);
      const live=isGuest&&liveGroups?liveGroups.flatMap(g=>g.bots||[]).find(b=>b.id===id):null;
      const gone=isGuest&&liveGroups&&!(live&&open(live)&&botSettings(live).enabled);
      const target=gone?null:(live||roster.find(b=>b.id===id));
      if(!target){
        const named=[...group.bots,...(guests||[])].find(b=>b.id===id);
        run.status='failed';
        run.error=`${named?.name||'That bot'} can no longer be summoned. It was switched off, made private or removed.`;
        const stalled=runNote(run);
        emit({id:makeId(),role:'system',text:stalled.text,runId:run.id,at:new Date().toISOString()});
        return run;
      }
      const bot=normalizeBot(target);
      // The same rules as the server loop: a lead hears about its team and a plain
      // bot about the group; a lead's closing step is handed the team's answers.
      const lead=isLead(world,bot.id), closing=run.closeAt===i;
      const handed=previousFor(run,i,[...world.groups.flatMap(g=>g.bots||[]),...roster]);
      if(handed)previous=handed;
      const envelope=createEnvelope({run,bot,previous,team:closing?[]:rosterFor(world,bot,roster,{thread:isThread(group)}),thread:threadContext(state?.chats?.[run.chatKey]),lead,closing});
      const output=`${bot.name} received the task and ${previous?`a handoff from ${roster.find(b=>b.id===previous.botId)?.name||previous.botId}`:'its initial instructions'}. This Pages demo cannot run its custom AI instructions.\nTask: ${envelope.objective.slice(0,220)}\n${previous?`Previous handoff: ${previous.output.slice(0,220)}`:''}`;
      previous={botId:bot.id,output};
      const added=closing?[]:handoffTargets({run,roster:rosterFor(world,bot,roster,{thread:isThread(group)}),fromBot:bot,output,home:lead||isThread(group)?null:group.bots,reserve:lead&&run.closeAt==null?1:0});
      enlist(run,{fromId:bot.id,added,output,lead});
      if(isThread(group))for(const id2 of added)noteMember(group,id2);
      const recipient=roster.find(b=>b.id===run.recipients[i+1]);
      run.trace.push({botId:bot.id,output,at:new Date().toISOString(),toBotId:recipient?.id||null});
      emit({id:makeId(),role:'bot',senderId:bot.id,senderName:bot.name,toBotId:recipient?.id||null,text:output,runId:run.id,kind:'handoff',at:new Date().toISOString()});
      i++;
      run.currentStep=i;
      if(run.checkpointsEnabled&&i<run.recipients.length){
        run.status='awaiting_checkpoint';
        run.checkpoint={nextStep:i,previous,at:new Date().toISOString()};
        const pause=runNote(run);
        emit({id:pause.id,role:'system',text:pause.text,runId:run.id,at:new Date().toISOString()});
        return run;
      }
      if(i>=run.recipients.length){
        const gap=assessTask(run);
        if(gap.retryBotId){
          run.task={...run.task,retried:true};
          run.recipients.push(gap.retryBotId);
          const name=roster.find(b=>b.id===gap.retryBotId)?.name||'That bot';
          emit({id:makeId(),role:'system',text:`${name} has not finished its part. Asking once more.`,runId:run.id,at:new Date().toISOString()});
        }
      }
    }
    if(shouldStop()){run.status='cancelled';return run;}
    run.status='completed';run.checkpoint=null;run.currentStep=run.recipients.length;run.lastOutput=previous?.output||null;
    if(run.task)run.task.closing=assessTask(run).note;
    const note=runNote(run);
    emit({id:note.id,role:'system',text:note.text,runId:run.id,at:new Date().toISOString()});
    return run;
    // A step that throws is a failed run, not a rejected promise: the server
    // records the failure on the run and in the conversation (src/coordination.js
    // catches it the same way), and a browser build that only rejected left the
    // user looking at a chat with no explanation.
  } catch (error) {
    run.status='failed';
    run.error=String(error?.message||error).slice(0,400);
    const failed=runNote(run);
    emit({id:makeId(),role:'system',text:failed.text,runId:run.id,at:new Date().toISOString()});
    return run;
  }
}
