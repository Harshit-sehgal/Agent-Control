/** HTTP primitives shared by the server and every route module: the error
 * helper, JSON responses with the security headers, bounded body readers and
 * the same-origin check. Nothing here knows about routes or the store. */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fail} from '../shared/errors.js';

export {fail};

/** A flag an operator writes as `HSTS=true` must not silently turn the header
 * off: the sibling SMTP flag is spelled the same way, and the unsafe outcome is
 * the one that needs no warning to be noticed. Unrecognised values fall through
 * to the PUBLIC_ORIGIN check rather than failing open. */
const on = value => /^(1|true|on|yes)$/i.test(String(value || '').trim());
export const HSTS_ENABLED = on(process.env.HSTS) || String(process.env.PUBLIC_ORIGIN || '').startsWith('https://');
export const SECURITY = {'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',...(HSTS_ENABLED?{'Strict-Transport-Security':'max-age=31536000; includeSubDomains'}:{})};

/** Bodies at least this large are gzipped for a client that accepts it. Below
 * it the header and the CPU cost more than the bytes saved. */
export const GZIP_MIN = 8 * 1024;
export const acceptsGzip = req => /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
/** A JSON answer. A large body travels gzipped when the request (`res.req`,
 * which Node sets on every response) accepts it. A 304 has no body at all. */
export function send(res,status,value,headers={}){
  const req=res.req,head={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers};
  if(status===304){delete head['Content-Type'];res.writeHead(304,head);return res.end();}
  const body=JSON.stringify(value);
  if(req&&body.length>=GZIP_MIN&&acceptsGzip(req)){
    // Compressed on the thread pool: a multi-megabyte snapshot must not hold
    // the event loop. The returned promise settles once the body is sent.
    return new Promise(resolve=>zlib.gzip(body,{level:6},(error,packed)=>{
      if(error){res.writeHead(status,head);res.end(body);}
      else{res.writeHead(status,{...head,'Content-Encoding':'gzip',Vary:'Accept-Encoding'});res.end(packed);}
      resolve();
    }));
  }
  res.writeHead(status,head);res.end(body);
}

export function cookie(req, key) {
  const found = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(key + '='));
  return found?.slice(key.length + 1);
}

/** Compare two secrets without leaking where they differ. */
export function timingEqual(a, b) {
  const h1 = crypto.createHash('sha256').update(String(a)).digest(), h2 = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(h1, h2);
}

/** Reject a browser write that comes from another origin. */
export function checkOrigin(req) {
  if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return; // Nonbrowser clients still require an authenticated session.
  const possible = [`http://${req.headers.host}`, `https://${req.headers.host}`, process.env.PUBLIC_ORIGIN].filter(Boolean);
  if (!possible.includes(origin)) fail('Cross-origin request rejected.', 403);
}

/** Raw bytes of a request body, bounded. The agent protocol signs exactly the
 * bytes it sends, so those routes parse JSON only after the signature check. */
export async function rawBody(req, limit = 64 * 1024) {
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > limit) fail('Request too large.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export function safeJson(raw) { try { return JSON.parse(raw || '{}'); } catch { fail('Invalid JSON.', 400); } }
