/** Refuse to fetch addresses on the device's own network.
 *
 * A dashboard member can queue `http.check` for the agent. Without this, that
 * is a way to probe the router, other machines on the LAN or a cloud metadata
 * service from inside the network. Set AGENT_ALLOW_PRIVATE=1 on the device to
 * allow private addresses on purpose (for example to watch a local service).
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** Expand an IPv6 address to its eight 16-bit hextets (handles `::`). */
function hextets(text) {
  const [head, tail] = text.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  if (!text.includes('::')) return text.split(':');
  const t = tail ? tail.split(':').filter(Boolean) : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}
/** The IPv4 address embedded in a 6to4 (2002::/16) or NAT64 (64:ff9b::/96) host. */
const embeddedV4 = (h, i) => { const v1 = parseInt(h[i], 16) || 0, v2 = parseInt(h[i + 1], 16) || 0; return `${v1 >> 8}.${v1 & 255}.${v2 >> 8}.${v2 & 255}`; };

/** True for loopback, private, link-local, carrier-grade NAT, reserved,
 * documentation, benchmark and unspecified addresses. */
export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
      // 192.0.0.0/24 (IETF), 192.0.2.0/24 and 198.51.100.0/24 and 203.0.113.0/24 (TEST-NET),
      // 192.88.99.0/24 (6to4 relay anycast), 198.18.0.0/15 (benchmarking).
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (kind === 6) {
    const text = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (text === '::' || text === '::1' || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || text.startsWith('::ffff:')) return true;
    // 6to4 and NAT64 tunnel an IPv4 address inside the IPv6 address; without
    // decoding it, a public-looking IPv6 name reaches a private IPv4 one.
    const h = hextets(text);
    if (h.length === 8 && h[0] === '2002') return isPrivateAddress(embeddedV4(h, 1));
    if (h.length === 8 && h[0] === '64' && h[1] === 'ff9b') return isPrivateAddress(embeddedV4(h, 6));
    return false;
  }
  return true; // Not an address at all.
}

/** Resolve a URL's host once and return the single address to connect to,
 * throwing unless every address it resolves to is public. Returning the chosen
 * address (rather than the hostname) lets the caller pin its connection to the
 * exact address that was checked, so a name cannot be rebound to a private one
 * between the check and the connect. */
export async function resolvePublicAddress(url, {lookup = dns.lookup, allowPrivate = process.env.AGENT_ALLOW_PRIVATE === '1'} = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) addresses can be checked.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true});
  // No addresses is treated as a refusal, so a name that resolves to nothing
  // cannot be used to skip the private-address check.
  if (!addresses.length || (!allowPrivate && addresses.some(a => isPrivateAddress(a.address)))) {
    throw new Error(`Refusing to reach ${host}: it is on a private or local network. Set AGENT_ALLOW_PRIVATE=1 on this device to allow that.`);
  }
  return {parsed, host, address: addresses[0].address};
}

/** Resolve `url`'s host and throw unless every address it has is public. */
export async function assertPublicUrl(url, opts = {}) {
  return (await resolvePublicAddress(url, opts)).parsed;
}

/** A one-shot GET pinned to `address` (no redirects). Because the connection is
 * bound to the vetted IP, the Host header and TLS SNI still use the real name,
 * but DNS is never consulted again — there is no rebinding window. */
export function pinnedRequest(url, {address, method = 'GET', headers = {}, timeoutMs = 10000, maxBytes = 200000} = {}) {
  const parsed = new URL(url);
  const mod = parsed.protocol === 'https:' ? https : http;
  const family = net.isIP(address) || 4;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method,
      headers: {...headers, host: parsed.host},
      // Pin the lookup to the address that was checked; the resolver is never
      // consulted a second time. Node may ask for all addresses (happy eyeballs),
      // in which case the answer must be an array.
      lookup: (hostname, options, callback) => (options && options.all)
        ? callback(null, [{address, family}])
        : callback(null, address, family),
      timeout: timeoutMs,
    }, res => {
      let body = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(new Error('Response too large.')); } else body += chunk; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s.`)));
    req.on('error', reject);
    req.end();
  });
}
