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

/** Eight numeric hextets, or null. Leading zeros, `::`, a dotted IPv4 tail and a
 * zone id (`%eth0`) all name the same address as the compressed form, so the
 * checks below compare numbers rather than the spelling the caller used. */
function ipv6Hextets(text) {
  let body = String(text).toLowerCase();
  const zone = body.indexOf('%');
  if (zone >= 0) body = body.slice(0, zone);
  const dotted = body.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some(n => !Number.isInteger(n) || n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    body = `${body.slice(0, dotted.index)}:${hi}:${lo}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parse = side => (side ? side.split(':').filter(Boolean).map(part => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(n => Number.isNaN(n))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  return [...head, ...(halves.length === 2 ? Array(missing).fill(0) : []), ...tail];
}
const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

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
    const h = ipv6Hextets(address);
    if (!h) return true;
    const [a, b, c, d, e, f, g, i] = h;
    // IPv4-mapped (::ffff:0:0/96), including the expanded and hex spellings.
    // `0:0:0:0:0:ffff:7f00:1` is 127.0.0.1 and the stack will connect to it.
    if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isPrivateAddress(v4From(g, i));
    // IPv4-compatible (::/96). `::10.0.0.1` is 10.0.0.1 written as IPv6.
    if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return isPrivateAddress(v4From(g, i));
    if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local unicast
    if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
    // Every address in ff00::/8 is multicast, including organization and
    // global scopes. HTTP(S) checks must connect to a unicast destination.
    if ((a & 0xff00) === 0xff00) return true;
    // 6to4 (2002::/16) and the well-known NAT64 prefix (64:ff9b::/96) tunnel
    // an IPv4 address. The local-use NAT64 prefix (64:ff9b:1::/48) is never
    // a global address; its IPv4 is not in the last 32 bits, so reading only
    // those bits lets a metadata address through. Teredo (2001::/32) hides
    // the client IPv4 behind an XOR.
    if (a === 0x2002) return isPrivateAddress(v4From(b, c));
    if (a === 0x64 && b === 0xff9b && c === 1) return true;
    if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isPrivateAddress(v4From(g, i));
    if (a === 0x2001 && b === 0) return isPrivateAddress(v4From(g ^ 0xffff, i ^ 0xffff));
    // IANA allocates IPv6 global-unicast space from 2000::/3 (with the
    // translation and tunnel prefixes handled above). Refuse reserved space.
    if ((a & 0xe000) !== 0x2000) return true;
    // 2001::/23 is non-global except for a handful of explicit protocol
    // allocations. Do not let unallocated or special-purpose addresses in
    // that block pass just because they share the global-unicast prefix.
    if (a === 0x2001 && (b & 0xfe00) === 0) {
      const anycast = b === 1 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && i >= 1 && i <= 3;
      const amt = b === 3;
      const as112 = b === 4 && c === 0x112;
      const orchid = (b & 0xfff0) === 0x20 || (b & 0xfff0) === 0x30;
      if (!anycast && !amt && !as112 && !orchid) return true;
    }
    if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation
    if (a === 0x2001 && b === 2 && c === 0) return true; // 2001:2::/48 benchmarking
    if (a === 0x3fff && (b & 0xf000) === 0) return true; // 3fff::/20 documentation
    if (a === 0x5f00) return true; // 5f00::/16 SRv6 SIDs are not globally reachable
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
export function pinnedRequest(url, {address, method = 'GET', headers = {}, body, timeoutMs = 10000, maxBytes = 200000} = {}) {
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
    req.end(body);
  });
}
