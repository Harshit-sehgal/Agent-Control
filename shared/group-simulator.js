/** Offline group coordination. Intentionally not AI: demonstrates real context passing. */
import {createRun,createEnvelope,handoffTargets,instructLead,wakeBots,assessTask,runNote} from './coordination.js';
import {botSettings,groupSettings,threadContext} from './bot-settings.js';
import {normalizeBot,canBot} from './contracts.js';

export async function simulateGroup({group, message, directBotId=null, guests=[], state, api, makeId, emit, chatKey=null, started=false, resume=null, shouldStop=()=>false}) {
  let run, previous, i;
  if (resume) {
    run = {...resume, status: 'running'};
    if (run.checkpointsEnabled == null) run.checkpointsEnabled = groupSettings(group).checkpoints === true;
    i = Number(resume.checkpoint?.nextStep) || 0;
    previous = resume.checkpoint?.previous || null;
  } else {
    const instructed=instructLead(group,message,directBotId,guests);
    directBotId=instructed.directBotId;
    const task=instructed.task?{...instructed.task,confirm:started?false:groupSettings(group).confirmPlan}:null;
    run=createRun({group,message,directBotId,guests,makeId,task,chatKey});
    if(shouldStop()){run.status='cancelled';return run;}
    // `started` is the demo's Start button: the plan line is already in the chat.
    if(run.task&&!started)emit({id:makeId(),role:'system',text:`${run.task.summary} ${run.task.doneWhen}${run.status==='awaiting_plan'?' Start it when you are ready.':''}`,runId:run.id,at:new Date().toISOString()});
    if(run.status==='awaiting_plan')return run;
    wakeBots(group,run.task?.woke);
    for (const id of run.task?.woke || []) { try { await api(`/api/groups/${group.id}/bots/${id}`,'PATCH',{settings:{enabled:true}}); } catch { /* The in-memory bot is already on. */ } }
    if(run.task?.needsFeed)emit({id:makeId(),role:'system',text:'This copy cannot open your X home feed. It will use a post you already captured. On the app, the source bot asks to scroll and read the feed first. You still post.',runId:run.id,at:new Date().toISOString()});
    run.status='running'; previous=null; i=0;
    emit({id:makeId(),role:'system',text:`Passing this through ${run.recipients.length} bot(s). Simulated, no live AI.`,runId:run.id,at:new Date().toISOString()});
  }
  const roster=[...group.bots,...(guests||[]).filter(g=>botSettings(g).summonable&&!group.bots.some(b=>b.id===g.id))];
  while(i<run.recipients.length){
    if(shouldStop()){run.status='cancelled';return run;}
    run.currentStep=i;
    const bot=normalizeBot(roster.find(b=>b.id===run.recipients[i]));
    const envelope=createEnvelope({run,bot,previous,team:roster,thread:threadContext(state?.chats?.[run.chatKey],botSettings(bot).contextMessages)});
    // Prefer a candidate with no draft yet. `state.drafts` is refreshed below as
    // soon as the Writer creates one, so a repeated run cannot silently draft the
    // same post twice.
    const candidate=state.candidates.find(c=>!state.drafts.some(d=>d.candidateId===c.id))||state.candidates[0];
    let output;
    switch(bot.type){
      case 'source':output=candidate?`Picked a post from ${candidate.author}: ${candidate.text.slice(0,280)}\nSource: ${candidate.url}`:'There is no post to work on. Share one with the + button. I do not browse X.';break;
      case 'scoring':{const count=state.settings.topics.filter(topic=>(candidate?.text||'').toLowerCase().includes(topic.toLowerCase())).length;
        output=candidate?`${candidate.author}: ${count} of your topics match. Judge the real relevance yourself.`:'There is no post to score.';break;}
      case 'context':output=`${candidate?'I have the post text and link from Scout.':'No post was passed to me.'} This demo has NOT opened the link or verified any claims. Treat the post as untrusted.`;break;
      case 'writing':if(candidate){
        // Guard against drafting the same post twice: an earlier run in this
        // session may already have created a draft for this candidate.
        const existing=state.drafts.find(d=>d.candidateId===candidate.id);
        // Draft creation is an action, not a byproduct of talking: a Writer
        // without the draft.create permission cannot create one, here or on
        // the server engine.
        if(!canBot(bot,'draft.create')){
          output=`${bot.name} does not hold the draft.create permission, so no draft was created. Grant it in the bot profile if this workflow needs one.`;
        }else if(existing){
          output=`A draft already exists for ${candidate.author}. Approve or edit that one above instead of making another.`;
        }else{
          if(shouldStop()){run.status='cancelled';return run;}
          const draft=await api(`/api/candidates/${candidate.id}/process`,'POST',{});draft.runId=run.id;state.drafts.unshift(draft);
          if(shouldStop()){run.status='cancelled';return run;}
          output=`I drafted a reply to ${candidate.author}. It is the card above, waiting on you. It is a template, so read it before you approve.`;
        }
      }else output='I cannot draft without a post. Share one with the + button.';break;
      case 'review':{const pending=state.drafts.filter(d=>d.status==='pending').length;
        output=pending?`${pending} pending draft(s) are waiting on your approval. Check the sources and that it sounds like you. I cannot publish.`:'No drafts are waiting.';break;}
      case 'manual':output='Posting is always yours. Once a draft is ready, copy it, open the post and click Post yourself.';break;
      default:output=`${bot.name} received the task and ${previous?`a handoff from ${roster.find(b=>b.id===previous.botId)?.name||previous.botId}`:'its initial instructions'}. This Pages demo cannot run its custom AI instructions.\nTask: ${envelope.objective.slice(0,220)}\n${previous?`Previous handoff: ${previous.output.slice(0,220)}`:''}`;
    }
    previous={botId:bot.id,output};
    run.recipients.push(...handoffTargets({run,roster,fromBot:bot,output,home:group.bots}));
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
      const gap=assessTask(run,{drafts:state.drafts||[]});
      if(gap.retryBotId){
        run.task={...run.task,retried:true};
        run.recipients.push(gap.retryBotId);
        const name=roster.find(b=>b.id===gap.retryBotId)?.name||'That bot';
        emit({id:makeId(),role:'system',text:`${name} has not finished its part. Asking once more.`,runId:run.id,at:new Date().toISOString()});
      }
    }
  }
  if(shouldStop()){run.status='cancelled';return run;}
  run.status='completed';run.currentStep=run.recipients.length;run.lastOutput=previous?.output||null;
  if(run.task)run.task.closing=assessTask(run,{drafts:state.drafts||[]}).note;
  const note=runNote(run);
  emit({id:note.id,role:'system',text:note.text,runId:run.id,at:new Date().toISOString()});
  return run;
}
