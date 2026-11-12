/** Where an admin-typed address (an AI provider, an HTTP MCP server, the
 * sign-in addresses an MCP server names) may point, and the connection to it.
 *
 * The server sends a saved key or header there and reads the reply, so the
 * address may name a public host or this machine (a local model or MCP server,
 * which this local-first app documents), never another private-network,
 * link-local or metadata address. Every address the name resolves to is
 * checked. AGENT_ALLOW_PRIVATE=1, the switch the device guard reads, lets a LAN
 * server in.
 *
 * `guardedFetch` resolves the name once, checks it, and connects to that same
 * address (the Host header and TLS name stay the real name), so a name rebound
 * after the check is never consulted again. `assertLocalOrPublic` is the same
 * check alone, for a clear 400 when an address is saved. */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import {Readable} from 'node:stream';
import {fail} from '../shared/errors.js';
import {isPrivateAddress} from '../agent/net-guard.mjs';

/** This machine only: 127.0.0.0/8 and ::1, plus their IPv4-mapped spelling. */
const isLoopback = address => {
  const a = String(address).toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || (net.isIPv4(a) && a.startsWith('127.'));
};
const allowPrivateNow = () => process.env.AGENT_ALLOW_PRIVATE === '1';
const hostOf = url => new URL(url).hostname.replace(/^\[|\]$/g, '');
const refuse = (host, what) => fail(`Refusing ${host}: it is on a private or local network. ${what} may be a public host or this machine (127.0.0.1); set AGENT_ALLOW_PRIVATE=1 to allow a LAN server.`, 400);
const refused = addresses => addresses.some(a => isPrivateAddress(a) && !isLoopback(a));

export async function assertLocalOrPublic(url, {what = 'That address', lookup = dns.lookup} = {}) {
  if (allowPrivateNow()) return;
  const host = hostOf(url);
  let addresses;
  if (net.isIP(host)) addresses = [host];
  // A name that does not resolve is left to fail on the call itself.
  else { try { addresses = (await lookup(host, {all: true})).map(a => a.address); } catch { return; } }
  if (refused(addresses)) refuse(host, what);
}

/** fetch's own failure: a TypeError whose cause names the network error. */
const fetchFailed = cause => Object.assign(new TypeError('fetch failed'), {cause});
const abortError = signal => signal?.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
const NULL_BODY = new Set([101, 204, 205, 304]);
const DECODERS = {gzip: () => zlib.createGunzip(), 'x-gzip': () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress()};

/** A fetch for an admin-typed address, pinned to the address that passed the check. Returns a real `Response`
 * (status, headers, text, json, a streaming body). Redirects are never followed: the caller sees the 3xx. */
export async function guardedFetch(url, init = {}, {what = 'That address', lookup = dns.lookup, allowPrivate = allowPrivateNow()} = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw fetchFailed(new Error('Only http(s) addresses can be reached.'));
  const signal = init.signal;
  if (signal?.aborted) throw abortError(signal);
  const host = hostOf(url);
  let addresses;
  if (net.isIP(host)) addresses = [{address: host, family: net.isIP(host)}];
  else {
    try { addresses = await lookup(host, {all: true}); } catch (error) { throw fetchFailed(error); }
    if (!addresses?.length) throw fetchFailed(Object.assign(new Error(`${host} did not resolve.`), {code: 'ENOTFOUND'}));
  }
  if (!allowPrivate && refused(addresses.map(a => a.address))) refuse(host, what);
  // Every checked address, in the resolver's order: the socket tries each in turn (as fetch does), and no other.
  const checked = addresses.map(a => ({address: a.address, family: net.isIP(a.address) || 4}));

  const headers = Object.fromEntries(new Headers(init.headers || {}));
  let body = init.body ?? null;
  if (body instanceof URLSearchParams) { headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8'; body = body.toString(); }
  if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw new TypeError('guardedFetch sends a string, bytes or URLSearchParams body.');
  if (body != null) headers['content-length'] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    const req = (parsed.protocol === 'https:' ? https : http).request({
      protocol: parsed.protocol, hostname: host, port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`, method: init.method || 'GET', headers,
      ...(net.isIP(host) ? {} : {servername: host}),
      // The resolver is never asked again: every lookup is answered with the checked addresses.
      lookup: (_name, options, callback) => options?.all ? callback(null, checked) : callback(null, checked[0].address, checked[0].family),
      autoSelectFamily: checked.length > 1,
      signal,
    }, res => {
      const out = new Headers();
      for (const [name, value] of Object.entries(res.headers)) for (const one of [].concat(value)) out.append(name, one);
      const decode = DECODERS[String(res.headers['content-encoding'] || '').trim().toLowerCase()];
      let stream = res;
      if (decode) { stream = res.pipe(decode()); res.on('error', error => stream.destroy(error)); out.delete('content-encoding'); out.delete('content-length'); }
      const nullBody = NULL_BODY.has(res.statusCode) || init.method === 'HEAD';
      if (nullBody) res.resume();
      try { resolve(new Response(nullBody ? null : Readable.toWeb(stream), {status: res.statusCode, statusText: res.statusMessage || '', headers: out})); }
      catch (error) { res.destroy(); reject(fetchFailed(error)); }
    });
    req.on('error', error => reject(signal?.aborted ? abortError(signal) : fetchFailed(error)));
    req.end(body ?? undefined);
  });
}
