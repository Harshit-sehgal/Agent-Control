/** Browser accounts: the pure rules (shared/browser-accounts.js) and the owner-only bot setting that names one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ACCOUNTS, ACCOUNT_STATES, cleanAccount, addAccount, updateAccount, removeAccount, sanitizeAccount,
  browserAccountOf, browserDeviceOf, repointDevice, cleanAccountReport,
} from '../shared/browser-accounts.js';
import {BOT_DEFAULTS, ACCOUNT_ID, validateBotSettings} from '../shared/bot-settings.js';
import {BOT_SETTABLE} from '../shared/setup.js';

const A = '0b6f1c2e-4d5a-4b8c-9e1f-2a3b4c5d6e7f', B = '1c7a2d3f-5e6b-4c9d-8f2a-3b4c5d6e7f80';
const state = () => ({groups: [{id: 'home', bots: [{id: 'scout', name: 'Scout', settings: {browserAccount: A, device: 'pc-2'}}, {id: 'atlas', name: 'Atlas', settings: {device: 'pc-2'}}]}], browserAccounts: []});

test('an account is a name, a site and one computer; cookies only; 20 at most', () => {
  const s = state();
  assert.equal(MAX_ACCOUNTS, 20);
  assert.deepEqual(ACCOUNT_STATES, ['signed-in', 'signed-out', 'unknown']);
  const made = addAccount(s, {name: ' Work CRM ', site: 'https://CRM.example.com/login', deviceId: 'pc-1'}, {makeId: () => A});
  assert.deepEqual(made, {id: A, name: 'Work CRM', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'});
  assert.deepEqual(s.browserAccounts, [made], 'it is pushed onto the state');
  assert.throws(() => addAccount(s, {name: 'work crm', site: 'x.com', deviceId: 'pc-1'}, {makeId: () => B}), /^Error: Another account is already called that\.$/);
  assert.throws(() => cleanAccount({name: 'X', site: 'localhost', deviceId: 'pc-1'}), /such as crm\.example\.com/);
  assert.throws(() => cleanAccount({name: 'X', site: 'x.com', deviceId: 'pc-1', storage: 'profile'}), /not available yet\. Use cookies\.$/);
  assert.throws(() => cleanAccount({name: 'X', site: 'x.com'}), /^Error: That computer is not paired/);
  assert.throws(() => cleanAccount({name: '  ', site: 'x.com', deviceId: 'pc-1'}), /^Error: An account needs a name of up to 60 characters\.$/);
  assert.throws(() => cleanAccount({name: 'n'.repeat(61), site: 'x.com', deviceId: 'pc-1'}), /^Error: An account needs a name of up to 60 characters\.$/);
  assert.equal(cleanAccount({name: 'n'.repeat(60), site: 'x.com', deviceId: 'pc-1'}).name.length, 60);
  assert.deepEqual(cleanAccount({name: 'X', site: 'x.com', deviceId: 'pc-1', storage: 'cookies'}).storage, 'cookies');
  // 19 more fill it; the 21st is refused
  for (let i = 0; i < 19; i++) addAccount(s, {name: `Acct ${i}`, site: 'x.com', deviceId: 'pc-1'}, {makeId: () => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`});
  assert.equal(s.browserAccounts.length, 20);
  assert.throws(() => addAccount(s, {name: 'One too many', site: 'x.com', deviceId: 'pc-1'}, {makeId: () => B}), /^Error: At most 20 browser accounts\.$/);
});

test('a site is a hostname with a dot, however the owner pasted it', () => {
  const site = site => cleanAccount({name: 'X', site, deviceId: 'pc-1'}).site;
  assert.equal(site('crm.example.com'), 'crm.example.com');
  assert.equal(site('CRM.Example.com.'), 'crm.example.com');
  assert.equal(site('crm.example.com:8443/app?x=1'), 'crm.example.com');
  assert.equal(site('http://user:pw@crm.example.com/'), 'crm.example.com');
  for (const bad of ['', '   ', 'localhost', 'https://localhost:3000', 'not a host', 7, null, undefined, {}, '[::1]']) {
    assert.throws(() => cleanAccount({name: 'X', site: bad, deviceId: 'pc-1'}), /such as crm\.example\.com/, JSON.stringify(bad));
  }
});

test('an update keeps what it does not name, refuses a clash, and a missing account is 404', () => {
  const s = state();
  addAccount(s, {name: 'Work CRM', site: 'crm.example.com', deviceId: 'pc-1'}, {makeId: () => A});
  addAccount(s, {name: 'Personal', site: 'x.com', deviceId: 'pc-1'}, {makeId: () => B});
  assert.deepEqual(cleanAccount({name: 'Renamed'}, {current: s.browserAccounts[0]}), {name: 'Renamed', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'});
  const kept = updateAccount(s, A, {name: 'work crm'});   // its own name, another case, is not a clash
  assert.equal(kept, s.browserAccounts[0]);
  assert.equal(kept.name, 'work crm');
  assert.throws(() => updateAccount(s, A, {name: 'PERSONAL'}), /^Error: Another account is already called that\.$/);
  assert.equal(s.browserAccounts[0].name, 'work crm', 'a refused update changes nothing');
  assert.equal(updateAccount(s, A, {deviceId: 'pc-3'}).deviceId, 'pc-3');
  assert.equal(s.browserAccounts[0].id, A);
  assert.throws(() => updateAccount(s, 'nope', {name: 'x'}), e => e.status === 404 && e.message === 'Browser account not found.');
  assert.throws(() => removeAccount(s, 'nope'), e => e.status === 404 && e.message === 'Browser account not found.');
});

test("a bot's account and its computer: the account's computer beats the bot's pin, and a gone account is missing", () => {
  const s = state(); s.browserAccounts.push({id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'});
  assert.deepEqual(browserAccountOf(s, 'scout').account.id, A);
  assert.equal(browserAccountOf(s, 'scout').missing, false);
  assert.equal(browserDeviceOf(s, 'scout'), 'pc-1');
  assert.equal(browserDeviceOf(s, 'atlas'), 'pc-2');
  assert.equal(browserDeviceOf(s, 'ghost'), null);
  s.browserAccounts = [];
  assert.deepEqual(browserAccountOf(s, 'scout'), {account: null, missing: true});
  assert.deepEqual(browserAccountOf(s, 'atlas'), {account: null, missing: false});
  assert.deepEqual(browserAccountOf({}, 'scout'), {account: null, missing: false});
});

test('removing an account a bot uses is refused, naming the bot; repoint moves accounts and pins', () => {
  const s = state(); s.browserAccounts.push({id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-2', storage: 'cookies'});
  assert.throws(() => removeAccount(s, A), e => e.status === 409 && /^Bots still sign in as this account: Scout\./.test(e.message));
  s.groups[0].bots.push({id: 'zed', name: 'Zed', settings: {browserAccount: A}});
  assert.throws(() => removeAccount(s, A), e => e.message === 'Bots still sign in as this account: Scout, Zed. Choose another account on their Edit pages first.');
  assert.equal(repointDevice(s, 'pc-2', 'pc-9'), 3);
  assert.equal(s.browserAccounts[0].deviceId, 'pc-9'); assert.equal(s.groups[0].bots[1].settings.device, 'pc-9');
  assert.equal(s.groups[0].bots[0].settings.device, 'pc-9');
  assert.equal(repointDevice(s, 'pc-2', 'pc-9'), 0, 'nothing is left to move');
  s.groups[0].bots.length = 2;
  s.groups[0].bots[0].settings.browserAccount = null;
  assert.equal(removeAccount(s, A).id, A);
  assert.deepEqual(s.browserAccounts, []);
});

test('a backup keeps five fields and drops anything that is not an account', () => {
  const ok = {id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'};
  assert.deepEqual(sanitizeAccount({...ok, cookies: [{value: 'x'}], jar: 'secret'}), ok);
  assert.deepEqual(sanitizeAccount({...ok, storage: undefined}), ok, 'cookies when absent');
  for (const bad of [null, 'x', 7, [], {...ok, id: 'work-crm'}, {...ok, id: A.toUpperCase()}, {...ok, deviceId: undefined}, {...ok, site: 'localhost'}, {...ok, name: ''}, {...ok, storage: 'profile'}]) {
    assert.equal(sanitizeAccount(bad), null, JSON.stringify(bad));
  }
});

test('a device report keeps only its own accounts and four words', () => {
  assert.deepEqual(cleanAccountReport([{id: A, state: 'signed-in', cookies: [{value: 'x'}]}, {id: B, state: 'signed-in'}, {id: A.toUpperCase(), state: 'weird'}], [A]), [{id: A, state: 'signed-in', storage: 'cookies'}]);
  assert.deepEqual(cleanAccountReport('nope', [A]), []);
  assert.deepEqual(cleanAccountReport([{id: A, state: 'weird'}], [A]), [{id: A, state: 'unknown', storage: 'cookies'}]);
  assert.deepEqual(cleanAccountReport([{id: A, state: 'signed-out', lost: true, storage: 'profile'}], new Set([A])), [{id: A, state: 'signed-out', storage: 'cookies', lost: true}]);
  assert.deepEqual(cleanAccountReport([{id: A, state: 'signed-out', lost: 'yes'}], [A]), [{id: A, state: 'signed-out', storage: 'cookies'}], 'lost is only ever true');
  assert.deepEqual(cleanAccountReport([null, 7, 'x', {id: A, state: 'signed-in'}, {id: A, state: 'signed-out'}], [A]), [{id: A, state: 'signed-in', storage: 'cookies'}], 'bad entries and repeats are dropped');
  assert.deepEqual(cleanAccountReport([{id: A, state: 'signed-in'}], undefined), []);
  const many = Array.from({length: 40}, (_, i) => ({id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, state: 'signed-in'}));
  assert.equal(cleanAccountReport(many, many.map(m => m.id)).length, MAX_ACCOUNTS);
});

test('browserAccount is a bot setting no model text can set', () => {
  assert.equal(BOT_DEFAULTS.browserAccount, null);
  assert.equal(ACCOUNT_ID.test(A), true);
  assert.equal(ACCOUNT_ID.test(A.toUpperCase()), false);
  assert.equal(validateBotSettings({browserAccount: A}).browserAccount, A);
  assert.equal(validateBotSettings({browserAccount: ''}, {browserAccount: A}).browserAccount, null);
  assert.equal(validateBotSettings({browserAccount: null}, {browserAccount: A}).browserAccount, null);
  assert.equal(validateBotSettings({style: 'brief'}, {browserAccount: A}).browserAccount, A, 'a form that saves another field keeps it');
  for (const bad of ['work-crm', 7, {}, A + 'x', true, [A]]) assert.throws(() => validateBotSettings({browserAccount: bad}), /^Error: A browser account must be an account's id, or empty for the computer's own browser\.$/);
  assert.equal(BOT_SETTABLE.includes('browserAccount'), false);
});
