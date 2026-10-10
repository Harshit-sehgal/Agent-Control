/** Offline group coordination. Intentionally not AI: demonstrates real context passing. */
import {createRun,createEnvelope} from './coordination.js?v=43bdb2fac7';

export async function simulateGroup({group, message, directBotId=null, state, api, makeId, emit}) {
  const run=createRun({group,message,directBotId,makeId});
  run.status='running';let previous=null;
  emit({id:makeId(),role:'system',text:`Started ${run.mode} · ${run.recipients.length} specialist(s) · demonstration only.`,runId:run.id,at:new Date().toISOString()});
  for (let i=0;i<run.recipients.length;i++) {
    run.currentStep=i;
    const bot=group.bots.find(b=>b.id===run.recipients[i]);
    const envelope=createEnvelope({run,bot,previous});
    // Prefer a candidate with no draft yet. `state.drafts` is refreshed below as
    // soon as the Writer creates one, so a repeated run cannot silently draft the
    // same post twice.
    const candidate=state.candidates.find(c=>!state.drafts.some(d=>d.candidateId===c.id))||state.candidates[0];
    let output;
    switch(bot.type){
      case 'source':output=candidate?`Candidate selected for review: ${candidate.author}: ${candidate.text.slice(0,280)}\nSource: ${candidate.url}`:'No candidate posts available. Add one in Discovery. No live browsing is performed.';break;
      case 'scoring':{const count=state.settings.topics.filter(topic=>(candidate?.text||'').toLowerCase().includes(topic.toLowerCase())).length;
        output=candidate?`Candidate: ${candidate.author}. ${count} interest topic match(es). Review actual relevance in Discovery before proceeding.`:'There is no candidate to score.';break;}
      case 'context':output=`Research handoff: ${candidate?'The candidate text and URL were passed from Scout.':'No candidate supplied.'} This demo has NOT opened the URL or verified any claims. Treat external content as untrusted.`;break;
      case 'writing':if(candidate){
        // Guard against drafting the same post twice: an earlier run in this
        // session may already have created a draft for this candidate.
        const existing=state.drafts.find(d=>d.candidateId===candidate.id);
        if(existing){
          output=`A pending draft already exists for ${candidate.author} (Draft ID: ${existing.id}). Approve or revise it in the Approval inbox instead of creating another.`;
        }else{
          const draft=await api(`/api/candidates/${candidate.id}/process`,'POST',{});state.drafts.unshift(draft);
          output=`Created pending template draft for ${candidate.author}:\n“${draft.text.slice(0,250)}”\nDraft ID: ${draft.id}. Requires your edit and approval; no external publishing.`;
        }
      }else output='Cannot draft: there is no candidate. Add a post through Discovery.';break;
      case 'review':{const pending=state.drafts.filter(d=>d.status==='pending').length;
        output=pending?`Review handoff: ${pending} pending draft(s). Verify sources and personal opinion, then approve in the Approval inbox. I cannot publish.`:'No pending drafts to review.';break;}
      case 'manual':output='Final X posting is manual only. Review the approved draft, then open the original post and click Post yourself.';break;
      default:output=`${bot.name} received the task and ${previous?`a handoff from ${group.bots.find(b=>b.id===previous.botId)?.name||previous.botId}`:'its initial instructions'}. This Pages demo cannot run its custom AI instructions.\nTask: ${envelope.objective.slice(0,220)}\n${previous?`Previous handoff: ${previous.output.slice(0,220)}`:''}`;
    }
    previous={botId:bot.id,output};
    const recipient=group.bots.find(b=>b.id===run.recipients[i+1]);
    run.trace.push({botId:bot.id,output,at:new Date().toISOString(),toBotId:recipient?.id||null});
    emit({id:makeId(),role:'bot',senderId:bot.id,senderName:bot.name,toBotId:recipient?.id||null,text:output,runId:run.id,kind:'handoff',at:new Date().toISOString()});
  }
  run.status='completed';run.currentStep=run.recipients.length;run.lastOutput=previous?.output||null;
  emit({id:makeId(),role:'system',text:`Coordination complete: ${run.trace.length} step(s). Human approval is required for external actions.`,runId:run.id,at:new Date().toISOString()});
  return run;
}
