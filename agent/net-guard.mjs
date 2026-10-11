/** Refuse to fetch addresses on the device's own network.
 *
 * A dashboard member can queue `http.check` for the agent. Without this, that
 * is a way to probe the router, other machines on the LAN or a cloud metadata
 * service from inside the network. Set AGENT_ALLOW_PRIVATE=1 on the device to
 * allow private addresses on purpose (for example to watch a local service).
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** True for loopback, private, link-local, carrier-grade NAT and unspecified addresses. */
export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (kind === 6) {
    const text = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return isPrivateAddress(mapped[1]);
    return text === '::' || text === '::1' || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || text.startsWith('::ffff:');
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
