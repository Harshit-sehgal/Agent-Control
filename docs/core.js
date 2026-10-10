export const uuid = () => crypto.randomUUID();
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export function cleanText(v, max=4000) { return typeof v === 'string' ? v.trim().slice(0,max) : ''; }
export function validHttpUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
export function candidateInput(body) {
  const text=cleanText(body?.text,6000), url=validHttpUrl(body?.url);
  if (!text || text.length<12) throw Object.assign(new Error('Post text must contain at least 12 characters.'),{status:400});
  if (!url) throw Object.assign(new Error('Enter a valid public http(s) post URL.'),{status:400});
  return {url, text, author:cleanText(body.author,120)||'Unknown author', topic:cleanText(body.topic,100)};
}
export function scoreCandidate(candidate, topics) {
  const haystack=`${candidate.text} ${candidate.topic}`.toLowerCase();
  const words=(topics||[]).map(t=>String(t).trim().toLowerCase()).filter(Boolean);
  const matched=words.filter(w=>haystack.includes(w));
  const relevance=words.length ? Math.round((matched.length / words.length)*45) : 15;
  const specificity=Math.min(25,Math.floor(candidate.text.length/14));
  const conversation=/\?|why\b|how\b|thoughts\b|agree\b/i.test(candidate.text)?20:6;
  const sources=/(https?:\/\/|research|study|released|benchmark)/i.test(candidate.text)?10:0;
  const score=clamp(10+relevance+specificity+conversation+sources,0,100);
  return {score, matched, reasons:[`${matched.length} matched topic(s)`,conversation===20?'Contains a discussion prompt':'No clear discussion prompt',`Text length ${candidate.text.length} characters`], label:score>=70?'High':score>=45?'Medium':'Low'};
}
export function templateDraft(candidate,settings,direction='') {
  const excerpt=candidate.text.replace(/\s+/g,' ').slice(0,135);
  const question=/\?/.test(candidate.text);
  const intro=question?'Interesting question. ':'Worth looking into. ';
  const opinion=cleanText(settings.opinions,700);
  const angle=cleanText(direction,240);
  // A template cannot rewrite prose, so when the user asks for a direction we
  // carry it into the draft, clearly marked as an instruction not yet applied,
  // instead of pretending an AI acted on it (or silently returning the same text).
  const requested=angle?`\n\nRequested angle (not yet applied): ${angle}`:'';
  return `${intro}${question?'I would check the actual results before settling on an answer.':'I would want to see how this holds up in practice.'}${opinion?' '+opinion:''}${requested}\n\nContext: ${excerpt}`.slice(0,1700);
}
export function delayWindow(min,max,random=()=>Math.random()) {
  const a=Number(min),b=Number(max);
  if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b>1440||a>b) throw Object.assign(new Error('Delay must be whole minutes with 0 ≤ min ≤ max ≤ 1440.'),{status:400});
  const msMin=a*60000,msMax=b*60000;
  return msMin+Math.floor(random()*(msMax-msMin+1));
}
export function initialState() {
  return {version:1, createdAt:new Date().toISOString(), settings:{topics:['AI','machine learning','robotics','technology'],style:'Short, casual, direct. Simple words. No em dashes. Do not invent my opinions.',opinions:'',minDelay:2,maxDelay:10},captureToken:crypto.randomUUID().replaceAll('-',''),groups:[{id:'x-engage',name:'X-engage',description:'User-assisted social research and drafting',bots:[
    {id:'scout',name:'Scout',instructions:'Collect only user-submitted browser context.',type:'source'},
    {id:'ranker',name:'Ranker',instructions:'Score post relevance and discussion value.',type:'scoring'},
    {id:'researcher',name:'Researcher',instructions:'Only describe evidence supplied; do not fabricate verification.',type:'context'},
    {id:'writer',name:'Writer',instructions:'Draft short replies in user style without invented opinions.',type:'writing'},
    {id:'reviewer',name:'Reviewer',instructions:'Require human approval and flag unsupported claims.',type:'review'},
    {id:'handoff',name:'Handoff',instructions:'Prepare copy/manual posting. Never click Post.',type:'manual'}
  ]}],candidates:[],drafts:[],runs:[],schedules:[],events:[]};
}
export function scheduleApproval(draft, min, max, now=Date.now(), random) {
  if(draft.status!=='pending') throw Object.assign(new Error('Only pending drafts can be approved.'),{status:409});
  if(!cleanText(draft.text)) throw Object.assign(new Error('Draft is empty.'),{status:400});
  const delay=delayWindow(min,max,random);
  draft.status='scheduled'; draft.approvedText=draft.text; draft.approvedRevision=draft.revision;
  draft.approvedAt=new Date(now).toISOString(); draft.dueAt=new Date(now+delay).toISOString();
  return draft;
}
export function markDue(draft,now=Date.now()) {
  if(draft.status!=='scheduled') return false;
  // Guard the falsy cases explicitly: `new Date(null).getTime()` is 0 and
  // `new Date(undefined).getTime()` is NaN, both of which are <= now, so a draft
  // with a missing dueAt would be released instantly instead of waiting for its
  // real time. Only a real, finite timestamp counts as due.
  if(!draft.dueAt) return false;
  const due = new Date(draft.dueAt).getTime();
  if(Number.isFinite(due) && due<=now) {draft.status='ready';return true;}
  return false;
}
export function activity(state,type,message,meta={}) {
  state.events.unshift({id:uuid(),at:new Date().toISOString(),type,message,meta});
  state.events=state.events.slice(0,200);
}
/** Content Security Policy shared by the Node response header and the static
 * Pages <meta http-equiv> tag. Both copies must stay byte-identical;
 * tests/security-headers.test.js asserts they match, so editing one without the
 * other fails the build instead of silently weakening the demo. */
export const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** The sample posts the demo seeds. The Node `/api/demo/seed` route and the
 * browser-local transport both load from here, so the two demos cannot drift
 * into different fixtures. */
export const DEMO_SAMPLES=[
  {url:'https://example.com/robotics-demo',author:'Demo robotics account',topic:'robotics',text:'What would make robotics models genuinely useful outside a lab? I care more about reliability than demos.'},
  {url:'https://example.com/ai-demo',author:'Demo AI account',topic:'AI',text:'New AI coding benchmark released. Does a benchmark really tell you how the model performs on a messy production codebase?'},
  {url:'https://example.com/misc-demo',author:'Demo lifestyle account',topic:'other',text:'It is a nice day today.'},
];

