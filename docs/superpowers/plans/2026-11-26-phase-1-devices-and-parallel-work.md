# Phase 1: devices and parallel work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan path (once merged):** `docs/superpowers/plans/2026-11-26-phase-1-devices-and-parallel-work.md`

**Goal:** Two bots read two sites at the same time, and taking over one bot's tab does not stop the other. Every piece of device work picks its computer in one place. The owner can pin a bot to one computer. A device app that is too old for a piece of work is refused that work and told to update, while it keeps doing everything else.

**Architecture:** `chooseDevice` in `src/agent.js` replaces the three device pickers. It answers `{agent}` or `{reason}`, and each caller turns the reason into the answer it gives today.
- A bot setting `device`, which only the owner can set, narrows the choice to one computer.
- A `needs` list narrows it to computers that report every named feature. Phase 0 keeps the reported list in kv `agent_features:<id>` (`readAgentFeatures`).
- `shared/device-features.js` becomes the general list of features. For each one it records the date the server first relied on it and whether it is needed or preferred. A preferred feature counts as needed `FEATURE_GRACE_DAYS` (60) days after that date.

Work then runs in parallel at three levels. Each level is keyed by one lane function, so Phase 2 changes a key and nothing else:
- the device's worker pool (`agent/task-pool.mjs`, key `taskKey(task)`);
- the shared browser's per-bot queues (`laneOf(botId)` in `agent/shared-browser.mjs`);
- the server runtime's per-bot queues (`browserLane(store, botId)` in `src/bot-browser.js`).

**Tech Stack:**
- Node ≥ 22, with no npm runtime dependencies;
- `node --test`, with `tests/fake-cdp.js` standing in for Chrome;
- SQLite through `src/sqlite-store.js`;
- the Playwright smoke `tests/usability_smoke.py` (`npm run test:ui`).

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`.
- §5.5 is binding, including the "Features" paragraph and the "Tests Phase 1 must add" line.
- §15 row "1." is the definition of done.
- §2.2 items 3, 4 and 19 are the problems this phase fixes.
- Phase 1b, the model fallbacks of §3.3 and §2.2 item 18, is a separate PR with its own plan (`docs/superpowers/plans/2026-11-26-phase-1b-model-fallbacks.md`). Nothing from it is here.

**Builds on Phase 0, which is merged in the tree this plan reads:**
- `shared/device-features.js`, which exports `SECRET_INPUT_V1`, `DEVICE_FEATURES`, `UPDATE_DEVICE_LINE`, `cleanFeatures` and `hasFeature`. It is already listed in `shared/assets.js`.
- `recordAgentFeatures` and `readAgentFeatures` in `src/agent.js` (`:396-405`).
- The heartbeat's `features` field, in `agent/agent.mjs:268` and `src/routes-public.js:207-211`.
- `hub.holdsSecrets`, in `src/browser-live.js:38,75` and `src/routes-live.js:28-31`.
- The per-tab `typed` set, `scrubTyped`, `scrub` and `clearSecretFields`, in `agent/shared-browser.mjs`.
- `FOCUSED_IS_SECRET_JS`, `TAG_FOCUSED_SECRET_JS` and `CLEAR_SECRETS_ON_HANDBACK_JS` in `agent/page-secrets.mjs`. `tests/fake-cdp.js:27-33` matches these by equality.

## Global Constraints

**Repo rules**
- No npm runtime dependencies. `shared/` stays browser-safe. No new `shared/` module is planned. Any edit to `shared/` is followed by `npm run build:pages`.
- Every task leaves `npm run check`, `npm test` and `npm run build:pages` green, with no drift in `docs/`.

**The online rule and the chooser's reasons**
- **Online:** `last_seen_at` falls within `AGENT_ONLINE_MS` (180000 ms). A device that has never been seen counts by `paired_at` instead. All three callers and both wait loops use this one predicate. `cli-model.js` and `mcp-client.js` keep no `ONLINE_MS` of their own.
- **Reasons without a pin**, checked in this order:
  - `no-agent`: no device is paired that has not been revoked.
  - `no-permission`: no device holds `kind`.
  - `missing-feature`: some devices hold `kind`, but none reports every name in `needs`. The answer carries `feature`, the first missing name on the most recently seen device that holds `kind`.
  - `agent-offline`: some devices hold `kind` and report every name in `needs`, but none of them is online.
  - Otherwise the most recently seen device that holds `kind`, reports every need and is online is chosen.
- **Reasons with a pin (`deviceId`)**, checked in this order:
  - `not-pinned`: the pinned device is unknown, revoked, or does not hold `kind`.
  - `missing-feature`: the pinned device does not report a name in `needs`.
  - `agent-offline`: the pinned device is not online.
  - Otherwise the pinned device is chosen.
  - With a pin the answer is never `no-agent` or `no-permission`, even when no other device exists.

**Behaviour without a pin or `needs` stays as today**
- Every existing sentence, HTTP status and `code` is kept.
- Two places that queue device work keep their own rules: the `agent-job` fan-out (`src/handlers.js:87`) and `POST /api/agents/:id/tasks` (`src/routes-account.js:93`).
- Phase 0's secret checks stay as they are. `src/routes-live.js:74` and `src/browser-live.js:75` already refuse a `secret` event for a device without `secret-input-v1`. They act on the device that holds the bot's tab, which is not a choice of device.

**Features**
- **Where they are defined.** `FEATURES` in `shared/device-features.js` is the list. Each entry is `{name, since, use, what}`:
  - `since` is an ISO date, the release in which the server first relied on the feature;
  - `use` is `'needed'` or `'preferred'`;
  - `what` says in words what the feature lets the device do.
  - `secret-input-v1` is `{since: '2026-11-26', use: 'needed', what: 'type passwords and codes'}`.
  - `DEVICE_FEATURES` becomes `FEATURES.map(f => f.name)`. Its value is unchanged.
- **Preferred features.** A preferred feature counts as needed once `nowMs ≥ Date.parse(since) + FEATURE_GRACE_DAYS × 86400000`. Before that, the caller keeps the older path for a device that lacks it.
- **Unknown names.** A name passed as a need that is not in `FEATURES` counts as needed. A mistake fails closed.
- **When the device reports.** It sends its list when it pairs (new in this phase) and on every heartbeat (Phase 0).
- **No new feature names in this phase.** Phase 1 adds no feature name, so no caller passes a non-empty `needs` yet. The preferred rule is tested against an injected list.
- **Refusal sentence.** `missingFeatureLine(name)` in `src/agent.js` returns `This needs a newer app on your computer: it does not report ${name}. Update the app on your computer, then try again.`
  - The browser answers 409 with it.
  - The CLI model and device MCP answer 422 with code `missing-feature`.

**What a pin does**
- **Browser, `BROWSER_RUNTIME=auto`:** a pinned bot skips the server browser and goes to its computer.
- **Browser, `BROWSER_RUNTIME=server`:** a pinned bot is refused with 409 and this sentence: `This bot is set to use one computer, and this install opens pages only on the server (BROWSER_RUNTIME=server). Clear the bot's computer on its profile, or set BROWSER_RUNTIME=auto.`
- **Browser, `not-pinned`:** 409, `This bot's computer is not available. Pair it again, or choose another computer on the bot's profile.`
- **CLI model, `not-pinned`:** 422, code `not-pinned`, `This bot is set to use a computer that is not available or may not run models. Choose another computer on the bot's profile, or set it to any computer.`
- **MCP on the device, `not-pinned`:** 422, code `not-pinned`, `This bot is set to use a computer that is not available or may not run MCP servers. Choose another computer on the bot's profile, or set it to any computer.`
- **Scope:** a bot's pin applies to its browser pages, its `model.run` and its device MCP calls. The Settings sign-in check (`cliSignIn`) uses no pin.

**The bot setting `device`**
- **Default:** `device: null` in `BOT_DEFAULTS`. A value is `null`, `''` (read as `null`), or an id matching `/^[A-Za-z0-9-]{1,64}$/`. Anything else fails with `A computer must be a paired computer's id, or empty for any computer.`
- **Who may set it:** only the owner, in `src/routes-groups.js`, on both bot routes that accept `settings`. A non-owner who sends a `device` key gets 403, `Only the owner can choose which computer a bot uses.`
- **Which ids:** an id that is not a device of this workspace that has not been revoked gets 400, `That computer is not paired. Choose one in Settings → Local agents, or use any computer.`
- **Never from a model:** `device` never enters `BOT_SETTABLE` (`shared/setup.js:48`) and never reaches `buildCreatedBot` (`shared/bot-create.js`).

**Parallel work**
- `AGENT_CONCURRENCY` is the number of device tasks that run at once. The default is 3. It must be a whole number from 1 to 8: a value above 8 is 8, and anything else is 3.
- At most one `model.run` runs per CLI engine.
- On the device, one bot's browser tasks run one at a time. The server runtime does the same per lane, where a lane is a workspace and a bot.
- `MAX_LIVE` stays at 1 in the server runtime, and on the device the owner still drives one tab at a time.
- **Phase 0's takeover rules hold for each tab:**
  - what the owner types in secret is remembered in that tab's `typed` set and scrubbed from every result, error and status that leaves;
  - `applyInput` keeps its order: ask `FOCUSED_IS_SECRET_JS`, then tag with `TAG_FOCUSED_SECRET_JS`, then `rememberTyped`, then `Input.insertText`;
  - a hand back clears the secret fields before it lets the tab's bot go on.

**Merging**
- Tasks 2, 10 and 11 touch `shared/`. `build:pages` stamps every file in `docs/` with one content hash, so these three tasks never run side by side. Each one sits in its own wave.
- **Beside Phase 1b.** Phase 1b (`docs/superpowers/plans/2026-11-26-phase-1b-model-fallbacks.md`) may run at the same time. The two plans share several files:
  - `docs/`, rewritten by `build:pages`: this plan's Tasks 2, 10 and 11, and 1b's Tasks 1, 2 and 6;
  - `shared/ui-admin.js` and the `AdminServer` stub in `tests/usability_smoke.py`: this plan's Task 11 and 1b's Task 2;
  - `AGENTS.md` and `docs/DEPLOYMENT.md`;
  - `docs/BUILD-PLAN.md:238`.

  Whichever PR merges second rebases, re-runs `npm run build:pages`, and merges those files by hand.

## Review Focus

1. **Bot B's refused address in bot A's error.** Captures that run in parallel share one `refused` list (`agent/browser.mjs:308`). The newest refusal can belong to another tab. This happens at three places: `capture` (`:380`), `open` (`:588`), and the takeover handle's navigate (`:609-610`). Expected: a page that would not open names only a refusal for its own host. Task 5 pins this.
2. **One bot's failed page kills another bot's page in the server runtime.** A failure calls `forget()` (`src/browser-runtime.js:129`), and the idle clock is armed when any page finishes (`:135`). Expected: a failure drops the browser only when the process is dead or no other page is open, and the idle clock starts only when no page and no takeover is open. Task 9 pins this.
3. **A computer that was just paired and has not beaten yet.**
   - The chooser accepts it by `paired_at`. The CLI and MCP wait loops (`src/cli-model.js:82`, `src/mcp-client.js:198`) read only `last_seen_at`, so they would fail it as offline at the first poll. Expected: it is waited for, and the wait ends in `timeout` if it never beats. Task 4 pins this.
   - It reports its features at pairing (Task 11), so `needs` does not refuse it before its first heartbeat.
4. **The device stops while several tasks run** (Ctrl+C, or the server is gone). Expected: no queued task starts, the running ones finish and report, and heartbeats keep their leases until then. Tasks 7 and 8 pin this.
5. **A pinned bot is edited by someone who does not see the Computer choice** (a member, or a workspace with no paired computer). Expected: renaming the bot keeps its pin. Task 10 pins this.
6. **Phase 0's secret rules break once tabs run side by side.** Two places are at risk:
   - Bot B's step in flight could hold or reorder the owner's secret typing into bot A's tab.
   - Bot A's typed memory could leak into, or be dropped from, bot B's results.

   Expected: the order ask → tag → remember → insert holds on A's session while B runs, A's next result is scrubbed, and B's is scrubbed only by B's own memory. All of Phase 0's tests in `tests/shared-browser-takeover.test.js:229-562` pass unchanged. Task 6 pins this.
7. **A feature rule that fails open.** An unknown name, a list that is not an array, or a store with no kv must each count as "lacks the feature". Tasks 1 and 11 pin this.

---

## Order and parallel work

| Wave | Tasks (each set touches disjoint files) | Waits for |
|---|---|---|
| A | 1, 2, 5, 6, 7 | nothing |
| B | 3, 4, 11 | 3 and 4 wait for 1 and 2. 11 waits for 1 (`src/agent.js`) and 2 (`shared/`). |
| C | 8, 9, 10 | 8 waits for 7 and 11 (`agent/agent.mjs`). 9 waits for 3 (`src/bot-browser.js`). 10 waits for 2 and 11 (`shared/`, `tests/usability_smoke.py`). |
| D | 12 | all |

---

### Task 1: `chooseDevice`, `needs`, and the one online rule

**Files:**
- Modify: `src/agent.js`. Add `agentOnline`, `chooseDevice` and `missingFeatureLine` below `AGENT_ONLINE_MS` (`:42`). Import `hasFeature` beside `cleanFeatures` (`:26`).
- Test: `tests/choose-device.test.js` (new).
  - The harness copies `tests/agent-offline.test.js:26-36`.
  - Add `pair(name, permissions, {seenAgo, pairedAgo, features})`. It writes `last_seen_at` and `paired_at` directly (`seenAgo: null` means never seen) and calls `recordAgentFeatures` when `features` is given.

**Interfaces:**
- Produces `agentOnline(row, nowMs = Date.now()) → boolean`.
- Produces `chooseDevice(store, {kind, deviceId = null, needs = [], nowMs = Date.now()})`. It returns one of:
  - `{agent: row}`, where `row` is the full `agents` row;
  - `{reason: 'no-agent' | 'no-permission' | 'agent-offline' | 'not-pinned'}`;
  - `{reason: 'missing-feature', feature}`.
- How it reads:
  - A store with no `all` function answers `{reason: 'no-agent'}`.
  - Without a pin it reads `SELECT * FROM agents WHERE revoked_at IS NULL ORDER BY last_seen_at DESC`. With a pin it reads the row by id.
  - It reads features only when `needs.length > 0`, through `readAgentFeatures(store, row.id)`. A store without `kvGet` reports none.
- Produces `missingFeatureLine(name) → string`, with the sentence in Global Constraints.

- [ ] **Step 1: Write the failing tests.**

```js
const MIN = 60000;
test('no computer, none that may, none online: the three reasons', async t => {
  const {store, pair} = await rig(t);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'no-agent'});
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'no-permission'});
  pair('Desk', ['model.run'], {seenAgo: 10 * MIN});
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'agent-offline'});
  assert.deepEqual(chooseDevice({read: () => ({})}, {kind: 'model.run'}), {reason: 'no-agent'});
});
test('online is seen within AGENT_ONLINE_MS, or paired within it and never seen', async t => {
  assert.equal(AGENT_ONLINE_MS, 180000);
  const {store, pair} = await rig(t);
  const fresh = pair('New', ['model.run'], {seenAgo: null, pairedAgo: MIN});
  assert.equal(chooseDevice(store, {kind: 'model.run'}).agent.id, fresh);
  store.run('UPDATE agents SET paired_at=? WHERE id=?', new Date(Date.now() - 10 * MIN).toISOString(), fresh);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'agent-offline'});
  const at = ms => new Date(Date.now() - ms).toISOString();
  assert.equal(agentOnline({last_seen_at: at(10 * MIN), paired_at: at(MIN)}), false, 'a device that was seen is judged by when it was seen');
});
test('the most recently seen capable computer is chosen, and a revoked one never is', async t => {
  const {store, pair} = await rig(t);
  const older = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  const newer = pair('Laptop', ['browser.capture'], {seenAgo: MIN});
  assert.equal(chooseDevice(store, {kind: 'browser.capture'}).agent.id, newer);
  agent.revokeAgent(store, newer);
  assert.equal(chooseDevice(store, {kind: 'browser.capture'}).agent.id, older);
});
test('a pin restricts the choice to that computer, and a revoked pin gives not-pinned', async t => {
  const {store, pair} = await rig(t);
  pair('Laptop', ['browser.capture'], {seenAgo: MIN});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  const asleep = pair('Old', ['browser.capture'], {seenAgo: 10 * MIN});
  assert.equal(chooseDevice(store, {kind: 'browser.capture', deviceId: desk}).agent.id, desk);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run', deviceId: desk}), {reason: 'not-pinned'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: 'nope'}), {reason: 'not-pinned'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: asleep}), {reason: 'agent-offline'});
  for (const row of store.all('SELECT id FROM agents')) agent.revokeAgent(store, row.id);
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: desk}), {reason: 'not-pinned'}, 'not no-agent');
});
test('needs: a computer that reports no features gets no work that needs one, and still gets the rest', async t => {
  const {store, pair} = await rig(t);
  const old = pair('Old app', ['browser.capture'], {seenAgo: 0});           // reports nothing
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1});
  assert.equal(chooseDevice(store, {kind: 'browser.capture'}).agent.id, old, 'no needs: it is chosen as before');
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: old, needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1});
  const updated = pair('New app', ['browser.capture'], {seenAgo: 2 * MIN, features: [SECRET_INPUT_V1]});
  assert.equal(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}).agent.id, updated, 'the older-seen one that has it wins');
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 10 * MIN).toISOString(), updated);
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'agent-offline'}, 'one has it but is asleep');
  assert.deepEqual(chooseDevice({all: () => [{id: 'x', permissions: '["browser.capture"]', last_seen_at: new Date().toISOString()}]}, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1}, 'no kv: no features');
  assert.match(missingFeatureLine(SECRET_INPUT_V1), /^This needs a newer app on your computer: it does not report secret-input-v1\. Update the app on your computer, then try again\.$/);
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/choose-device.test.js`. Expected: FAIL, because `chooseDevice` is not exported.
- [ ] **Step 3: Implement `agentOnline`, `chooseDevice` and `missingFeatureLine`** as the Interfaces block and Global Constraints say. A device's `permissions` column is JSON: read it the way `listAgents` does. Have `listAgents` and `agentsBrief` (`:407-431`) keep their own `status` and `online` words. They describe the device list, not a choice.
- [ ] **Step 4: Run the tests and see them pass.** Run `node --test tests/choose-device.test.js tests/device-features.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/agent.js tests/choose-device.test.js && git commit -m "feat: one device chooser with pins, needed features and one online rule"`

---

### Task 2: The bot `device` setting, owner-only

**Files:**
- Modify: `shared/bot-settings.js`. Add `device: null` to `BOT_DEFAULTS` (`:31-60`), validate it in `validateBotSettings` (`:102-145`), and add `pinnedDevice`.
- Modify: `src/routes-groups.js`. Add `assertDevicePin`, used by `POST /api/groups/:group/bots` (`:162`) and `PATCH /api/groups/:group/bots/:bot` (`:165`).
- Regenerate: `docs/` (`npm run build:pages`).
- Test: `tests/bot-device-pin.test.js` (new). The route harness copies `tests/route-guards.test.js:31-56`, and it registers `groupRoutes`.

**Interfaces:**
- Produces `pinnedDevice(state, botId) → string | null` in `shared/bot-settings.js`. It looks across every group's bots, and an unknown bot gives `null`.
- Produces `assertDevicePin(c, settings)`, local to `src/routes-groups.js`:
  - It does nothing when `settings` has no own `device` key.
  - Otherwise it checks the role with `allows(c.actor.role, 'owner')`.
  - It checks a non-empty id with `c.store.get('SELECT id FROM agents WHERE id=? AND revoked_at IS NULL', id)`.

- [ ] **Step 1: Write the failing tests.**

```js
test('device is a bot setting: null by default, an id or empty, nothing else', () => {
  assert.equal(BOT_DEFAULTS.device, null);
  assert.equal(validateBotSettings({device: '1b2c-3d4e'}).device, '1b2c-3d4e');
  assert.equal(validateBotSettings({device: ''}, {device: 'x'}).device, null);
  assert.equal(validateBotSettings({device: null}, {device: 'x'}).device, null);
  for (const bad of [7, true, {}, 'has space', 'x'.repeat(65)]) assert.throws(() => validateBotSettings({device: bad}), /^Error: A computer must be a paired computer's id, or empty for any computer\.$/);
  assert.equal(validateBotSettings({style: 'brief'}, {device: 'a1'}).device, 'a1', 'saving another field keeps the pin');
});
test('pinnedDevice reads a bot in any group', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'atlas', settings: {}}]}, {id: 'lab', bots: [{id: 'web', settings: {device: 'a1'}}]}]};
  assert.deepEqual([pinnedDevice(state, 'web'), pinnedDevice(state, 'atlas'), pinnedDevice(state, 'gone')], ['a1', null, null]);
});
test('no model text sets a pin: not a setup card, not a new-bot block', () => {
  assert.equal(BOT_SETTABLE.includes('device'), false);
  const state = {groups: [{id: 'home', bots: [{id: 'web', name: 'Web', instructions: 'x', settings: {}}]}]};
  assert.match(resolveSetup(state, {action: 'settings', bot: 'Web', settings: {device: 'a1'}}).error, /nothing to change/);
  const made = buildCreatedBot(validateCreateBotRequest({name: 'Scout', job: 'Read the supplier pages each morning', device: 'a1', settings: {device: 'a1'}}), {bot: {id: 'atlas'}});
  assert.equal(Object.hasOwn(made.settings, 'device'), false);
});
test('only the owner pins, and only to a computer paired here', async t => {
  // member PATCH {settings: {device: id}} → 403, the owner-only sentence; the bot's settings are unchanged
  // member PATCH {settings: {style: 'brief'}} → 200 (a member still edits the rest)
  // owner PATCH {settings: {device: 'nope'}} → 400, the not-paired sentence; and the same for a revoked device
  // owner PATCH {settings: {device: id}} → 200, and store.read() shows the pin; owner PATCH {settings: {device: null}} → 200, cleared
  // member POST /api/groups/home/bots {name, instructions, settings: {device: id}} → 403
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/bot-device-pin.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the setting, `pinnedDevice`, and `assertDevicePin` in both routes.** The route check runs before `c.store.update`. The Pages demo (`shared/local-api.js`) is not changed: it checks the shape only, and it has no computers.
- [ ] **Step 4: Run the tests, the suite and the build.** Run `node --test tests/bot-device-pin.test.js && npm run build:pages && npm test`. Expected: PASS, and `tests/pages-bundle.test.js` reports no drift.
- [ ] **Step 5: Commit.** `git add shared/bot-settings.js src/routes-groups.js tests/bot-device-pin.test.js docs && git commit -m "feat: an owner-only device pin on a bot"`

---

### Task 3: Browser dispatch uses the chooser and the pin

**Files:**
- Modify: `src/bot-browser.js`:
  - delete `online` (`:35`) and `pickAgent` (`:38-46`);
  - change `dispatchBrowserRequest`'s choice at `:53-57`;
  - keep `OFFLINE` (`:33`).
- Test: `tests/device-pin-browser.test.js` (new). Use the harness of `tests/agent-offline.test.js` with two paired devices and a bot `web` whose `settings.device` is set per test. There is one pending request, `br1`, of kind `browser.capture`.

**Interfaces:**
- Consumes `chooseDevice`, `agentOnline` and `missingFeatureLine` from Task 1, and `pinnedDevice` from Task 2.
- Changes `dispatchBrowserRequest(store, id, {actor, runtime, needs = []})` in an additive way. `needs` goes to the chooser unchanged. No caller passes it yet.
- Gives the same answers as today without a pin or `needs`. With a pin, `here` is false.

- [ ] **Step 1: Write the failing tests.** `agentOnly` is `{mode: 'agent', available: () => false}`, as in `tests/agent-offline.test.js:23`.

```js
test('unpinned: the browser answers as before', async t => {
  // no device, and a device without browser.capture → 409 /No paired local agent holds the browser\.capture permission/, status pending, 0 agent_tasks
  // capable, seen 10 min ago → 409 /agent is offline/
  // capable and online → status dispatched, one agent_tasks row on that device
});
test('a pinned bot\'s page goes only to its computer', async t => {
  // Laptop seen 1 min ago, Desk 2 min ago, both capable; web pinned to Desk
  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  assert.equal(store.get('SELECT agent_id FROM agent_tasks').agent_id, desk);
});
test('a revoked pin is not-pinned, and nothing is queued', async t => {
  agent.revokeAgent(store, desk);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /^This bot's computer is not available\. Pair it again, or choose another computer on the bot's profile\.$/.test(e.message));
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(store.all('SELECT id FROM agent_tasks').length, 0);
  // A pin to a capable device seen 10 min ago gives 409 /agent is offline/.
});
test('a pinned bot never runs in the server runtime', async t => {
  const here = {mode: 'auto', available: () => true, run: async () => assert.fail('ran on the server')};
  assert.equal((await browser.dispatchBrowserRequest(store, 'br1', {runtime: here})).via, 'agent');
  // {mode: 'server', available: () => true} → 409 /BROWSER_RUNTIME=server/; with no pin the same runtime gives via 'server', as today
});
test('an older device app still reads pages, and is refused only work that needs a feature', async t => {
  // one capable online device that reports no features
  assert.equal((await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly})).via, 'agent');
  // a second pending request br2: dispatch with {needs: [SECRET_INPUT_V1]} → 409 matching missingFeatureLine(SECRET_INPUT_V1) exactly; br2 stays pending, one agent_tasks row in all (br1's)
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/device-pin-browser.test.js`. Expected: FAIL. The pinned task goes to Laptop, and a revoked pin is ignored.
- [ ] **Step 3: Implement the choice.**
  - Read the pin with `pinnedDevice(store.read(), request.botId)`.
  - A pin under `server` mode is refused first, with the Global Constraints sentence.
  - Set `here = !pin && !needs.length && runtime.mode !== 'agent' && runtime.available()`. A need names a device feature, and the server browser has none.
  - When `!here`, `chooseDevice(store, {kind: request.kind, deviceId: pin, needs})` gives the answer:
    - `agent-offline` is `fail(OFFLINE, 409)`;
    - `not-pinned` is a 409 with its sentence;
    - `missing-feature` is a 409 with `missingFeatureLine(feature)`;
    - `no-agent` or `no-permission` falls through to today's 409 at `:55`.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/device-pin-browser.test.js tests/agent-offline.test.js tests/bot-browser.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: browser pages go to the bot's pinned computer, and a missing feature is refused by name"`

---

### Task 4: The CLI model and device MCP use the chooser and the pin

**Files:**
- Modify: `src/cli-model.js`:
  - delete `ONLINE_MS` (`:18`) and `pickAgent` (`:32-42`);
  - `cliSignIn` (`:50`), `runOnAgent` (`:69`), and its wait loop at `:82-83`.
- Modify: `src/mcp-client.js`:
  - delete `ONLINE_MS` (`:161`) and `pickAgent` (`:167-176`);
  - `viaAgent` (`:179`) and its wait loop at `:198-199`.
- Modify: `src/connector-use.js` (`useConnector`, `:15`) and `src/connector-runs.js` (the call at `:64`).
- Test: `tests/device-pin-model-mcp.test.js` (new). Use the same harness. For the connector-run case, copy the run fixture from `tests/phase56-review.test.js:200-220`.

**Interfaces:**
- Consumes `chooseDevice`, `agentOnline` and `missingFeatureLine` from Task 1, and `pinnedDevice` from Task 2.
- Changes `useConnector(store, connector, tool, args = {}, {deviceId = null} = {})` in an additive way. The stdio target becomes `{transport: 'stdio', store, server, deviceId}`. `viaAgent` reads `target.deviceId ?? null`, and reads `needs` from its options (default `[]`).
- `runConnectorCalls` passes `{deviceId: pinnedDevice(state, call.botId)}`.
- `runOnAgent` reads `pinnedDevice(store.read(), botId)` and accepts `needs = []`.
- The wait loops judge the device with `agentOnline(store.get('SELECT last_seen_at,paired_at FROM agents WHERE id=?', id))`.

- [ ] **Step 1: Write the failing tests.**

```js
test('unpinned model runs and sign-in checks give today\'s codes', async t => {
  // none → runOnAgent rejects {status: 422, code: 'no-agent'} /No computer is connected to run `claude`/; cliSignIn(store,'claude').status === 'no-agent'
  // a device without model.run → {422, 'no-permission'}; a capable one seen 10 min ago → {422, 'agent-offline'}; cliSignIn the same words
});
test('a pinned bot\'s model run goes only to its computer, and a revoked pin is not-pinned', async t => {
  const reply = runOnAgent(store, {engine: 'claude', input: 'hi', botId: 'web', waitMs: 5000, pollMs: 10});
  const task = await until(() => store.get("SELECT id,agent_id FROM agent_tasks WHERE kind='model.run'"));
  assert.equal(task.agent_id, desk);
  agent.completeAgentTask(store, desk, task.id, {status: 'done', result: {ok: true, text: 'hello'}});
  assert.equal(await reply, 'hello');
  agent.revokeAgent(store, desk);
  await assert.rejects(runOnAgent(store, {engine: 'claude', input: 'hi', botId: 'web'}), e => e.status === 422 && e.code === 'not-pinned' && /may not run models\. Choose another computer on the bot's profile/.test(e.message));
});
test('a just-paired computer that has not beaten yet is waited for, not failed as offline', async t => {
  // paired now, last_seen_at NULL
  await assert.rejects(runOnAgent(store, {engine: 'claude', input: 'hi', waitMs: 300, pollMs: 10}), e => e.code === 'timeout');
  await assert.rejects(mcpCall({transport: 'stdio', store, server: 'files'}, 'read', {}, {timeoutMs: 300, pollMs: 10}), e => e.code === 'timeout');
});
test('device MCP: today\'s codes unpinned, and a connector call carries its bot\'s pin', async t => {
  // mcpCall stdio with none / no mcp.call / offline → 422 'no-agent' / 'no-permission' / 'agent-offline'
  // useConnector(store, {kind: 'mcp', transport: 'stdio', agentServer: 'files', name: 'Files'}, 'read', {}, {deviceId: revoked}) → 422 'not-pinned'
  // runConnectorCalls on a run whose call is for bot web, pinned to a revoked device: say() gets kind 'connector-error' matching /may not run MCP servers/, and there are 0 mcp.call rows
});
test('a need the computer lacks is 422 missing-feature for a model run and an MCP call, naming the feature', async t => {
  // one capable online device reporting no features
  // runOnAgent(..., needs: [SECRET_INPUT_V1]) and mcpCall(..., {needs: [SECRET_INPUT_V1], timeoutMs: 300}) each reject {status: 422, code: 'missing-feature'} with message === missingFeatureLine(SECRET_INPUT_V1); no task row is written
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/device-pin-model-mcp.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each caller maps a reason to the `problem(...)` it throws today, with today's sentence.
  - Each caller adds `not-pinned`, with its Global Constraints sentence, and `missing-feature`, with `missingFeatureLine(feature)`.
  - `cliSignIn` passes no pin and no needs.
  - Before finishing, grep `tests/` for a device that is paired, never touched, and expected to be `agent-offline`. None was found while this plan was written. Fix any that turns up so it sets `last_seen_at`, and say so in the commit body.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/device-pin-model-mcp.test.js tests/agent-offline.test.js tests/agent-mcp.test.js tests/agent-cli-status.test.js tests/local-cli.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: model runs and device MCP calls use the device chooser and the bot's pin"`

---

### Task 5: One CDP connection, many tabs

**Files:**
- Modify: `agent/browser.mjs`. Add `ownRefusal`, and use it in place of the newest-refusal pick at three places:
  - in `capture` (`:342`), the `lastRefusal` at `:380`;
  - in `open` (`:522`), the `lastRefusal` at `:588`;
  - in the takeover handle's `act` navigate, the `refusal` at `:609-610`, with `refusedBefore` and `target`.
- Leave `connect` (`:258-290`) as it is. Its `waiting` map is at `:262`.
- Test: `tests/cdp-sessions.test.js` (new).

**Interfaces:**
- Produces `export function ownRefusal(refused, from, url) → string`. It returns the newest entry after index `from` that starts with `${new URL(url).hostname}:`, or `''`. An entry looks like `${host}: msg` (`startProxy`'s `deny`, `:194`). The host is `name:443` for a CONNECT, so the match is on the hostname followed by `:`.
- `blockedRequests` (`:465`, `:556`) keeps counting every refusal since the capture began. That is a known overcount under parallel work, and the count is all it affects.

- [ ] **Step 1: Write the tests.** The first two pin behaviour that already works, as §5.5 asks. The third one fails.

```js
test('replies are matched by id and each command names its session', async t => {
  // globalThis.WebSocket = FakeSocket (records sent frames, opens on a microtask); restore in t.after
  const cdp = await connect('ws://fake');
  const a = cdp.send('Runtime.evaluate', {expression: '1'}, 'S1'), b = cdp.send('Runtime.evaluate', {expression: '2'}, 'S2');
  const [fa, fb] = socket.sent;
  assert.deepEqual([fa.sessionId, fb.sessionId], ['S1', 'S2']);
  socket.reply({id: fb.id, result: {value: 'two'}}); socket.reply({id: fa.id, result: {value: 'one'}});
  assert.deepEqual([await a, await b], [{value: 'one'}, {value: 'two'}]);
});
test('two captures in different tabs interleave on one connection and each gets its own page', async () => {
  const ALLOW = ['a.example', 'b.example'];
  const fake = fakeCdp({pages: {'https://a.example/': {title: 'A', text: 'page a'}, 'https://b.example/': {title: 'B', text: 'page b'}}});
  const live = await startBrowserSession({connection: fake.connection});
  const [ta, tb] = [await live.newTab({allow: ALLOW}), await live.newTab({allow: ALLOW})];
  let releaseA; const heldA = new Promise(r => { releaseA = r; });
  // A hook that returns undefined falls through to the scripted answer (tests/fake-cdp.js:48).
  fake.hook('Page.navigate', async (params, sessionId) => { if (sessionId === ta.sessionId) await heldA; });
  const pa = live.capture('https://a.example/', {allow: ALLOW, tab: ta, settleMs: 0});
  const pb = await live.capture('https://b.example/', {allow: ALLOW, tab: tb, settleMs: 0});
  releaseA(); const ra = await pa;
  assert.deepEqual([ra.title, ra.text, pb.title, pb.text], ['A', 'page a', 'B', 'page b']);
  const order = fake.calls.map(c => c.sessionId);
  assert.ok(order.indexOf(tb.sessionId) < order.lastIndexOf(ta.sessionId), 'B\'s commands ran between A\'s');
});
test('a page that would not open names only a refusal for its own host', () => {
  const refused = ['old.example:443: x', 'a.example:443: Refusing to reach a.example: it is on a private or local network.', 'b.example:443: Refusing to reach b.example: it is on a private or local network.'];
  assert.match(ownRefusal(refused, 1, 'https://a.example/login'), /^a\.example:443: /);
  assert.equal(ownRefusal(refused, 1, 'https://c.example/'), '');
  assert.equal(ownRefusal(refused, 3, 'https://a.example/'), '', 'only refusals since this page began');
  assert.equal(ownRefusal(['ba.example:443: x'], 0, 'https://a.example/'), '', 'a host that only ends with the name is another host');
});
```

- [ ] **Step 2: Run the tests.** Run `node --test tests/cdp-sessions.test.js`. Expected: the first two PASS, and the third FAILS because `ownRefusal` is not exported. If the interleave test fails, first check that the test matches `tests/fake-cdp.js`:
  - a hook that returns `undefined` falls through (`:48`);
  - `newTab` returns `{targetId, sessionId, …}` (`agent/browser.mjs:650-653`);
  - the page read is answered by the `JSON.stringify((function(){ … shown:` branch (`tests/fake-cdp.js:38`).

  Only then suspect `capture`'s listener routing.
- [ ] **Step 3: Implement `ownRefusal` and use it at all three sites.**
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/cdp-sessions.test.js tests/agent-browser.test.js tests/browser-refusal.test.js tests/planted-secret.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix: a page's error names only its own refused host; pin one CDP connection for many tabs"`

---

### Task 6: The shared browser: one queue per bot, and a takeover parks one tab

**Files:**
- Modify: `agent/shared-browser.mjs`:
  - the header comment bullets (`:9-16`);
  - replace the global `queue`, `holder`, `epoch` and `parked` (`:57-62`) with per-lane state. `tabs` (`:56`) stays as it is, entries `{tab, url, title, typed}`;
  - `acquire` and `release` (`:105-113`);
  - the `gate` in `run` (`:129-133`);
  - `takeover` (`:154-165`);
  - the wait in `applyInput` (`:233`);
  - `status` (`:285`).
- Test: `tests/shared-browser.test.js` and `tests/shared-browser-takeover.test.js`.
  - Add a `within(promise, ms, why)` helper to each. It rejects with `why` after `ms`.
  - Give `holdStep` (`tests/shared-browser-takeover.test.js:29-39`) an optional third argument `{sessionId}`. With it, only that session's action evaluations are counted and held.

**Interfaces:**
- Produces `laneOf(botId) → string`, internal, returning `botId` for now. Phase 2 makes it `(account, tab)`.
- Per lane: `lanes: Map<lane, {queue: ticket[], holding: boolean, parked: boolean, epoch: number}>`.
  - A lane is created on first use.
  - It is removed when its queue is empty and it holds nothing.
  - `forget()` and `close()` clear `tabs` as today and leave `lanes` alone.
- `driving` stays one bot id: the owner holds one tab at a time.
- Kept exactly as Phase 0 left them:
  - `run` scrubs its result and its error with that tab's `typed` (`:134-139`);
  - `handback` awaits `clearSecretFields(tabs.get(botId))` before `driving = null`, and checks `driving` again after it (`:181-188`);
  - `applyInput` runs ask (`FOCUSED_IS_SECRET_JS`), then tag (`TAG_FOCUSED_SECRET_JS`), then `rememberTyped`, then `Input.insertText` (`:246-261`);
  - `scrub(botId, value)` (`:297`) works as before;
  - `status` scrubs each tab with its own `typed`.
- The exports, `status()` entries and `owner()` keep their shapes. Several tabs may be `browsing` at once.

- [ ] **Step 1: Rewrite the tests whose old behaviour the spec removes, and add the new ones.**
  - `tests/shared-browser.test.js:80`, "two bots asking at once: one waits", becomes the overlap test below.
  - `tests/shared-browser.test.js:101` uses three different bots, so it becomes one bot with three tasks: first come, first served, never two at once, and a failure does not strand the next.
  - `tests/shared-browser-takeover.test.js:70`, "a task that starts while the owner is driving waits, then runs whole", becomes "while the owner drives bot A, A's next task waits and B's runs whole". B no longer waits for a takeover of A.
  - Every other test in `tests/shared-browser-takeover.test.js` stays as it is, including Phase 0's at `:229-562`.

```js
test('two bots\' browser tasks overlap in time on the fake CDP', async t => {
  const {sb, processes} = rig(t);
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const [fake] = processes;
  let release; const gate = new Promise(r => { release = r; });
  fake.hook('Page.navigate', async ({url}) => { if (url === 'https://docs.example.com/') await gate; });
  const a = sb.run('bot-a', {url: 'https://docs.example.com/'});
  assert.equal((await within(sb.run('bot-b', {url: 'https://mail.example.com/'}), 1000, 'B waited for A')).title, 'Mail');
  assert.equal(sb.status().find(s => s.botId === 'bot-a').state, 'browsing');
  release(); assert.equal((await a).title, 'Docs');
});
test('one bot\'s tasks run one at a time, first come first served, and a failure does not strand the next', async t => {
  // three sb.run('bot-a', …) at once; the Page.navigate hook counts in-flight (max must be 1) and throws on the first call
  assert.deepEqual(order, ['1!', 2, 3]); assert.equal(most, 1);
});
test('a takeover of bot A\'s tab does not delay bot B', async t => {
  // prime both tabs; holdStep(fake(), 1, {sessionId: tabA}) holds A's first click; takeover('bot-a') while it is held; release
  const b = await within(sb.run('bot-b', {url, steps: [{op: 'click', index: 1}]}), 1000, 'B was parked by A\'s takeover');
  assert.equal(b.tookOver, undefined); assert.equal(b.actions[0].ok, true);
  await sb.handback('bot-a'); assert.equal((await a).tookOver, true);
});
test('the owner\'s input to bot A waits only for A\'s own step, never for bot B\'s', async t => {
  // holdStep(fake(), 1, {sessionId: tabB}) holds B's click mid-step; takeover('bot-a')
  await within(sb.applyInput('bot-a', {type: 'key', key: 'Enter'}), 1000, 'input waited on B');
});
test('while the owner drives bot A, A\'s next task waits and B\'s runs whole', async t => { /* the old :70, adapted as above */ });
test('secret typing into A while B runs keeps its order, and each tab is scrubbed only by its own memory', async t => {
  // prime both tabs; holdStep(fake(), 1, {sessionId: tabB}) holds B mid-step; takeover('bot-a')
  await within(sb.applyInput('bot-a', {type: 'type', text: 'hunter2-secret', secret: true}), 1000, 'secret typing waited on B');
  const onA = fake().calls.filter(c => c.sessionId === tabA && (c.method === 'Input.insertText' || [FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS].includes(c.params?.expression)));
  assert.deepEqual(onA.map(c => c.method === 'Input.insertText' ? 'insert' : c.params.expression === FOCUSED_IS_SECRET_JS ? 'ask' : 'tag'), ['ask', 'tag', 'insert']);
  // B's page shows 'hunter2-secret' (set fake pages so B's text contains it): B's result is NOT scrubbed of A's memory
  // handback('bot-a') clears A's fields once (fake().cleared has one entry for tabA); A's next capture of a page echoing it says [hidden]
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/shared-browser.test.js tests/shared-browser-takeover.test.js`. Expected: the new tests FAIL (B waits for A), and the other existing tests still PASS.
- [ ] **Step 3: Implement the per-lane state.**
  - `acquire(id)` waits until the ticket is first in its lane, the lane is not holding, and `driving !== id`.
  - `gate` parks only when `driving === id`. It sets and clears that lane's `parked` and compares that lane's `epoch`.
  - `takeover(botId)` bumps only `botId`'s lane `epoch`. The "already driving another bot's tab" refusal and the rollback when the browser will not start stay as they are.
  - `applyInput` waits for `!lane.holding || lane.parked || driving !== botId` on `botId`'s lane. Everything after that wait is unchanged.
  - Rewrite the header bullets so they say:
    - one bot drives each tab, and tabs run side by side;
    - a takeover parks only the tab the owner holds;
    - each tab keeps its own typed memory.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/shared-browser.test.js tests/shared-browser-takeover.test.js tests/live-browser-agent.test.js tests/planted-secret.test.js tests/secret-input.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: each bot's tab has its own queue, and a takeover parks only that tab"`

---

### Task 7: The device worker pool

**Files:**
- Create: `agent/task-pool.mjs`.
- Test: `tests/agent-task-pool.test.js` (new).

**Interfaces:**
- Produces `concurrencyOf(env = process.env) → number`, which follows the `AGENT_CONCURRENCY` rule in Global Constraints.
- Produces `taskKey(task) → string | null`:
  - `model:<payload.engine>` for `model.run`;
  - `bot:<payload.botId || 'shared'>` for `browser.capture` and `browser.action`;
  - `null` for any other kind.
  - Phase 2 changes only this function.
- Produces `createTaskPool({concurrency = 3, keyOf = taskKey, run}) → pool`:
  - `add(task) → boolean`: false when a task with that id is queued or running already;
  - `running() → number` and `queued() → number`;
  - `settled() → Promise<void>`: resolves once the next task finishes and its slot has been refilled;
  - `drain() → Promise<void>`: starts nothing more, and resolves when the running tasks have finished.
- A task starts as soon as a slot is free and no running task has its key. The pool picks the first queued task that qualifies, so a capped `model.run` never holds back a browser or `http.check` task behind it.
- `run(task)` may reject. The slot is freed either way.

- [ ] **Step 1: Write the failing tests.** `blocker()` gives a `run` that logs `['start', id]`, waits for `finish(id)`, and then logs `['end', id]`.

```js
test('AGENT_CONCURRENCY: 3 by default, 1 to 8, a bad value is 3', () => {
  assert.deepEqual([{}, {AGENT_CONCURRENCY: '1'}, {AGENT_CONCURRENCY: '8'}, {AGENT_CONCURRENCY: '50'}].map(concurrencyOf), [3, 1, 8, 8]);
  for (const bad of ['0', '-2', '2.5', 'many', '']) assert.equal(concurrencyOf({AGENT_CONCURRENCY: bad}), 3);
});
test('at most that many run at once, and the rest start as slots free', async () => {
  for (const id of ['1', '2', '3', '4', '5']) pool.add(check(id));
  assert.deepEqual([pool.running(), pool.queued()], [3, 2]);
  b.finish('1'); await pool.settled();
  assert.deepEqual([pool.running(), pool.queued()], [3, 1]);
});
test('two model.run tasks on the same engine never overlap, and one on each engine do', async () => {
  pool.add(model('c1', 'claude')); pool.add(model('c2', 'claude')); pool.add(model('x1', 'codex'));
  assert.deepEqual(b.log, [['start', 'c1'], ['start', 'x1']]);
  b.finish('c1'); await pool.settled();
  assert.deepEqual(b.log.slice(2), [['end', 'c1'], ['start', 'c2']]);
});
test('one bot\'s browser tasks run in order, and nothing else waits behind them', async () => {
  pool.add(page('a1', 'bot-a')); pool.add(page('a2', 'bot-a')); pool.add(page('b1', 'bot-b'));
  assert.deepEqual(b.log, [['start', 'a1'], ['start', 'b1']]);
  assert.equal(taskKey(page('x', '')), 'bot:shared');
});
test('a task is taken once, a failure frees its slot, and drain starts nothing new', async () => {
  assert.equal(pool.add(check('1')), true); assert.equal(pool.add(check('1')), false);
  // a run that rejects leaves running() at 0 after settled(); with concurrency 1 and two queued, drain() resolves once the first ends, and the second never starts
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/agent-task-pool.test.js`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `agent/task-pool.mjs`.** It has no imports and no I/O.
- [ ] **Step 4: Run the tests and see them pass.** Run `node --test tests/agent-task-pool.test.js && npm run check`. Expected: PASS. `scripts/check.mjs` walks the new file without being told.
- [ ] **Step 5: Commit.** `git commit -m "feat: a device worker pool with a per-engine and per-bot cap"`

---

### Task 8: The device runs its tasks through the pool

**Files:**
- Modify: `agent/agent.mjs`:
  - import from `./task-pool.mjs` beside the others (`:34-44`);
  - replace `inbox` and `busy` (`:257-258`);
  - `heartbeat` adds to the pool (`:271`);
  - the keepalive gate (`:281-285`);
  - the main loop (`:309-317`);
  - the `finally` at `:338`.
- Test: `tests/agent-parallel.test.js` (new), modelled on `tests/agent-guards.test.js:65-122`.

**Interfaces:**
- Consumes `createTaskPool`, `concurrencyOf` and `taskKey` from Task 7.
- Creates the pool as `pool = createTaskPool({concurrency: concurrencyOf(process.env), run: runTask})`.
- The main loop heartbeats when `pool.queued() === 0` and then sleeps, as it does today with `inbox.size`. It no longer waits for tasks.
- The keepalive beats when `pool.running() > 0` and no beat went out in the last half interval (`lastBeatAt`, set in `heartbeat`).
- On stop, the `finally` clears the keepalive first, then `await pool.drain()`, then stops the live channel and closes the shared browser.
- The heartbeat body keeps `features: DEVICE_FEATURES` (`:268`).
- Lease renewal stays on the server (`src/routes-public.js:216` renews every running row), so the server is not changed.

- [ ] **Step 1: Write the failing test.**
  - The stand-in server hands over two tasks, `t1` and `t2`, in the first heartbeat. Both are `http.check` with permissions `[]`, so each one fails at once and reports.
  - It holds each result report open for 3 s.
  - It records when each report arrives and whether a heartbeat arrives while a report is held.
  - `pollIntervalMs` is 2000.

```js
test('two tasks from one heartbeat run side by side, and the keepalive beats while they do', {timeout: 30000}, async () => {
  // … spawn agent/agent.mjs run as in agent-guards.test.js:99
  assert.ok(arrived.t1 && arrived.t2, output);
  assert.ok(Math.abs(arrived.t2 - arrived.t1) < 2000, 't2 did not wait for t1\'s report to be answered');
  assert.ok(beatsWhileHeld >= 1, 'a heartbeat renewed the leases while both were running');
});
```

- [ ] **Step 2: Run the test and see it fail.** Run `node --test tests/agent-parallel.test.js`. Expected: FAIL. Today `t2` starts only after `t1`'s report returns, about 3 s later.
- [ ] **Step 3: Wire the pool in** as the Interfaces block says. Change the stop log line to `stopping after the running tasks.`
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/agent-parallel.test.js tests/agent-guards.test.js tests/agent-cli-status.test.js && npm test`. Expected: PASS. The existing keepalive and Ctrl+C tests (`agent-guards.test.js:65`, `:250`) still pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: the device runs up to AGENT_CONCURRENCY tasks at once"`

---

### Task 9: The server runtime: one queue per bot

**Files:**
- Modify: `src/browser-runtime.js`:
  - replace `tail` (`:70`) with `tails: Map<lane, Promise>` and an in-flight count, `active`;
  - `run` (`:104-140`), `beginLive` (`:169-191`), `liveView` (`:193`), `liveAct` (`:204`), `endLive` (`:224-232`), `close` (`:245-255`).
- Modify: `src/bot-browser.js`. Add `browserLane`, and pass it from `runHere` (`:125`) and `beginTakeover` (`:228`).
- Test: `tests/browser-runtime.test.js`.

**Interfaces:**
- Produces `export const browserLane = (store, botId) => …` in `src/bot-browser.js`. It is `${store?.dbPath || ''}\u0000${botId || ''}`. The runtime is shared across the whole process, and every workspace has a bot called `atlas`.
- `run({url, steps, approved, lane = ''})`. It refuses with today's 409, "A person is using the browser right now…", only when an open takeover has the same `lane`.
- `beginLive({url, requestId, openedBy, workspaceId, lane = ''})` and `liveView`/`liveAct` queue on the entry's lane. `endLive` does not queue.
- **On a capture failure,** the session is dropped only when `live.dead` is true or no other page is in flight.
- **The idle clock** is armed only when `active === 0` and no takeover is open.
- **`close()`** waits for every lane.
- The `secret` step that `liveAct` passes on (Phase 0) is unchanged.

- [ ] **Step 1: Rewrite the tests whose old behaviour the spec removes, and add the new ones.**
  - `:104`, "requests are serial, so two bots never share a page", becomes "one bot's requests are serial, and two bots' pages overlap".
  - `:213`, "a person using the browser blocks a bot…", becomes "a takeover refuses only the bot whose page is held".
  - `:126`, "a capture that fails relaunches the browser…", stays as it is, because nothing else is in flight there.

```js
test('one bot\'s requests are serial, and two bots\' pages overlap', async () => {
  // capture holds url /a until released; lanes A = 'w\u0000bot-a', B = 'w\u0000bot-b'
  const a1 = runtime.run({url: 'https://example.com/a', lane: A}), a2 = runtime.run({url: 'https://example.com/a-next', lane: A});
  assert.equal((await within(runtime.run({url: 'https://example.com/b', lane: B}), 1000, 'B waited for A')).url, 'https://example.com/b');
  release(); await Promise.all([a1, a2]);
  assert.deepEqual(order.filter(x => x.includes('/a')), ['start https://example.com/a', 'end https://example.com/a', 'start https://example.com/a-next', 'end https://example.com/a-next']);
});
test('a takeover refuses only the bot whose page is held', async () => {
  const live = await runtime.beginLive({url: 'https://example.com/a', lane: A});
  await assert.rejects(runtime.run({url: 'https://example.com/b', lane: A}), e => e.status === 409 && /A person is using the browser/.test(e.message));
  assert.equal((await runtime.run({url: 'https://example.com/b', lane: B})).url, 'https://example.com/b');
  await runtime.endLive(live.id);
});
test('a page that fails for one bot does not close the browser under another bot\'s page', async () => {
  // /bad throws at once; /slow takes 60 ms; close() counts
  assert.equal(closes, 0); assert.equal((await slow).url, 'https://example.com/slow'); assert.equal(runtime.open, true);
});
test('the idle clock starts only once no bot has a page open', async () => {
  // BROWSER_IDLE_MS 30; lane A takes 90 ms, lane B takes 5 ms; 50 ms after B ends, closes === 0; 60 ms after A ends, closes === 1
});
test('the lane is the workspace and the bot, and dispatch and takeover pass it', async t => {
  assert.notEqual(browserLane({dbPath: '/d/a.db'}, 'atlas'), browserLane({dbPath: '/d/b.db'}, 'atlas'));
  // a SqliteStore with pending request br1 for bot 'web'; a runtime {mode: 'auto', available: () => true, run: r => { seen.push(r.lane); … }, beginLive: o => { seen.push(o.lane); … }}
  // after dispatchBrowserRequest and beginTakeover, every seen lane === browserLane(store, 'web')
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-runtime.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as the Interfaces block says.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-runtime.test.js tests/bot-browser.test.js tests/takeover-scope.test.js tests/secret-input.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: the server browser runs one queue per bot, and a takeover holds only its bot"`

---

### Task 10: The Computer choice on a bot's Edit page

**Files:**
- Modify: `shared/ui-profile-model.js`. Add `deviceOptions`, and handle `device` in `editChanges` (`:228`).
- Modify: `shared/ui-profile.js`:
  - `editPage` (`:319`) puts `device` into `data-was` and adds an empty `<div data-device-slot>` after the Manager row;
  - add `fillDevices(botId)`, scheduled with `setTimeout(…, 0)` the way `computerPage` mounts (`shared/ui-computer-view.js:101`).
- Regenerate: `docs/`.
- Test: `tests/ui-profile-model.test.js`, and `tests/usability_smoke.py` (a new scenario, registered beside `edit_rename_and_move` at `:2873`).

**Interfaces:**
- Consumes the `device` setting and the owner-only route from Task 2.
- Produces `deviceOptions(agents, current) → [{id, label, selected}]`:
  - It returns `[]` when no agent has a status other than `revoked`.
  - Otherwise the list starts with `{id: '', label: 'Any computer'}`, then each agent that is not revoked, by `name`.
  - When `current` names none of them, the list ends with `{id: current, label: 'A computer that is no longer paired', selected: true}`.
- `fillDevices` reads `api('/api/agents')`. It renders only when `store.state?.me?.role === 'owner'` and the options are not empty, as `<label class="nb-boss nb-device"><span>Computer</span><select class="input" name="device">…</select></label>`. That reuses the Manager row's style, so no CSS changes.
- The Pages demo answers `/api/agents` with `[]`, so it never shows the row.

- [ ] **Step 1: Write the failing tests.**

```js
test('the Computer choice: any computer first, each paired one by name, and a removed pin still shows', () => {
  const agents = [{id: 'a1', name: 'Laptop', status: 'online'}, {id: 'a2', name: 'Desk PC', status: 'stale'}, {id: 'a3', name: 'Old', status: 'revoked'}];
  assert.deepEqual(deviceOptions(agents, null), [{id: '', label: 'Any computer', selected: true}, {id: 'a1', label: 'Laptop', selected: false}, {id: 'a2', label: 'Desk PC', selected: false}]);
  assert.equal(deviceOptions(agents, 'a2').find(o => o.selected).id, 'a2');
  assert.deepEqual(deviceOptions(agents, 'a3').at(-1), {id: 'a3', label: 'A computer that is no longer paired', selected: true});
  assert.deepEqual(deviceOptions([{id: 'a3', name: 'Old', status: 'revoked'}], null), []);
});
test('Edit saves the computer only when it changed, and keeps a pin it did not show', () => {
  const was = {name: 'Web', reportsTo: null, shape: 'rounded', tint: 2, device: 'a1'}, same = {name: 'Web', reportsTo: '', shape: 'rounded', tint: 2};
  assert.equal(editChanges(was, same), null);
  assert.equal(editChanges(was, {...same, device: 'a1'}), null);
  assert.deepEqual(editChanges(was, {...same, device: 'a2'}), {settings: {device: 'a2'}});
  assert.deepEqual(editChanges(was, {...same, device: ''}), {settings: {device: null}});
  assert.deepEqual(editChanges(was, {...same, name: 'Scout'}), {name: 'Scout'}, 'a rename by someone who sees no Computer row keeps the pin');
});
```

Write the smoke scenario `edit_pins_a_bot_to_one_computer`:
- Call `install_admin(page)` (`:2530`). Its `AdminServer.agents` (`:1912-1916`) has `a1` Laptop and `a2` Desk PC.
- Call `open_app(page, base, bots=EXTRA_BOTS)` (`:114`, `:33`).
- Set `store.state.me.role = 'owner'` the way `mount_admin` does (`:2538-2545`).
- Go to `#profile/<Writer>/edit`.
- Assert that `#edit-bot-form select[name=device]` offers `['', 'a1', 'a2']`, labelled `Any computer`, `Laptop` and `Desk PC`.
- Select `a1`, Save, and assert that the `Saved.` toast shows and `company_bot(await state(page), 'Writer')['settings']['device'] == 'a1'` (`:168`).
- Set the role to `member` and reopen Edit. Assert that the select has a count of 0. Rename the bot to `Drafter` and assert that the pin is still `a1`.
- Assert that the page does not overflow at phone width (`overflow(page) <= 0`, `:133`).

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/ui-profile-model.test.js`, then `npm run build:pages && npm run test:ui`. Expected: both new checks FAIL.
- [ ] **Step 3: Implement** `deviceOptions`, the `editChanges` rule, `data-was`, the slot, and `fillDevices`. In `editChanges`, `now.device === undefined` means no change, and `''` means `null`. Leave the `'edit-bot-form'` submit handler (`:452`) unchanged, since `editChanges` carries the change.
- [ ] **Step 4: Run the tests and see them pass.** Run `node --test tests/ui-profile-model.test.js && npm run build:pages && npm test && npm run test:ui`. Expected: PASS, with no drift in `docs/`.
- [ ] **Step 5: Commit.** `git commit -m "feat: the owner picks a bot's computer on its Edit page"`

---

### Task 11: The device feature list: needed, preferred, and the 60 days

**Files:**
- Modify: `shared/device-features.js`:
  - add `FEATURES`, `FEATURE_GRACE_DAYS`, `neededNow`, `requiredNow` and `updateNeeded`;
  - derive `DEVICE_FEATURES` from `FEATURES`;
  - update the header comment (`:1-11`), which says "needs" and "missing-feature" come later.
- Modify: `src/agent.js`. `redeemPairing` (`:184-206`) takes `features` and records them with `recordAgentFeatures` (`:396`) after the insert.
- Modify: `src/routes-public.js`. The pair route (`:186-197`) passes `features: b.features`.
- Modify: `agent/agent.mjs`. The `pair` command's body (`:125`) becomes `{code, name, permissions, features: DEVICE_FEATURES}`.
- Modify: `shared/ui-admin.js`. `agentCard` (`:159-169`) shows one line when `updateNeeded(agent.features)` is not empty.
- Modify: `docs/AGENT-PROTOCOL.md:40-46`, which is hand-written. Say the pair body carries `features` too, and that a device's card says when it needs an update.
- Regenerate: `docs/`.
- Test: `tests/device-feature-rules.test.js` (new), `tests/agent-guards.test.js:124` (the pairing body), and `tests/usability_smoke.py` (a new scenario, registered beside `:2915`).

**Interfaces:**
- `FEATURES` and `FEATURE_GRACE_DAYS = 60`, as in Global Constraints.
- `neededNow(name, {nowMs = Date.now(), list = FEATURES} = {}) → boolean`. It is true for a `needed` entry, for a `preferred` entry past its grace, and for a name not in `list`.
- `requiredNow(prefers, opts) → string[]`. These are the names in `prefers` that `neededNow` says count as needed. A caller that prefers a feature passes `needs: [...needs, ...requiredNow(prefers)]` to `chooseDevice`, then picks its path with `hasFeature(readAgentFeatures(store, agent.id), name)`.
- `updateNeeded(features, opts) → [{name, what}]`. These are the entries of `list` that are needed now and that `features` does not name. Anything that is not an array names nothing.
- `redeemPairing(store, {code, name, permissions = [], features})`. When `features` is `undefined` (an older app) nothing is recorded, and the device reports none until it beats.
- The device card line is `line('Needs an update', esc(\`Its app cannot ${whats.join(' or ')}. Update the app on this computer. Everything else it runs as before.\`), tag('Update', 'warn'))`. `whats` is the `what` of each entry `updateNeeded` returns.

- [ ] **Step 1: Write the failing tests.**

```js
const DAY = 86400000;
const LIST = [{name: 'new-thing-v1', since: '2026-12-01', use: 'preferred', what: 'do the new thing'}, {name: 'must-v1', since: '2026-12-01', use: 'needed', what: 'do the must'}];
test('the list is well formed, and what the device reports is every name on it', () => {
  for (const f of FEATURES) { assert.deepEqual(cleanFeatures([f.name]), [f.name]); assert.ok(['needed', 'preferred'].includes(f.use)); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(f.since) && Number.isFinite(Date.parse(f.since))); assert.ok(f.what); }
  assert.equal(new Set(FEATURES.map(f => f.name)).size, FEATURES.length);
  assert.deepEqual(DEVICE_FEATURES, FEATURES.map(f => f.name));
  assert.deepEqual(FEATURES.find(f => f.name === SECRET_INPUT_V1), {name: SECRET_INPUT_V1, since: '2026-11-26', use: 'needed', what: 'type passwords and codes'});
  assert.equal(FEATURE_GRACE_DAYS, 60);
});
test('a preferred feature keeps the older path for 60 days, then counts as needed; an unknown one always does', () => {
  const at = days => Date.parse('2026-12-01') + days * DAY;
  assert.equal(neededNow('new-thing-v1', {nowMs: at(59), list: LIST}), false);
  assert.equal(neededNow('new-thing-v1', {nowMs: at(60), list: LIST}), true);
  assert.equal(neededNow('must-v1', {nowMs: at(0), list: LIST}), true);
  assert.equal(neededNow('typo-v1', {list: LIST}), true);
  assert.deepEqual(requiredNow(['new-thing-v1'], {nowMs: at(10), list: LIST}), []);
  assert.deepEqual(requiredNow(['new-thing-v1'], {nowMs: at(61), list: LIST}), ['new-thing-v1']);
});
test('a preferred feature\'s older path still answers inside the 60 days, and is refused after', async t => {
  // SqliteStore with one capable online device that reports no features
  const choose = days => chooseDevice(store, {kind: 'browser.capture', needs: requiredNow(['new-thing-v1'], {nowMs: Date.parse('2026-12-01') + days * DAY, list: LIST})});
  assert.ok(choose(30).agent, 'inside the window it is still chosen');
  assert.equal(hasFeature(readAgentFeatures(store, choose(30).agent.id), 'new-thing-v1'), false, 'so the caller takes the older path');
  assert.deepEqual(choose(61), {reason: 'missing-feature', feature: 'new-thing-v1'});
});
test('which features a device needs an update for: none when it has them, a malformed list counts as none', () => {
  assert.deepEqual(updateNeeded([SECRET_INPUT_V1]), []);
  for (const none of [[], undefined, 'secret-input-v1', {}]) assert.deepEqual(updateNeeded(none).map(f => f.name), [SECRET_INPUT_V1]);
  assert.deepEqual(updateNeeded([], {nowMs: Date.parse('2026-12-02'), list: LIST}).map(f => f.name), ['must-v1'], 'a preferred one inside its window is not asked for yet');
});
test('a device reports its features when it pairs, an older app that sends none records none, and a heartbeat still replaces them', async t => {
  // redeemPairing(store, {code, name, permissions: [], features: [SECRET_INPUT_V1, 'BAD NAME']}) → readAgentFeatures(store, id) deepEquals [SECRET_INPUT_V1]
  // a second code redeemed with no features → []
  // recordAgentFeatures(store, id, []) after the first → []
});
```

- Update `tests/agent-guards.test.js:124`: if it compares the whole pair body, add `features: DEVICE_FEATURES` to the expected body.
- Write the smoke scenario `agents_page_says_which_computer_needs_an_update`:
  - Give `AdminServer.agents` `'features': ['secret-input-v1']` on Laptop and `'features': []` on Desk PC.
  - `install_admin(page)`, `open_app(page, base)`, then `panel = await mount_admin(page, 'agents')`.
  - Assert that Desk PC's `.st-g` card contains `Needs an update` and `type passwords and codes`, and that Laptop's does not.
  - Rerun `agents_page_status_signin_and_switches` (`:2557`). If it counts rows exactly, adjust only that count.

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/device-feature-rules.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** as the Interfaces block says. Keep `cleanFeatures`, `hasFeature`, `SECRET_INPUT_V1` and `UPDATE_DEVICE_LINE` exactly as Phase 0 left them.
- [ ] **Step 4: Run the tests and the build.** Run `node --test tests/device-feature-rules.test.js tests/device-features.test.js tests/agent-guards.test.js tests/choose-device.test.js && npm run build:pages && npm test && npm run test:ui`. Expected: PASS, with no drift.
- [ ] **Step 5: Commit.** `git commit -m "feat: device features are needed or preferred, with 60 days for the older path, reported at pairing and shown on the device card"`

---

### Task 12: Docs, the contract and the tick

**Files:**
- Modify: `docs/DEPLOYMENT.md:280-284`.
  - "While you drive" now says that only that bot waits, other bots keep working, and a model run no longer waits behind a parked browser task.
  - Add one bullet on `AGENT_CONCURRENCY` (default 3, from 1 to 8, one model run per CLI engine).
  - Add one bullet on choosing a bot's computer on its Edit page.
  - Add one bullet saying a computer whose app is too old is marked "Needs an update" under Settings → Local agents, and still does everything it can.
- Modify: `docs/AGENT-PROTOCOL.md:82-85` ("While the owner drives, bots wait…"), with the same change in protocol terms.
- Modify: `AGENTS.md`. Add one sentence to the `src/` bullet: device work picks its computer only through `chooseDevice` in `src/agent.js`, which a bot's owner-only `device` pin and a `needs` list of device features (`shared/device-features.js`) narrow.
- Modify: `docs/BUILD-PLAN.md:238`. Tick Phase AA step 1, add "device features" to its words, and add `(plan: docs/superpowers/plans/2026-11-26-phase-1-devices-and-parallel-work.md)`.
- Copy this plan to `docs/superpowers/plans/2026-11-26-phase-1-devices-and-parallel-work.md`.

- [ ] **Step 1: Make the doc edits above.** These are hand-written files, so edit them in place.
- [ ] **Step 2: Run the full gate.** Run `npm run check && npm test && npm run build:pages && git diff --exit-code docs/ ':!docs/*.md' ':!docs/superpowers' && npm run test:ui`. Expected: all PASS, with no drift.
- [ ] **Step 3: See it work** (the definition of done in §15):
  1. On this computer, run the server with `AGENT_BROWSER=1`, with two sites in `AGENT_BROWSER_ALLOWLIST`.
  2. Ask bot A and bot B to read one site each, at the same moment. Both replies arrive without either waiting for the other.
  3. Take over A's tab in its Computer view and ask B to read again. B answers while you still hold A.
  4. Run a second device from a checkout before Phase 0, which reports no features. Its card in Settings → Local agents says "Needs an update", and a bot pinned to it still reads a page.
  5. Write the results in the commit body.
- [ ] **Step 4: Commit.** `git commit -m "docs: devices and parallel work; tick Phase AA step 1"`

---

## Spec coverage (§5.5)

| §5.5 item | Task |
|---|---|
| One `chooseDevice`, the five reasons, the online rule | 1 |
| `needs` and `missing-feature`: browser 409, CLI and MCP 422, one line naming the feature | 1, 3, 4 |
| Browser row: pending (null) / 409 offline / 409 not available | 3 |
| CLI model row: 422 by code, read by `cliSignIn` / 422 `agent-offline` / 422 `not-pinned` | 4 |
| MCP over the device row: the same three | 4 |
| `agent-job` fan-out and `POST /api/agents/:id/tasks` keep their rules | Global Constraints (untouched) |
| Bot `device` pin, owner-only, through the existing bot settings route | 2, 10 |
| Account `deviceId` wins over the bot's | Phase 2 (the `deviceId` argument is ready for it) |
| Features: the general list with names and the release that first relied on each | 11 |
| Features reported at pairing and on each heartbeat, kept with the device | 11 (pairing); Phase 0 (heartbeat) |
| Needed versus preferred, `FEATURE_GRACE_DAYS` 60, then it counts as needed and the card says update | 11 |
| `secret-input-v1` masked fields hidden for a device without it | Phase 0 (kept; Global Constraints) |
| One queue per bot on the device; a takeover parks only that tab | 6 |
| Worker pool, `AGENT_CONCURRENCY`, one `model.run` per engine, keepalive counts running tasks | 7, 8 |
| One CDP WebSocket, many sessions; the interleave test | 5 |
| Server runtime: one queue per bot; a takeover refuses only its bot | 9 |
| Test: two bots' browser tasks overlap | 6 |
| Test: a takeover of A's tab does not delay B | 6, 9 |
| Test: same-engine `model.run` never overlap, different engines do | 7 |
| Test: a pinned task goes only to its device; a revoked pin is `not-pinned` | 1, 3, 4 |
| Test: each caller's unpinned answers stay as today | 3, 4 |
| Test: a device with no features gets no work that needs one and still gets the rest | 1, 3, 4 |
| Test: a preferred feature's older path still answers inside the 60 days | 11 |
| Done when: an older device app is told to update and still reads pages | 3, 11, 12 (manual) |

## Done when

- `npm run check`, `npm test`, `npm run build:pages` (with no drift) and `npm run test:ui` pass.
- Every test that §5.5 asks for exists and passes. The coverage table above names the task for each.
- The seven Review Focus cases each have a passing test.
- The manual check in Task 12 has been seen working.
