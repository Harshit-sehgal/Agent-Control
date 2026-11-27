# Phase 2: browser accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan path (once merged):** `docs/superpowers/plans/2026-11-27-phase-2-browser-accounts.md`

**Goal:** Two bots are signed in to two accounts of one site, and each sees its own. Both are still signed in after the device restarts.

**Architecture:**
- **The record.** A **browser account** is a server record `{id, name, site, deviceId, storage}` in kv `browser_accounts`, managed by owner-only routes. A bot names one through the owner-only bot setting `browserAccount`. The pure rules live in a new `shared/browser-accounts.js`: validation, which account a bot uses, and which computer runs its pages (the account's beats the bot's own pin).
- **The device.** In the one shared Chrome, each account gets its own browser context (`Target.createBrowserContext`). Its cookies are saved, encrypted, to `browser-accounts/<id>.jar` next to the agent's config (`agent/account-jars.mjs`). They are restored into a fresh context whenever one is made. Tabs and lanes are keyed by `(account, bot)`. Every step first checks that its tab sits in the payload's account's context.
- **Four hops carry the account.** A model's block never carries it. Dispatch stamps it from the bot record. The device checks it before every step. The live hub routes takeover and input to the account's own computer.
- **Housekeeping on the device.** `sweep(nowMs)` in the shared browser does all of it:
  - it reaps tabs idle for 10 minutes;
  - it saves jars every 10 minutes;
  - it keeps one keeper tab per signed-in account and checks it every 30 minutes;
  - it can quit an idle Chrome.

  The heartbeat reports each account's state and hears which accounts this computer holds.

**Tech Stack:**
- Node ≥ 22, with no npm runtime dependencies;
- `node:crypto` (`hkdfSync`, AES-256-GCM);
- `node --test`, with `tests/fake-cdp.js` standing in for Chrome, and one real-Chrome test that skips with no browser;
- SQLite through `src/sqlite-store.js`;
- the Playwright smoke `tests/usability_smoke.py` (`npm run test:ui`).

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`.
- §5.1 to §5.3 are binding, without the profile fallback or named tabs.
- §15 row "2." is the definition of done.
- §2.2 item 2 is the problem.
- §5.5 "Pins" sets the rule that an account's device beats a bot's.
- §6.1: jars never reach a model.
- §9.4: names only in backups, never jars, signed out after a restore.
- §17: cookie jars are as valuable as passwords.

**Builds on Phase 0, 1 and 1b, all merged in the tree this plan reads:**
- `chooseDevice`, `agentOnline`, `normalizeNeeds` and `missingFeatureLine` in `src/agent.js:45-98`;
- the owner-only `device` pin: `pinnedDevice` and `validateBotSettings` in `shared/bot-settings.js:60-167`, and `assertDevicePin` in `src/routes-groups.js:162-168`;
- `FEATURES`, `neededNow` and `UPDATE_DEVICE_LINE` in `shared/device-features.js`;
- the lane seams Phase 1 left for this phase: `laneOf` (`agent/shared-browser.mjs:54`) and `taskKey` (`agent/task-pool.mjs:18-22`);
- the per-tab `typed` memory and `scrubTyped`;
- `ownRefusal` (`agent/browser.mjs:260`).

## Global Constraints

**Repo rules**
- No npm runtime dependencies. One new `shared/` module, `shared/browser-accounts.js`, which goes in `shared/assets.js`. Any edit to `shared/` is followed by `npm run build:pages`.
- Every task leaves `npm run check`, `npm test` and `npm run build:pages` green, with no drift in `docs/`.
- `build:pages` stamps every file in `docs/` with one content hash. So Tasks 1, 10 and 12, the only ones that touch `shared/`, each sit in a wave with no other `shared/` task.
- **No cookie value leaves the device:**
  - not in a heartbeat, a task result, the live report or a log line;
  - not in the server's store or a backup;
  - never to a model.

  A jar is never read by anything but `agent/account-jars.mjs` and the shared browser.

**The account record** (`shared/browser-accounts.js`)
- `id`: a UUID made by the server (`crypto.randomUUID()` in the route, passed as `makeId`). It is never typed by the owner. The device accepts only `ACCOUNT_ID` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) before it builds any path.
- `name`: 1 to 60 characters after `cleanText`, unique in the workspace, ignoring case.
- `site`: a hostname, lowercased, holding a dot. The owner may paste a URL; its hostname is kept.
- `deviceId`: required. It must be a paired computer of this workspace that has not been revoked.
- `storage`: `'cookies'` (also when absent). `'profile'` is refused.
- At most `MAX_ACCOUNTS = 20` per workspace.
- **There is no `default` record.** A bot with `browserAccount: null` uses the device's persistent profile, as today.

**Sentences** (exact)
- `ACCOUNT_GONE` (409): `This bot's browser account no longer exists. Choose another on the bot's Edit page, or clear it.`
- `ACCOUNT_ON_SERVER` (409): `This bot signs in as a browser account, which lives on a computer, and this install opens pages only on the server (BROWSER_RUNTIME=server). Set BROWSER_RUNTIME=auto, or clear the bot's account on its Edit page.`
- `ACCOUNT_NOT_PINNED` (409): `This bot's browser account is on a computer that is not available. Pair it again, or move the account to another computer in Settings → Local agents.`
- `ACCOUNT_TAKEOVER` (409): `This bot signs in as a browser account, which lives on its computer. Take over from the bot's Computer view instead.`
- Bot setting shape: `A browser account must be an account's id, or empty for the computer's own browser.`
- Non-owner (403): `Only the owner can choose which browser account a bot signs in as.`
- Unknown account (400): `That browser account does not exist. Choose one in Settings → Local agents, or use the computer's own browser.`
- Route refusals:
  - `At most 20 browser accounts.`
  - `An account needs a name of up to 60 characters.`
  - `Another account is already called that.`
  - `An account needs the site it signs in to, such as crm.example.com.`
  - `That computer is not paired. Choose one in Settings → Local agents.`
  - `An account with its own browser is not available yet. Use cookies.`
  - in use (409): `Bots still sign in as this account: ${names}. Choose another account on their Edit pages first.`
- Device refusals:
  - `This task is for another computer, so it was not run.`
  - `This task names a browser account this device cannot use.`
  - `This tab is not in the bot's browser account, so the step was not run.`
- Demo (409): `The demo has no computer to keep browser accounts on. Run the full app with the local agent to use them.`

**The device feature**
- `BROWSER_ACCOUNTS_V1 = 'browser-accounts-v1'`: `{since: '2026-11-27', use: 'needed', what: 'keep separate browser accounts'}`.
- Every piece of account work needs it: dispatch, and live takeover, input and watch. An older device app would ignore `account` and act in the default profile, which is the wrong account.

**Jars** (`agent/account-jars.mjs`)
- **Where.** `browserAccountsDir(env, configPath)` is `AGENT_BROWSER_ACCOUNTS`, else `browser-accounts/` beside the config. The folder is 0700, and an existing looser one is tightened, as in `ensureProfileDir`. Each file is 0600.
- **How each file is written.** It is written to `<id>.jar.tmp`, fsynced, then renamed.
- **The file.** It is JSON `{v: 1, salt, iv, tag, data}`, base64:
  - the key is `hkdfSync('sha256', secret, salt, 'agent-control browser-account jar v1', 32)`, with a fresh 16-byte salt per write;
  - AES-256-GCM, with AAD `account:${id}`, so a jar copied to another name never decrypts;
  - `data` is the JSON array of cookies.
- **A jar that will not decrypt** is removed, and its account reads `signed-out`.
- **What a jar holds.** It holds every cookie of the account's context, in the fields `Storage.setCookies` accepts (`cookieParams`, Task 6).

**Timings** (the shared browser's `sweep`)
- `REAP_MS = 600000`: a bot tab untouched for 10 minutes is closed after its jar is saved.
- `SAVE_MS = 600000`: each live account context is saved at least every 10 minutes. It is also saved after every task that touched it.
- `KEEPER_MS = 1800000`: each keeper is checked every 30 minutes.
- `QUIT_IDLE_MS = 1800000`, only with `AGENT_BROWSER_QUIT_IDLE=1`.
- `agent/agent.mjs` calls `sweep()` every `SWEEP_MS = 60000`.

**Account states**
- **The device reports** `accounts: [{id, state, storage: 'cookies', lost?}]` on each heartbeat, where `state` is `'signed-in' | 'signed-out' | 'unknown'`.
- **The server keeps it.** It stores kv `agent_accounts:<agentId>`, keeping only entries for accounts whose `deviceId` is the reporting device. Every field is cleaned to those four.
- **No report reads `signed-out`.** That covers a new account and a restored one.
- **The heartbeat answer** carries `accounts: [{id, site}]`: the accounts whose `deviceId` is this device.

## Calls

Each is a choice the spec leaves open, with the reason.

1. Call: **Account ids are server UUIDs, not owner slugs.** A jar's file name can then never be a path, and never collides across workspaces or re-pairs.
2. Call: **Every account names one computer** (`deviceId` is required). Its jar lives on one machine, and two jars of one account would drift apart.
3. Call: **No `default` record.** `browserAccount: null` is today's persistent profile, so an existing bot changes nothing.
4. Call: **A bot whose account record is gone is refused** (`ACCOUNT_GONE`) and never falls back to the default profile. The default profile is somebody else's sign-in.
5. Call: **Deleting an account a bot still names is refused**, and the refusal names the bots. That is the same reason as Call 4.
6. Call: **A new needed feature, `browser-accounts-v1`,** is required for all account work, including live takeover and input. An older app would ignore `account`.
7. Call: **The account's computer governs browser work only.** `model.run` and device MCP keep the bot's own `device` pin. An account is a cookie space, not a CLI sign-in.
8. Call: **A re-pair that proves the old secret moves the computer's accounts and pins to the new id;** otherwise every pin points at a dead row and the next heartbeat wipes the jars. The pair body carries `previous: {agentId, proof}`, where `proof` is HMAC-SHA256(old secret, `re-pair\n<code>`).
   - On a match in the same workspace, the server moves accounts and bot `device` pins to the new device and revokes the old row.
   - A missing or wrong proof pairs a new computer with nothing moved.
   - The device re-encrypts its jars under the new secret before it saves the new config.
9. Call: **The device wipes a jar only on an explicit list.** That is a heartbeat answer whose `accounts` array omits the account. A beat with no `accounts` field (an older server, an error) wipes nothing. Moving an account to another computer wipes it from the old one.
10. Call: **An account with no report reads `signed-out`,** and a restore drops every `agent_accounts:*` key. That follows §9.4's "shown signed out until a keeper reports".
11. Call: **Schema v15 is a migration that converts nothing.** `migrate()` refuses a database from a newer build. That stops a downgraded build from running account bots on the default profile.
12. Call: **Accounts are managed in Settings → Local agents, with no `SNAPSHOT_KEYS` entry,** because they sit under the computers they live on and members need only a name.
    - Accounts sit under the computers they live on.
    - Owner pages fetch the owner-only route.
    - A member's Computer view gets only the account's name, through `liveStates`.
13. Call: **The live hub keeps one space per device.** A bot with an account or a pin is served only by its computer. An unpinned bot keeps "the device that polled last", so one-device behaviour is unchanged.
14. Call: **At most 20 accounts.** Each context costs about 45 MB ([measured], §5.1).
15. Call: **A context with no tab and no keeper is closed** after its jar is saved. It comes back from the jar on the next task.
16. Call: **With `AGENT_BROWSER_QUIT_IDLE=1`, keeper checks pause while Chrome is quit.** Waking Chrome every 30 minutes would undo the quit. The last state reported stands.
17. Call: **The keeper looks at `https://<site>/`,** and only when the allowlist allows that host. Otherwise the state stays `unknown`.
18. Call: **`lost: true`** means the first keeper check after restoring a non-empty jar found a sign-in page. The account row says the site keeps its sign-in outside cookies. Switching to a profile is deferred with the profile fallback (§15).
19. Call: **No new health-watch check.** A keeper's signed-out finding becomes a card in Phase 3 (§6.3). An account's computer going quiet is already the `agent-offline` alert.

## Review Focus

1. **The wrong account through a fallback to the default profile.** This happens when a bot's account record is gone (a restore, a deletion), when an older device app has no `browser-accounts-v1`, or when the device's plain-read fallback swaps a signed-in page for a cookieless read. Expected: each is refused before anything opens, or is never replaced. Nothing runs in the default profile. Task 4 pins the first two, and Task 9 pins the third (`plainFallback` in `tests/plain-fallback.test.js`).
2. **A stale context after Chrome restarts.** The browser died, and a tab or context id from the old process is still in a map. Expected: both maps are cleared with the session, each context comes back from its jar, and a tab whose context is not the account's current one never serves a step. Task 7 pins this.
3. **A re-pair loses the jars.** Expected: after `pair` and the first heartbeat, every jar is still there and decrypts under the new secret. The server has moved the accounts to the new device id and revoked the old one. Tasks 3 and 9 pin this.
4. **A cookie value leaves the device.** A planted cookie marker must be absent from every one of these:
   - `accountStates()`, `status()` and the task result;
   - every console line;
   - the jar file's bytes.

   The server must also store nothing but `{id, state, storage, lost, checkedAt}` from a report that carries extra fields. Tasks 8 and 3 pin this.
5. **Two computers, and a takeover lands on the wrong one.** Expected: the takeover, input and watch of a bot whose account or pin names computer B are queued for B even when A polled last. The answer for an unpinned bot is unchanged. Task 11 pins this.

---

## Order and parallel work

| Wave | Tasks (each set touches disjoint files) | Waits for |
|---|---|---|
| A | 1, 5, 6 | nothing (1: `shared/` and `docs/`; 5: `agent/account-jars.mjs`, with its own `JAR_ID` copy of the id pattern so it needs nothing from 1; 6: `agent/browser.mjs`, `tests/fake-cdp.js`) |
| B | 2, 7 | 2 waits for 1. 7 waits for 1, 5 and 6 (`ACCOUNT_ID`, jars, contexts). |
| C | 3, 4, 10 | 3 and 4 wait for 2 (the kv key, the routes). 10 is the only `shared/` task in the wave. |
| D | 8, 11 | 8 waits for 7 and 10 (`signinPage`). 11 waits for 4 and 7 (`browserDeviceOf`, the `account` arguments). 8 touches `agent/shared-browser.mjs`, and 11 does not. |
| E | 9, 12 | 9 waits for 3 and 8 (`agent/agent.mjs`). 12 waits for 3 and 11, and is the only `shared/` task in the wave. |
| F | 13 | all |

---

### Task 1: The pure rules, the bot setting and the feature name

**Files:**
- Create: `shared/browser-accounts.js` (browser-safe, no imports beyond `shared/`).
- Modify: `shared/bot-settings.js`:
  - add `browserAccount: null` to `BOT_DEFAULTS` (`:31-64`), with a comment saying only the owner sets it;
  - export `ACCOUNT_ID`;
  - validate the setting in `validateBotSettings` beside `device` (`:149-152`).
- Modify: `shared/device-features.js`. Add `BROWSER_ACCOUNTS_V1` and its `FEATURES` entry.
- Modify: `shared/assets.js`. Add `'browser-accounts.js'` beside `'bot-settings.js'`.
- Regenerate: `docs/`.
- Test: `tests/browser-accounts.test.js` (new). Extend `tests/device-features.test.js` and `tests/bot-device-pin.test.js:63-67` (the "no model text" test).

**Interfaces:**
- From `shared/bot-settings.js`:
  - produces `ACCOUNT_ID`;
  - `browserAccount` is `null`, `''` (read as `null`) or a match of `ACCOUNT_ID`. Anything else fails with the shape sentence.
  - `browserAccount` never enters `BOT_SETTABLE` (`shared/setup.js:48`) or `buildCreatedBot`.
- From `shared/browser-accounts.js`:
  - `MAX_ACCOUNTS = 20`, `ACCOUNT_STATES = ['signed-in', 'signed-out', 'unknown']`.
  - `cleanAccount(body, {current = null} = {}) → {name, site, deviceId, storage}`. It validates by the rules in Global Constraints. With `current`, a missing field keeps its value. It does not check that the device exists (the route does).
  - `addAccount(state, body, {makeId}) → record`. It enforces the cap and unique names, and pushes onto `state.browserAccounts`.
  - `updateAccount(state, id, body) → record`. An unknown id is 404 `Browser account not found.`
  - `removeAccount(state, id) → record`. It returns 409 with the in-use sentence when any bot's `browserAccount` is `id`, naming the bots by `name` in group order.
  - `sanitizeAccount(raw) → record | null`, for backups. It keeps the five fields, and anything that fails `cleanAccount`, or has a bad id, is `null`.
  - `browserAccountOf(state, botId) → {account: record | null, missing: boolean}`. `missing` is true when the bot names an id with no record.
  - `browserDeviceOf(state, botId) → string | null`. That is the account's `deviceId`, else `pinnedDevice(state, botId)`.
  - `repointDevice(state, fromId, toId) → number`. It moves every account's `deviceId` and every bot's `settings.device` from `fromId` to `toId`, and returns how many it moved.
  - `cleanAccountReport(list, allowedIds) → [{id, state, storage: 'cookies', lost?: true}]`. It keeps only entries whose `id` is in `allowedIds`, at most `MAX_ACCOUNTS`. A `state` outside `ACCOUNT_STATES` becomes `'unknown'`, and every other field is dropped. Not a list gives `[]`.
- From `shared/device-features.js`: `BROWSER_ACCOUNTS_V1`. `DEVICE_FEATURES` now lists it.

- [ ] **Step 1: Write the failing tests.**

```js
const A = '0b6f1c2e-4d5a-4b8c-9e1f-2a3b4c5d6e7f', B = '1c7a2d3f-5e6b-4c9d-8f2a-3b4c5d6e7f80';
const state = () => ({groups: [{id: 'home', bots: [{id: 'scout', name: 'Scout', settings: {browserAccount: A, device: 'pc-2'}}, {id: 'atlas', name: 'Atlas', settings: {device: 'pc-2'}}]}], browserAccounts: []});
test('an account is a name, a site and one computer; cookies only; 20 at most', () => {
  const s = state();
  const made = addAccount(s, {name: ' Work CRM ', site: 'https://CRM.example.com/login', deviceId: 'pc-1'}, {makeId: () => A});
  assert.deepEqual(made, {id: A, name: 'Work CRM', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'});
  assert.throws(() => addAccount(s, {name: 'work crm', site: 'x.com', deviceId: 'pc-1'}, {makeId: () => B}), /^Error: Another account is already called that\.$/);
  assert.throws(() => cleanAccount({name: 'X', site: 'localhost', deviceId: 'pc-1'}), /such as crm\.example\.com/);
  assert.throws(() => cleanAccount({name: 'X', site: 'x.com', deviceId: 'pc-1', storage: 'profile'}), /not available yet\. Use cookies\.$/);
  assert.throws(() => cleanAccount({name: 'X', site: 'x.com'}), /^Error: That computer is not paired/);
  // 19 more fill it; the 21st: /^Error: At most 20 browser accounts\.$/
});
test('a bot\'s account and its computer: the account\'s computer beats the bot\'s pin, and a gone account is missing', () => {
  const s = state(); s.browserAccounts.push({id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'});
  assert.deepEqual(browserAccountOf(s, 'scout').account.id, A);
  assert.equal(browserDeviceOf(s, 'scout'), 'pc-1');
  assert.equal(browserDeviceOf(s, 'atlas'), 'pc-2');
  s.browserAccounts = [];
  assert.deepEqual(browserAccountOf(s, 'scout'), {account: null, missing: true});
  assert.deepEqual(browserAccountOf(s, 'atlas'), {account: null, missing: false});
});
test('removing an account a bot uses is refused, naming the bot; repoint moves accounts and pins', () => {
  const s = state(); s.browserAccounts.push({id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-2', storage: 'cookies'});
  assert.throws(() => removeAccount(s, A), e => e.status === 409 && /^Bots still sign in as this account: Scout\./.test(e.message));
  assert.equal(repointDevice(s, 'pc-2', 'pc-9'), 3);
  assert.equal(s.browserAccounts[0].deviceId, 'pc-9'); assert.equal(s.groups[0].bots[1].settings.device, 'pc-9');
});
test('a device report keeps only its own accounts and four words', () => {
  assert.deepEqual(cleanAccountReport([{id: A, state: 'signed-in', cookies: [{value: 'x'}]}, {id: B, state: 'signed-in'}, {id: A.toUpperCase(), state: 'weird'}], [A]), [{id: A, state: 'signed-in', storage: 'cookies'}]);
  assert.deepEqual(cleanAccountReport('nope', [A]), []);
});
test('browserAccount is a bot setting no model text can set', () => {
  assert.equal(BOT_DEFAULTS.browserAccount, null);
  assert.equal(validateBotSettings({browserAccount: A}).browserAccount, A);
  assert.equal(validateBotSettings({browserAccount: ''}, {browserAccount: A}).browserAccount, null);
  for (const bad of ['work-crm', 7, {}, A + 'x']) assert.throws(() => validateBotSettings({browserAccount: bad}), /^Error: A browser account must be an account's id, or empty for the computer's own browser\.$/);
  assert.equal(BOT_SETTABLE.includes('browserAccount'), false);
});
```

Also extend `tests/bot-device-pin.test.js:66-67`. A `buildCreatedBot` given `settings: {browserAccount: A}` has no `browserAccount`. In `tests/device-features.test.js`, `neededNow(BROWSER_ACCOUNTS_V1)` is `true`.

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-accounts.test.js tests/bot-device-pin.test.js tests/device-features.test.js`. Expected: FAIL, because the module does not exist.
- [ ] **Step 3: Implement.** Import `ACCOUNT_ID`, `botSettings` and `pinnedDevice` from `shared/bot-settings.js`; that file imports nothing from the new module, so no cycle forms. Read the site through `hostOf` from `shared/bot-browser.js`.
- [ ] **Step 4: Run the tests, the build and the suite.** Run `node --test tests/browser-accounts.test.js tests/bot-device-pin.test.js tests/device-features.test.js tests/assets.test.js && npm run build:pages && npm test`. Expected: PASS, with no drift.
- [ ] **Step 5: Commit.** `git add shared/browser-accounts.js shared/bot-settings.js shared/device-features.js shared/assets.js docs tests/browser-accounts.test.js tests/bot-device-pin.test.js tests/device-features.test.js && git commit -m "feat: browser account rules, the owner-only bot setting and the browser-accounts-v1 feature"`

---

### Task 2: The store, schema v15, the owner-only routes and the bot's account check

**Files:**
- Modify: `src/sqlite-store.js`:
  - add `browserAccounts` to `readCollections` beside `watches` (`:616`), read from kv `browser_accounts` with `[]` as the default;
  - add `kv('browser_accounts', …)` beside `:723`;
  - add `{to: 15, up() {}}` after `:446`, with a comment that says why it exists (Call 11).
- Create: `src/routes-browser-accounts.js`. It exports `browserAccountRoutes(router)`.
- Modify: `src/app.js`. Import and register it after `liveRoutes` (`:138`).
- Modify: `src/routes-groups.js`. Add `assertAccountPin(c, settings)` beside `assertDevicePin` (`:162`), and call it in the two bot routes (`:172`, `:175`).
- Modify: `tests/route-roles.test.js`. Import the new module beside `:51`, and add the four routes to `LEAST_ROLE` as `'owner'`.
- Test: `tests/browser-account-routes.test.js` (new). The harness copies `tests/bot-device-pin.test.js:40-46`.

**Interfaces:**
- Consumes `addAccount`, `updateAccount`, `removeAccount`, `cleanAccount` and `ACCOUNT_ID` from Task 1.
- The routes, every one `'owner'`:
  - `GET /api/browser-accounts` → `{accounts: [{...record, state: 'signed-out', lost: false, checkedAt: null}]}`. Task 3 fills in `state`.
  - `POST /api/browser-accounts` → 201 with the record, made with `makeId: () => crypto.randomUUID()`.
  - `PATCH /api/browser-accounts/:id` → the record.
  - `DELETE /api/browser-accounts/:id` → `{ok: true}`.
- Before writing, POST and PATCH check that a `deviceId` names a computer of this workspace that has not been revoked: `c.store.get('SELECT id FROM agents WHERE id=? AND workspace_id=? AND revoked_at IS NULL', id, c.actor.workspaceId)`, else 400 `That computer is not paired. Choose one in Settings → Local agents.`
- `assertAccountPin(c, settings)`:
  - It does nothing without an own `browserAccount` key.
  - A non-owner gets 403 with the non-owner sentence.
  - A non-empty id that is not in `c.store.read().browserAccounts` gets 400 with the unknown-account sentence.

- [ ] **Step 1: Write the failing tests.**

```js
test('only the owner lists, adds, renames, moves and deletes accounts', async t => {
  const {owner, member, pcId} = await rig(t);
  assert.equal((await owner('POST', '/api/browser-accounts', {name: 'CRM', site: 'crm.example.com', deviceId: pcId})).status, 201);
  assert.equal((await member('GET', '/api/browser-accounts')).status, 403);
  const [acct] = (await owner('GET', '/api/browser-accounts')).body.accounts;
  assert.match(acct.id, ACCOUNT_ID); assert.equal(acct.state, 'signed-out');
  assert.equal((await owner('POST', '/api/browser-accounts', {name: 'X', site: 'x.com', deviceId: 'nope'})).status, 400);
  assert.equal((await owner('PATCH', `/api/browser-accounts/${acct.id}`, {name: 'Sales CRM'})).body.name, 'Sales CRM');
});
test('a bot\'s account is the owner\'s to set, must exist, and an account in use cannot be deleted', async t => {
  // member PATCH bot settings {browserAccount: id} → 403 /^Only the owner can choose which browser account/
  // owner PATCH {browserAccount: <unknown uuid>} → 400 /That browser account does not exist/
  // owner PATCH {browserAccount: id} → 200; DELETE /api/browser-accounts/:id → 409 /Bots still sign in as this account: Atlas\./
  // owner PATCH {browserAccount: null} → 200; DELETE → 200; renaming the bot by a member keeps nothing else changed
});
test('accounts survive a restart, and the schema is v15', async t => {
  // add one, close and reopen the SqliteStore → read().browserAccounts has it; SCHEMA_DB_VERSION === 15
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-account-routes.test.js tests/route-roles.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Model the route module on `src/routes-workflow.js:117-122`, the watches routes.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-account-routes.test.js tests/route-roles.test.js tests/sqlite-store.test.js tests/architecture.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: owner-only browser account routes, stored in kv, with schema v15"` (explicit paths).

---

### Task 3: Heartbeat state, the device's list, re-pair, and backups

**Files:**
- Modify: `src/agent.js`:
  - add `recordAccountReports` and `readAccountReports` beside `recordAgentFeatures` (`:448-457`);
  - `redeemPairing` (`:233-258`) takes `previous` and returns `replaces`.
- Modify: `src/routes-public.js`:
  - the pair route (`:186-197`) passes `previous: b.previous`; on `replaces` it runs `store.update(s => repointDevice(s, replaces, result.agentId))` and then `agent.revokeAgent(store, replaces)`, and strips `replaces` from the reply;
  - the heartbeat (`:199-233`) records `beat.accounts` and answers with `accounts`.
- Modify: `src/routes-browser-accounts.js`. GET fills in `state`, `lost` and `checkedAt` from `readAccountReports(c.store, record.deviceId)`.
- Modify: `src/backup.js`:
  - add `'browser_accounts'` to `OWNER_SETTINGS` (`:66`);
  - add a `checkOwnerSettings` branch that maps through `sanitizeAccount`, keeps at most `MAX_ACCOUNTS` and drops repeated ids;
  - `importBackup` deletes `kv` keys `LIKE 'agent_accounts:%'` beside `:360`.
- Test: `tests/browser-account-heartbeat.test.js` (new). The harness copies `tests/agent-heartbeat-stopping.test.js:16-40`. Extend `tests/backup-carries.test.js`.

**Interfaces:**
- Produces `recordAccountReports(store, agentId, reported)`:
  - It runs `cleanAccountReport(reported, ids)`, where `ids` are the ids of `store.read().browserAccounts` whose `deviceId === agentId`.
  - It writes kv `agent_accounts:<agentId>` as that list, each entry with `checkedAt: now`.
  - A `reported` that is not an array writes nothing, so an older app leaves the last report.
- Produces `readAccountReports(store, agentId) → [{id, state, storage, lost?, checkedAt}]`. Unreadable is `[]`.
- Produces `redeemPairing(store, {…, previous}) → {…, replaces: string | null}`:
  - `replaces` is the old id only when every one of these holds:
    - `previous.agentId` names a row of the code's workspace that is not revoked;
    - `previous.proof` is a hex string;
    - it equals `HMAC-SHA256(oldSecret, 're-pair\n' + code)`, compared with `timingSafeEqual`.
  - Anything else is `null`, and the pairing goes ahead as a new computer.
- The heartbeat answer gains `accounts: [{id, site}]`. That is every account whose `deviceId` is this device, read after the beat's own writes.

- [ ] **Step 1: Write the failing tests.**

```js
test('a heartbeat records its own accounts\' states, never a cookie, and hears the accounts it holds', async t => {
  const {store, beat, deviceId} = await harness(t);
  await store.update(s => { s.browserAccounts = [acct(A, deviceId), acct(B, 'other-pc')]; });
  const reply = await beat({accounts: [{id: A, state: 'signed-in', cookies: [{name: 'sid', value: 'MARKER-COOKIE'}]}, {id: B, state: 'signed-in'}]});
  assert.deepEqual(reply.accounts, [{id: A, site: 'crm.example.com'}]);
  const kept = store.kvGet(`agent_accounts:${deviceId}`);
  assert.doesNotMatch(kept, /MARKER-COOKIE|cookies/);
  assert.deepEqual(agent.readAccountReports(store, deviceId).map(r => [r.id, r.state]), [[A, 'signed-in']]);
  await beat({});                                        // an older app: no field
  assert.equal(agent.readAccountReports(store, deviceId).length, 1, 'the last report stands');
});
test('a re-pair that proves the old secret moves the accounts and pins, and revokes the old computer', async t => {
  // pair device D1 (secret s1); account A on D1; bot atlas pinned to D1
  // new code c2; pair with previous {agentId: D1, proof: hmac(s1, 're-pair\n' + c2)} → D2
  // read().browserAccounts[0].deviceId === D2; atlas device === D2; D1 revoked_at set
  // first heartbeat from D2 answers accounts [{id: A, …}]
});
test('a wrong proof, or an old computer in another workspace, pairs a new computer and moves nothing', async t => { /* … */ });
test('a backup carries account names, never a report, and a restore reads every account signed out', async t => {
  // export: owner_settings has browser_accounts with the five fields; no agent_accounts key anywhere in the JSON
  // a backup row with an extra `jar` field or a bad id restores without it
  // after importBackup the GET route reads state 'signed-out' for every account
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-account-heartbeat.test.js tests/backup-carries.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** The proof check decrypts the old row's `secret_enc` the way `verifyAgentRequest` does (`:200-202`).
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-account-heartbeat.test.js tests/backup-carries.test.js tests/backup-restore.test.js tests/agent.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: devices report account states and hear their accounts; a proven re-pair keeps them; backups carry names only"`

---

### Task 4: Dispatch stamps the account, and nothing runs in the wrong place

**Files:**
- Modify: `src/bot-browser.js`:
  - `dispatchBrowserRequest` (`:45-120`) reads `browserAccountOf` and `browserDeviceOf`;
  - the payload at `:87` gains `account` and `deviceId`;
  - the claim at `:64-72` stamps `live.account` and `live.accountName`;
  - `beginTakeover` (`:230-241`) refuses an account bot.
- Test: `tests/browser-account-dispatch.test.js` (new). The harness copies `tests/device-pin-browser.test.js`. The block assertion (step 1) lives in this new file too, because Task 10 extends `tests/bot-browser.test.js` in the same wave.

**Interfaces:**
- Consumes `browserAccountOf` and `browserDeviceOf` (Task 1) and `BROWSER_ACCOUNTS_V1`.
- Dispatch order:
  1. `missing` → 409 `ACCOUNT_GONE`, before anything is claimed.
  2. With an account and `runtime.mode === 'server'` → 409 `ACCOUNT_ON_SERVER`.
  3. `pin = browserDeviceOf(state, botId)`. `here` is false whenever there is an account or a pin.
  4. The needs are `account ? [...needs, BROWSER_ACCOUNTS_V1] : needs`.
  5. With an account, `not-pinned` answers `ACCOUNT_NOT_PINNED`. The other reasons keep today's answers.
  6. The payload is `{url, steps, botId, account: account.id, deviceId: agentId}` with an account. Without one it is `{url, steps, botId}`, byte for byte as today.
- `beginTakeover` with an account gives 409 `ACCOUNT_TAKEOVER`. That check comes before the pin check at `:239`.

- [ ] **Step 1: Write the failing tests.**

```js
test('a model\'s block cannot name an account: it never reaches the request or the payload', () => {
  const v = validateBrowserRequest({url: 'https://crm.example.com/', account: 'someone-else', deviceId: 'x'});
  assert.equal(Object.hasOwn(v, 'account'), false); assert.equal(Object.hasOwn(v, 'deviceId'), false);
});
test('an account bot\'s page goes to the account\'s computer with the account stamped, even over the bot\'s own pin', async t => {
  // accounts: A on pc-1; bot pinned to pc-2 with browserAccount A; both computers report browser-accounts-v1
  // dispatch → agent_tasks row on pc-1; payload {url, steps, botId, account: A, deviceId: pc-1}; request.account === A
});
test('the wrong account is never the fallback', async t => {
  // the bot names an account with no record → 409 ACCOUNT_GONE, request still pending, no agent_tasks row
  // pc-1 reports no features (an older app) → 409 missingFeatureLine('browser-accounts-v1'), no row
  // BROWSER_RUNTIME=server with a browser → 409 ACCOUNT_ON_SERVER; auto with a server browser → still the device, never runHere
  // pc-1 revoked → 409 ACCOUNT_NOT_PINNED
});
test('a server-runtime takeover of an account bot is refused; a bot with no account is unchanged', async t => {
  // beginTakeover → 409 ACCOUNT_TAKEOVER; an unpinned bot with no account still runs here, payload has no account key
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-account-dispatch.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-account-dispatch.test.js tests/device-pin-browser.test.js && npm test`. Expected: PASS. The device-pin tests must pass unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat: a browser request carries its bot's account to that account's computer, and never runs elsewhere"`

---

### Task 5: Encrypted jars on the device

**Files:**
- Create: `agent/account-jars.mjs`.
- Test: `tests/account-jars.test.js` (new).

**Interfaces:**
- Produces `browserAccountsDir(env = process.env, configPath) → string`.
- Produces `createJarStore({dir, secret}) → jars`:
  - `jars.save(id, cookies)` writes atomically, as in Global Constraints;
  - `jars.load(id) → cookie[] | null`. A missing file is `null`. A file that does not decrypt is removed, and the answer is `null`;
  - `jars.wipe(id)`;
  - `jars.ids() → string[]`, the valid ids of the `*.jar` files;
  - `jars.retain(ids) → string[]` wipes every jar whose id is not in `ids` and returns the wiped ids. Not an array wipes nothing and returns `[]`.
  - Every method throws `This task names a browser account this device cannot use.` for an id that fails `JAR_ID`, before any path is built. `JAR_ID` is a local copy of the `ACCOUNT_ID` pattern, so this task runs beside Task 1 with no import; Task 13's docs name both.
- Produces `rekeyJars({dir, oldSecret, newSecret}) → {kept: string[], wiped: string[]}`. It decrypts each jar under the old key and writes it under the new one. A jar that fails is wiped.
- Produces `rePairProof(secret, code) → string`, the hex HMAC-SHA256 of `re-pair\n${code}`. Task 3 checks the same formula on the server. Task 3 tests it against this function, imported from `agent/`.

- [ ] **Step 1: Write the failing tests.**

```js
test('a jar is encrypted, private to this user, and tied to its account', async t => {
  const dir = await tmp(t); fs.mkdirSync(dir, {mode: 0o755}); fs.chmodSync(dir, 0o755);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [{name: 'sid', value: 'MARKER-COOKIE', domain: 'crm.example.com', path: '/', httpOnly: true}]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'a looser folder is tightened');
  assert.equal(fs.statSync(path.join(dir, `${A}.jar`)).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'), /MARKER-COOKIE|sid/);
  assert.equal(jars.load(A)[0].value, 'MARKER-COOKIE');
  fs.copyFileSync(path.join(dir, `${A}.jar`), path.join(dir, `${B}.jar`));
  assert.equal(jars.load(B), null, 'a copied jar does not open as another account'); assert.equal(fs.existsSync(path.join(dir, `${B}.jar`)), false);
  assert.equal(createJarStore({dir, secret: 'other'}).load(A), null);
});
test('ids are checked before any path is built', () => {
  for (const bad of ['../x', 'work-crm', `${A}/..`, '']) assert.throws(() => createJarStore({dir: '/nowhere', secret: 's'}).load(bad), /cannot use\.$/);
});
test('retain wipes only what an explicit list leaves out', async t => {
  // save A and B; retain(undefined) → [] and both stay; retain([A]) → [B] and only A stays
});
test('a re-pair re-encrypts every jar under the new secret; one that will not open is wiped', async t => {
  // save A under s1; write garbage as B.jar; rekeyJars({dir, oldSecret: 's1', newSecret: 's2'}) → {kept: [A], wiped: [B]}
  // createJarStore({dir, secret: 's2'}).load(A) has the cookie; under s1 it is null
  assert.match(rePairProof('s1', 'CODE'), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/account-jars.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `fs.openSync(tmp, 'w', 0o600)`, `fchmodSync`, `fsyncSync` and `renameSync`, as `saveConfig` does (`agent/agent.mjs:63-73`).
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/account-jars.test.js tests/check-coverage.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: encrypted, per-account cookie jars on the device"`

---

### Task 6: Browser contexts and cookies in the browser session, and in the fake CDP

**Files:**
- Modify: `agent/browser.mjs`:
  - add `cookieParams`;
  - `newTab` (`:663-687`) takes `browserContextId`;
  - the session (`:692`) gains `createContext`, `disposeContext`, `getCookies` and `setCookies`;
  - `liveTargets` (`:689`) keeps Chrome's `browserContextId`.
- Modify: `tests/fake-cdp.js`. Model contexts and cookies:
  - `Target.createBrowserContext` returns `{browserContextId: 'C<n>'}`;
  - `Target.createTarget` keeps `browserContextId`, and `Target.getTargets` reports it;
  - `Target.disposeBrowserContext` removes the context and its targets;
  - `Storage.getCookies` and `Storage.setCookies` work per context;
  - a `pages[url]` value may be a function `({cookies}) => shown`, so a page can read signed in or out;
  - the test handle gains `setCookie(contextId, cookie)` and `contexts()`.
- Test: `tests/browser-contexts.test.js` (new).

**Interfaces:**
- Produces `export function cookieParams(cookies) → object[]`. It keeps `name, value, domain, path, secure, httpOnly, sameSite, expires, priority, sourceScheme, sourcePort, partitionKey`, drops `expires` when it is `-1` or missing (a session cookie), and drops entries without a string `name` and `value`.
- The session's new methods:
  - `createContext() → browserContextId`;
  - `disposeContext(id)`;
  - `getCookies(id) → cookie[]`;
  - `setCookies(id, cookies)`, which sends `cookieParams(cookies)`.
- `newTab({allow, viewport, browserContextId = null})` creates the target in that context, and the tab records `browserContextId` (`null` for the default context).
- Existing `tests/shared-browser*.test.js` and `tests/agent-parallel.test.js` pass unchanged: a fake with no contexts behaves as today.

- [ ] **Step 1: Write the failing tests.**

```js
test('a tab in a context sees only that context\'s cookies, and cookies move between contexts whole', async () => {
  const fake = fakeCdp({pages: {'https://crm.example.com/': ({cookies}) => ({title: cookies.some(c => c.name === 'who') ? 'Signed in' : 'Sign in', text: '…'})}});
  const session = await startBrowserSession({connection: fake.connection});
  const a = await session.createContext(), b = await session.createContext();
  fake.setCookie(a, {name: 'who', value: 'alice', domain: 'crm.example.com', path: '/', httpOnly: true, expires: -1, size: 8, session: true});
  const tabB = await session.newTab({allow: ['crm.example.com'], browserContextId: b});
  assert.equal(tabB.browserContextId, b);
  assert.equal((await session.capture('https://crm.example.com/', {allow: ['crm.example.com'], tab: tabB})).title, 'Sign in');
  await session.setCookies(b, await session.getCookies(a));
  assert.equal((await session.capture('https://crm.example.com/', {allow: ['crm.example.com'], tab: tabB})).title, 'Signed in');
  assert.deepEqual(Object.keys(cookieParams([{name: 'who', value: 'a', expires: -1, size: 8, session: true}])[0]).sort(), ['name', 'value']);
  assert.equal((await session.liveTargets()).find(t => t.targetId === tabB.targetId).browserContextId, b);
});
```

Use whatever `startBrowserSession` already takes to accept a ready connection. If it takes none, add a `connection` option used only by tests, as `fakeCdp` is used in `tests/shared-browser.test.js`.

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-contexts.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-contexts.test.js tests/shared-browser.test.js tests/shared-browser-takeover.test.js tests/agent-parallel.test.js tests/agent-browser.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: browser contexts and cookie transfer in the device's browser session"`

---

### Task 7: The shared browser keeps a context per account

**Files:**
- Modify: `agent/shared-browser.mjs`:
  - `createSharedBrowser` (`:56`) takes `jars`;
  - `laneOf` (`:54`) becomes `tabKey(account, botId)`;
  - add `contextFor` and `checkContext`;
  - `tabFor` (`:93-104`) becomes single-flight per key and takes the account's context;
  - `ensure` and `forget` (`:73-90`) clear the context map with the session;
  - `run`, `takeover`, `handback`, `applyInput`, `watch`, `status` and `scrub` take the account;
  - after a task that touched an account, its jar is saved;
  - `runBrowserTask` (`:317-335`) reads and checks `payload.account` and `payload.deviceId`.
- Modify: `agent/task-pool.mjs`. `taskKey` (`:18-22`) keys browser tasks by `tab:${payload.account || ''}:${payload.botId || 'shared'}`.
- Test: `tests/shared-browser-accounts.test.js` (new). Extend `tests/agent-task-pool.test.js`.

**Interfaces:**
- Consumes `createJarStore` (Task 5, or a test double with the same methods), the session methods from Task 6, and `ACCOUNT_ID` (Task 1).
- `tabKey(account, botId) → string`, exported, is `${account || ''}\u0000${botId}`.
- `createSharedBrowser({…, jars = null})`. An account task on a browser with no `jars` is refused with `This task names a browser account this device cannot use.`
- `contextFor(live, account) → {id, restored: boolean}`. It is single-flight per account:
  - it creates the context;
  - it then runs `setCookies(id, jars.load(account) || [])`;
  - `restored` is true when the jar held any cookie.
- `checkContext(account, tab)` throws `This tab is not in the bot's browser account, so the step was not run.` when `tab.browserContextId !== (account ? contexts.get(account)?.id : null) ?? null`. It is called before the first navigation and inside `gate` before each step.
- The shared browser's methods with the account:
  - `run(botId, {url, steps, approved, account = null})`;
  - `takeover(botId, account = null)` and `watch(botId, account = null)`;
  - `scrub(botId, value, account = null)`;
  - `handback(botId)`, `applyInput(botId, event)` and `owner() → botId` stay as they are. They act on the tab being driven, now held as `{botId, account}`;
  - `status() → [{botId, account, state, url, title}]`, with `account: null` for the default profile.
- `runBrowserTask(task, {shared, allow, env, agentId = null})`:
  - with `agentId`, a payload `deviceId` that is not `agentId` throws `This task is for another computer, so it was not run.`;
  - a present `account` that fails `ACCOUNT_ID` throws `This task names a browser account this device cannot use.`

- [ ] **Step 1: Write the failing tests.** Use `fakeCdp`, and `memJars()`, a `Map`-backed double that counts `save` calls.

```js
test('two bots on two accounts of one site each see their own sign-in, side by side', async () => {
  // A's jar holds who=alice, B's who=bob; page reads `who` from its context's cookies
  // run('scout', {url, account: A}) and run('writer', {url, account: B}) at once → 'alice' and 'bob'
  // two contexts were created; the default-profile bot's tab has browserContextId null and reads 'signed out'
  // each account's jar was saved once after its task
});
test('a stale context after the browser died is never used: the tab and context come back from the jar', async () => {
  // run scout on A; fake.die(); next run on A creates a new context (calls Target.createBrowserContext again),
  // restores A's cookies into it, and the tab used has the new browserContextId
  // a tab whose browserContextId is not the account's current one: checkContext throws the sentence and no Page.navigate is sent
});
test('a takeover and the bot\'s own first task open one tab, not two', async () => {
  // takeover('scout', A) and run('scout', {account: A}) started together → one Target.createTarget for that key
});
test('the device refuses a task for another computer or an account id it cannot use', async () => {
  await assert.rejects(runBrowserTask({kind: 'browser.capture', payload: {url, botId: 'scout', account: A, deviceId: 'pc-2'}}, {shared, allow, agentId: 'pc-1'}), /^Error: This task is for another computer, so it was not run\.$/);
  await assert.rejects(runBrowserTask({kind: 'browser.capture', payload: {url, botId: 'scout', account: '../x'}}, {shared, allow}), /cannot use\.$/);
});
test('one bot on two accounts gets two lanes; one account and one bot one lane', () => {
  assert.notEqual(taskKey({kind: 'browser.capture', payload: {botId: 'scout', account: A}}), taskKey({kind: 'browser.capture', payload: {botId: 'scout'}}));
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/shared-browser-accounts.test.js tests/agent-task-pool.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The typed-secret memory stays per tab, so it is now per `(account, bot)`.
  - Keep the takeover rules of `tests/shared-browser-takeover.test.js` exactly. The order ask → tag → remember → insert must not change.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/shared-browser-accounts.test.js tests/shared-browser.test.js tests/shared-browser-takeover.test.js tests/agent-parallel.test.js tests/agent-task-pool.test.js && npm test`. Expected: PASS. Every Phase 0 and Phase 1 test passes unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat: one browser context per account in the shared browser, checked before every step"`

---

### Task 8: Reaper, saves, keepers, account states and the idle quit

**Files:**
- Modify: `agent/shared-browser.mjs`. Add `setAccounts`, `accountStates` and `sweep`, the constants in Global Constraints, a `usedAt` per tab, and the state update after a task on the account's own site.
- Test: `tests/shared-browser-keepers.test.js` (new).

**Interfaces:**
- Consumes `signinPage` from Task 10 and the jars and contexts from Task 7.
- `createSharedBrowser({…, quitIdle = false})`.
- `setAccounts(list)`. The list is `[{id, site}]` from the heartbeat answer, and not an array does nothing. For each account the browser holds (a context, tabs or a jar) that is not on the list, it closes the tabs, disposes the context and runs `jars.wipe(id)`.
- `accountStates() → [{id, state, storage: 'cookies', lost?: true}]`, one per listed account:
  - `'signed-out'` with no jar and no context;
  - `'unknown'` until a check;
  - otherwise the last keeper or task finding.
- `sweep(nowMs = Date.now()) → Promise`. In order:
  1. **Reap.** Each bot tab with `usedAt + REAP_MS ≤ nowMs` is closed after its account's jar is saved, unless it is driven, its lane is holding, or it is being watched. A keeper is never reaped.
  2. **Save.** Each account context not saved in `SAVE_MS` is saved.
  3. **Close.** A context with no tab and no keeper is disposed after it is saved.
  4. **Keep.** Each listed account whose state is `'signed-in'`, or which has a jar and is `'unknown'`, has a keeper tab under `tabKey(id, KEEPER)`, where `KEEPER = '\u0000keeper'`. When `checkedAt + KEEPER_MS ≤ nowMs` it reads `https://<site>/` on the keeper's own lane:
     - `signinPage(result)` sets `'signed-out'` and closes the keeper;
     - anything else sets `'signed-in'`;
     - the first check after a `restored` context that finds a sign-in page sets `lost: true`;
     - no keeper runs while the session is quit, or for a host the allowlist refuses.
  5. **Quit.** With `quitIdle`, when nothing has run, been driven or been watched for `QUIT_IDLE_MS`, every jar is saved and the session closed.
- After `run` on an account, a result on the account's site sets the state: `signinPage(result)` gives `'signed-out'`, and anything else on that site gives `'signed-in'`.

- [ ] **Step 1: Write the failing tests.** Drive time through `sweep(now + …)`. Use no real timers.

```js
test('a tab idle for ten minutes is closed after its cookies are saved; a driven, busy or watched one is not', async () => { /* … */ });
test('a signed-in account keeps one keeper, checked every 30 minutes; a sign-in page marks it signed out', async () => {
  // page '/' of crm.example.com reads signed in → accountStates [{id: A, state: 'signed-in', storage: 'cookies'}]
  // the site now shows a visible password field → sweep(+30 min) → 'signed-out', keeper closed
});
test('an account dropped from the list loses its tabs, its context and its jar; no list changes nothing', async () => {
  // setAccounts([{id: A}, {id: B}]) then setAccounts([{id: A}]) → jars.ids() === [A]; setAccounts(undefined) → unchanged
});
test('a restored jar that does not sign the site in is marked lost', async () => { /* … lost: true */ });
test('with the idle quit, a quiet browser saves every jar and closes; keepers wait until it starts again', async () => { /* … */ });
test('a planted cookie value leaves the device nowhere', async t => {
  const lines = []; t.mock.method(console, 'error', (...a) => lines.push(a.join(' '))); t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  // the page sets cookie sid=MARKER-COOKIE-7f3 in account A; run, sweep(+11 min), takeover/handback
  const out = JSON.stringify([result, shared.accountStates(), shared.status(), lines]);
  assert.doesNotMatch(out, /MARKER-COOKIE-7f3/i);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'), /MARKER-COOKIE-7f3/i);
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/shared-browser-keepers.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/shared-browser-keepers.test.js tests/shared-browser-accounts.test.js tests/shared-browser-takeover.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: idle tabs closed, jars saved on a timer, a keeper per signed-in account, and an optional idle quit"`

---

### Task 9: The device process: jars, the heartbeat, the sweep and re-pair

**Files:**
- Modify: `agent/agent.mjs`:
  - `shared()` (`:149-150`) passes `jars` and `quitIdle: process.env.AGENT_BROWSER_QUIT_IDLE === '1'`;
  - `run()` creates `jars = createJarStore({dir: browserAccountsDir(process.env, CONFIG), secret: config.secret})`;
  - the heartbeat body (`:296`) gains `accounts: sharedBrowser ? sharedBrowser.accountStates() : jars.ids().map(id => ({id, state: 'unknown', storage: 'cookies'}))`;
  - after the beat, `if (Array.isArray(beat.accounts)) { jars.retain(beat.accounts.map(a => a.id)); sharedBrowser?.setAccounts(beat.accounts); }`;
  - a `setInterval(() => sharedBrowser?.sweep().catch(…), SWEEP_MS).unref()`, cleared in the `finally`;
  - both `runBrowserTask` calls (`:176`, `:188`) pass `agentId: config.agentId`;
  - the plain-read fallback (`:180-183`) goes through `plainFallback(task, seen)` and is skipped when `task.payload?.account` is set;
  - `pair` (`:116-140`) sends `previous` and re-encrypts the jars before it saves.
- Modify: the header comment (`:1-28`), to describe accounts.
- Modify: `agent/page-fetch.mjs` (it already exports `turnedAway` and `preferRead`, which `agent/agent.mjs:44` imports). Add `plainFallback`. `agent/agent.mjs` has top-level await and cannot be imported by a test, so the decision moves here.
- Test: `tests/plain-fallback.test.js` (new).
- Test: `tests/agent-accounts-e2e.test.js` (new). It spawns the real server and agent as `tests/live-browser-e2e.test.js:15-30` does, with no browser. Extend `tests/check-coverage.test.js` only if it needs it.

**Interfaces:**
- Consumes `createJarStore`, `rekeyJars`, `rePairProof` and `browserAccountsDir` (Task 5), and `setAccounts`, `accountStates` and `sweep` (Task 8).
- **`pair`.**
  - When the existing config is readable and has the same `server`, the body gains `previous: {agentId: old.agentId, proof: rePairProof(old.secret, code)}`.
  - After a 2xx carrying a credential, it calls `rekeyJars({dir, oldSecret: old.secret, newSecret: value.secret})` and prints `Kept ${kept.length} browser account(s); ${wiped.length} need signing in again.` when either count is not zero. Then it calls `saveConfig`.
  - With no old config, it wipes any jars in the folder: they cannot be read.
- **The fallback.** Produces `plainFallback(task, seen) → boolean`: false when `task.payload?.account` is set or the task has steps; otherwise today's rule (`turnedAway(seen)` or under 300 characters of text). A capture with an account never goes to `readPlain`. Its page is the browser's own.

- [ ] **Step 1: Write the failing tests.**

```js
test('a re-pair keeps every jar: the first heartbeat after it wipes nothing, and each still opens', {timeout: 60000}, async t => {
  // server up; owner pairs device (code1) → agent `pair`; owner adds account A on that device (POST /api/browser-accounts)
  // write A.jar with createJarStore({dir, secret: config1.secret}) and an orphan O.jar for an account the server never had
  // owner makes code2; agent `pair --code code2` (same server) → config2
  // createJarStore({dir, secret: config2.secret}).load(A) has the cookie; GET /api/browser-accounts shows A on config2.agentId; the old device is revoked
  // agent `run` with AGENT_POLL_MS=2000 until one heartbeat lands, then SIGTERM
  // A.jar is still there and opens under config2.secret; O.jar is gone (the server's list omits it)
});
test('a device whose server sends no account list wipes nothing', {timeout: 60000}, async t => {
  // a stub control plane answering /api/agent/heartbeat with {ok: true, tasks: []} (no accounts); after one beat both jars remain
});
```

```js
// tests/plain-fallback.test.js
test('a signed-in account page is never swapped for a cookieless plain read', () => {
  const short = {text: 'Hi', finalUrl: 'https://crm.example.com/'};
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://crm.example.com/', botId: 'scout', account: A}}, short), false);
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://crm.example.com/', botId: 'scout'}}, short), true, 'no account: today\'s rule');
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://x.com/', botId: 'scout', steps: [{click: 1}]}}, short), false);
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/plain-fallback.test.js tests/agent-accounts-e2e.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/plain-fallback.test.js tests/agent-accounts-e2e.test.js tests/live-browser-e2e.test.js tests/agent-parallel.test.js tests/page-fetch.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: the device keeps its account jars across restarts and re-pairs, reports their state and runs the sweep"`

---

### Task 10: Wider sign-in detection

**Files:**
- Modify: `shared/bot-browser.js`. Add `signinPage` beside `signinSite` (`:272`), and use it in `capturePageText` (`:296`).
- Regenerate: `docs/`.
- Test: extend `tests/bot-browser.test.js`.

**Interfaces:**
- Produces `signinPage(result) → string | null`:
  - it returns `signinSite(result.finalUrl || result.url)` when that is not null;
  - else, when `result.elements` holds an `{tag: 'input', type: 'password'}` (the snapshot lists only visible elements), the lowercased hostname of the page;
  - else `null`.
- `capturePageText` uses `signinPage(r)` where it used `signinSite(r.finalUrl)`. The sentence it writes is unchanged.

- [ ] **Step 1: Write the failing test.**

```js
test('a page with a visible password field is a sign-in page, wherever it lives', () => {
  assert.equal(signinPage({finalUrl: 'https://crm.example.com/home', elements: [{index: 1, tag: 'input', type: 'password', text: 'password field'}]}), 'crm.example.com');
  assert.equal(signinPage({finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com/'}), 'mail.google.com');
  assert.equal(signinPage({finalUrl: 'https://crm.example.com/home', elements: [{tag: 'input', type: 'text'}]}), null);
  assert.match(capturePageText({finalUrl: 'https://crm.example.com/home', text: 'Welcome', elements: [{index: 1, tag: 'input', type: 'password', text: 'password field'}]}), /^This is a sign-in page: the owner is not signed in to crm\.example\.com/);
});
```

- [ ] **Step 2: Run it and see it fail.** Run `node --test tests/bot-browser.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, the build and the suite.** Run `node --test tests/bot-browser.test.js && npm run build:pages && npm test`. Expected: PASS, with no drift.
- [ ] **Step 5: Commit.** `git commit -m "feat: a page with a visible password field counts as a sign-in page"`

---

### Task 11: The live hub serves each computer on its own line

**Files:**
- Modify: `src/browser-live.js`:
  - spaces are keyed by workspace and device (`space`, `:40-47`);
  - `agentSync`, `view`, `takeover`, `handback`, `input`, `taskQueued`, `isDriving`, `agentLive`, `agentId` and `tab` (`:88-176`) take the device;
  - command entries carry `account`;
  - the answer carries `watchAccount`;
  - `liveStates` (`:221-236`) names each bot's account.
- Modify: `src/routes-live.js`:
  - resolve the bot's device with `browserDeviceOf`;
  - `featuresOf` (`:56-59`) reads that device's features;
  - takeover, input and handback (`:68-90`) pass `{agentId, account}`;
  - an account bot's device must report `browser-accounts-v1`.
- Modify: `agent/live-channel.mjs`. `handle` (`:43-48`) and `apply` (`:18-28`) pass `command.account` and `reply.watchAccount`, and the report's `tabs` (`:60`) carry `account`.
- Test: `tests/browser-live-devices.test.js` (new). `tests/browser-live.test.js`, `tests/browser-live-state.test.js` and `tests/live-browser-agent.test.js` pass unchanged.

**Interfaces:**
- Consumes `browserAccountOf` and `browserDeviceOf` (Task 1), and the shared browser's `takeover(botId, account)` and `watch(botId, account)` (Task 7).
- **Hub methods.** Each takes an optional device id last:
  - `agentSync(ws, agentId, report)`;
  - `view(ws, botId, {after, agentId = null})`;
  - `takeover(ws, botId, {agentId = null, account = null} = {})`, and the same for `handback` and `input`;
  - `taskQueued(ws, agentId)`;
  - `agentLive(ws, agentId = null)`, `agentId(ws, agentId = null)` and `tab(ws, botId, {agentId = null, account = null} = {})`.
- **Which device.** `agentId = null` means the device of the workspace that polled last, which is today's rule. A named device that has no space is "not there" (`alive` false).
- `isDriving(ws, botId)` is true on any of the workspace's devices.
- A device's report `tabs` entries are `{botId, account, url, title}`. The hub keys them by `${account || ''}|${botId}`.
- `liveStates` entries gain `account: {id, name} | null`. Their `live` and `url` come from the bot's own device.
- The takeover and input routes refuse 409 with `missingFeatureLine(BROWSER_ACCOUNTS_V1)` for an account bot whose device lacks the feature. That happens before anything is queued.

- [ ] **Step 1: Write the failing tests.**

```js
test('with two computers, an account bot\'s takeover, input and watch go to the account\'s computer, not the last poller', async () => {
  const hub = createLiveHub({waitMs: 50});
  const fromB = hub.agentSync('ws', 'pc-b', {});           // B parks first
  const fromA = hub.agentSync('ws', 'pc-a', {});           // A polled last
  hub.takeover('ws', 'scout', {agentId: 'pc-b', account: A});
  assert.deepEqual((await fromB).commands, [{type: 'takeover', botId: 'scout', account: A}]);
  assert.deepEqual((await fromA).commands, []);
  hub.view('ws', 'scout', {agentId: 'pc-b'});
  const next = await hub.agentSync('ws', 'pc-b', {});
  assert.equal(next.watch, 'scout'); assert.equal(next.watchAccount, A);
});
test('an unpinned bot with one computer behaves exactly as before', async () => { /* hub.takeover('ws', 'atlas') reaches the only poller */ });
test('the routes resolve the bot\'s computer, refuse an older app, and name the account', async t => {
  // routes harness: account A on pc-b; pc-b reports no features → POST takeover 409 /browser-accounts-v1/; nothing queued
  // with the feature → queued on pc-b; GET /api/browser-live has scout with account {id: A, name: 'CRM'}
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-live-devices.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** `hub.holdsSecrets(ws, agentId)` keeps its signature, and is asked with the device that drains the commands, as today.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-live-devices.test.js tests/browser-live.test.js tests/browser-live-state.test.js tests/live-browser-agent.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix: the live view serves each computer on its own line, so a takeover lands on the bot's own computer"`

---

### Task 12: Browser accounts on screen

**Files:**
- Modify: `shared/ui-profile-model.js`:
  - add `accountRows` and `accountOptions` beside `deviceOptions` (`:244`);
  - handle `browserAccount` in `editChanges` (`:237`).
- Modify: `shared/ui-admin.js`:
  - `agentsPanel` (`:189-195`) and `adminPage('agents')` (`:603-609`) add a "Browser accounts" group. The owner gets it; for anyone else, a 403 on `/api/browser-accounts` leaves it out;
  - add the actions `account-add` (form `#account-form`: Name, Site, Computer), `account-rename`, `account-move` and `account-delete` to `adminActions`.
- Modify: `shared/ui-profile.js`. Add a "Signs in as" row on Edit, beside the Runs on slot (`:312`, `:320-333`). It is drawn only for the owner, and only when the list has an account.
- Modify: `shared/ui-computer-view.js`. The session header (`paintSession`, `:192-240`) shows `Signs in as ${account.name}` when the entry has an account.
- Modify: `shared/local-api.js`, beside `:277`. Add `/api/browser-accounts`: GET is `{accounts: [], demo: true}`, and POST, PATCH and DELETE are 409 with the demo sentence.
- Regenerate: `docs/`.
- Test:
  - `tests/ui-profile-model.test.js`: add the view models.
  - `tests/usability_smoke.py`: add the scenarios `local_agents_page_adds_a_browser_account` and `edit_page_sets_a_bots_browser_account`. The `AdminServer` stub answers `/api/browser-accounts`.

**Interfaces:**
- Consumes the routes (Tasks 2 and 3) and `liveStates`' `account` (Task 11).
- `accountRows(accounts, agents) → [{id, name, site, computer, word, tone, note}]`:
  - `word` and `tone`:
    - `signed-in` → `Signed in`, `good`;
    - `signed-out` → `Not signed in`, `warn`;
    - `unknown` → `Not checked yet`, `warn`.
  - `note`, by case:
    - an account whose `deviceId` is not a live agent → `Its computer is not paired. Move it to another.`;
    - a `lost` account → `This site keeps its sign-in outside cookies, so sign in again after the computer restarts.`;
    - otherwise `''`.
- `accountOptions(accounts, current) → [{id, label, selected}]`:
  - first `{id: '', label: 'The computer\'s own browser'}`;
  - then each account as `${name} · ${site}`;
  - a `current` with no record shows last, as `An account that no longer exists`;
  - none at all when there is no account and no `current`.
- The group's hint: `Each account is its own cookie space on one computer: bots on different accounts never see each other's sign-ins. Its cookies stay on that computer, encrypted, and are never in a backup. To sign in, open a bot that uses it, take over its Computer view and sign in there.`

- [ ] **Step 1: Write the failing tests.**

```js
test('account rows say whether each is signed in, and when its computer or its storage needs you', () => {
  const rows = accountRows([{id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-1', state: 'signed-in'}, {id: B, name: 'Mail', site: 'mail.example.com', deviceId: 'gone', state: 'signed-out', lost: true}], [{id: 'pc-1', name: 'Laptop', status: 'online'}]);
  assert.deepEqual(rows.map(r => [r.word, r.computer, r.note]), [['Signed in', 'Laptop', ''], ['Not signed in', '', 'Its computer is not paired. Move it to another.']]);
  assert.deepEqual(accountOptions([{id: A, name: 'CRM', site: 'crm.example.com'}], 'f'.repeat(8) + A.slice(8)).map(o => o.label), ["The computer's own browser", 'CRM · crm.example.com', 'An account that no longer exists']);
  assert.deepEqual(accountOptions([], null), []);
});
```

The smokes:
- the owner adds an account from Local agents, and `server.sent('POST', '/api/browser-accounts') == [{'name': 'CRM', 'site': 'crm.example.com', 'deviceId': …}]` and the row reads `Not signed in`;
- on a bot's Edit page the owner picks it, and the bot PATCH carries `settings.browserAccount`;
- a member's Edit page has no `browserAccount` field.

- [ ] **Step 2: Run them and see them fail.** Run `node --test tests/ui-profile-model.test.js && npm run build:pages && npm run test:ui`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** `ui-profile-model.js` stays pure.
- [ ] **Step 4: Run the build and the tests.** Run `npm run build:pages && npm test && npm run test:ui`. Expected: PASS, with no drift. The existing Local agents and Edit scenarios pass unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat: browser accounts in Settings → Local agents, on a bot's Edit page and in the Computer view"`

---

### Task 13: Done when you can see it, docs and the tick

**Files:**
- Test: `tests/browser-accounts-chrome.test.js` (new). It uses real Chrome and is `{skip: !findBrowser() && 'no browser installed', timeout: 90000}`.
- Modify: `AGENTS.md`. In the Security section, add a "Browser accounts" bullet:
  - the record and the owner-only routes;
  - `browserAccount`, owner-only and never from a model;
  - a context per account;
  - the jars (where, how encrypted, never off the device, wiped by the server's list);
  - the four hops;
  - `browser-accounts-v1`;
  - never in the server runtime;
  - the sweep;
  - the proven re-pair.

  In the `shared/` bullet, name `browser-accounts.js` as pure.
- Modify: `docs/AGENT-PROTOCOL.md`, which is hand-written:
  - §1, pairing, gains `previous`;
  - §3, the heartbeat, gains `accounts` both ways;
  - §3b, the shared browser (`:66-100`, `:123-125`), gains contexts per account, the jars, keepers and `AGENT_BROWSER_QUIT_IDLE`;
  - the live commands carry `account` and `watchAccount`.
- Modify: `docs/DEPLOYMENT.md:269-311`, the browser-profile section:
  - the `browser-accounts/` folder and `AGENT_BROWSER_ACCOUNTS`;
  - it is never in a backup, and copying it to another machine does not work;
  - wiping one account means deleting it in Settings;
  - `AGENT_BROWSER_QUIT_IDLE=1`.
- Modify: `SECURITY.md:169`. Jars are as valuable as passwords. Say where they are, how they are encrypted and what the key does not protect (§5.1, §17).
- Modify: `docs/BUILD-PLAN.md:239`. Tick Phase AA step 2 and add `(plan: docs/superpowers/plans/2026-11-27-phase-2-browser-accounts.md)`.

**Interfaces:**
- Consumes everything above.
- The test drives the pieces in-process:
  - `createSharedBrowser({start: opts => startBrowserSession({...opts, permit: (host, address) => address === '127.0.0.1'}), allow: ['127.0.0.1'], profile: tmpProfile, jars: createJarStore({dir, secret})})`;
  - the permit is the loopback one in `tests/agent-browser.test.js:74`.

- [ ] **Step 1: Write the test.**

```js
test('two bots signed in to two accounts of one site each see their own, and both are still signed in after a restart', {skip: !browser && 'no browser installed', timeout: 90000}, async t => {
  // a local http server: /login?as=<name> sets `who=<name>; HttpOnly; Path=/` and a session cookie; / prints "Signed in as <name>" or a page with <input type=password>
  // shared #1: run('scout', {url: base + '/login?as=alice', account: A}); run('writer', {url: base + '/login?as=bob', account: B})
  // run('scout', {url: base + '/', account: A}).text matches /Signed in as alice/; writer's matches /Signed in as bob/
  // run('atlas', {url: base + '/'}) (no account) is a sign-in page: signinPage(result) === '127.0.0.1'
  // await shared.close(); shared #2 on the same profile, jar dir and secret
  // scout on A reads alice and writer on B reads bob again; accountStates() after sweep shows both 'signed-in'
});
```

- [ ] **Step 2: Run it.** Run `node --test tests/browser-accounts-chrome.test.js`. Expected: PASS where Chrome is installed, SKIP elsewhere. If it fails, fix the owning task's code in a separate commit that names the task.
- [ ] **Step 3: Make the doc edits.**
- [ ] **Step 4: Run the full gate.** Run `npm run check && npm test && npm run build:pages && npm run test:ui`. Expected: PASS, with no drift.
- [ ] **Step 5: See it work** (§15 row 2):
  1. Start the server and a device with `AGENT_BROWSER=1`, and allowlist a site where you have two accounts.
  2. In Settings → Local agents, add two accounts of that site on that computer.
  3. Give one bot each account on its Edit page.
  4. Take over each bot's Computer view and sign in to that bot's account.
  5. Ask each bot to read its account's home page. Each names its own account.
  6. Restart the device app (Ctrl+C, then `node agent/agent.mjs run`) and ask again. Both are still signed in, and the Local agents page reads `Signed in` for both after the next heartbeat.
  7. Write the results in the commit body.
- [ ] **Step 6: Commit.** `git commit -m "docs: browser accounts; tick Phase AA step 2"` (explicit paths).

---

## Spec coverage (§5.1 to §5.3)

| Spec item | Task |
|---|---|
| A named, isolated cookie space per account in one Chrome | 6, 7 |
| `storage: "cookies"`: the jar, 0700 folder and 0600 file, AES-256-GCM under an HKDF key from the pairing secret, saved after each task and every 10 minutes, restored on context creation | 5, 7, 8 |
| Jars never leave the device | 5, 8 (planted cookie), 3 (the server stores no extra field) |
| Re-pair re-encrypts the jars before dropping the old secret; on failure the accounts show signed out | 5, 9, 3 |
| The `default` account is today's persistent profile | 7 (a bot with no account; Call 3) |
| Records in kv `browser_accounts`, owner-only routes, names only in backups | 1, 2, 3 |
| A bot's `browserAccount`, validated, owner or blueprint only, never from a model | 1, 2 (a blueprint apply is Phase 7) |
| A pure browser-safe module in `shared/assets.js`; jar crypto in `agent/` | 1, 5 |
| The Pages demo says the routes need the server | 12 |
| Heartbeat `accounts: [{id, state, storage}]`, the last report kept per account | 3, 8, 9 |
| Hop 1: a block's `account` is dropped | 4 |
| Hop 2: dispatch adds `account` and `deviceId` from the bot record | 4 |
| Hop 3: the device keys tabs by `(account, bot)` and checks the context before every step | 7 |
| Hop 4: live and takeover open the bot's account tab, and the screen names it | 11, 12 |
| Never in the server runtime: `auto` goes to the device, `server` refuses in one line | 4 |
| One tab per bot per account; today's blocks unchanged | 7 |
| A tab untouched for 10 minutes is closed after saving | 8 |
| A keeper per signed-in account, checked every 30 minutes | 8 |
| Wider sign-in detection: a visible password field | 10 |
| `AGENT_BROWSER_QUIT_IDLE=1` | 8, 9 |
| §5.5 Pins: an account's `deviceId` beats a bot's pin | 1, 4, 11 |
| §5.5: a queue per `(account, tab)` | 7 |

## Phase 1 follow-ups

| Follow-up | Where |
|---|---|
| 1. The live hub keeps one device per workspace | Task 11 |
| 2. `takeover()` and `tabFor` race on a bot's first tab | Task 7 (single-flight tab creation per `(account, bot)`) |
| 3. `blockedRequests` counts other tabs' proxy refusals | Out of scope (below) |
| 4. §5.5 Pins: the account's `deviceId` beats the bot's pin | Tasks 1, 4 and 11 |

## Out of scope

- **Follow-up 3, `blockedRequests` counting other tabs' refusals** (`agent/browser.mjs:479`, `:570`, `:595`). It is a count a bot reads, not an account boundary. Contexts still share one egress proxy, so fixing it means a proxy per context, which is its own change.
- **The profile fallback (`storage: "profile"`) and named tabs.** §15 defers them until a real use. Task 8 detects `lost` and Task 12 shows it.
- **The server-posted sign-in card per account, `signin_pending`, and the `awaiting_ask` park.** These are Phase 3 (§6.3). A keeper's signed-out finding is reported and shown here only.
- **Connector accounts (§5.4).** These are Phase 5.
- **A lane per account for outward pacing (§8.3).** This is Phase 4.
- **An applied blueprint setting `browserAccount`.** This is Phase 7. The route check in Task 2 is the only way in until then.

## Done when

- `npm run check`, `npm test`, `npm run build:pages` (with no drift) and `npm run test:ui` pass.
- The five Review Focus cases each have a passing test.
- The real-Chrome test in Task 13 passes on a machine with Chrome.
- The manual check in Task 13 has been seen working.
