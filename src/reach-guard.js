/** Where an admin-typed address (an AI provider, an HTTP MCP server) may point.
 *
 * The server sends a saved key or header there and reads the reply, so the
 * address may name a public host or this machine (a local model or MCP server,
 * which this local-first app documents), never another private-network,
 * link-local or metadata address. Every address the name resolves to is
 * checked; a name that does not resolve is left to fail on the call itself.
 * AGENT_ALLOW_PRIVATE=1, the switch the device guard reads, lets a LAN server in.
 *
 * This is a check, not a pinned connection: a name rebound after it passes is
 * not caught here. */
import dns from 'node:dns/promises';
import net from 'node:net';
import {fail} from '../shared/errors.js';
import {isPrivateAddress} from '../agent/net-guard.mjs';

/** This machine only: 127.0.0.0/8 and ::1, plus their IPv4-mapped spelling. */
const isLoopback = address => {
  const a = String(address).toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || (net.isIPv4(a) && a.startsWith('127.'));
};

export async function assertLocalOrPublic(url, {what = 'That address'} = {}) {
  if (process.env.AGENT_ALLOW_PRIVATE === '1') return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else { try { addresses = (await dns.lookup(host, {all: true})).map(a => a.address); } catch { return; } }
  if (addresses.some(a => isPrivateAddress(a) && !isLoopback(a))) {
    fail(`Refusing ${host}: it is on a private or local network. ${what} may be a public host or this machine (127.0.0.1); set AGENT_ALLOW_PRIVATE=1 to allow a LAN server.`, 400);
  }
}
