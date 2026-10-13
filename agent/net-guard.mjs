/** Refuse to fetch addresses on the device's own network.
 *
 * A dashboard member can queue `http.check` for the agent. Without this, that
 * is a way to probe the router, other machines on the LAN or a cloud metadata
 * service from inside the network. Set AGENT_ALLOW_PRIVATE=1 on the device to
 * allow private addresses on purpose (for example to watch a local service).
 */
import dns from 'node:dns/promises';
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

/** Resolve `url`'s host and throw unless every address it has is public. */
export async function assertPublicUrl(url, {lookup = dns.lookup, allowPrivate = process.env.AGENT_ALLOW_PRIVATE === '1'} = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) addresses can be checked.');
  if (allowPrivate) return parsed;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{address: host}] : await lookup(host, {all: true});
  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
    throw new Error(`Refusing to reach ${host}: it is on a private or local network. Set AGENT_ALLOW_PRIVATE=1 on this device to allow that.`);
  }
  return parsed;
}
