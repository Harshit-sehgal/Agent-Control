// Found in review: guardedFetch connected to the first checked address only. Node 22 hands addresses back in the
// resolver's order, so a host whose first answer is IPv6 failed on a machine with no IPv6 route (an IPv4-only VM),
// where fetch would have tried the next address. Every checked address is now tried in turn, and only those.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {guardedFetch} from '../src/reach-guard.js';

test('an address that cannot be reached falls through to the next checked one', async t => {
  const server = http.createServer((req, res) => res.end(`ok ${req.headers.host}`));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const {port} = server.address();
  let asked = 0;
  // ::1 has nothing listening on this port (the server is bound to 127.0.0.1 only), so the first try is refused.
  const lookup = async () => { asked++; return [{address: '::1', family: 6}, {address: '127.0.0.1', family: 4}]; };
  const res = await guardedFetch(`http://pin.example:${port}/`, {}, {lookup});
  assert.equal(await res.text(), `ok pin.example:${port}`);
  assert.equal(asked, 1, 'the name is resolved once');
});
