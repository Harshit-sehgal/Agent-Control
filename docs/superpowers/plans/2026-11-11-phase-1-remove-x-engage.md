# Phase 1: Remove X-engage, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the X/Twitter drafting feature set: the capture extension, feed reading, candidates, drafts, evidence, reminders, voice settings and the X seed. Every other feature keeps working, and the tree stays green after every task.

**Architecture:** Removal runs from the outside in. First the extension and capture token go, then the UI surfaces and the feed path, then the Pages engine and the server routes, then the shared domain and seed, and last the database tables and docs. Each task removes one slice together with its tests, so every commit is green. Phase 2 replaces the seed and the Pages engine properly. This phase leaves a neutral one-bot seed and a generic simulator.

**Tech Stack:** Node >=22.5 with `node:sqlite`, vanilla browser JS in `shared/`, `node --test`, and the Python Playwright smokes.

**Spec:** `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md` (Phases → 1, and "X-engage footprint"). The line ranges below were re-mapped on 2026-11-11 against commit `2b503a7`. Re-check them with `grep` before editing, because each task shifts the lines that later tasks name.

## Global Constraints

- Zero npm runtime dependencies. `shared/` stays browser-safe (no `node:` imports, no `../src/`, no `process.env`).
- Every module reachable from `shared/index.html` is listed in `shared/assets.js`. Removing a shared file means removing its entry too.
- `docs/` copies of shared files are generated. After deleting a shared file, add its name to the `stale` list in `scripts/build-pages.js:35` and run `npm run build:pages`. Otherwise `tests/pages-bundle.test.js` ("docs/ holds no generated file the asset list does not name") fails.
- The CSP meta in `shared/index.html` must stay equal to `META_CSP` in `shared/core.js`.
- **Keep the X posting guard:** `POSTING_HOSTS`, the trailing-dot normalisation and the click/type refusal in `shared/bot-browser.js`, and the matching code in `agent/browser.mjs`. AGENTS.md: "Click/type on X is refused in validation; keep it that way."
- Every task ends with `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` all passing. Commit only your own files (`git add <paths>`, never `-A`).
- Commit subjects use `refactor:` or `feat:`/`fix:`, matching history, and end with the `Co-Authored-By` line.
- Test command for one file: `node --experimental-sqlite --import ./tests/ai-env.js --test tests/<name>.test.js`.

## Review Focus

1. **An existing database full of X data upgrades cleanly.** Booting a v10 database that has candidates, drafts, evidence, a capture token and X settings reaches v11. Groups, bots, chats, memory and tasks are intact, and the X tables are gone. (Task 7)
2. **An old backup file still restores.** A backup taken before this phase lists `candidates`, `drafts` and `evidence`. It restores with those tables ignored, not refused. (Task 7)
3. **A run parked in `awaiting_feed` at upgrade does not hang.** It loads as `cancelled` with an error naming the removal, and the group is not stuck "busy". (Task 3)
4. **Queued `reminder` or `candidate-draft` tasks left in the queue at upgrade do not crash the worker.** The migration cancels them. (Task 7)
5. **A cached old client calling a removed route gets a clean 404 JSON, not a 500.** The X posting guard still refuses click/type on `x.com`. (Tasks 5 and 3)

---

### Task 1: Extension, capture endpoint and capture token

**Files:**
- Delete: `extension/` (whole folder), `shared/demo-feed.html`, `tests/extension.test.js`
- Modify:
  - `scripts/check.mjs` (drop the `extension` root, lines 5 and 23)
  - `src/routes-public.js` (`POST /api/capture` 134-147 and its imports 4-5)
  - `src/workspaces.js` (`byCaptureToken` 220-225)
  - `shared/workflow.js` (`rotateCaptureToken` 493-506)
  - `src/routes-workflow.js` (capture-token route 38; `/api/state` 21 stops deleting `captureToken`)
  - `shared/core.js` (`captureToken` in `initialState`)
  - `src/sqlite-store.js` (`captureToken()` 652; the `capture_token` read and create in the loader, 529/546/620)
  - `shared/ui-panel.js` ("Replace capture token", 314)
  - `shared/ui-actions.js` (capture-token actions 125-128)
  - `shared/assets.js` (`demo-feed.html`)
  - `scripts/build-pages.js` (`stale` += `demo-feed.html`)
- Tests to modify: `tests/check-coverage.test.js` (45, 73, 81), `tests/version.test.js` (9-18, the manifest version check), `tests/assets.test.js` (143), `tests/workspaces-restore.test.js` (37), `tests/http-hardening.test.js` (149)

**Interfaces:**
- Produces: no `captureToken` anywhere in state, store or API. `POST /api/capture` → 404.

- [ ] **Step 1: Write the failing tests.** In `tests/api.test.js` add `test('the X capture endpoint is gone', …)`. Assert that `POST /api/capture` with any body returns status 404, and that `GET /api/state` JSON has no `captureToken` key. In `tests/check-coverage.test.js`, replace the extension expectations with an assertion that the roots do not include `extension`.
- [ ] **Step 2: Run them and confirm they fail.** `node --experimental-sqlite --import ./tests/ai-env.js --test tests/api.test.js tests/check-coverage.test.js` → FAIL, because capture returns 200/401 and `extension` is a root.
- [ ] **Step 3: Remove the files and code listed above.** Delete the test cases that only exercised capture, the token or the extension, and edit the rest.
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → all pass.
- [ ] **Step 5: Commit.** `refactor: remove the X capture extension and capture token`

### Task 2: UI surfaces for drafts, posts, evidence, reminders, voice and samples

**Files:**
- Delete:
  - `shared/usability.js`: all four prefs it holds are candidate or draft ones.
  - `shared/chat-engine.js`: the offline intent classifier and X chips.
  - `tests/usability.test.js`: keep any non-X assertions by moving them to `tests/ui-model.test.js`.
- Modify:
  - `shared/ui-panel.js`:
    - X rows in `groupHome` (37-50);
    - `draftsBody`/`draftsSection`, `visiblePosts`/`postsBody`/`postsSection`, `remindersSection`, `voiceSection` (118-204);
    - the section map (293), `refreshLists` (297-301), "Posting to X" (328);
    - the `draftCard`/`postCard` import (12).
  - `shared/ui-views.js`:
    - `draftCard`, `evidencePanel`, `postCard` (75-130);
    - the post and draft branches of `itemHtml` (189-197), `itemKey` (269);
    - the X chips (231, 320), the `feeds` pill in `threadHead`, imports 5 and 10.
  - `shared/ui-actions.js`:
    - `draftOp` (41), `share-post`, `new-reminder` (73-74);
    - lines 152-215: samples, `draft-*`, `copy-thread`, evidence, `remove-candidate`, `remove-reminder`;
    - forms `approve-form`, `candidate-form`, `settings-form`, `schedule-form`, `.edit-form`, `.evidence-form`;
    - `PREF_BY_CONTROL`, `candidate-search`, the edit-form meter (392-420);
    - the hardcoded `draft.create`/`evidence.add` permission list (338).
  - `shared/ui-sheets.js`:
    - the X rows of `attachSheet` (47-52), `sharePostSheet`, `reminderSheet`, `localInput`, `scheduleDraftSheet` (57-106);
    - the X commands (129), `textResults` (138-148), the `minuteCeil` import (7).
    - Keep `BOT_TEMPLATES`.
  - `shared/ui-model.js`:
    - `X_GROUP`, `ACTIVE_DRAFTS`, `POST_LIMIT`, `draftLength`, `threadParts`, `threadPosts`, `lengthLabel`, `draftStage` (9-77);
    - the drafts part of `needsYou`, and the drafts in `waitingOnYou`/`totalWaitingOnYou` and the chat-list previews;
    - posts and drafts in `timeline`;
    - the `drafts`, `posts`, `reminders` and `voice` entries of `GROUP_SECTIONS`, `LEGACY_TABS`, and the `#inbox` route (374-375).
    - Leave the feed symbols for Task 3.
  - `shared/ui-chat.js`: the `localReply` X intents (84-106). Keep `create-bot` and the default reply. Remove the `chat-engine` import (6).
  - `shared/ui-store.js`: `prefs`, `postQuery`, `editDraft`, `editText`, `openEvidence`, `isXGroup`, `setPref`/`PREF_KEYS`, and their resets.
  - `shared/app.js`:
    - the reminder and draft due handling (88-89);
    - the `.edit-form`/`.evidence-form` handling (230), the evidence toggle (265-266).
    - Keep the first-boot Pages seed call; Task 4 changes it.
  - `shared/app.css`: `.post*`, `.draft*`, `.evidence-*` and the other X-only rules (179, 197-233, 302, 357-365, 527, 578).
  - `shared/index.html:5`: the meta description becomes "Local-first personal bot platform". The CSP line is untouched.
  - `shared/assets.js`: drop `usability.js` and `chat-engine.js`. `scripts/build-pages.js` `stale` += both.
- Tests to modify:
  - `tests/chat-ui.test.js` (19, 29, 33)
  - `tests/ui-model.test.js` (18, 31, 37, 43, 61, 71, 91, 202, 246, 254, 346-386, 471, 561, 578+)
  - `tests/escaping.test.js` (88, 262)
  - `tests/ui-batch-d.test.js` (84, 95)
  - `tests/ui-a11y.test.js` (41)
- Smokes:
  - `tests/usability_smoke.py`: delete `draft_one`, `approve_to_posted`, `schedule_exact_time`, `edit_skip_rewrite`, `draft_filters`, `share_and_find_post`, `load_and_remove_samples`, `reminders`, `voice_settings`.
  - `tests/polish_smoke.py`: keep `first_run`, `group_chat_flow`, `quick_navigation` and `history_routes`, but drop any draft or post assertions in them.

**Interfaces:**
- Produces: `GROUP_SECTIONS` without `drafts`, `posts`, `reminders` or `voice`. No UI code calls `/api/candidates*`, `/api/drafts*`, `/api/evidence*`, `/api/schedules`, `/api/settings` or `/api/demo/*`.

- [ ] **Step 1: Write the failing test.** In `tests/ui-model.test.js` add `test('group sections hold no X surfaces', …)`. It asserts that `GROUP_SECTIONS` has none of `drafts`, `posts`, `reminders` or `voice`, and that `shared/assets.js` lists neither `usability.js` nor `chat-engine.js`.
- [ ] **Step 2: Run it and confirm it fails.** `node --experimental-sqlite --import ./tests/ai-env.js --test tests/ui-model.test.js` → FAIL.
- [ ] **Step 3: Remove the UI code and files listed above, and edit the listed tests.** Then `grep -rn "api/candidates\|api/drafts\|api/evidence\|api/schedules\|api/demo\|api/settings" shared/ui-*.js shared/app.js` must print nothing.
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → pass. `npm run test:ui` → pass, with the X steps removed.
- [ ] **Step 5: Commit.** `refactor: remove draft, post, evidence, reminder and voice UI`

### Task 3: The feed path (`awaiting_feed`, home-feed reads)

**Files:**
- Modify:
  - `shared/run-state.js`: `awaiting_feed` in `BUSY_STATUSES` (20) and `INTERRUPT_STATUSES` (30).
  - `shared/run-follow.js`: the feed branch (24, 87-99) and the use of `feedPauseAction`.
  - `shared/app.js:28`: the feed status.
  - `shared/ui-model.js`: `FEED_WAIT`, `FEED_OPEN`, `feedPauseAction` (100-118), the `feed-permission` grant (161), `stuckFeedReads` (189-195), and the feeds part of `waitingOnYou`.
  - `shared/ui-chat.js`: the feed branch of `watchQueuedRun` (48-73).
  - `shared/ui-actions.js`: the feed branches (261-262, 278).
  - `shared/bot-browser.js`: `HOME_FEED_URL` (32), `feedPageText`, `homeFeedRequest`, `queueFeedRead` (202-232). Keep the posting guard.
  - `src/bot-browser.js`: the feed branch (153-166) and the `feedPageText` import (16).
  - `src/coordination.js`:
    - the feed interrupt (71-74), `holdForFeed` (343-364) and its callers (132, 212, 482);
    - `resumeFeedRun` (366-382) and its imports in `src/routes-public.js` (8, 21, 182), `src/routes-account.js` (11, 125) and `src/routes-groups.js` (10, 181);
    - `HOME_FEED_URL` (272), and `purpose!=='feed'` (412).
  - `shared/coordination.js`: in `planTracked` (82-112), `needsFeed` and `feedBotId`. Keep the rest of `planTracked`; Task 6 removes the draft half.
  - `shared/workflow.js`: in `forgetBot` (383), the `awaiting_feed` read. In `migrate`, add the run mapping below.
  - `src/backup.js`: the `awaiting_feed` text (74-75).
- Tests to modify:
  - `tests/bot-browser.test.js` (32-35, 93, 199, 217, 241). Keep test 22 and every posting-guard test.
  - `tests/run-follow.test.js` (67, 74)
  - `tests/coordination.test.js` (43)
  - `tests/engine-parity.test.js` (318)

**Interfaces:**
- Produces: `migrate(state)` in `shared/workflow.js` turns every run or group run whose `status==='awaiting_feed'` into `status:'cancelled'` with `error:'X feed reading was removed'`. It is idempotent.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/workflow.test.js`: `test('a run parked on the X feed loads as cancelled', …)`. Build a state with one group run `{status:'awaiting_feed'}`, call `migrate`, and assert `status==='cancelled'` and `error==='X feed reading was removed'`. Assert that a second `migrate` leaves it unchanged.
  - In `tests/run-state.test.js`: assert that `BUSY_STATUSES` does not include `'awaiting_feed'`.
  - In `tests/bot-browser.test.js`: keep, and if missing add, `test('click and type on x.com are still refused', …)`. Validating `{url:'https://x.com/home', steps:[{op:'click', index:1}]}` throws, and so does the same with host `x.com.`.
- [ ] **Step 2: Run them and confirm the first two fail.** `node --experimental-sqlite --import ./tests/ai-env.js --test tests/workflow.test.js tests/run-state.test.js tests/bot-browser.test.js`.
- [ ] **Step 3: Remove the feed code and add the `migrate` mapping.** Then `grep -rn "awaiting_feed\|HOME_FEED_URL\|queueFeedRead\|resumeFeedRun\|holdForFeed" shared src agent` must print only the `migrate` mapping.
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → pass.
- [ ] **Step 5: Commit.** `refactor: remove X home-feed reading`

### Task 4: Pages engine without X

**Files:**
- Modify:
  - `shared/local-api.js`: remove
    - `processLocal` (52-56), the candidates route in `runApi` (98), the draft due handling (179-181) and the reminder due handling (184-195);
    - the routes `/api/demo/seed`, `/api/settings`, `/api/candidates*`, `/api/drafts/*` (230-254);
    - `/api/schedules` (287-288), the evidence routes (298-300) and `/api/reset-demo` (325);
    - `scratch.drafts` and its comment (159-163).
    - The read guard at 37 checks `Array.isArray(state.groups)` instead of `state.candidates`.
  - `shared/group-simulator.js`: delete the per-type cases `source`, `scoring`, `context`, `writing`, `review` and `manual` (74-98). Every bot now takes the generic default branch, and checkpoints, handoffs and cancel stay as they are.
  - `shared/app.js` (141-145): on the first Pages boot, call `POST /api/reset-workspace` (new, below) instead of `/api/demo/seed`. Skip it when the workspace already has groups.
  - `shared/local-api.js`: new route `POST /api/reset-workspace`. It replaces the stored state with `initialState()` and returns it.
- Tests to modify:
  - `tests/pages.test.js`: tests 26 (X part), 31, 45 (reminders part), 58 and 205.
  - `tests/coordination-runs.test.js`: the simulator X cases.
  - `tests/bot-flex.test.js`: 39, 51, 98, 186, 195, 227, 236, 284, 454, 574.
  - `tests/engine-parity.test.js`: the X-typed bots become untyped.

**Interfaces:**
- Consumes: `initialState()` from `shared/core.js`. Its seed changes in Task 6, and this task must not depend on the seed's contents.
- Produces: `POST /api/reset-workspace` → `200 {state}` in the Pages backend only. The server does not get this route.

- [ ] **Step 1: Write the failing tests.** In `tests/pages.test.js`:
  - `test('the Pages backend has no X routes', …)`: `/api/candidates`, `/api/drafts/x/approve`, `/api/demo/seed`, `/api/schedules` and `/api/settings` each return 404.
  - `test('first Pages boot seeds the starting workspace', …)`: `POST /api/reset-workspace`, then `GET /api/state`. The groups deep-equal `initialState().groups`.
- [ ] **Step 2: Run them and confirm they fail.** `node --experimental-sqlite --import ./tests/ai-env.js --test tests/pages.test.js`.
- [ ] **Step 3: Remove the X routes and simulator cases, and add the reset route and boot call.**
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → pass.
- [ ] **Step 5: Commit.** `refactor: Pages engine without X routes`

### Task 5: Server routes, candidate processing, draft tick and `makeDraft`

**Files:**
- Modify:
  - `src/routes-workflow.js`: remove settings (30), demo seed and reset (33-34), candidates (39-52), drafts (54-71), evidence (74-79) and schedules (81-82). Keep `/api/state`, `/api/tasks*` and `/api/retention*`.
  - `src/app.js`: `processCandidate` (41-63), imports 19/20/22, `wf.recoverInterrupted` (93), and the `process` parameter (124/128).
  - `src/handlers.js`: the `'candidate-draft'` handler (61-70).
  - `src/scheduler.js`: delete `tick` and `startScheduler`. Keep `startRetention`. `src/app.js:108` starts only retention.
  - `src/ai.js`: delete `makeDraft` (513-527), and drop `templateDraft` from the import (1).
- Tests to modify:
  - `tests/scheduler.test.js`: 47 and 149. The stop tests 68/79/98 drive `startRetention` instead.
  - `tests/ai.test.js` (23-116, 203-258), `tests/ai-protocols.test.js` (31, 118) and `tests/prompt-injection.test.js` (48) used `makeDraft` as the vehicle for protocol tests. Switch them to `complete({instructions, input, config})`, exported from `src/ai.js:396`, keeping every protocol assertion.
  - `tests/api.test.js` (29, 117, 141), `tests/e2e-journey.test.js` (92), `tests/persistence-api.test.js` (41, 92)
  - `tests/tasks-handlers.test.js` (13, 114), `tests/queue.test.js` (220), `tests/queue-recovery.test.js` (75, 121)

**Interfaces:**
- Produces: the server answers `POST /api/candidates`, `PATCH /api/drafts/:id`, `POST /api/evidence`, `GET /api/schedules`, `POST /api/settings` and `POST /api/demo/seed` with a 404 JSON body, the same shape the router gives any unknown route.

- [ ] **Step 1: Write the failing test.** In `tests/api.test.js`: `test('removed X routes answer 404 JSON', …)`. Signed in as owner, each route above returns status 404, and the body parses as JSON with an `error` string.
- [ ] **Step 2: Run it and confirm it fails.** `node --experimental-sqlite --import ./tests/ai-env.js --test tests/api.test.js`.
- [ ] **Step 3: Remove the code, and move the protocol tests onto `complete()`.**
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → pass. `grep -n "makeDraft\|processCandidate\|candidate-draft\|startScheduler" -r src tests` prints nothing.
- [ ] **Step 5: Commit.** `refactor: remove X server routes, draft tick and makeDraft`

### Task 6: Shared domain and the new seed

**Files:**
- Delete: `shared/evidence.js`, `tests/evidence.test.js`. Drop the `assets.js` entry; `build-pages.js` `stale` += `evidence.js`.
- Modify:
  - `shared/core.js`:
    - remove `candidateInput`, `scoreCandidate`, `templateDraft`, `delayWindow`, `scheduleApprovalAt`, `scheduleApproval`, `markDue`, `minuteCeil` and `DEMO_SAMPLES`;
    - replace `initialState` (below).
    - Keep `uuid`, `clamp`, `cleanText`, `validHttpUrl`, `activity`, `CSP` and `META_CSP`.
  - `shared/workflow.js`:
    - remove `MAX_CANDIDATES`;
    - in `migrate`: the settings backfill (44-49), candidates/drafts/evidence (50-54) and the x-engage lead backfill (75-81);
    - remove `findDraft` … `draftAction` (91-299), keeping only the `retention` branch of `updateSettings` as `updateRetention(state, retention)`;
    - remove the x-engage delete guard (430), `recoverInterrupted`, `addSchedule`, `removeSchedule`, `scheduleView`, `removeCandidate` and `resetDemo`, plus imports 11 and 20.
    - Rename every caller of `updateSettings` to `updateRetention`.
  - `shared/contracts.js`: remove the actions `draft.create` and `evidence.add`, the inputs `evidence` and `source_post`, the field type `evidence_list` (22-24, 34, 114-120), and the writing/review defaults in `defaultPermissions` (44-47).
  - `shared/tasks.js`: remove the `reminder` kind (40-47), `candidate-draft` (60, 99, 185), the reminder title (184), `SCHEDULED` (87) and `migrateSchedules` (355-413).
  - `shared/bot-settings.js`: remove `X_ENGAGE_PIPELINE` (22) and the x-engage defaults (125-146). Keep the `tracked` mode.
  - `shared/coordination.js`: remove the `NEED` rules (69-75), `REFUSAL` (77), the draft half of `planTracked` (`draftBotId`, `wantsDraft`) and of `assessTask` (116-139), the `createRun` X task fields (238) and `feedText` (299, 312). Keep `planHandoffs`, `handoffTargets`, `instructLead`, `leadShouldRunGroup` and `summonableGuests`.
  - `src/coordination.js`: `attachRunDraft` (21, 281) and the `assessTask` draft uses (223, 327).
- Tests to modify:
  - `tests/core.test.js` (7, 8, 13, 18, 25, 33, 43, 71)
  - `tests/workflow.test.js` (23, 38, 46, 58, 76, 91, 120, 132, 158, 203, 273, 294, 357, 392, 416, 431, 445)
  - `tests/contracts.test.js`, `tests/task-validation.test.js` (27, 39), `tests/attempt-budget.test.js` (60), `tests/task-safety.test.js` (24, 63), `tests/coordination.test.js` (126), `tests/chats.test.js`
  - `tests/workspaces-restore.test.js` (117): its reminder becomes a `bot-task`.
  - Smokes: `TEAM` in `tests/polish_smoke.py:27` and `tests/usability_smoke.py:28`, and `tests/live_smoke.py:174-181`, become `'team-home'`.

**Interfaces:**
- Produces: `initialState()` returns
  ```js
  {version:1, createdAt, settings:{}, groups:[{id:'home', name:'Home', description:'Your bots', bots:[
    {id:'atlas', name:'Atlas', instructions:'You are Atlas, the primary bot. Answer the owner, and hand each piece of work to the bot whose job it is.', settings:{lead:true}}
  ]}], runs:[], tasks:[], events:[]}
  ```
  Phase 2 replaces this with the primary-bot seed.
- Produces: `updateRetention(state, retention) → state`.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/core.test.js`: `test('the starting workspace is one Atlas bot and nothing from X', …)`. Assert that `initialState().groups` has length 1, its id is `'home'`, its bots are `['atlas']` by id, and none of `candidates`, `drafts`, `captureToken`, `topics` or `schedules` is a key of the state or of its `settings`.
  - In `tests/tasks-handlers.test.js`: queuing a task of kind `'reminder'` or `'candidate-draft'` is rejected as an unknown kind.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Remove the code and write the new seed and `updateRetention`.**
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → pass. `npm run test:ui` → pass.
- [ ] **Step 5: Commit.** `refactor: remove X domain code and seed one Atlas bot`

### Task 7: Database and backups

**Files:**
- Modify:
  - `src/sqlite-store.js`:
    - remove the `TABLE_SHAPES` entries `candidates`, `drafts` and `evidence` (99-122);
    - `DOC_TABLES` becomes `['runs', 'group_runs', 'group_messages']` (28);
    - remove the readers (62-63, 561-565) and `failCandidate` (448-480);
    - remove the settings X columns from the loader (528, 536-544) and the writer (623-624).
    - The settings row now writes only `retention`.
    - The empty-roster seed in `loadDocument` (513-521) keeps using `initialState().groups`.
  - `src/sqlite-store.js` `MIGRATIONS`: append `{to: 11, up(db) { … }}` (sketched after this list).
  - `src/backup.js`:
    - remove `candidates`, `drafts` and `evidence` from `EXPORT_TABLES` (36) and the row handling (187, 195-199, 212, 289);
    - add `const RETIRED_TABLES = ['candidates', 'drafts', 'evidence']`;
    - `validateBackup` and the restore ignore those tables when present, and never require them.
- Tests to modify:
  - `tests/sqlite-store.test.js` (16, 95, 119), `tests/persistence-store.test.js` (109), `tests/credentials-backup.test.js` (16, 56-58, 123-157)
  - `tests/store-update.test.js`, `tests/store-incremental.test.js`, `tests/backup-restore.test.js` and `tests/workspaces-restore.test.js` used `candidates` as a generic document fixture. Switch them to `runs`.

The new migration:

```js
{to: 11, up(db) {
  db.exec('DROP TABLE IF EXISTS candidates; DROP TABLE IF EXISTS drafts; DROP TABLE IF EXISTS evidence;');
  for (const c of ['topics','style','opinions','min_delay','max_delay'])
    if (db.prepare('PRAGMA table_info(settings)').all().some(x => x.name === c)) db.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
  db.prepare("DELETE FROM kv WHERE key='capture_token'").run();
  db.prepare("UPDATE tasks SET status='cancelled' WHERE kind IN ('reminder','candidate-draft') AND status NOT IN ('done','failed','cancelled')").run();
}}
```

Use the real names of the kv table and of the task status and kind columns in this file. The terminal statuses must be the ones `shared/tasks.js` defines.

**Interfaces:**
- Produces: `SCHEMA_DB_VERSION === 11`.

- [ ] **Step 1: Write the failing tests.** In `tests/sqlite-store.test.js`:
  - `test('a v10 database with X data upgrades to v11', …)`:
    - create a store at v10 (run the migrations up to 10, or reuse the existing older-schema fixture helper);
    - insert one candidate, one draft, one evidence row, a `capture_token` kv row, a queued `reminder` task and a bot;
    - reopen it with the current store.
    - Assert: the schema version is 11; `sqlite_master` has no `candidates`, `drafts` or `evidence` table; `PRAGMA table_info(settings)` has no `topics` column; the bot is still there; the reminder task's status is `cancelled`.

  In `tests/backup-restore.test.js`:
  - `test('a backup from before X was removed still restores', …)`: a backup document whose tables include `candidates`, `drafts` and `evidence`, with rows, passes `validateBackup` and restores. The other tables come back, and the X rows are ignored.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the migration and make the store and backup changes.**
- [ ] **Step 4: Run the gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/` → pass.
- [ ] **Step 5: Commit.** `refactor: drop X tables and settings columns (schema v11)`

### Task 8: Docs, package metadata and the final sweep

**Files:**
- Modify:
  - `README.md`: rewrite the intro (3, 11-12) as a "personal bot platform". Remove the X workflow, "Try the full workflow" and "Chrome extension" sections (25-44, 111-166, 208-236, 267-353).
  - `AGENTS.md`: lines 6, 11, 15 and 52. The posting-guard line in Security stays.
  - `docs/COORDINATION.md` (27, 34, 41, 62, 84, 90), `docs/ROADMAP.md` (7-46), `docs/AGENT-PROTOCOL.md` (53, 59, 97, 110, 139, 144, 174), `docs/DEPLOYMENT.md` (88, 154), `docs/OPERATIONS.md` (98, 100), `SECURITY.md` (21, 81-82).
  - `docs/BUILD-PLAN.md`: under Phase Z, tick "Remove X-engage" and add one line per removed surface. Older phases stay as history; mark Phases D and the X parts of C as "removed in Phase Z".
  - `package.json` `description`: "Local-first personal bot platform with human-approved actions".
  - `CHANGELOG.md`: add an entry for the removal. Older entries stay.
- Test: a new `tests/no-x-engage.test.js`.

- [ ] **Step 1: Write the failing test.** `tests/no-x-engage.test.js`, with `test('no X-engage code is left', …)`:
  - walk `shared/`, `src/` and `agent/` (`.js`/`.mjs`);
  - assert that no file matches `/\b(candidates?|makeDraft|draftCard|evidence\.js|captureToken|awaiting_feed|X_ENGAGE|x-engage|DEMO_SAMPLES)\b/`.
  - Allow-list: the posting guard in `shared/bot-browser.js` and `agent/browser.mjs` does not match these words. If a legitimate match appears (for example `extractRuleCandidates` in `shared/memory.js`), anchor the regex instead of allow-listing the file.
- [ ] **Step 2: Run it.** Expected: PASS if Tasks 1-7 are complete. Fix any leftover it finds.
- [ ] **Step 3: Update the docs and package description listed above.**
- [ ] **Step 4: Run the full gate.** `npm run check && npm test && npm run build:pages && git diff --exit-code docs/ && npm run test:ui` → all pass.
- [ ] **Step 5: Commit.** `docs: the app is a personal bot platform; X-engage removed`
