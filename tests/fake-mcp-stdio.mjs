// A fake MCP server over stdio: newline-delimited JSON-RPC on stdin and stdout.
// FAKE_MCP_MODE: ok (default) | endless (talks forever) | huge | silent | noisy (logs to stderr, junk lines on stdout).
import readline from 'node:readline';
const mode = process.env.FAKE_MCP_MODE || 'ok';
const tools = [
  {name: 'read_file', description: 'Read a file.', inputSchema: {type: 'object'}, annotations: {readOnlyHint: true}},
  {name: 'write_file', description: 'Write a file.', inputSchema: {type: 'object'}},
];
const out = message => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
if (process.env.FAKE_MCP_SECRET) process.stderr.write(`started with ${process.env.FAKE_MCP_SECRET}\n`);
if (mode === 'endless') setInterval(() => process.stdout.write('{"jsonrpc":"2.0","method":"notifications/message","params":{}}\n'.repeat(200)), 1);
readline.createInterface({input: process.stdin}).on('line', line => {
  if (mode === 'silent' || mode === 'endless') return;
  let message; try { message = JSON.parse(line); } catch { return; }
  if (mode === 'noisy') { process.stdout.write('not json at all\n'); process.stderr.write('warning: noisy\n'); }
  if (message.id === undefined) return;
  if (message.method === 'initialize') return out({id: message.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fake-stdio', version: '1'}}});
  if (message.method === 'tools/list') return out({id: message.id, result: {tools}});
  if (message.method === 'tools/call') {
    if (mode === 'huge') return out({id: message.id, result: {content: [{type: 'text', text: 'z'.repeat(300000)}]}});
    return out({id: message.id, result: {content: [{type: 'text', text: `${message.params.name}(${JSON.stringify(message.params.arguments)}) cwd=${process.cwd() === process.env.EXPECT_CWD ? 'ok' : 'other'} env=${process.env.FAKE_MCP_FLAG || ''}`}]}});
  }
  out({id: message.id, error: {code: -32601, message: 'Method not found'}});
});
