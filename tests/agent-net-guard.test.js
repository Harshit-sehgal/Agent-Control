import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {isPrivateAddress, assertPublicUrl, resolvePublicAddress, pinnedRequest} from '../agent/net-guard.mjs';

test('loopback, private, link-local and metadata addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a);
});

test('addresses that tunnel a private IPv4 or sit in reserved ranges are recognised', () => {
  for (const a of [
    '192.0.0.1', '192.0.2.5', '198.51.100.9', '203.0.113.7', '198.18.0.1', '198.19.255.255', '192.88.99.1',
    // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) embed an IPv4 address.
    '2002:7f00:1::', '2002:0a00:1::', '64:ff9b::7f00:1', '64:ff9b::a00:1',
  ]) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['2002:0808:0808::', '64:ff9b::808:808']) assert.equal(isPrivateAddress(a), false, a);
});

test('a check is refused when the host is, or resolves to, a private address', async () => {
  const lookup = async host => ({'public.test': [{address: '93.184.216.34'}], 'inside.test': [{address: '10.0.0.5'}], 'mixed.test': [{address: '93.184.216.34'}, {address: '127.0.0.1'}], 'empty.test': []})[host];
  const opts = {lookup, allowPrivate: false};
  await assertPublicUrl('https://public.test/health', opts);
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:4173/', 'http://[::1]/', 'http://inside.test/', 'http://mixed.test/', 'http://empty.test/']) await assert.rejects(() => assertPublicUrl(url, opts), /private or local network/, url);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd', opts), /Only http/);
  // The device owner can opt in.
  await assertPublicUrl('http://127.0.0.1:4173/', {lookup, allowPrivate: true});
});

test('a pinned request connects to the vetted address and reports redirects', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/away') return res.writeHead(302, {Location: 'http://169.254.169.254/'}).end();
    res.writeHead(200, {'Content-Type': 'text/plain'}).end(`host=${req.headers.host}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const url = `http://rebind.test:${port}/`;
    // The name resolves to the loopback server for the check; a pin means the
    // connection never re-resolves (so a later rebind cannot redirect it).
    const lookup = async () => [{address: '127.0.0.1'}];
    const {address} = await resolvePublicAddress(url, {lookup, allowPrivate: true});
    const res = await pinnedRequest(url, {address, timeoutMs: 5000});
    assert.equal(res.status, 200);
    assert.equal(res.body, `host=rebind.test:${port}`, 'the Host header keeps the real name');
    // A redirect off the host is reported, not chased.
    const away = await pinnedRequest(`http://rebind.test:${port}/away`, {address, timeoutMs: 5000});
    assert.equal(away.status, 302);
  } finally { server.close(); }
});
