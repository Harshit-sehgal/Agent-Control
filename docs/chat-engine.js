/** Intent extraction for the offline Pages prototype; not an LLM or online agent. */
export function classifyMessage(message) {
  const s=String(message??'').trim();
  if (!s) return {intent:'empty'};
  if (/\b(create|add|make)\b.{0,24}\bbot\b/i.test(s)) {
    const m=s.match(/(?:create|add|make)\s+(?:(?:a|an|new)\s+)*bot\s+(?:named|called)\s+([\w][\w \-]{1,45})/i);
    const proposed=m?.[1]?.replace(/\s+(?:that|which|who|to)\b.*$/i,'').trim();
    return {intent:'create-bot',name:proposed||null};
  }
  if (/\b(draft|write|reply|response)\b/i.test(s)) return {intent:'draft'};
  if (/\b(approve|approval|pending|review|inbox)\b/i.test(s)) return {intent:'approvals'};
  if (/\b(scout|scan|find posts|candidates|discover|feed)\b/i.test(s)) return {intent:'discover'};
  if (/\b(schedule|delay|reminder|routine|interval)\b/i.test(s)) return {intent:'schedules'};
  if (/\b(status|summary|progress|how many|report)\b/i.test(s)) return {intent:'status'};
  return {intent:'general'};
}
export function botSuggestions(name='Bot',group='') {
  const n=name.toLowerCase();
  if (/scout|rank/.test(n)) return ['Show candidate posts','What should we scout?','Show status'];
  if (/writer|research|review/.test(n)) return ['Draft a reply','Show pending approvals','Show status'];
  if (/coordinator|team/.test(n)||group.toLowerCase().includes('engage')) return ['Show X-engage status','Draft a reply','Show pending approvals'];
  return ['What can you do?','Show status','Create a new bot'];
}
export function statusSummary(s) {
  const candidates=s?.candidates?.length??0;
  const drafts=s?.drafts??[];
  return `${candidates} candidate${candidates===1?'':'s'} in Discovery · ${drafts.filter(d=>d.status==='pending').length} awaiting approval · ${drafts.filter(d=>d.status==='scheduled').length} scheduled · ${drafts.filter(d=>d.status==='ready').length} ready for your manual Post click.`;
}
