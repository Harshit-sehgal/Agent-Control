// Global Web Crypto is required throughout: ids and request hashing all use
// it. Node 18 exposes crypto in CommonJS but not as an ESM global, so without this guard the first failure is a bare "crypto is not
// defined" deep inside state setup. Fail early with the actual fix instead.
if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
  throw new Error('Agent Control requires Node.js 22.5+ (global Web Crypto, node:sqlite). Run `nvm use` (see .nvmrc) or install Node 22.');
}
export const uuid = () => crypto.randomUUID();
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export function cleanText(v, max=4000) { return typeof v === 'string' ? v.trim().slice(0,max) : ''; }
export function validHttpUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
export function initialState() {
  return {version:1, createdAt:new Date().toISOString(), settings:{}, groups:[{id:'home', name:'Home', description:'Your bots', bots:[
    {id:'atlas', name:'Atlas', type:'custom', instructions:'You are Atlas, the primary bot. Answer the owner, and hand each piece of work to the bot whose job it is.', settings:{lead:true}}
  ]}], runs:[], tasks:[], events:[]};
}
export function activity(state,type,message,meta={}) {
  state.events.unshift({id:uuid(),at:new Date().toISOString(),type,message,meta});
  state.events=state.events.slice(0,200);
}
/** Content Security Policy for the Node response header, which is the copy that
 * can enforce every directive including frame-ancestors. The static Pages build
 * sends the rest of it in a <meta> tag; see META_CSP below for why the two
 * differ, and tests/security-headers.test.js for the assertion that keeps them
 * in step instead of letting one drift weaker than the other. */
export const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** The same policy for the static Pages build, minus `frame-ancestors`. A CSP
 * delivered in a <meta> element cannot enforce framing directives: browsers
 * ignore them there, so a tag that claimed `frame-ancestors 'none'` would only
 * look like protection. The Node server keeps the full policy in its header,
 * which does enforce it, and also sends `X-Frame-Options: DENY`. */
export const META_CSP=CSP.replace("; frame-ancestors 'none'",'');
