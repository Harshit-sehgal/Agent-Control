/* Sign-in limits and reset-token logging on the public routes, driven through
 * the real route handlers with a stub `auth`, so no server or store is needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter, isReply} from '../src/router.js';
import {publicRoutes} from '../src/routes-public.js';

const auth = {
  login: ({password}) => password === 'right'
    ? {ok: true, user: {email: 'owner@localhost'}, role: 'owner', sessionId: 's'}
    : {ok: false, error: 'Wrong email or password.', status: 401},
  logout() {},
  requestPasswordReset: () => 'reset-token-123',
  consumePasswordReset() {},
};

function routes() {
  const router = createRouter();
  publicRoutes(router, {auth, workspaces: {}, version: 't'});
  return (method, path, body, ip = '10.0.0.1') => {
    const found = router.find(method, path);
    return found.route.handler({req: {headers: {}, socket: {remoteAddress: ip}}, path, params: found.params, body: async () => body});
  };
}
const status = async promise => { try { const r = await promise; return isReply(r) ? r.status : 200; } catch (e) { return e.status; } };

function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('wrong guesses from many addresses cannot lock the owner out of the right password', () => withEnv({AUTH_RATE_LIMIT: undefined}, async () => {
  const call = routes();
  // 32 failures spread over 32 addresses fill the account bucket.
  for (let i = 0; i < 32; i++) assert.equal(await status(call('POST', '/api/login', {password: 'wrong'}, `10.1.0.${i}`)), 401);
  // Another wrong guess from a fresh address is now refused outright...
  assert.equal(await status(call('POST', '/api/login', {password: 'wrong'}, '10.2.0.1')), 429);
  // ...but the owner with the right password still gets in.
  assert.equal(await status(call('POST', '/api/login', {password: 'right'}, '10.2.0.2')), 200);
}));

test('a full per-address bucket still refuses even the right password', () => withEnv({AUTH_RATE_LIMIT: undefined}, async () => {
  const call = routes();
  for (let i = 0; i < 8; i++) assert.equal(await status(call('POST', '/api/login', {password: 'wrong'}, '10.3.0.1')), 401);
  assert.equal(await status(call('POST', '/api/login', {password: 'right'}, '10.3.0.1')), 429);
}));

async function printed(env) {
  const lines = [], log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await withEnv({AUTH_RATE_LIMIT: 'off', PUBLIC_ORIGIN: undefined, SMTP_HOST: undefined, RESET_TOKEN_CONSOLE: undefined, ...env}, () => routes()('POST', '/api/auth/forgot', {email: 'owner@localhost'})); }
  finally { console.log = log; }
  return lines.some(line => line.includes('reset-token-123'));
}

test('reset tokens reach the console only on a plain local install, unless asked', async () => {
  assert.equal(await printed({}), true, 'A local install with no mail has no other way to deliver the token.');
  assert.equal(await printed({PUBLIC_ORIGIN: 'https://dash.example.com'}), false, 'A hosted https install keeps tokens out of its logs by default.');
  assert.equal(await printed({SMTP_HOST: 'smtp.example.com'}), false, 'With mail configured the console is not the delivery path.');
  assert.equal(await printed({PUBLIC_ORIGIN: 'http://192.168.1.5:3000'}), true);
  assert.equal(await printed({PUBLIC_ORIGIN: 'https://dash.example.com', RESET_TOKEN_CONSOLE: '1'}), true, 'An operator can still turn it on.');
  assert.equal(await printed({RESET_TOKEN_CONSOLE: '0'}), false);
});
