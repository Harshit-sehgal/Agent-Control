# Phase 1b: model fallbacks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan path (once merged):** `docs/superpowers/plans/2026-11-26-phase-1b-model-fallbacks.md`

**Goal:** With the main provider refused, a turn finishes on the second model. After the cool-off, the next turn is back on the first.

**Architecture:**
- `ai.fallbacks` replaces `ai.fallback`. It holds up to three saved provider-and-model picks, read in order, and an old single `ai.fallback` reads as a list of one.
- `resolveConfig` attaches them to a bot's config as `fallbacks: [config, …]`.
- `callModel` in `src/ai.js` walks the bot's own model, then the list:
  - `fallsBack(error)` decides whether a failure moves on;
  - only a call made before the bot's turn has acted moves on;
  - a provider that hit a limit or an outage rests in an in-memory `coolOff` map.
- **Turn notes.** `src/usage.js` already wraps every turn in `meterTurn`. Its AsyncLocalStorage scope now also carries a per-bot note: whether the bot has acted, which model answered it, and how many chat lines it was given.
- **The handoff.** A call answered by a model other than the bot's own gets a prompt rebuilt for the handoff. It is cut to the newest chat lines that fit, and it offers one read-only `search_chat` block. That block is run once in `src/bot-turn.js` over this chat's older lines, through `shared/message-search.js`.

**Tech Stack:**
- Node ≥ 22, with no npm runtime dependencies;
- `node --test`, with loopback provider stubs (`tests/ai-usage.test.js:11-27`);
- `mock.timers` for the clock;
- the Playwright smoke `tests/usability_smoke.py`.

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`.
- §3.3 is binding.
- §15 row "1b." is the definition of done.
- §2.2 item 18 is the problem.
- §2.2 item 17 governs the outside marks.
- The "ceilings" bullet of §3.3 needs goals (Phase 4). It is out of scope here: no goal exists to skip a fallback for.

## Global Constraints

**Repo rules**
- No npm runtime dependencies. No new `shared/` module.
- Every task leaves `npm run check`, `npm test` and `npm run build:pages` green, with no drift.
- Tasks 1, 2 and 6 touch `shared/`, so they never run side by side.
- **Beside Phase 1.** Phase 1 (`docs/superpowers/plans/2026-11-26-phase-1-devices-and-parallel-work.md`) may run at the same time. The two plans share several files:
  - `docs/`, rewritten by `build:pages`: Phase 1 Tasks 2, 10 and 11, and this plan's Tasks 1, 2 and 6;
  - `shared/ui-admin.js` and the `AdminServer` stub in `tests/usability_smoke.py`: Phase 1 Task 11 and this plan's Task 2;
  - `AGENTS.md` and `docs/DEPLOYMENT.md`;
  - `docs/BUILD-PLAN.md:238`.

  Whichever PR merges second rebases, re-runs `npm run build:pages`, and merges those files by hand.

**The list**
- **What it holds.** `ai.fallbacks` is an array of at most 3 entries `{providerId, model|null}`. The array is in order, and the same provider and model never appears twice.
- **Reading old state.** A stored `ai.fallback` with no `ai.fallbacks` reads as `[ai.fallback]`. Any save writes `ai.fallbacks` and deletes `ai.fallback`.
- **Saving.** `PATCH /api/ai` takes `fallbacks: [{providerId, model}] | []`. The old `fallback: {…} | null` is still accepted and means a list of one, or none.
- **Refusals.** More than 3 fails with `At most 3 fallback models.` An unknown provider is 404 `Provider not found.`, as today.
- **Listings.** They return `fallbacks`, plus `fallback` (the first entry or `null`) for any reader not yet moved.
- **Removing a provider** removes its entries from the list (`src/ai-providers.js:300`).
- **Attaching to a bot.** A bot's config gets `fallbacks`, a list of full configs built by today's `fallbackConfig` (`:328`), one per entry. Leave out:
  - an entry equal to the bot's own model;
  - an entry whose key is gone;
  - a duplicate.

  A fallback config carries no `fallbacks` of its own.

**The walk** (`callModel`, `src/ai.js:436`)
- **Order.** Models are tried in the order `[own, ...config.fallbacks]`. Each one is tried at most once per call, and each keeps its own one retry inside `callOnce` (`:444-468`).
- **When it moves on.** It moves to the next model only when all three hold:
  - `fallsBack(error)` (`:425`) is true. A 400, a 422 or `model-not-found` never moves on.
  - The bot has not acted in this turn. A bot has acted once any model call for it in this turn has returned. That returned text is the reply, with any tool block in it.
  - A next model is left.
- **Outside a turn** (`complete()` for memory or the Settings check, or any call with no `meterTurn` scope), nothing has acted. Those configs carry no `fallbacks` today in any case.
- **Later calls in the same turn.** Once a model answers a bot's call, that bot's later calls in the same turn start at that model. This covers a helper round, the reply after teammates answer, and a setup retry. A turn never changes models halfway.
- **The note on the trace.** A call answered by a model that is not the bot's own carries `fallbackFrom: {model: <own model name>, why}`, as today. `why` is `fallbackWhy` (`:414`) of the own model's failure, or the reason stored with its cool-off when it was skipped.

**The cool-off**
- **Where it lives.** `coolOff` is a `Map` in `src/ai.js`, in memory only, keyed by `coolKey(config)`:
  - `providerId` when there is one. Saved provider ids are `uuid()` (`src/ai-providers.js:155,170`), so they are unique across workspaces, and one owner's 429 never rests another owner's provider. Subscription CLI configs carry their provider's id too;
  - else `cli:<engine>` for a subscription CLI;
  - else `env:<baseUrl>`. That is the operator's own environment provider, shared by every workspace, so it rests for all of them together.
- **What sets it.** A failure that is a limit or an outage sets an entry `{until, why}`:
  - limits: 429, 402, `quota`, `usage-limit`;
  - outages: 5xx, 408, a timeout, a network failure, `agent-offline`.
  - `auth` (401 or 403), `not-signed-in` and `cli-missing` move the walk on but set no cool-off.
- **How long.** `until` is now plus `coolOffMs(error, now)`. That is the provider's `Retry-After` (seconds or a date, `error.retryAfter`) when it gives one, else 300000 (5 minutes). It is capped at 3600000 (1 hour) and never below 0.
- **Skipping.** The walk skips a model whose entry has not ended. When every model in the list is resting, the bot's own model is tried anyway. A cool-off never leaves a turn with nothing to try.
- **Clearing.** A success clears that model's entry. A restart starts with an empty map, so the bot's own model is tried at once.

**The handoff**
- **The cut.** A call answered by a model that is not the bot's own (in either direction) is sent `handoffInput`. That is the same envelope with `handoff: {from, to, why}` added after the existing keys, `tools.search_chat` described, and the thread cut to the newest lines that fit.
  - The window is `MAX_BOT_INPUT` (`src/ai.js:715`) for every model. The app knows no model's context window today, so the cut is `boundBotInput` with the thread trimmed oldest first.
  - The Anthropic cache breakpoints stay where `createEnvelope` puts them. `handoff` comes after the stable keys.
  - A fallback call misses the cache anyway, because it is a different model.
- **`search_chat`.** The block is ` ```search_chat {"query": "…"} ``` `.
  - It is honoured only in a turn whose reply came from a model other than the bot's own.
  - It runs at most once per turn, over this chat only.
  - It searches the user and bot lines older than the lines the model was given, at most 8 hits, 800 characters each, newest first.
  - The bot then gets one more call with `chatSearch: {query, hits}`.
  - A hit from a reply marked outside (`messagesCarryOutside`, `shared/asks.js:292`) marks the run `readOldChat: true`. Outside a run, it marks the reply line `outside: true`. Either way, later sends ask as for any outside chat line.

## Review Focus

1. **A half-done turn replayed on another model.** A bot's turn returns a reply with a send block, and a later call in that turn fails with a 503. Expected: that call fails normally, no fallback request is made, and the send is not proposed twice. Task 3 pins this.
2. **The walk chains forever, or a fallback walks its own list.** Expected: at most `1 + fallbacks.length` models are tried for one call, and a fallback config has no `fallbacks`. Task 3 pins this.
3. **A cool-off that never ends, or that skips every model.** Expected: it is capped at an hour, cleared by a success, and when every model is resting the own model is tried. Task 4 pins this.
4. **Old chat text that came from outside sneaks past the guards through `search_chat`.** Expected: a hit from an outside-marked reply makes the run count as having read outside content. Task 6 pins this.
5. **Stored state from before.** An install with `ai.fallback` set must keep its one fallback, both in listings and in turns, until the owner saves again. Task 1 pins this.

---

## Order and parallel work

| Wave | Tasks | Waits for |
|---|---|---|
| A | 1, 3 | nothing (1: `src/ai-providers.js`, `shared/setup.js`; 3: `src/ai.js`, `src/usage.js`) |
| B | 2, 4 | 2 waits for 1 (`shared/`, the listing shape); 4 waits for 3 (same function) |
| C | 5 | 4 (same function) |
| D | 6 | 5 (the turn note `kept`) and 2 (`shared/`) |
| E | 7 | all |

---

### Task 1: `ai.fallbacks`, saved and attached

**Files:**
- Modify: `src/ai-providers.js`:
  - `fallbackOf` (`:86`) becomes `fallbackPicks(ai) → [{providerId, model}]`;
  - the three listings (`:135`, `:140`, `:184`);
  - the provider removal (`:300`);
  - `fallbackConfig` (`:328`) takes one pick;
  - `withFallback` (`:342`) becomes `withFallbacks`;
  - `setDefaults` (`:416-433`).
- Modify: `shared/setup.js:672`. The workspace brief's `fallbackModel` names each fallback in order, and "none" when there are none.
- Regenerate: `docs/`.
- Test: `tests/ai-fallback-settings.test.js`. Extend the test at `:28-51` and add new ones.

**Interfaces:**
- Produces `fallbackPicks(ai)`, which applies the reading rule in Global Constraints. It is not called `fallbacksOf`, because `src/usage.js:50` already exports a `fallbacksOf(calls)` that `src/coordination.js` imports.
- Produces `setDefaults(store, {…, fallbacks})`. `fallback` is kept as an alias.
- Changes the resolved config from `{…, fallback}` to `{…, fallbacks: [config]}`, with the `fallback` key gone.

- [ ] **Step 1: Write the failing tests.**

```js
test('up to three fallbacks, in order, saved and listed; the old single fallback reads as a list of one', async t => {
  const listed = await ai.setDefaults(store, {fallbacks: [{providerId: a.id, model: 'x'}, {providerId: b.id, model: 'y'}]});
  assert.deepEqual(listed.fallbacks, [{providerId: a.id, model: 'x'}, {providerId: b.id, model: 'y'}]);
  assert.deepEqual(listed.fallback, {providerId: a.id, model: 'x'});
  assert.equal(Object.hasOwn(store.read().ai, 'fallback'), false);
  await assert.rejects(() => ai.setDefaults(store, {fallbacks: [1, 2, 3, 4].map(() => ({providerId: a.id, model: 'x'}))}), /^Error: At most 3 fallback models\.$/);
  store.state.ai = {...store.read().ai, fallbacks: undefined, fallback: {providerId: b.id, model: 'y'}};   // an install from before
  assert.deepEqual(ai.publicAi(store.read()).fallbacks, [{providerId: b.id, model: 'y'}]);
  assert.deepEqual(ai.resolveConfig(store, 'writer').fallbacks.map(f => f.model), ['y']);
  await ai.setDefaults(store, {fallback: null}); assert.deepEqual(store.read().ai.fallbacks, []);
});
test('a bot\'s config carries its fallbacks in order, never itself, never a repeat, and none carries its own', async t => {
  // default model = a/x; fallbacks [a/x, b/y, b/y, c/z] (saved straight into state) → resolveConfig fallbacks models ['y', 'z']
  // every fallback config has no `fallbacks`; deleting provider b leaves ['z']
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/ai-fallback-settings.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rewrite the existing assertions at `:32-51` from `.fallback` to `.fallbacks`, keeping what each one checks.
- [ ] **Step 4: Run the tests, the suite and the build.** Run `node --test tests/ai-fallback-settings.test.js tests/setup-more.test.js tests/ai-providers.test.js && npm run build:pages && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: up to three fallback models, in order"`

---

### Task 2: Three fallback choices in Settings → Models

**Files:**
- Modify: `shared/ui-admin.js`:
  - `fallbackForm` (`:533-544`) shows three selects, `fallback1`, `fallback2` and `fallback3`, labelled `First fallback`, `Second fallback` and `Third fallback`. Each offers `None` and the same rows as today. A select after a `None` is disabled;
  - the `'ai-fallback-form'` handler (`:910-915`) sends `{fallbacks: [...]}` with the empties and repeats dropped;
  - the help text becomes `When a bot's model is busy, down, times out or is signed out, the turn goes to these in order, before it has replied. A refused request is not sent elsewhere.`
- Regenerate: `docs/`.
- Test: `tests/usability_smoke.py`. Add the scenario `models_page_saves_fallbacks_in_order`, and make the `AdminServer` `/api/ai` stub (`:1978-1985`) answer `fallbacks`.

**Interfaces:**
- Consumes the `fallbacks` listing and the PATCH body from Task 1.

- [ ] **Step 1: Write the failing smoke.**
  - `install_admin(page)`, `open_app(page, base)`, then open Settings → Models.
  - Pick two fallbacks and Save.
  - Assert `server.sent('PATCH', '/api/ai') == [{'fallbacks': [{'providerId': …, 'model': …}, {…}]}]` and the toast `Fallback models saved.`
  - Assert that the third select is enabled and the fourth does not exist.
- [ ] **Step 2: Run it and see it fail.** Run `npm run build:pages && npm run test:ui`. Expected: the new scenario FAILS.
- [ ] **Step 3: Implement.** Then rerun the existing Models scenarios (`:2422`, `:2454`). They assert the default-model PATCH only, and must still pass.
- [ ] **Step 4: Run the build and the tests.** Run `npm run build:pages && npm test && npm run test:ui`. Expected: PASS, with no drift.
- [ ] **Step 5: Commit.** `git commit -m "feat: choose up to three fallback models in Settings"`

---

### Task 3: The walk, which moves on only before the turn has acted

**Files:**
- Modify: `src/usage.js`:
  - the scope (`:13`) holds `{sink, bots: new Map()}`;
  - `noteUsage` (`:16`) reads `.sink`;
  - `meterTurn` (`:32`) creates the store;
  - add `turnNote`.
- Modify: `src/ai.js`. `callModel` (`:436-443`) walks `[own, ...fallbacks]`.
- Test: `tests/ai-usage.test.js`. Rewrite the test at `:110-135` and add new ones.

**Interfaces:**
- Produces `export function turnNote(botId) → {acted: boolean, answeredBy: number, kept: number | null} | null`. It returns `null` outside a turn, and otherwise one mutable note per `botId || ''`, made on first use.
- `callModel` behaviour:
  - It starts at `note?.answeredBy ?? 0`.
  - On success it sets `acted = true` and `answeredBy = i`.
  - On a failure it moves on only under the rules in Global Constraints.
  - It reads `config.fallbacks ?? (config.fallback ? [config.fallback] : [])`, so it works with or without Task 1 and each task can be approved alone. Task 7 drops the `config.fallback` read once both have landed.

- [ ] **Step 1: Write the failing tests.** Use `stub`, `cfg` and `memStore` from `:11-27`, with `AI_RETRY_MS=0`.

```js
test('the walk goes down the list: own model, then each fallback once, each with its own retry', async () => {
  // own 503×2, first fallback 500×2, second 200 'from second'
  const out = await meterTurn(store, {}, () => executeCustomBot(bot, 'hi', cfg(own.port, {protocol: 'openai-chat', model: 'main-model', fallbacks: [cfg(f1.port, {protocol: 'openai-chat', model: 'f1'}), cfg(f2.port, {protocol: 'openai-chat', model: 'f2'})]})));
  assert.equal(out.value, 'from second');
  assert.deepEqual([own.requests.length, f1.requests.length, f2.requests.length], [2, 2, 1]);
  assert.deepEqual(out.calls[0].fallbackFrom, {model: 'main-model', why: 'the provider is having trouble'});
  // every model failing: rejects with the last model's error, and no model is asked twice beyond its own retry
});
test('a refused request never moves on', async () => { /* own 400 → rejects /400/, fallback has 0 requests */ });
test('once the bot has replied in a turn, a later call that fails is not replayed on another model', async () => {
  // inside one meterTurn: executeCustomBot(bot, 'one', config) answered by own; then executeCustomBot(bot, 'two', config) with own now 503×2
  // the second rejects /503/ and the fallback has 0 requests
});
test('a turn that moved stays on the model that answered it', async () => {
  // inside one meterTurn: first call own 503×2 → f1 answers; second call goes straight to f1 (own request count unchanged)
});
test('outside a turn nothing has acted, and the note is per bot', async () => {
  assert.equal(turnNote('b1'), null);
  // inside one meterTurn, bot b1 replies, then bot b2's first call fails 503 on own and is answered by its fallback
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/ai-usage.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** The old test's `fallback: cfg(…)` configs become `fallbacks: [cfg(…)]`. Its "a fallback never falls back again" line becomes the second test above.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/ai-usage.test.js tests/ai-fallback-settings.test.js tests/usage.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: a turn walks its fallbacks in order, only before it has replied"`

---

### Task 4: The cool-off and the way back

**Files:**
- Modify: `src/ai.js`. Add `coolOff`, `coolKey`, `coolOffMs` and `clearCoolOff` beside `retryWaitMs` (`:477`), and use them in `callModel`.
- Test: `tests/ai-cool-off.test.js` (new). It uses the same stubs as `tests/ai-usage.test.js` and `mock.timers.enable({apis: ['Date']})`.

**Interfaces:**
- Produces `export function coolOffMs(error, nowMs = Date.now()) → number | null`. It returns `null` when the failure sets no cool-off.
- Produces `export function coolKey(config) → string`.
- Produces `export function clearCoolOff()`, for tests and for nothing else.
- The rules are those in Global Constraints.

- [ ] **Step 1: Write the failing tests.**

```js
test('how long a provider rests: its Retry-After, else 5 minutes, at most an hour, and none for a refused key', () => {
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: '120'}), 120000);
  assert.equal(coolOffMs({providerStatus: 503}), 300000);
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: '86400'}), 3600000);
  assert.equal(coolOffMs({providerStatus: 429, retryAfter: new Date(Date.now() + 60000).toUTCString()}) > 50000, true);
  for (const e of [{providerStatus: 401}, {providerStatus: 403}, {code: 'not-signed-in'}, {code: 'cli-missing'}, {providerStatus: 400}]) assert.equal(coolOffMs(e), null);
  assert.deepEqual([coolKey({providerId: 'p1'}), coolKey({kind: 'local-cli', engine: 'claude'}), coolKey({baseUrl: 'https://x/v1'})], ['p1', 'cli:claude', 'env:https://x/v1']);
});
test('a rate-limited model is skipped until its cool-off ends, then the next turn is back on it', async t => {
  t.mock.timers.enable({apis: ['Date']});
  // turn 1: own 429 (Retry-After 120) ×2 → fallback answers
  // turn 2 (new meterTurn): own gets 0 new requests, fallback answers, fallbackFrom.why === 'rate limited'
  t.mock.timers.tick(121000);
  // turn 3: own answers; turn 4: own answers again (the success cleared the entry)
});
test('when every model is resting the bot\'s own is tried, and a restart forgets every cool-off', async () => {
  // own and the fallback both cooled; next call reaches own once; clearCoolOff() then own is tried first
});
test('a refused key moves the walk on but sets no cool-off', async () => { /* own 401 → fallback answers; next turn own is tried first again */ });
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/ai-cool-off.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Store `why` from `fallbackWhy(error)` with the entry, for the trace note.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/ai-cool-off.test.js tests/ai-usage.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: a provider that hit a limit or an outage rests, and the bot returns to it after"`

---

### Task 5: The handoff prompt

**Files:**
- Modify: `src/ai.js`:
  - add `handoffInput` beside `boundBotInput` (`:719`);
  - `executeCustomBot` (`:769-791`) passes `handoff`, a function that rebuilds the input for another model;
  - `callModel` uses it for any model at index > 0 and sets `turnNote(botId).kept`.
- Test: `tests/ai-handoff.test.js` (new).

**Interfaces:**
- Produces `export function handoffInput(input, {from, to, why}, max = MAX_BOT_INPUT) → string`:
  - It parses the envelope and adds `handoff: {from, to, why}` after the existing keys.
  - It adds `tools.search_chat`: `Search this chat's older lines: send a search_chat block {"query": "<words>"} and you are handed up to 8 matching lines. Read-only, once.`
  - It keeps the newest `thread` lines that fit, then applies `boundBotInput(…, max)`.
  - An input that is not a JSON object comes back as `boundBotInput(input, max)`.
- The call passed to `callModel` gains `handoff(note) → string`. `executeCustomBot` builds it as `note => handoffInput(input, note) + filesText`.
- Produces `export const keptLines = text => …`, the number of `thread` lines in the text sent.

- [ ] **Step 1: Write the failing tests.**

```js
test('a handoff keeps the job, says which model and why, offers search_chat, and keeps the newest lines that fit', () => {
  const env = {objective: 'o', contract: 'c', botRole: 'r', thread: Array.from({length: 30}, (_, i) => ({from: 'user', text: `line ${i} ` + 'x'.repeat(700)})), tools: {browser: 'b'}};
  const out = JSON.parse(handoffInput(JSON.stringify(env), {from: 'main', to: 'spare', why: 'rate limited'}, 12000));
  assert.deepEqual(out.handoff, {from: 'main', to: 'spare', why: 'rate limited'});
  assert.match(out.tools.search_chat, /search_chat block/); assert.equal(out.tools.browser, 'b');
  assert.equal(out.thread.at(-1).text.startsWith('line 29'), true, 'the newest line is kept');
  assert.ok(out.thread.length < 30 && JSON.stringify(out).length <= 12000);
  assert.deepEqual(Object.keys(out).slice(0, 4), ['objective', 'contract', 'botRole', 'thread'], 'the existing keys keep their order');
});
test('the fallback model is sent the handoff prompt and the bot\'s own model the usual one', async () => {
  // own 503×2; the fallback stub records its request body: its user content parses to an envelope with `handoff` and tools.search_chat;
  // a second turn answered by own has neither; turnNote('b1').kept equals the thread length sent
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/ai-handoff.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/ai-handoff.test.js tests/ai-usage.test.js && npm test`. Expected: PASS. `tests/ai-usage.test.js` also holds the `cache_control` breakpoint tests, which must pass unchanged.
- [ ] **Step 5: Commit.** `git commit -m "feat: a turn handed to another model gets a prompt cut for it and the search_chat tool"`

---

### Task 6: `search_chat`, with outside marks kept

**Files:**
- Modify: `shared/message-search.js`. Add `searchChat` and `parseSearchChat` beside `searchMessages` (`:31`), reusing `wordsOf` (`:15`) and `fold` (`:14`).
- Modify: `shared/asks.js`:
  - export `messagesCarryOutside` (`:292`);
  - `runReadOutside` (`:264-270`) also reads `run.readOldChat === true`.
- Modify: `src/bot-turn.js`. `runBotTurn` (`:46`) takes `chatKey = null`. After `replyWithSubagents` (`:55-56`) it runs one search round, and it returns `outsideChat`.
- Modify: `src/coordination.js`. The call at `:359` passes `chatKey: r.chatKey`. When `reply.outsideChat` is set, the update after it sets `live.readOldChat = true`.
- Modify: `src/routes-groups.js`. The call at `:131` passes `chatKey: bot.id`, and the reply line gets `outside: true` when `outsideChat` is set.
- Regenerate: `docs/`.
- Test: `tests/search-chat.test.js` (new).

**Interfaces:**
- Produces `searchChat(messages, query, {skipNewest = 0, limit = 8}) → [{id, from, at, text}]`.
  - It first leaves out the newest `skipNewest` lines, counted with the filter `threadContext` uses (`shared/bot-settings.js:215`: a user or bot line with text, steps included), so the skip matches what the model was given.
  - It then drops step lines from what remains, and returns the matches newest first, each text cut to 800 characters.
- Produces `parseSearchChat(output) → string | null`, the first block's `query`, trimmed. A missing or empty query is `null`.
- The round runs only when `turnNote(bot.id)?.answeredBy > 0` and the reply has a block:
  - `hits = searchChat(store.read().chats?.[chatKey], query, {skipNewest: turnNote(bot.id).kept ?? 0})`;
  - then one more `executor(bot, JSON.stringify({...envelope, chatSearch: {query, hits}}), config)`, whose text replaces the reply;
  - `outsideChat = messagesCarryOutside(state, hitMessages)`.
- On the bot's own model, a `search_chat` block is plain text and nothing runs.

- [ ] **Step 1: Write the failing tests.**

```js
test('searchChat finds older lines in this chat only, newest first, and leaves out what the model was given', () => {
  const chat = [u('the invoice from Acme', 1), b('noted', 2), {role: 'bot', step: true, text: 'invoice step', at: t(3)}, u('Acme invoice paid', 4), u('newest about invoice', 5)];
  assert.deepEqual(searchChat(chat, 'acme INVOICE', {skipNewest: 1}).map(h => h.text), ['Acme invoice paid', 'the invoice from Acme']);
  assert.deepEqual(searchChat(chat, '', {}), []);
  assert.equal(parseSearchChat('x\n```search_chat\n{"query": " acme "}\n```'), 'acme');
  assert.equal(parseSearchChat('```search_chat\n{}\n```'), null);
});
test('a turn on a fallback model may search once, and gets the hits in one more call', async t => {
  // executor stub: first call sets turnNote(bot.id).answeredBy = 1, kept = 1 and returns a search_chat block; second returns 'answer'
  // runBotTurn inside meterTurn → output 'answer'; the second envelope has chatSearch.hits; a third block in 'answer' is not run
});
test('on the bot\'s own model the block runs nothing', async t => { /* answeredBy 0 → one executor call, output unchanged */ });
test('an old line from a run that read outside content marks this run, so its sends ask', async t => {
  // a hit whose message is a bot reply with outside: true → runBotTurn returns outsideChat: true;
  // via runGroup, the run gets readOldChat and outsideRead(state, {runId}) is true
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/search-chat.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** `shared/message-search.js` and `shared/asks.js` must stay pure, because Node tests import them.
- [ ] **Step 4: Run the tests, the build and the suite.** Run `node --test tests/search-chat.test.js tests/message-search.test.js tests/asks.test.js && npm run build:pages && npm test`. Expected: PASS, with no drift.
- [ ] **Step 5: Commit.** `git commit -m "feat: a bot on a fallback model can search its chat's older lines, with outside marks kept"`

---

### Task 7: Docs and the tick

**Files:**
- Modify: `src/ai.js`. Drop the `config.fallback` read that Task 3 kept, now that Task 1 has landed.
- Modify: `AGENTS.md`, the "Usage and cost" bullet (`:46`). Replace "The fallback model (`ai.fallback`, `PATCH /api/ai`) answers a turn once … it never chains and never retries a 400" with:
  - up to three `ai.fallbacks`, walked in order only before the turn has replied;
  - the in-memory cool-off (Retry-After, else 5 minutes, at most an hour);
  - the handoff prompt and `search_chat`;
  - still never a 400.
- Modify: `docs/DEPLOYMENT.md:141-144`. Its "Usage limit" bullet says "There is no silent fallback and no retry", which is already untrue whenever a fallback is set. Say instead that the turn goes to the fallbacks in order when it has not replied yet, that a limited model rests until its cool-off ends, and that the Switch card still appears when no fallback answers.
- Modify: `docs/BUILD-PLAN.md`. Add `- [x] 1b. Model fallbacks: up to three in order, only before a turn has replied, a cool-off and the way back, a handoff prompt with search_chat (plan: docs/superpowers/plans/2026-11-26-phase-1b-model-fallbacks.md)` after step 1 (`:238`).
- Copy this plan to `docs/superpowers/plans/2026-11-26-phase-1b-model-fallbacks.md`.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run the full gate.** Run `npm run check && npm test && npm run build:pages && npm run test:ui`. Expected: PASS, with no drift.
- [ ] **Step 3: See it work** (§15 row 1b):
  1. Save a provider with a key that is refused or rate-limited as the default model, and a working one as the first fallback.
  2. Ask a bot something. The reply arrives, with the fallback note naming both models.
  3. With a stub that answers 429 with `Retry-After: 60`, wait out the minute and ask again. The trace shows the bot's own model answered.
  4. Write the results in the commit body.
- [ ] **Step 4: Commit.** `git commit -m "docs: model fallbacks; tick Phase AA step 1b"`

---

## Spec coverage (§3.3)

| §3.3 item | Task |
|---|---|
| A list of up to 3, `ai.fallbacks` through `PATCH /api/ai`, old `ai.fallback` as a list of one | 1, 2 |
| The walk: own model then the list; `fallsBack` decides; a 400 never moves on; each model keeps its one retry | 3 |
| Only a turn that has done no work moves on | 3 |
| Cool-off: Retry-After else 5 minutes, up to 1 hour, in memory, by provider; success clears; a restart tries own at once | 4 |
| Bounded handoff: same prompt, cut to the newest lines that fit; `fallbackFrom` says which model and why | 5 |
| `search_chat` over older text in this chat, built on `shared/message-search.js`; outside marks kept | 6 |
| Ceilings: a goal's model tiers | Phase 4 (no goals yet); tokens per model and prices are unchanged |

## Done when

- `npm run check`, `npm test`, `npm run build:pages` (with no drift) and `npm run test:ui` pass.
- The five Review Focus cases each have a passing test.
- The manual check in Task 7 has been seen working.
