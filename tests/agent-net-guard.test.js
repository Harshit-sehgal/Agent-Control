import test from 'node:test';
import assert from 'node:assert/strict';
import {isPrivateAddress, assertPublicUrl} from '../agent/net-guard.mjs';

test('loopback, private, link-local and metadata addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a);
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
