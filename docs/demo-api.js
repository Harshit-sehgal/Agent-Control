/* Agent Control Pages demo: ALL data stays inside the browser via localStorage. */
(() => {
  'use strict';
  const KEY = 'agent-control-ghpages-v1';
  const now = () => new Date().toISOString();
  const id = () => crypto.randomUUID();
  const text = (v, max=3000) => typeof v === 'string' ? v.trim().slice(0,max) : '';
  const fail = message => { throw new Error(message); };
  const defaults = () => ({
    version: 1,
    settings: {topics:['AI','machine learning','robotics','technology'],style:'Short, casual, direct. Simple words. No em dashes. Do not invent my opinions.',opinions:'',minDelay:2,maxDelay:10},
    captureToken:'NOT_SUPPORTED_ON_GITHUB_PAGES',
    groups:[{id:'x-engage',name:'X-engage',description:'User-assisted social research and drafting',bots:[
      {id:'scout',name:'Scout',type:'source',instructions:'Collect user-submitted browser context only.'},
      {id:'ranker',name:'Ranker',type:'scoring',instructions:'Score posts by topic relevance.'},
      {id:'researcher',name:'Researcher',type:'context',instructions:'Do not invent facts or citations.'},
      {id:'writer',name:'Writer',type:'writing',instructions:'Draft short replies without invented opinions.'},
      {id:'reviewer',name:'Reviewer',type:'review',instructions:'Require manual editing and approval.'},
      {id:'handoff',name:'Handoff',type:'manual',instructions:'Never click Post on X.'}
    ]}],candidates:[],drafts:[],runs:[],schedules:[],events:[]
  });
  const read = () => {
    try {
      const value = localStorage.getItem(KEY);
      if (value) {
        const state = JSON.parse(value);
        if (state?.version === 1 && Array.isArray(state.candidates) && Array.isArray(state.drafts) && Array.isArray(state.groups) && Array.isArray(state.schedules)) return state;
      }
    } catch { fail('Browser storage is unavailable. Enable local storage to use this demo.'); }
    return defaults();
  };
  const save = s => { try { localStorage.setItem(KEY,JSON.stringify(s)); } catch { fail('Unable to save browser-local data. Check available storage and private browsing settings.'); } };
  const log = (s,type,message) => {s.events.unshift({id:id(),type,message,at:now()});s.events=s.events.slice(0,200);};
  const find = (items, key) => items.find(x=>x.id===key) || fail('Item not found.');
  const ensureUrl = u => {try{const x=new URL(u);if((x.protocol==='https:'||x.protocol==='http:')&&!x.username&&!x.password)return x.href;}catch{}fail('Enter a valid http(s) URL.');};
  const candidateInput = b => {const content=text(b?.text,6000);if(content.length<12)fail('Post text must contain at least 12 characters.');return {url:ensureUrl(b?.url),text:content,author:text(b?.author,120)||'Unknown author',topic:text(b?.topic,100)};};
  const score = (c,topics) => {const hay=`${c.text} ${c.topic}`.toLowerCase(),matched=topics.filter(t=>hay.includes(t.toLowerCase()));const relevance=topics.length?Math.round(matched.length/topics.length*45):15;const specificity=Math.min(25,Math.floor(c.text.length/14));const discussion=/\?|why\b|how\b|thoughts\b|agree\b/i.test(c.text)?20:6;const sources=/(https?:\/\/|research|study|released|benchmark)/i.test(c.text)?10:0;return {score:Math.min(100,10+relevance+specificity+discussion+sources),matched,reasons:[`${matched.length} matched topics`],label:matched.length?'Relevant':'General'};};
  const draftText = (c,s) => {const start=c.text.includes('?')?'Interesting question. ':'Worth looking into. ';return `${start}I would want to check the actual results before settling on a view. ${s.opinions?text(s.opinions,500)+' ':''}\n\nContext: ${c.text.replace(/\s+/g,' ').slice(0,130)}`.slice(0,1700);};
  const minMax = (a,b) => {if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b>1440||a>b)fail('Delay must be whole minutes with 0 ≤ min ≤ max ≤ 1440.');};
  const due = s => {
    const time=Date.now();let changed=false;
    for (const d of s.drafts) if(d.status==='scheduled'&&Date.parse(d.dueAt)<=time) {d.status='ready';log(s,'ready','Draft ready for manual posting.');changed=true;}
    for(const r of s.schedules) if(r.enabled&&Date.parse(r.nextAt)<=time){log(s,'schedule',`Reminder: ${r.label}`);if(r.kind==='interval'){const interval=r.intervalMinutes*60000;const missed=Math.floor((time-Date.parse(r.nextAt))/interval)+1;r.nextAt=new Date(Date.parse(r.nextAt)+Math.min(missed,100000)*interval).toISOString();}else r.enabled=false;changed=true;}
    if(changed)save(s);
  };
  const samples=[
    {url:'https://example.com/robotics-demo',author:'Demo robotics account',topic:'robotics',text:'What would make robotics models genuinely useful outside a lab? I care more about reliability than demos.'},
    {url:'https://example.com/ai-demo',author:'Demo AI account',topic:'AI',text:'New AI coding benchmark released. Does a benchmark really tell you how the model performs on a messy production codebase?'},
    {url:'https://example.com/misc-demo',author:'Demo lifestyle account',topic:'other',text:'It is a nice day today.'}
  ];
  async function api(path,method='GET',body={}) {
    if(path==='/api/login'||path==='/api/logout')return {ok:true};
    const s=read(); due(s);
    if(path==='/api/state'&&method==='GET')return {...s,aiEnabled:false,serverTime:now()};
    let m;
    if(path==='/api/demo/seed'&&method==='POST'){
      let added=0; for(const x of samples)if(!s.candidates.some(c=>c.url===x.url)){s.candidates.unshift({...x,id:id(),demo:true,status:'new',createdAt:now()});added++;}
      log(s,'demo',`Loaded ${added} sample post(s).`);save(s);return {added};
    }
    if(path==='/api/settings'&&method==='PATCH'){
      const a=Number(body.minDelay),b=Number(body.maxDelay);minMax(a,b);if(!Array.isArray(body.topics))fail('Topics must be an array.');s.settings={topics:body.topics.slice(0,30).map(x=>text(x,60)).filter(Boolean),style:text(body.style,1000),opinions:text(body.opinions,1000),minDelay:a,maxDelay:b};log(s,'settings','Updated local preferences.');save(s);return s.settings;
    }
    if(path==='/api/candidates'&&method==='POST'){
      const c=candidateInput(body),prior=s.candidates.find(x=>x.url===c.url&&x.text===c.text);if(prior)return prior;
      const item={...c,id:id(),status:'new',createdAt:now()};s.candidates.unshift(item);log(s,'capture',`Added candidate from ${c.author}.`);save(s);return item;
    }
    if((m=path.match(/^\/api\/candidates\/([a-z0-9-]+)\/process$/))&&method==='POST'){
      const c=find(s.candidates,m[1]);c.score=score(c,s.settings.topics);c.status='drafted';const d={id:id(),candidateId:c.id,author:c.author,url:c.url,sourceText:c.text,text:draftText(c,s.settings),revision:1,status:'pending',score:c.score.score,mode:'template',note:'Static template only; not real AI, research or verified fact-checking.',createdAt:now()};s.drafts.unshift(d);log(s,'draft',`Created template draft for ${c.author}.`);save(s);return d;
    }
    if((m=path.match(/^\/api\/drafts\/([a-z0-9-]+)$/))&&method==='PATCH'){
      const d=find(s.drafts,m[1]),t=text(body.text,3000);if(!t)fail('Draft cannot be empty.');if(!['pending','scheduled','ready'].includes(d.status))fail('Draft cannot be edited in this state.');d.text=t;d.revision++;d.status='pending';delete d.approvedText;delete d.approvedRevision;delete d.dueAt;delete d.approvedAt;log(s,'edit','Saved revision and cleared earlier approval.');save(s);return d;
    }
    if((m=path.match(/^\/api\/drafts\/([a-z0-9-]+)\/(approve|reject|ready|posted|rewrite)$/))&&method==='POST'){
      const d=find(s.drafts,m[1]),action=m[2];
      if(action==='rewrite'){
        if(!['pending','scheduled','ready'].includes(d.status))fail('Cannot rewrite this draft.');
        const c=find(s.candidates,d.candidateId);d.text=`${draftText(c,s.settings)}${text(body?.direction,250)?'\n\nRewrite request: '+text(body.direction,250):''}`;d.revision++;d.status='pending';d.note='Template draft. Rewrite instructions have not been processed by an AI model.';delete d.approvedText;delete d.approvedRevision;delete d.dueAt;delete d.approvedAt;
      }else if(action==='approve'){
        if(d.status!=='pending')fail('Only pending drafts can be approved.');minMax(s.settings.minDelay,s.settings.maxDelay);d.status='scheduled';d.approvedText=d.text;d.approvedRevision=d.revision;d.approvedAt=now();const a=s.settings.minDelay,b=s.settings.maxDelay;d.dueAt=new Date(Date.now()+(a+(b-a)*Math.random())*60000).toISOString();
      }else if(action==='reject'){
        if(!['pending','scheduled','ready'].includes(d.status))fail('Cannot reject this draft.');d.status='rejected';
      }else if(action==='ready'){
        if(d.status!=='scheduled')fail('Only scheduled drafts can become ready.');d.status='ready';
      }else if(action==='posted'){
        if(d.status!=='ready')fail('Only ready drafts can be marked posted.');if(d.approvedRevision!==d.revision||d.approvedText!==d.text)fail('Approval no longer matches this draft.');d.status='posted';d.postedAt=now();
      }
      log(s,action,`Draft ${action} (local demo).`);save(s);return d;
    }
    if(path==='/api/groups'&&method==='POST'){
      const name=text(body.name,80);if(!name)fail('Group name required.');const g={id:id(),name,description:text(body.description,300),bots:[]};s.groups.push(g);log(s,'group',`Created ${name}.`);save(s);return g;
    }
    if((m=path.match(/^\/api\/groups\/([a-z0-9-]+)\/bots$/))&&method==='POST'){
      const g=find(s.groups,m[1]),name=text(body.name,80),instructions=text(body.instructions,3000);if(!name||!instructions)fail('Bot name and instructions are required.');const b={id:id(),name,instructions,type:'custom'};g.bots.push(b);log(s,'bot',`Created ${name}.`);save(s);return b;
    }
    if(path==='/api/bots/run')fail('Running AI bots requires the separate Node backend, not GitHub Pages.');
    if(path==='/api/schedules'&&method==='POST'){
      const label=text(body.label,200),kind=body.kind;if(!label||!['once','interval'].includes(kind))fail('Provide a label and schedule type.');let nextAt,intervalMinutes=null;
      if(kind==='once'){const t=Date.parse(body.nextAt);if(!Number.isFinite(t)||t<Date.now()+1000||t>Date.now()+365*86400000)fail('Choose a future time within one year.');nextAt=new Date(t).toISOString();}
      else {intervalMinutes=Number(body.intervalMinutes);if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080)fail('Interval must be 1–10080 minutes.');nextAt=new Date(Date.now()+intervalMinutes*60000).toISOString();}
      const item={id:id(),label,kind,nextAt,intervalMinutes,enabled:true};s.schedules.unshift(item);log(s,'schedule',`Created local reminder: ${label}.`);save(s);return item;
    }
    if((m=path.match(/^\/api\/schedules\/([a-z0-9-]+)$/))&&method==='DELETE'){
      const idx=s.schedules.findIndex(x=>x.id===m[1]);if(idx<0)fail('Schedule not found.');s.schedules.splice(idx,1);log(s,'schedule','Removed reminder.');save(s);return {ok:true};
    }
    if(path==='/api/reset-demo'&&method==='POST'){
      s.candidates=s.candidates.filter(x=>!x.demo);s.drafts=s.drafts.filter(d=>s.candidates.some(c=>c.id===d.candidateId));log(s,'demo','Removed demo candidates.');save(s);return {ok:true};
    }
    fail(`Not available in GitHub Pages demo: ${method} ${path}`);
  }
  window.AGENT_PAGES_DEMO=api;
})();
