/** HTTP primitives shared by the server and every route module: the error
 * helper, JSON responses with the security headers, bounded body readers and
 * the same-origin check. Nothing here knows about routes or the store. */
import crypto from 'node:crypto';

export function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

export const HSTS_ENABLED = process.env.HSTS === '1' || String(process.env.PUBLIC_ORIGIN || '').startsWith('https://');
export const SECURITY = {'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',...(HSTS_ENABLED?{'Strict-Transport-Security':'max-age=31536000; includeSubDomains'}:{})};

export function send(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers});res.end(JSON.stringify(value));}

export function cookie(req, key) {
  const found = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(key + '='));
  return found?.slice(key.length + 1);
}

/** Compare two secrets without leaking where they differ. */
export function timingEqual(a, b) {
  const h1 = crypto.createHash('sha256').update(String(a)).digest(), h2 = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(h1, h2);
}

/** Reject a browser write that comes from another origin. The capture route is
 * exempt: the extension calls it cross-origin and proves itself with a token. */
export function checkOrigin(req) {
  if (req.url?.split('?')[0] === '/api/capture') return;
  if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return; // Nonbrowser clients still require authenticated session/capture token.
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
export async function jsonBody(req) { return safeJson(await rawBody(req, 128 * 1024)); }
