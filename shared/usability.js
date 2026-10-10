// Pure, stable selectors for the static Pages interface. Does not mutate stored records.
const timestamp = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : 0;
const score = value => Number.isFinite(Number(value)) ? Number(value) : -1;
export function filterCandidates(items, {status='all',sort='newest',query=''}={}) {
  const q = String(query).trim().toLocaleLowerCase();
  const filtered = items.filter(item => {
    if (status==='new' && item.status!=='new') return false;
    if (status==='drafted' && item.status!=='drafted') return false;
    if (status==='high' && (item.score?.score??-1)<70) return false;
    // Include the URL: users naturally paste the post link to find a capture,
    // and it is the only stable handle they have for it.
    return !q || [item.author,item.topic,item.text,item.url].some(v => String(v??'').toLocaleLowerCase().includes(q));
  });
  return filtered.sort((a,b) => {
    if (sort==='score-high') return score(b.score?.score)-score(a.score?.score) || timestamp(b.createdAt)-timestamp(a.createdAt);
    if (sort==='score-low') return score(a.score?.score)-score(b.score?.score) || timestamp(b.createdAt)-timestamp(a.createdAt);
    return sort==='oldest' ? timestamp(a.createdAt)-timestamp(b.createdAt) : timestamp(b.createdAt)-timestamp(a.createdAt);
  });
}
export function filterDrafts(items,{status='active',sort='newest'}={}) {
  const active=['pending','scheduled','ready'];
  const filtered=items.filter(d=> status==='all' || (status==='active' ? active.includes(d.status) : d.status===status));
  return filtered.sort((a,b)=>{
    if(sort==='score-high')return score(b.score)-score(a.score)||timestamp(b.createdAt)-timestamp(a.createdAt);
    return sort==='oldest'?timestamp(a.createdAt)-timestamp(b.createdAt):timestamp(b.createdAt)-timestamp(a.createdAt);
  });
}
export const UI_PREFS_KEY = 'agent-control-ui-preferences-v1';
export function normalizeUiPrefs(p={}){
  const pick=(v,valid,def)=>valid.includes(v)?v:def;
  return {
    candidateStatus:pick(p.candidateStatus,['all','new','drafted','high'],'all'),
    candidateSort:pick(p.candidateSort,['newest','oldest','score-high','score-low'],'newest'),
    draftStatus:pick(p.draftStatus,['active','pending','scheduled','ready','posted','rejected','all'],'active'),
    draftSort:pick(p.draftSort,['newest','oldest','score-high'],'newest')
  };
}
