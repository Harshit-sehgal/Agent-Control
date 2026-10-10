const $=id=>document.getElementById(id),status=message=>{$('msg').textContent=message;};
/** Ask Chrome for origin access to the configured dashboard before fetching it.
 * The bundled host_permissions only cover the default port 4173, but the server
 * accepts any PORT, so a custom port would otherwise fail with an opaque CORS
 * error. The user grants the exact origin in the browser prompt. */
async function ensureOriginAccess(url){
  const origin=`${url.protocol}//${url.host}/*`;
  const granted=await chrome.permissions.contains({origins:[origin]});
  if(granted)return true;
  return chrome.permissions.request({origins:[origin]});
}
(async()=>{const s=await chrome.storage.local.get(['endpoint','token','topic']);for(const name of ['endpoint','token','topic'])if(s[name])$(name).value=s[name];})();
function readSelectedPost(){
  const selection=window.getSelection();const node=selection?.anchorNode;
  const parent=node?.nodeType===1?node:node?.parentElement;
  const tweet=parent?.closest?.('[data-testid="tweet"],article')||document.querySelector('[data-testid="tweet"],article');
  const selected=(selection?.toString()||'').trim();
  const text=(selected||tweet?.querySelector('[data-testid="tweetText"]')?.innerText||tweet?.innerText||'').trim().slice(0,6000);
  const author=tweet?.querySelector('[data-testid="User-Name"]')?.innerText?.split('\n')[0]||tweet?.querySelector('strong')?.innerText||document.title;
  const statusLink=tweet?.querySelector('a[href*="/status/"]')?.getAttribute('href');
  const url=statusLink?new URL(statusLink,location.origin).href:location.href;
  return {text,author:author.slice(0,120),url};
}
$('capture').addEventListener('click',async()=>{
  const endpoint=$('endpoint').value.trim().replace(/\/$/,''),token=$('token').value.trim(),topic=$('topic').value.trim();
  try{
    const url=new URL(endpoint);
    if(url.protocol!=='https:'&&!(['127.0.0.1','localhost'].includes(url.hostname)&&url.protocol==='http:'))throw new Error('Use HTTPS or localhost HTTP.');
    if(!token)throw new Error('Enter capture token from Dashboard → Settings.');
    // The dashboard may run on a port other than the bundled 4173.
    if(!await ensureOriginAccess(url))throw new Error('Permission for this dashboard origin was denied.');
    await chrome.storage.local.set({endpoint,token,topic});
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab found.');
    const data=await chrome.scripting.executeScript({target:{tabId:tab.id},func:readSelectedPost});
    const candidate={...data[0].result,topic};
    if(candidate.text.length<12)throw new Error('Select a post containing at least 12 characters.');
    const res=await fetch(`${endpoint}/api/capture`,{method:'POST',headers:{'Content-Type':'application/json','X-Capture-Token':token},body:JSON.stringify(candidate)});
    const body=await res.json();if(!res.ok)throw new Error(body.error||`HTTP ${res.status}`);
    status(body.duplicate?'This post is already in the queue.':'Captured. Open the dashboard → Discovery to draft a reply.');
  }catch(e){status('Capture failed: '+e.message);}
});
