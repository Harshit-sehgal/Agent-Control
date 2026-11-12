/* An HTTP MCP server may be public or on this machine, never another private,
 * link-local or metadata address: the server sends the saved headers there. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mcpList, mcpCall} from '../src/mcp-client.js';

test('an HTTP MCP server on a private network or a metadata address is refused before any request', async () => {
  const before = process.env.AGENT_ALLOW_PRIVATE;
  delete process.env.AGENT_ALLOW_PRIVATE;
  const fetched = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetched.push(String(args[0])); throw new Error('no network in this test'); };
  try {
    for (const url of ['http://169.254.169.254/mcp', 'http://10.0.0.7/mcp', 'http://[fd00::1]/mcp']) {
      await assert.rejects(mcpList({url, headers: {Authorization: 'Bearer secret-token'}}), e => e.status === 400 && /private or local network/.test(e.message), url);
      await assert.rejects(mcpCall({url}, 'tool'), e => e.status === 400, url);
    }
    assert.deepEqual(fetched, [], 'nothing was sent to a refused address');
    // Loopback is a local MCP server: allowed through the guard (it then fails to connect).
    await assert.rejects(mcpList({url: 'http://127.0.0.1:1/mcp'}), e => /Could not reach/.test(e.message));
    assert.equal(fetched.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.AGENT_ALLOW_PRIVATE; else process.env.AGENT_ALLOW_PRIVATE = before;
  }
});
