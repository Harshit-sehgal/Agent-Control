/** Offline group coordination. Intentionally not AI: demonstrates real context passing. */
import {createRun,createEnvelope} from './coordination.js?v=8487cfc1fa';
import {normalizeBot,canBot} from './contracts.js?v=8487cfc1fa';

export async function simulateGroup({group, message, directBotId=null, state, api, makeId, emit}) {
  const run=createRun({group,message,directBotId,makeId});
  run.status='running';let previous=null;
  emit({id:makeId(),role:'system',text:`Passing this through ${run.recipients.length} bot(s). Simulated, no live AI.`,runId:run.id,at:new Date().toISOString()});
  for (let i=0;i<run.recipients.length;i++) {
    run.currentStep=i;
    const bot=normalizeBot(group.bots.find(b=>b.id===run.recipients[i]));
    const envelope=createEnvelope({run,bot,previous});
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
          const draft=await api(`/api/candidates/${candidate.id}/process`,'POST',{});state.drafts.unshift(draft);
          output=`I drafted a reply to ${candidate.author}. It is the card above, waiting on you. It is a template, so read it before you approve.`;
        }
      }else output='I cannot draft without a post. Share one with the + button.';break;
      case 'review':{const pending=state.drafts.filter(d=>d.status==='pending').length;
        output=pending?`${pending} pending draft(s) are waiting on your approval. Check the sources and that it sounds like you. I cannot publish.`:'No drafts are waiting.';break;}
      case 'manual':output='Posting is always yours. Once a draft is ready, copy it, open the post and click Post yourself.';break;
      default:output=`${bot.name} received the task and ${previous?`a handoff from ${group.bots.find(b=>b.id===previous.botId)?.name||previous.botId}`:'its initial instructions'}. This Pages demo cannot run its custom AI instructions.\nTask: ${envelope.objective.slice(0,220)}\n${previous?`Previous handoff: ${previous.output.slice(0,220)}`:''}`;
    }
    previous={botId:bot.id,output};
    const recipient=group.bots.find(b=>b.id===run.recipients[i+1]);
    run.trace.push({botId:bot.id,output,at:new Date().toISOString(),toBotId:recipient?.id||null});
    emit({id:makeId(),role:'bot',senderId:bot.id,senderName:bot.name,toBotId:recipient?.id||null,text:output,runId:run.id,kind:'handoff',at:new Date().toISOString()});
  }
  run.status='completed';run.currentStep=run.recipients.length;run.lastOutput=previous?.output||null;
  emit({id:makeId(),role:'system',text:`Done in ${run.trace.length} step(s). Anything to post still needs your approval.`,runId:run.id,at:new Date().toISOString()});
  return run;
}
