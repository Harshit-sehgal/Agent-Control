# Handoff: building Phases 4 to 10

Written 27 Nov 2026 for agents who have never seen this repo. It assumes Phases 0, 1, 1b, 2 and 3 are merged to
`main`. Phase 3 (sign-in from the phone) is included, with its final fix wave.

How to read this file:
- Sections 1 to 4 tell you what the product is and how to work here. Read them once.
- Section 5 has one part per remaining phase. Read the part for your phase.
- Section 8 is a short "start here" checklist.

Two words used throughout:
- **"not built yet; spec §N"** means the design names the thing, and nothing in the code has it yet.
- **"the spec"** means `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`. It is the design every
  remaining phase implements. Its line references (`file.js:123`) were written against an older commit and have
  drifted. Trust function names over its line numbers, and grep before you cite a line.

When a plan, the spec and the code disagree, the code and `AGENTS.md` win. Example: the Phase 3 plan says a team
chat's sign-in push routes to `#thread/<groupId>`, but `AGENTS.md` (and `signinRoute` in the code) says
`#chat/<chatKey>`.

---

## 1. What this project is

### 1.1 The product

Agent Control is a local-first, self-hosted personal bot platform for one owner (plus people they invite). The owner
runs a primary bot, **Atlas**, and other bots. Bots chat, hand work to each other, read web pages through a browser on
the owner's own computer, and use connected apps (Gmail, Drive, any MCP server). Anything that acts outside the app (a
send, a post, a payment, a delete, a connector write) stops for the owner's approval first, unless the owner set a rule
that covers it.

- It runs on the owner's own machine or server. State is one SQLite database per workspace.
- Bots use the owner's own AI keys (BYOK) or the owner's signed-in `claude` / `codex` CLI.
- It has zero npm runtime dependencies. Node `>=22.5` (`package.json` `engines`; `.nvmrc` says `22`).
- The same UI ships twice: served by the Node server, and as a static demo on GitHub Pages (`docs/`) that runs an
  offline engine in the browser.

The remaining phases turn "bots that chat" into "a team that works toward a goal for days": goals, records, an
outbox with timed sends, playbooks, blueprints, service profiles and skills. Spec §1 has the picture.

### 1.2 The architecture

| Folder | What it holds | Rule |
|---|---|---|
| `shared/` | Code both the browser UI and the Node server run: pure rules (`shared/asks.js`, `shared/tasks.js`, `shared/limits.js`…) and the UI (`shared/ui-*.js`, `shared/app.js`, three stylesheets). | Browser-safe: no `node:` imports, no `../src/` imports, no `process.env`. Every module reachable from `shared/index.html` is listed in `shared/assets.js`. |
| `src/` | The Node server. `src/server.js` opens the store and listens; `src/app.js` owns the dispatcher and per-workspace start-up; routes live in `src/routes-*.js`, registered through `src/router.js` with the access each needs. | Every `src/` module must be reachable from `src/server.js`. |
| `agent/` | The local device process (`agent/agent.mjs`). It pairs with the server, polls for tasks, drives one shared Chrome over CDP (`agent/browser.mjs`, `agent/shared-browser.mjs`), runs CLI models and stdio MCP servers. | Every request is outbound from the device (`docs/AGENT-PROTOCOL.md`). |
| `tests/` | `node --test` suites (`tests/*.test.js`), a fake Chrome (`tests/fake-cdp.js`), and Python Playwright smokes (`tests/polish_smoke.py`, `tests/usability_smoke.py`, `tests/live_smoke.py`). | |
| `docs/` | The GitHub Pages bundle. JS, CSS and HTML here are **generated** from `shared/` by `npm run build:pages`. Markdown here is hand-written. | Never edit generated files in `docs/` by hand. |
| `deploy/` | Compose files, systemd units. | |
| `scripts/` | `check.mjs`, `build-pages.js`, `backup.mjs`, `reset-password.mjs`. | |

The server never dials the device. The device signs every request with HMAC (`docs/AGENT-PROTOCOL.md` §2).

### 1.3 The core ideas, and where each lives

**Bots, groups and threads.**
- A bot is a record inside a group record (`state.groups[].bots[]`). Its settings are validated by
  `validateBotSettings` in `shared/bot-settings.js` (both the server and the demo use it).
- The company (`shared/company.js`) is every bot of every non-thread group. A bot's manager is
  `settings.reportsTo`. The primary bot is the lead of the `home` group (`PRIMARY_GROUP`).
- A thread (`shared/threads.js`) is a group record with `settings.kind = 'thread'` and no bots of its own. The
  primary bot answers there; other bots join as guests.
- Chat keys (`shared/chats.js`): a bot's own chat is keyed by its bot id; a group chat is `team-<groupId>`.
- `POST /api/groups` still exists (`src/routes-groups.js`). The README says "There are no groups to create" in the
  UI. Phase 4's "one goal is one group" needs a group the UI does not create today.

**Runs.**
- A run (`state.groupRuns`, made by `createRun` in `shared/coordination.js`) is one piece of work in a chat: the
  steps, the recipients, the page requests, the connector calls.
- Run statuses are one list in `shared/run-state.js`: `BUSY_STATUSES` (`running`, `queued`, `awaiting_browser`,
  `awaiting_ask`, `awaiting_plan`, `awaiting_checkpoint`, `awaiting_limit`), `STOPPABLE_STATUSES` and
  `INTERRUPT_STATUSES`.
- The orchestrator is `src/coordination.js` (`queueGroupRun`, `runBotTask`, `resumeBrowserRun`,
  `resumeAfterAsks`). One bot step runs through `src/bot-turn.js`.
- Limits per run: `shared/limits.js` (`state.limits`, `BACKSTOP = {pages: 8, rounds: 25, steps: 30}`,
  `FAIL_STREAK = 3`, the per-site daily cap `perSite` with `MAX_PER_SITE = 1000`, `runBudget`).
- The runaway guard (`shared/runaway.js`): about 50 bot creations or 300 bot-started runs in five minutes pauses
  everything bots start.

**Asks, grants and Hands-off.**
- `shared/asks.js` decides whether a bot may do something: `verdict`, `createAsk`, `answerAsk`, `expireAsks`
  (24 hours, `ASK_EXPIRY_MS`). `src/ask-runs.js` and `src/ask-cards.js` are the server side.
- A grant is per bot, per action, per site or account: Ask each time, Always allow (optionally with an `until`), or
  Deny. `BASIC_ACCESS` lets every bot open a page and read a connected app with no grant.
- A payment asks every time, unless one bot has Always allow on one site. An every-site payment Always allow is
  refused.
- Hands-off (`state.handsOff`, kv `hands_off`, on for a new install) lets a send, post or connector write with no rule
  go without asking, but only in a run that has read nothing from outside.
- Safety presets (Careful, Balanced, Hands-off) are `shared/presets.js`.

**Outside marks and taint.** Text from outside the app (a page, a connector result, an event body) is untrusted.
- A run that read it is marked: `tainted` and `outsideRead` in `shared/asks.js`, `run.outsideInput` for event
  runs, `outsideMemory` (`src/coordination.js`) for runs handed memory written from outside text, `readOldChat` for
  a fallback's `search_chat` hit.
- A later run whose chat holds a reply from a marked run is marked too.
- Pruning keeps the marks (`keepOutsideMarks` in `shared/retention.js`).
- A marked run asks before every send or post, even with Hands-off on.
- Spec §2.2 item 17: marks follow a run and its chat, not a bot.

**The paired device and browser accounts.**
- A device pairs once (`docs/AGENT-PROTOCOL.md` §1). `chooseDevice` in `src/agent.js` picks one for a task kind,
  with pins (`settings.device` on a bot) and named features (`shared/device-features.js`: `secret-input-v1`,
  `browser-accounts-v1`, `FEATURE_GRACE_DAYS = 60`).
- The device runs tasks in a worker pool (`agent/task-pool.mjs`, `AGENT_CONCURRENCY`, default 3).
- A browser account (`shared/browser-accounts.js`, kv `browser_accounts`, owner-only routes in
  `src/routes-browser-accounts.js`) is a named cookie space on one computer. Its cookies are an encrypted jar on that
  computer (`agent/account-jars.mjs`) and never leave it.
- A bot names an account through the owner-only `browserAccount` setting. The account is stamped at four hops (spec
  §5.2). Keeper tabs notice a sign-out.
- Phase 3 added sign-in from the phone: a `signin` ask per account (`createSigninAsk`, kv `signin_pending`,
  `src/signin-wait.js`), a quiet push, a held page and a parked run that carry on after Hand back.
- Secrets typed by the owner never reach a model (`agent/page-secrets.mjs`, `scrubTyped`,
  `tests/planted-secret.test.js`).

**Connectors and MCP.**
- `state.connectors` (`shared/connectors.js`: `CONNECTOR_KINDS = ['google', 'mcp', 'site']`, `MAX_CONNECTORS = 20`).
- One call runs through `useConnector(store, connector, tool, args, {deviceId})` in `src/connector-use.js`.
- Calls are filed on the run by `recordConnectorCalls` and made by `runConnectorCalls` (`src/connector-runs.js`).
  Each is claimed `running` in its own store update before it is made, and one still `running` at start-up becomes
  `unknown` and is never repeated.
- Approvals are bound to the exact arguments with `argsHash` (`shared/connectors.js`) and to the connector with
  `connectorIdentity`.
- `src/held-sends.js` holds an Always-allowed `gmail.send` for 30 seconds with Undo (`UNDO_WINDOW_MS`).
- The app catalogue is `shared/app-catalog.js`; OAuth to MCP servers is `src/mcp-oauth.js`.

**Schedules, watches and triggers.**
- The durable task queue: `shared/tasks.js` (`PAYLOAD_KINDS`: `bot-task`, `group-run`, `agent-job`, `notification`;
  `enqueueTask`, `claimDue`, `requeue`), the worker `src/queue.js`, the handlers `taskHandlers` in
  `src/handlers.js`.
- A schedule is a `bot-task`, and every run of one is a model turn. Bots propose schedules as setup cards; only the
  owner applies them.
- A watch (`shared/watches.js`, `src/watches.js`) checks a page by code, never by a model, and tells the owner. Only
  the owner makes watches.
- An event trigger (`src/triggers.js`, `src/routes-events.js`, `shared/triggers.js`) is a signed webhook that starts a
  run marked `outsideInput`.

**Memory.** `shared/memory.js`, `src/memory.js`.
- Each bot has a rulebook (`bot:<id>`). Every bot reads a company notebook it cannot write.
- A bounded tidy-up pass condenses memory, and marks what it wrote from outside text.

**The kill switch.**
- `pauseAllSchedules` / `resumeAllSchedules` in `shared/tasks.js` set `state.schedulesPaused` (kv
  `schedules_paused`). The owner flips it with `POST /api/automation/pause-all` and `/resume-all`.
- In the queue it holds only `bot-task` (spec §2.2 item 14). It also holds watches (`shared/watches.js` returns no due
  watch while it is on) and events (`receiveEvent` in `src/triggers.js` answers 202 `held`).

**Workspaces.** One database file per workspace (`src/workspaces.js`). Accounts, sessions, memberships and push
subscriptions live in the first workspace's store. A route handler uses `c.store`, the session's workspace store.

**Other pieces you will touch.**
- Setup cards (`shared/setup.js`, 22 `SETUP_ACTIONS`; `src/setup-cards.js`): a bot proposes a change, and the
  owner's tap calls the ordinary route.
- The activity log (`shared/activity-log.js`, `ACTIVITY_KINDS = ['outside', 'perm', 'bots']`).
- Usage metering (`src/usage.js` `meterTurn`; `shared/usage.js`).
- The health watch (`src/health-watch.js`: `healthIssues`, `heldKeys`).
- The daily briefing (`shared/briefing.js`).
- Quiet hours (`shared/quiet-hours.js`).
- The owner's clock for schedules (`tz`, `keepWallTime` in `shared/schedules.js`).
- Backups (`src/backup.js`).
- The store (`src/sqlite-store.js`).

---

## 2. How to work in this repo

### 2.1 Setup and commands

```bash
nvm use            # Node 22 (.nvmrc); package.json needs >=22.5
npm run check      # syntax-check every .js/.mjs under src/ shared/ agent/ scripts/ (scripts/check.mjs)
AGENT_SKIP_DOTENV=1 npm test   # the Node suite: node --experimental-sqlite --import ./tests/ai-env.js --test tests/*.test.js
npm run build:pages            # regenerate docs/ from shared/ (scripts/build-pages.js)
npm run test:ui    # Playwright smokes: tests/polish_smoke.py then tests/usability_smoke.py
npm run test:e2e   # tests/live_smoke.py: real server, stub model, real browser
npm run test:coverage
```

Notes:
- `AGENT_SKIP_DOTENV=1` stops `src/env.js` from loading a local `.env`. Server-spawning tests set it themselves.
  `tests/ai-env.js` also clears provider variables and sets `LOCAL_AGENT=0`.
- **One test file:** `node --experimental-sqlite --import ./tests/ai-env.js --test tests/<name>.test.js`. The
  plans write `node --test tests/<name>.test.js`. That works for pure tests; add the two flags for anything that opens
  the store, on Node before 23.4.
- **The smokes need Python and Playwright:** `pip install playwright` and `python -m playwright install chromium`
  (as CI does).
- **One smoke scenario:** `SMOKE_ONLY=<text> npm run test:ui` runs only the scenarios whose name contains `<text>`.
- CI (`.github/workflows/ci.yml`) runs `check`, `test`, a docs-drift check (it re-runs `build:pages` and fails if
  `git status --porcelain docs` is not empty), and the live smoke. The two visual smokes run only locally.

### 2.2 The gate

Every change must leave all of these green before you commit or merge:

1. `npm run check`
2. `AGENT_SKIP_DOTENV=1 npm test`
3. `npm run build:pages`, then `git status --porcelain docs` is empty after you commit the result.
4. `npm run test:ui` when anything in `shared/` changed, and at every merge (see §3).

### 2.3 The five hard invariants

Each is enforced by a test. Do not work around them.

| # | Invariant | Test |
|---|---|---|
| 1 | Every module reachable from the `index.html` scripts is listed in `shared/assets.js`. | `tests/assets.test.js` |
| 2 | Every file under `scripts/check.mjs`'s `ROOTS` (`src`, `shared`, `agent`, `scripts`) is walked by it. | `tests/check-coverage.test.js` |
| 3 | Generated files in `docs/` match `shared/` byte for byte, `?v=` hash included. | `tests/pages-bundle.test.js` and CI |
| 4 | The CSP meta in `shared/index.html` equals `META_CSP` in `shared/core.js`. | `tests/security-headers.test.js` |
| 5 | `shared/` imports no `node:` builtin and no `../src/` and reads no `process.env`; no import cycle; every `src/` module is reachable from `src/server.js`; every `TABLE_SHAPES` entry matches its table. | `tests/architecture.test.js`, `tests/store-incremental.test.js` |

### 2.4 Adding a shared module

1. Create `shared/<name>.js`. It must be browser-safe.
2. Add `'<name>.js'` to `shared/assets.js`. Both `scripts/build-pages.js` and `src/app.js` read that list.
3. Run `npm run build:pages` and commit `docs/` with it.

`tests/assets.test.js` walks the import closure, so a missed step 2 fails.

### 2.5 Other wiring a new piece needs

These come from the code, not from AGENTS.md, and each has bitten before:
- **A new route module** (`src/routes-<x>.js`) is imported in `src/app.js` and added to `MODULES` in
  `tests/route-roles.test.js`. The test asserts the two lists match.
- A public route that takes an id needs a written reason in `PUBLIC_WITH_PARAM` there. Avoid adding one.
- Sensitive least roles are pinned there, and `tests/authz-matrix.test.js` drives real HTTP for the write surface.
- **A new migration** is appended to `MIGRATIONS` in `src/sqlite-store.js`. The schema is **v15** today (browser
  accounts), so your first one is **v16**. `SCHEMA_DB_VERSION` is `MIGRATIONS.length`, and
  `tests/browser-account-routes.test.js` asserts `SCHEMA_DB_VERSION === 15`: update it in the same commit.
- **A new kv key** that is part of state is read in `readCollections` and written in `writeCollections` in
  `src/sqlite-store.js`, beside `watches`, `browser_accounts` and `signin_pending`.
- **Backups.** `kv` is in `EXCLUDED_TABLES` in `src/backup.js`. An owner setting kept in kv must be added to
  `OWNER_SETTINGS` (today: `ask_basics`, `browser_accounts`, `hands_off`, `limits`, `templates`, `usage`, `watches`).
  Machine state must be dropped on restore: see the `DELETE FROM kv WHERE key = 'signin_pending'` line.
- **A table kept outside the state document** follows `attachments`: created by migration (v13), read and written
  by direct SQL (`src/attachments.js`), and carried by `src/backup.js` as `tables.attachments` with a byte cap and an
  `attachmentsLeftOut` list.
- **A new task kind** needs a validator in `PAYLOAD_KINDS` (`shared/tasks.js`) and a handler in `taskHandlers`
  (`src/handlers.js`). The kill switch hard-codes `task.kind === 'bot-task'` in five functions in `shared/tasks.js`:
  `enqueueTask`, `claimDue`, `requeue`, `pauseAllSchedules` and `resumeAllSchedules`. A new kind that acts on its
  own must be held in all five.
- **A new repeating per-workspace pass** goes through `startSweep` in `src/interval.js`, never a bare `setInterval`.
- **The snapshot** sent to the UI is built from `SNAPSHOT_KEYS` in `src/routes-workflow.js`. The spec wants only counts
  and the newest few records and outbox items in it.
- **The Pages demo** answers the same routes from `shared/local-api.js`. The UI never branches on the build to drive a
  run. A route the demo cannot serve answers "this needs the server", as connectors and browser accounts do.

### 2.6 Security rules a builder must never break

From `AGENTS.md`, `SECURITY.md` and spec §3.1:
- **A model proposes; it never grants.** Only the owner widens what a bot may do. A model's block never carries a
  permission, an account, a device or a connection; those come from the bot record. `shared/bot-create.js` refuses
  permission fields, and `validateBrowserRequest` (`shared/bot-browser.js`) drops unknown fields such as `account`.
- **Model output never gets a publishing or filesystem tool.** A send, post or submit happens only through the ask
  mechanism (or, after Phase 4, the outbox), with an approval or a grant the owner gave.
- **An approval covers only the exact payload shown** (`argsHash` today, `payloadHash` for the outbox). An edit
  sends it back for approval.
- **Payments and deletes ask every time**, apart from one bot's Always allow on one site. Hands-off never covers them.
- **Outside text is data, never instructions.** It is fenced when handed to a model. A run that read it asks before
  every send. It can never approve, grant or auto-apply anything.
- **Secrets never reach a model, a chat line, memory, a log or a backup:** passwords, codes, cookie jars, tokens and
  API keys. Never print a key. Never commit `.env`.
- **The network guard:** bots reach only allowed sites and never a private network (`agent/net-guard.mjs`,
  `src/reach-guard.js`, `guardedFetch`).
- **A CAPTCHA is never solved by a bot.** It is handed to the owner. Nothing imitates a person, changes a fingerprint
  or hides automation (spec §8.3, §17).
- **Anything delayed or repeated is a stored task,** never a wait inside a model turn or only a process timer.
- **The kill switch and the runaway guard hold every task kind that acts on its own.**
- **Every outward action, approval, account change and blueprint change is logged** in the activity log.
- **Only the owner's own words or taps count as the owner.**

---

## 3. Lessons learned while building Phases 0 to 3

Treat each of these as a rule.

1. **Every merge of a branch that touched `shared/` conflicts on the `?v=<hash>` stamps in `docs/`.** Resolve it
   this way:
   1. Check that no non-docs file is unmerged:
      `git diff --name-only --diff-filter=U | grep -v '^docs/'` must print nothing. Also check that no hand-written
      markdown in `docs/` is unmerged: `git diff --name-only --diff-filter=U | grep '^docs/.*\.md$'` must print
      nothing. If either prints a file, resolve that file by hand first.
   2. `git diff --name-only --diff-filter=U | grep '^docs/' | grep -v '\.md$' | xargs git checkout --theirs --`
   3. `npm run build:pages && git add docs`

   The rebuild makes the generated files in `docs/` match the merged `shared/`, whichever side you took. It does not
   rebuild markdown: `docs/BUILD-PLAN.md`, `docs/AGENT-PROTOCOL.md`, `docs/DEPLOYMENT.md` and the plans under
   `docs/superpowers/` are hand-written. Taking `--theirs` on one of those would silently drop your side's edit, so
   those files are kept out of step 2. Two phase branches that both tick `docs/BUILD-PLAN.md` will conflict there.
2. **Two tasks that both touch `shared/` must not run in parallel.** `build:pages` stamps every docs file with one
   hash, so two such branches always conflict on every file. Put each `shared/` task in a wave of its own, as the
   Phase 2 and 3 plans do.
3. **Run `npm run test:ui` at every merge, not only at the end.** It once stayed red for many tasks and nobody
   noticed.
4. **Some tests are flaky under load. Re-run a failure alone before you treat it as real.** Known ones:
   - the takeover idle test;
   - `tests/shared-browser-takeover.test.js`;
   - the real-browser test in `tests/agent-browser.test.js`;
   - `tests/live-browser-e2e.test.js`;
   - the TLS test in `tests/deployment.test.js`;
   - `EADDRINUSE` failures from tests that start a server;
   - the `cli-model` hang;
   - `tests/agent-accounts-e2e.test.js` "a first pairing wipes jars…".

   If it passes alone, note it in the task's report and move on. If it fails alone, it is real.
5. **Allow half a pixel of slack in UI size asserts.** A smoke once failed on 33.99999 against 34 (commit
   `f69f602`).
6. **Avoid import cycles in `shared/`.** For example, `shared/bot-browser.js` must never import
   `shared/browser-accounts.js`, and `shared/asks.js` may not import `shared/browser-accounts.js`.
   `tests/architecture.test.js` enforces it. When two modules need each other, move the shared piece down into the
   module they both already import, or pass it in as an argument.
7. **A plan's test skeletons are requirements.** That covers test titles and comments in a plan. A test with an empty
   body, or one that asserts nothing, is a defect. Write the assertions the comments describe.
8. **Write the failing test first and watch it fail.** Then implement. A test that passed before the feature
   existed proves nothing (Phase 2 left one: the wrong-proof test in `tests/browser-account-heartbeat.test.js`).
9. **Commit hygiene:**
   - Commit with explicit paths (`git add <file> <file> docs`), never `git add -A` or `git add .`.
   - Never run a bare `git stash`. The stash stack is shared across worktrees and sessions. If you must, use
     `git stash push -u -m "<unique tag>"` and apply it by its SHA.
   - Never rebase or force-push a PR branch.
   - Stay off port 4173 (the server's default `PORT`, which a running dev server may hold). Stay away from the real
     `data/state.json` and `data/state.db`. Tests use temp dirs and free ports.
   - Never commit or print secrets.
10. **Code and AGENTS.md beat the spec's line numbers.** The spec cites lines against an older commit. Grep for the
    function, and cite a line only when you have just read it.
11. **Fix in the owning task's code.** When an end-to-end test fails, fix it in a separate commit that names the
    task whose code was wrong. Don't patch around it in the test.

---

## 4. The process for one phase

This is the process that worked for Phases 0 to 3. Follow it.

1. **Read the spec sections for the phase** (listed per phase in §5 below), plus §2.2 (what had to change), §3.1 (the
   core rules), §15 (its row) and §16 (open decisions).
2. **Write a plan** at `docs/superpowers/plans/<YYYY-MM-DD>-phase-<N>-<name>.md`. Copy the shape of
   `docs/superpowers/plans/2026-11-27-phase-2-browser-accounts.md` and
   `docs/superpowers/plans/2026-11-27-phase-3-signin-from-phone.md`:
   - **Header:** Goal (the §15 "done when", in your words), Architecture (a few bullets), Tech Stack, Spec (which
     sections are binding), and "Builds on" (real functions with paths).
   - **Global Constraints:** repo rules (new `shared/` modules, migrations, which tasks touch `shared/`), record
     shapes, limits and their numbers, and **exact sentences** for every refusal, card line, push and toast. Tests
     assert these strings.
   - **Calls:** each choice the spec leaves open, numbered, with its reason.
   - **Review Focus:** the five riskiest cases. Each names the expected behaviour and the task whose test pins it.
   - **Order and parallel work:** a table of waves. Each wave lists tasks that touch disjoint files, what each waits
     for, and which single task in the wave touches `shared/`.
   - **Tasks:** each has Files (create or modify, with function names), Interfaces (what it consumes and produces,
     with signatures), TDD steps (write the failing test with real skeletons, run it and see it fail, implement, run
     it and the suite, commit), and a commit step with an explicit `git add` list and the message.
   - **The last task:** the end-to-end test for §15's "done when", the doc edits (AGENTS.md paragraph, README,
     `docs/AGENT-PROTOCOL.md`, `docs/DEPLOYMENT.md` as needed), the manual "see it work" steps, and the
     `docs/BUILD-PLAN.md` tick.
   - **Tail tables:** spec coverage (each spec item to a task), leftovers taken in, Optional (not in the steps), Out of
     scope, Done when, and a "Carried from Phase N-1" list.
3. **Build each task test-first, on its own branch** off the phase branch (`feat/phase-<N>-<name>`). Merge each task
   back into the phase branch when it is reviewed.
4. **Review each task** on two questions: does it match the spec and the plan, and is it well built? Fix the
   findings, then review again.
5. **At the end, review the whole branch**, then do one fix wave for what that review finds.
6. **Open one PR for the phase.** Merge it once CI is green.
7. **Tick the phase** in `docs/BUILD-PLAN.md` (the "Phase AA" list at the end of the file).

**Commit style.** Conventional, imperative subjects, one feature per commit. Real examples from `git log`:
- `feat: the sign-in ask per account, the account's wall and the signin request status`
- `fix: an account's site must be a real host name, not an IP address`
- `test: sign-in from the phone, end to end`
- `docs: sign-in from the phone; tick Phase AA step 3`
- Merges of task branches: `Merge Phase 3 Task 4: hand back, Not now and expiry release every waiter`

End each commit message with the attribution lines your environment gives you, if it gives any.

---

## 5. The phases left

Sizes are spec §15's "rough focused days for one person who knows the code, tests included". About 47 to 61 days
in all, Phases 0 to 3 included.

Dependencies: §15 says only that "Phases 5 and 6" can run "beside 4". Every other dependency below is **inferred**
from what the phase consumes, and is marked so.

### Phase 4: Goal v0

**Goal.** One goal runs as one group of bots with a brief, ceilings and a budget. Its results go into records and
notes, and its outward actions wait in an outbox for approval and go out paced on timers.

**Definition of done (§15, quoted):** "A lead-finding goal runs for a day: rows appear without duplicates, you approve
3 drafts in one card, they go out 5 to 15 minutes apart, and a restart in the middle shows `unknown` for the one being
sent and sends nothing twice."

**§15's scope for it (quoted):** "One goal as one group (9.2), brief, ceilings and per-goal budget with `goalId` on
runs and model calls; records with a `key`, outside marks and stats (9.1); notes; the stand-up under its own key; the
outbox in its table with approve-each and batch cards for connector items (8.2); the `timer` and `playbook` task
kinds held by the kill switch, with re-checks (8.1, 8.4); one lane per account; storage and restore (9.4); the `goal`
activity kind; the health checks (13.3); the goal's page and cards (13.1); capability card lines for what exists
(4.3). The `think` step with typed answers, `when` conditions, quoted outside values and wait-for-all inputs (8.4);
the handoff rules (4.2): answers together, no hand back to the giver, cancel only what a bot started, the four-part
reply. The team is edited by you."

**Spec sections:** §4.2 (work loop and handoff rules), §4.3 (capability card), §8.1 to §8.4 (timers, outbox, lanes,
playbook runner), §9.1 to §9.4 (records, notes, goals, ceilings, storage), §13.1 to §13.3 (screens, demo, health
watch). Read §2.2 items 5, 6, 7, 8, 10, 11, 13, 14, 15 and 16 for the problems these fix. Read §14 for the
walk-through.

**Size:** 13 to 15 days. It is the biggest phase.

#### What exists today

| Need | What is there | Where |
|---|---|---|
| A durable queue | Kinds `bot-task`, `group-run`, `agent-job`, `notification`; leases, retries, idempotency keys | `PAYLOAD_KINDS`, `enqueueTask`, `claimDue`, `requeue` in `shared/tasks.js`; `createQueue`, `recoverQueue` in `src/queue.js`; `taskHandlers` in `src/handlers.js` |
| The kill switch | Holds only `bot-task`, in five places | `enqueueTask`, `claimDue`, `requeue`, `pauseAllSchedules`, `resumeAllSchedules` in `shared/tasks.js` |
| Claim before call | `running` in its own update; `running` at start-up becomes `unknown`, never repeated, with the `UNKNOWN` sentence | `runConnectorCalls` in `src/connector-runs.js` |
| Exact-argument approval | `argsHash`, checked again when the call is made (`changed` in `src/connector-runs.js`) | `shared/connectors.js` |
| A timed, undoable send | `holdSend`, `releaseSend`, `undoHeldSend`, `settleHeldOnStart` (a restart sends nothing) | `src/held-sends.js` |
| Groups and a lead | `state.groups`, `POST /api/groups`, the `home` group, `reportsTo` | `shared/workflow.js`, `src/routes-groups.js`, `shared/company.js`, `shared/bot-settings.js` |
| Tracked tasks | `planTracked` names no workers, so `run.task` is null in practice. Not a base for goals (§2.2 item 13). | `shared/coordination.js` |
| Handoff recipients | `handoffTargets` drops the sender, bots already in the run and switched-off bots. It does **not** drop "the giver" (§4.2). | `shared/coordination.js` |
| Who started a run | Nothing. There is no run `startedBy`. (The only `startedBy` in the tree is a device config field in `src/local-agent.js`, unrelated.) | not built yet; spec §4.2 |
| `goalId` on runs and model calls | Nothing | not built yet; spec §9.2, §9.3 |
| Usage per run and per bot per day | `meterTurn`, `noteUsage`, `recordDay`, kv `usage` | `src/usage.js`, `shared/usage.js` |
| Limits | `state.limits`, `BACKSTOP`, `FAIL_STREAK`, `runBudget`, `setLimits` | `shared/limits.js` |
| Quiet hours | `parseQuietHours`, `inQuietHours` | `shared/quiet-hours.js` |
| The owner's clock | `tz`, `keepWallTime`, `skipToDays` | `shared/schedules.js` |
| Daily briefing from real state | `briefingFacts`, `briefingContext`, `BRIEFING_KEY` | `shared/briefing.js` |
| Outside marks | `tainted`, `outsideRead`, `verdict(…, {tainted, outside})` | `shared/asks.js`; `outsideMemory`, `outsideInput` in `src/coordination.js`; `keepOutsideMarks` in `shared/retention.js` |
| A table outside the state document | `attachments` (v13), direct SQL, `tables.attachments` in backups with a cap | `src/sqlite-store.js`, `src/attachments.js`, `src/backup.js` |
| Backups and restore | `OWNER_SETTINGS`, `EXCLUDED_TABLES`, `interruptRestoredRun` (a restored `awaiting_browser` or `awaiting_ask` run is cut) | `src/backup.js` |
| Activity kinds | `ACTIVITY_KINDS = ['outside', 'perm', 'bots']`, `logActivity` | `shared/activity-log.js` |
| Health checks | `healthIssues`, `heldKeys`, two checks in a row before an alert | `src/health-watch.js` |
| Needs you | `needsYou(state, group)` | `shared/ui-model.js` |
| The ask card | `askCard` | `shared/ui-asks.js` |
| The feed | `feed`, `runsOfChat` | `shared/ui-feed.js` |
| The envelope's cached head | `STABLE_KEYS = ['botId', 'botRole', 'contract', 'permissions', 'tools']` | `src/ai.js` |
| The group simulator | `simulateGroup` (coordination only) | `shared/group-simulator.js` |
| Message search (for chat lines) | used by `search_chat` | `shared/message-search.js` |
| Profile pages | Per-bot `profileView`; `profileRows`, `watchRows` | `shared/ui-profile.js`, `shared/ui-profile-model.js` |

Every module the spec proposes for this phase is **not built yet**:
- `shared/goals.js` (ceilings and counting; spec §13.2);
- `shared/records-rules.js` (queries, stats, outside marks; spec §13.2);
- `shared/outbox.js` (the pacer and lanes; spec §8.3, §13.2);
- `shared/playbook-rules.js` (`decodeAnswer`, `evalWhen`; spec §8.4);
- `src/outbox.js` (the `outbox_items` table; spec §8.2);
- `src/records.js` (the `records` table and routes; spec §9.1);
- `src/playbooks.js` (the runner; spec §8.4).

The `records` and `outbox_items` tables, kv `goals`, the `timer` and `playbook` task kinds and the `goal` activity
kind are also not built yet.

There is no group profile page today: the profile pages are per bot. The spec says the goal page goes on "the group
profile in `shared/ui-profile.js`" (§13.1). Check what renders a thread's header and settings before you plan the goal
page. It may be new UI.

#### What must be built (a starting task list, not a plan)

**A. The goal record.**
1. The goal record `{id, groupId, title, brief, leadBotId, metrics, deadline, status, ceilings, blueprintVersion}`
   (§9.2) in kv `goals`, carried in backups as an owner setting.
   - Files: new `shared/goals.js` (add it to `shared/assets.js`); `src/sqlite-store.js` (kv read and write);
     `src/backup.js` (`OWNER_SETTINGS`); a new `src/routes-goals.js`, registered in `src/app.js` and
     `tests/route-roles.test.js`.
2. One goal is one group, and a bot belongs to at most one goal. Moving a bot between goals is owner-only and logged.
3. **Playbooks, lanes and collections need a home before blueprints exist** (Phase 7). *Suggestion:* store them on
   the goal in the §10.1 shape, edited by owner-only routes, so Phase 7 can wrap them in versions without moving data.
   "The team is edited by you" (§15).

**B. `goalId` and `startedBy`.**
4. Put `goalId` on every run and every model call of a goal's bot.
   - `src/coordination.js`: `createRun` lives in `shared/coordination.js`; `queueGroupRun` and `runBotTask` are in
     `src/coordination.js`.
   - `src/usage.js` meters per goal from it.
5. Put `startedBy: {kind: "owner" | "schedule" | "bot", botId}` on each run (§4.2). A bot may cancel only its own
   timers and runs.

**C. Ceilings and budgets (§9.3).**
6. Max bots; model runs and tokens per day; outward actions per lane per day; the minimum gap per lane; accounts,
   connections, sites and model tiers; quiet hours; send-without-asking (default off); signed-in pages as images.
7. Read-only to bots. Only the owner raises a ceiling, never past a backstop. Every change is logged under `goal`.
8. Running out pauses that goal's playbooks, with a card to raise the ceiling or wait.

**D. Records and notes (§9.1).**
9. Migration v16: the `records(goal_id, collection, id, data, created_at, updated_at)` table.
   - `src/records.js` does direct SQL. Pure rules go in `shared/records-rules.js`.
   - A `key` field upserts. The cap is 20,000 rows per goal, and a write past it is refused.
   - Stats are computed in code: count, sum, median, by hour or weekday.
   - Backups carry `tables.records` with a cap and a `recordsLeftOut` list. A restore checks each row.
10. Outside marks per field: every non-`number` field a marked run wrote is `outside: true`.
    - A run handed a marked field is `outsideRecord`.
    - Numbers and code-computed aggregates are inside data.
    - Group labels are inside only for a number, a time bucket or a declared `enum`. Other values count as `other`.
    - Write it as an allow-list.
11. Notes: collection `_notes` in the same table. At most 2,000 lines per goal, oldest dropped first. Lines carry the
    outside mark, and a marked line can approve nothing.

**E. Timers and playbooks (§8.1, §8.4).**
12. The `timer` task kind in `PAYLOAD_KINDS`, fired by the queue with no model.
    - When: `after`, a `{min, max}` window drawn once and stored, or `at` on the owner's clock.
    - Limits: 10 seconds to 30 days; 50 pending per bot and 500 per goal.
    - Re-checks when it fires: the goal is active, the lane is not paused, the ceilings allow it, the account is still
      signed in, and every grant still stands. If any fails, it posts one line and does nothing.
13. The `playbook` task kind `{goalId, playbook, version, step}`.
    - `src/playbooks.js` runs fixed steps in code, each in its own store update: `record`, `read`, a connector-read
      `call`, an `outbox` item from a template, a `timer`, a `notify`.
    - A role step enqueues a `bot-task` or group run carrying `goalId`.
    - `FAIL_STREAK` failed runs pause that playbook, not the goal.
14. Hold both kinds in **all five** kill-switch places in `shared/tasks.js`, with a test per kind (§8.1, §17).

**F. The outbox and lanes (§8.2, §8.3).**
15. Migration v17, or the same v16: the `outbox_items` table.
    - `src/outbox.js` does direct SQL.
    - The item shape is in §8.2: `status: draft → approved → scheduled → sending → sent | failed | unknown |
      cancelled`.
    - `payloadHash` is taken over the account, the call and every parameter. An edit goes back to draft.
    - A connector item becomes a `connectorCalls` entry with its `argsHash`, run by `src/connector-runs.js`.
16. Claimed sending: `sending` in its own update before the call. `sending` at start-up becomes `unknown`, is never
    resent, and the owner is told. "Sent" needs evidence (the call's success result).
17. Lanes, one per account and channel: a gap window, a daily cap, quiet hours, and `startAfter: approval | now`.
    - The pacer: `fireAt = max(now, lastScheduledAt) + random(window)`, each gap drawn on its own.
    - Items late after downtime go one per gap, in order, never in a burst.
    - Pure rules go in `shared/outbox.js`.
18. The held email send becomes a lane setting (`startAfter: "now"`, a fixed 30 s window, Cancel as Undo). The
    restart rule of `src/held-sends.js` stays.
19. Approval cards: one card per item (Approve, Edit, Drop), and one card per batch (each draft with its own Approve,
    Edit or Drop, plus Approve all). The account and lane are named on the card. Build them on `askCard` in
    `shared/ui-asks.js`.
20. Hands-off does not reach a goal's lanes. A goal sends without asking only if its ceilings say so (default off).
    For a run with a `goalId`, the goal's "no" overrides an Always allow the bot holds from chat.

**G. The stand-up (§9.2).**
21. The daily briefing narrowed to the goal, run under chat key `goal:<id>:standup`, never the group chat.
22. It is handed only inside data: code-computed numbers, `enum` labels, outbox and timer counts, budget left, and
    unmarked notes. Marked notes are only counted.
23. It posts one status line to the group chat.

**H. Storage and restore (§9.4).**
24. Every goal comes back **paused**.
25. On restore: `sending` becomes `unknown`; `scheduled` goes back to `approved` with its timer cancelled; drafts stay
    drafts.
26. Timers and playbook tasks are cancelled, like `interruptRestoredRun`. The goal's resume re-arms them.

**I. Activity, health and the screens.**
27. The `goal` activity kind: every approval, batch answer, ceiling change and bot move. Every send is still logged
    under `outside`.
28. Three health checks in `healthIssues`:
    - an outbox item `sending` for more than 15 minutes;
    - an `unknown` item the owner has not looked at;
    - a timer more than 15 minutes past due while nothing holds it.

    The kill switch's hold and a paused goal are `heldKeys`.
29. The screens (§13.1):
    - the goal page: Brief, Metrics, Ceilings (edited there), Records, Outbox, Timers;
    - the outbox cards in the group chat;
    - a timer line in `shared/ui-feed.js` with a countdown and Do it now, Cancel, Edit;
    - `needsYou` counts outbox drafts and signed-out accounts a goal needs.
30. The Pages demo (§13.2): records in the snapshot; a send shows "sent (demo)"; timers run on the page's clock.

**J. Model-side rules.**
31. Capability card lines for what exists (§4.3).
    - What only the owner changes (account names, primitives) may go in `tools` (a `STABLE_KEYS` entry).
    - What changes on its own (budget left, signed-out accounts, pending outbox) goes after the head.
    - Keep the Anthropic cache head byte-stable.
32. The `think` step (§8.4): one model call with no tools that sees only the declared `in` inputs.
    - Typed answers are decoded strictly by `decodeAnswer`. A mismatch runs once more; a second mismatch fails.
    - `when` conditions are evaluated by `evalWhen`: no functions, no arithmetic. An unknown name or a type mismatch
      fails the step.
    - Outside values are quoted in a fence longer than any run inside them.
    - A step with several inputs waits for all of them.
33. The handoff rules (§4.2):
    - answers arrive together;
    - a task never goes back to the bot that gave it;
    - a bot cancels only what it started;
    - the four-part reply (`Status`, `Result`, `Evidence`, `Blocked on`), which nothing parses.

#### Suggested split into PRs

This split is a suggestion, not the spec's. Each PR adds `shared/` modules, so the "one `shared/` task per wave" rule
applies inside each PR and across them.

| PR | Contents | Why here |
|---|---|---|
| 4a: goal core and the clock | A, B, C; D (records with `key`, outside marks, stats, notes); E (the `timer` and `playbook` kinds, held in all five places, with the deterministic steps except `outbox`); H for goals, records and tasks; the `goal` activity kind; migration v16 | Records and timers are what the playbook steps need. Restore rules belong with the tables they restore. |
| 4b: the outbox | F (the `outbox_items` table, claim, `unknown`, lanes and pacer, approve-each and batch cards for connector items, the held send as a lane); the `outbox` playbook step; G (the stand-up); H for outbox items; the three health checks; the goal page and its cards; `needsYou` | §15's done-when lands here: no duplicates, 3 drafts in one card, 5 to 15 minutes apart, `unknown` after a restart. |
| 4c: thinking and handoffs | J (the `think` step, typed answers, `when`, quoted outside values, wait-for-all, the four handoff rules, capability card lines) | These are model-facing and can follow once the deterministic parts are proven. |

#### Rules and constraints that bind it

- §3.1 core rules: approvals cover only the payload shown; anything delayed is a stored task; budgets cannot be
  raised by bots; the kill switch holds every kind; every approval and goal change is logged.
- Records and outbox items stay **out of the state document** and out of `TABLE_SHAPES` (§9.1, §9.4). The snapshot
  carries only counts and the newest few.
- Numbers fixed by the spec:
  - 20,000 rows per goal;
  - 2,000 note lines;
  - 50 blueprint versions;
  - timers from 10 s to 30 days;
  - 50 pending timers per bot and 500 per goal;
  - `FAIL_STREAK` (3) pauses a playbook;
  - 15 minutes for each health check.
- A timer "never does what its bot could not do directly and never skips an approval" (§8.1).
- "Nothing important lives only in a chat" (§9.1).
- Browser items in the outbox are **out of scope** for Phase 4. §8.2 makes a browser item a trusted skill with
  parameters, and skills are Phase 8. "Until skills ship, a browser item is approved and sent in one go, with no
  timer." §15 lists only connector items for Phase 4.
- AGENTS.md: the `ui-*` model modules stay pure (no DOM, no globals) because Node tests import them.

#### Risks and tricky cases (Review Focus candidates)

1. **A restart in the middle of a send.** The item being sent shows `unknown`, nothing is sent twice, and the queued
   items go one per gap after the restart, never in a burst.
2. **The kill switch misses a new kind.** With the switch on, no `timer` or `playbook` fires, a requeued one waits as
   paused, and Resume brings back only what the switch paused. Test each kind in all five functions.
3. **Outside text reaches the plan.** A row a scout wrote from a page is marked on every non-number field. The
   stand-up is handed only counts and declared `enum` labels. Group-by on a `text` field carries the mark. A value
   outside a declared `enum` is counted as `other`.
4. **An approval covers something else.** An edit after approval sends the item back to draft. A changed account or
   argument fails the `payloadHash` check at send time.
5. **Hands-off or a chat Always allow lets a goal send.** With the workspace's Hands-off on and the bot holding Always
   allow from chat, a goal run with the default ceilings still waits for approval.
6. **A restore.** Every goal comes back paused, `sending` becomes `unknown`, `scheduled` becomes `approved` with no
   timer, and timers are cancelled.
7. **The budget.** A goal out of model runs pauses only its own playbooks. Other goals and plain chats keep working.

#### Dependencies

- Needs Phases 0 to 3, all merged.
- Phases 5 and 6 can run beside it (§15), but see lesson 2 about `shared/` and docs stamps.

#### Open owner decisions (§16) that touch it

| Decision | What it blocks | Default if the owner does not answer |
|---|---|---|
| §16.1 The publishing boundary: `shared/contracts.js` says "no contract can ever grant automated publishing", yet a click on Post with an Always allow already goes out. The spec suggests rewording it to "every outward action goes through an ask or the outbox, with an approval or a grant you gave". | Whether a lane may offer Always allow. It does not block §15's Phase 4 scope, which is approve-each and batch only. | Lanes offer no Always allow. Leave `shared/contracts.js` and SECURITY.md wording as they are. |
| §16.2 Sending without asking inside a goal | The ceiling default | Off, whatever Hands-off says (§8.2). One ceiling default flips it. |
| Calls the spec made that the owner can change: a bot belongs to at most one goal; records are capped at 20,000 rows per goal and kept until the goal is deleted; a failing playbook is paused, not reverted | Nothing, unless changed | As the spec says |

### Phase 5: Connector accounts

**Goal.** An app can have several connections (two mailboxes, two workspaces), and each bot is pinned to the ones it
may use.

**Definition of done (§15, quoted):** "Two mailboxes connected, one bot pinned to each."

**Spec sections:** §5.4; §2.2 item 9.

**Size:** 2 days.

#### What exists today

- **Connector records** in `state.connectors`, shown through `publicConnector` (`id, kind, name, account, status…`)
  in `shared/connectors.js`.
  - `CONNECTOR_KINDS = ['google', 'mcp', 'site']`, `MAX_CONNECTORS = 20`.
  - `newConnectorId` gives every MCP connector a unique slug id, but always returns `GOOGLE_ID = 'google'` for the
    Google kind. So today only one Google connection can exist.
- **Calls.** `useConnector(store, connector, tool, args, {deviceId})` in `src/connector-use.js` runs one call. The
  calling bot's device pin is already passed in.
- **Approvals** are bound to `connectorIdentity` (id, kind, `account`, transport, host…) and `argsHash`
  (`src/connector-runs.js`, `missing` and `changed`). A connector replaced under the same id fails the check.
- **Permission names** are per connector: `connectorAction(connector, write, tool)` gives `connector.<id>.read` or
  `connector.<id>.write.<tool>`.
- **What bots see.** `envelopeConnectors(state)` tells every bot about every connector, with no per-bot filter.
  `findConnector(state, use)` resolves a block's `use` by id or name.
- **OAuth.** `src/mcp-oauth.js` (`envClient` for Google, Slack and GitHub clients from `.env`), the catalogue in
  `shared/app-catalog.js`, and the routes in `src/routes-connectors.js`.

Per-bot connection pins and several Google connections are **not built yet; spec §5.4**.

#### What must be built

1. Several connections per app, each its own vault credential. Decide how a second Google connection gets an id other
   than `google`, and keep the old id working.
   - Files: `shared/connectors.js` (`newConnectorId`, `findConnector`), `src/routes-connectors.js`,
     `src/mcp-oauth.js`.
2. A per-bot pin: a bot setting naming the connections it may use. It is validated in `shared/bot-settings.js`, is
   owner-only, and is set like `browserAccount` (see `assertDevicePin` in `src/routes-groups.js` for the pattern).
3. The connection comes from the bot record, never from the block. Filter `envelopeConnectors` per bot. Refuse a
   block whose `use` names a connection the bot is not pinned to. Pass the chosen connector to `useConnector`.
4. An app with one connection and no pins behaves as today.
5. Settings and the bot's Edit page show the connections and pins. The demo says it needs the server, as connectors
   already do.
6. Backups carry pins as bot settings. A removed connection that a bot still names is refused, never silently swapped
   (compare Phase 2's `ACCOUNT_GONE`).

#### Rules and constraints

- §3.1: "A task runs on the device and in the account the server stamped on it, never one a model named."
- Grants are per account. An ask approved for connection A must not run on connection B. `connectorIdentity` already
  includes `account`; keep that true.
- Secrets: tokens stay in the vault and are never returned or printed.

#### Risks (Review Focus candidates)

1. A block names the other mailbox by name or id. It is refused, and nothing reaches `useConnector`.
2. An approval made while the bot was pinned to A is executed after the owner re-pins it to B. It must fail closed.
3. Removing the old single `google` connector or renaming ids breaks existing grants or `connectorCalls`.
4. Held sends (`holdsForUndo` checks `connector.kind === 'google' && tool === 'gmail.send'`) still work for a second
   Google connection.
5. A member's run uses a connection the owner pinned to another bot.

#### Dependencies

- Needs nothing new beyond Phases 0 to 3. It can run beside Phase 4 (§15).
- Inferred: Phase 4's ceilings name "connections", so if 5 lands first, Phase 4 can check them.

#### Open owner decisions (§16)

None.

### Phase 6: Reading

**Goal.** Bots read pages cheaply and in more formats: plain first, JSON, text, CSV, Markdown, PDF and images, with
redirects followed safely, and pages shown as images when the owner allows it.

**Definition of done (§15, quoted):** "A bot reads a PDF and a JSON feed, and sees a page as an image when you allow
it."

**Spec sections:** §7 (all five items); §3.2 rows `read` and `look`.

**Size:** 3 to 4 days.

#### What exists today

- **The device's read** is `execute` in `agent/agent.mjs` for `browser.capture`, then `capture` in
  `agent/browser-host.mjs`. With a browser (`AGENT_BROWSER=1` and `findBrowser()`), Chrome goes first.
  `plainFallback`, `turnedAway` and `preferRead` (`agent/page-fetch.mjs`) decide when a plain read replaces it. An
  account's page is never handed to the plain read.
- **The plain read** is `readPlain` in `agent/agent.mjs`.
  - It vets the address with `resolvePublicAddress` and pins the connection with `pinnedRequest`
    (`agent/net-guard.mjs`).
  - It reads HTML only (`readableHtml`) and is capped at 2,000,000 bytes.
  - It reports a redirect as text ("This page moved to …") instead of following it.
- **Screenshots.** `Page.captureScreenshot` is used for an action result (`agent/browser.mjs`) and for the live view
  (`agent/shared-browser.mjs`). Nothing hands a screenshot to a model.
- **Images to models** go through `userContent` (`src/ai.js`) and `cleanImages` (`agent/cli-model.mjs`). The limits
  `MODEL_IMAGE_BYTES` (5 MB) and `MODEL_IMAGES_TOTAL` (15 MB) are in `shared/attachments.js`. Today only the owner's
  attachments use these paths.
- **The block.** `validateBrowserRequest` (`shared/bot-browser.js`) keeps only known fields. A new field (`render`,
  `look`, `images`) must be added there, or it is dropped.
- **The allowlist:** `AGENT_BROWSER_ALLOWLIST`, `hostAllowed`.
- `pdftotext`, content types, followed redirects, `look`, `images` and images on handoffs are **not built yet;
  spec §7**.

#### What must be built

1. **Plain first.** A read with no steps tries a plain fetch first. It uses Chrome only when the text is under 300
   characters, the site turned it away, the bot asked `"render": true`, or the page needs the bot's account.
   - Files: `agent/browser-host.mjs`, `agent/page-fetch.mjs`, `shared/bot-browser.js`.
   - "A service profile records `render: true`" waits for Phase 8.
2. **Content types.** JSON, plain text, CSV and Markdown come back as text.
   - A PDF is turned to text with `pdftotext` where it is installed, with a 20 MB cap. Without it, one clear line names
     the file and its pages.
   - An image is handed to the model as an image.
   - Files: `agent/agent.mjs` (`readPlain`), `agent/page-fetch.mjs`.
3. **Redirects** are followed up to 5 hops. Each hop is checked against the allowlist and the private-address guard
   (`agent/net-guard.mjs`).
4. **Seeing.**
   - `"look": true` returns a JPEG screenshot, at most 1280 wide.
   - `"images": true` lists up to 12 main images.
   - An image URL arrives as an image.
   - At most 4 images a turn, 5 MB each, through `userContent` and `cleanImages`.
   - It is opt-in, sent once per page, and off for signed-in pages unless a goal's ceilings allow it.
5. **Images on handoffs:** up to 4 of that turn's images go along with an ask or a handoff.
6. If the server runtime (`src/browser-runtime.js`) also serves reads, decide whether it gets the same rules or stays
   as it is. The spec talks about the device.
7. Update `docs/AGENT-PROTOCOL.md` §6 (task kinds and the read boundaries).

#### Rules and constraints

- The network guard holds at every hop. A redirect never reaches a private address or a host off the allowlist.
- "A screenshot of a signed-in page sends private data to the model provider" (§7.4), so it is off by default.
- A PDF or image read is still outside content. The run is marked as for any page.
- Secrets: `scrubTyped` and the secret-field rules apply to any new result field (§6.1 lists `url`, `finalUrl`,
  `title`, `text`, `excerpt`, `links`, `elements` and `readText`). A screenshot of a page with a filled secret field
  is a new leak path. Think about it before you ship `look` on a tab the owner typed into.

#### Risks (Review Focus candidates)

1. A redirect chain that ends on `169.254.169.254` or a LAN host is refused at the hop, not after.
2. A signed-in account page with `look: true` and no ceiling allowing it returns no image.
3. Plain-first never reads an account's page with no cookies (Phase 2's Review Focus 1, "the wrong account through a
   fallback").
4. A 20 MB+ PDF, a PDF with no `pdftotext`, and a malformed JSON each give one clear line, not a crash.
5. The image budget (4 per turn, 5 MB each, 15 MB in all) holds when a handoff adds images on top of a page's.

#### Dependencies

- Needs nothing new beyond Phases 0 to 3. It can run beside Phase 4 (§15).
- The ceiling "whether signed-in pages may be seen as images" is a Phase 4 goal ceiling. Without Phase 4, keep it
  simply off.

#### Open owner decisions (§16)

None.

### Phase 7: Blueprints you apply

**Goal.** A goal's team is one versioned blueprint document. The lead proposes changes, and the owner applies each
one from a card that shows only the diff.

**Definition of done (§15, quoted):** "The lead proposes adding a role; you see only the diff, apply it, and the new
bot joins the group."

**§15's scope (quoted):** "10.1, 10.2 first step: schema, `shared/blueprints.js`, validation, dry run and step
resolver, the diff card, `POST /api/goals/:id/apply`, versions, pausing on failures; watch and event playbooks
(10.4)".

**Spec sections:** §10.1, §10.2 (first step only: every change is a card), §10.4; §13.1 (the blueprint change card).

**Size:** 6 to 8 days.

#### What exists today

- After Phase 4: goals, their playbooks, lanes and collections, the playbook runner and the `goal` activity kind.
- `simulateGroup` (`shared/group-simulator.js`): an offline run of a group's handoffs with canned replies. Spec §10.2
  uses it for the dry run, and it covers coordination only.
- Setup cards: `SETUP_ACTIONS` (`shared/setup.js`) and `setupCardsFromReply` (`src/setup-cards.js`). They are
  applied by the UI calling ordinary routes one by one. A blueprint is too many parts for that (§2.2 item 10).
- New bots: `shared/bot-create.js` refuses permission fields and sets `reportsTo`.
- A bot's `browserAccount` and `device` are owner-only settings. The Phase 2 plan says an applied blueprint may set
  `browserAccount`, and that this is Phase 7.
- Watches (`src/watches.js`, owner-made) and event triggers (`src/triggers.js`, run marked `outsideInput`).
- `shared/blueprints.js` and `POST /api/goals/:id/apply` are **not built yet; spec §10.1, §10.2**.

#### What must be built

1. **The schema** in `shared/blueprints.js` (add it to `shared/assets.js`): goal, roles (`key`, `job`, `model` tier,
   `browserAccount`, `connections`, `lanes`, `reportsTo`), playbooks, lanes and collections, as in §10.1.
   Experiments and record-change triggers are deferred.
2. **A `blueprint` block** a lead (or a role the blueprint allows) can send. Parse it with
   `shared/reply-blocks.js`, the one fence grammar.
3. **Validation:** the schema, every reference (roles, collections, lanes, accounts, connections, skills) and every
   number against the ceilings.
4. **The dry run:** `simulateGroup` for handoffs, and a step resolver that confirms each trigger, primitive and
   reference exists, and that each `when` parses and names only earlier answers. The card says this is not a full
   rehearsal.
5. **The diff card:** only the diff, with Apply, Edit and Decline, in the group chat.
6. **`POST /api/goals/:id/apply`:** owner-only. It validates the whole diff again, applies it in one store update and
   logs it under `goal`. Roles become the group's bots, and each role's `reportsTo` sets the bot's.
7. **Versions:** keep the newest 50, each restorable in one tap.
8. **Pausing on failures:** a playbook that fails 3 runs in a row is paused, and the stand-up says so. "A change you
   applied is never undone by itself."
9. **Watch and event playbooks** (§10.4): `on: {watch: id}` and `on: {event: trigger}`. A run they start is marked
   `outsideInput`, and every outbox item it makes waits for approval whatever the ceilings say.

**Likely files** (names that do not exist yet are suggestions):
- create `shared/blueprints.js` (not built yet; spec §10.1) and add it to `shared/assets.js`;
- the apply route in the goals route file Phase 4 adds (suggested `src/routes-goals.js`);
- the `blueprint` block: `shared/reply-blocks.js` for the fence, and the reply handling in `src/bot-turn.js` or
  `src/coordination.js`;
- the diff card: `shared/ui-asks.js` or `shared/ui-conversation.js`, beside the setup card;
- the dry run: `shared/group-simulator.js` plus a step resolver beside the Phase 4 playbook rules;
- watch and event starts: `src/watches.js`, `src/triggers.js` and the Phase 4 playbook runner (suggested
  `src/playbooks.js`).

#### Rules and constraints

- "The lead may propose; only your Apply changes the team" (§10.2).
- The sorting into free, power and never (§10.2 step 3) is **Phase 9**. In Phase 7 every change is a card.
- "Never" changes are refused with one line: core code, the permission registry, approval rules, guards, secrets.
- A blueprint never carries a grant. Account and connection choices in it are owner choices made through Apply.

#### Risks (Review Focus candidates)

1. A blueprint applied half-way: a failure in the middle leaves nothing changed (one store update).
2. A role in the diff that names an account, connection or site the goal's ceilings do not allow is refused at
   validation and again at apply.
3. A diff changes between the card and the tap. Apply must apply what the card showed: bind it by a hash, as
   `argsHash` does.
4. A watch-started playbook's outbox item goes out without approval while the ceilings allow sending. It must still
   wait.
5. Restoring an old version that names a deleted bot or account.

#### Dependencies

- Inferred: needs Phase 4 (goals, playbooks, `goalId`, the `goal` activity kind, the stand-up).
- Inferred: reads Phase 5's connections if they exist.

#### Open owner decisions (§16)

| Decision | What it blocks | Default if unanswered |
|---|---|---|
| §16.4 Schedules and watches made by a team | Whether a new schedule, timer pattern or watch in a blueprint is a power change | A power change, a card you apply (as the spec keeps it) |
| Call: the first release of blueprints is apply-only | Nothing | As the spec says |
| Call: a failing playbook is paused, not reverted | Nothing | As the spec says |

### Phase 8: Services and skills

**Goal.** The team knows each website or app it uses through a service profile, learns saved step lists (skills) it
reuses, and the lead turns a one-sentence goal into one Apply card.

**Definition of done (§15, quoted):** "You say a goal in a sentence and get one Apply card naming the services, their
rules and the team."

**§15's scope (quoted):** "11: profiles, the action vocabulary, the ladder, rule summaries you confirm, every skill
approved once, `actionPaths` set by you; browser outbox items as skills; intake (4.1) writing the first blueprint".

**Spec sections:** §11.1 to §11.4, §4.1 (intake), §8.2 (browser items as skills), §12 (patterns), §13.1 (rules and
skill cards).

**Size:** 5 to 7 days.

#### What exists today

- Browser approval by class and origin: `approvedFor(action, url)` gives `` `${action}@${originOf(url)}` ``
  (`shared/bot-browser.js`). Spec §2.2 item 6 wants payload-bound approval instead. For browser items, the outbox's
  `payloadHash` over a skill version and its parameters does that.
- Asks and grants decide first (`verdict` in `shared/asks.js`). A profile's `allowed` can only narrow.
- Sign-in detection (`signinSite`, `signinPage`, `accountWall`) and browser accounts, from Phases 2 and 3.
- After Phase 4: the outbox (connector items only), lanes and timers. After Phase 7: blueprints and the apply route.
- Service profiles (kv `services`), skills, `actionPaths`, rule summaries and intake are **not built yet; spec §11,
  §4.1**.

#### What must be built

1. **Service profiles** in kv `services`, carried as owner settings (add it to `OWNER_SETTINGS`): `service`,
   `domains`, `accounts`, `rules {summary, sources, checkedAt, confirmedByOwner}`, `actions`, `pacing`, `render`
   (§11.1).
2. **The action vocabulary:**
   - reads: `read_item`, `read_list`, `search`, `read_metrics`, `export`;
   - changes in your own space: `create`, `update`, `upload`, `organise`;
   - toward people: `message`, `reply`, `publish`, `comment`, `invite`, `submit`, `book`;
   - money and removal: `purchase`, `pay`, `delete`;
   - upkeep: `sign_in_check`.
3. **`allowed` only narrows:** `never` refuses; `approve-each` and `ask-each` ask even where a grant would let it go;
   `yes` changes nothing.
4. **The access ladder** (§11.2): an official API through a connector; official exports and feeds; reading in the
   browser; acting in the browser through the outbox only.
5. **Rule summaries** the lead writes from the service's own published terms, with links and the date, confirmed by
   the owner once per service. An unconfirmed action defaults to `approve-each`.
6. **Skills** (§11.4):
   - steps named by meaning, in primitive vocabulary, unable to leave the profile's domains;
   - the first version has `draft` and `trusted` only, and the owner removes a broken one;
   - every skill, read-only ones included, is approved once by the owner, and each new version asks again.
7. **`go` templates.** Each parameter sits in one place (one path segment or one query value, encoded with
   `encodeURIComponent`). A path parameter holding `/`, `..`, `?` or `#` is refused. The resolved host must be one of
   the profile's domains.
8. **`actionPaths`**, set only through the owner's Apply. Any navigation to one of them goes through an ask or the
   outbox.
9. **Browser outbox items** as `{skill: {id, version, params}}`. On release the device runs the skill's `check` first,
   and the item fails on any mismatch. A dispatched browser item that times out becomes `unknown`, never resent
   (`expireBrowserTasks` in `src/bot-browser.js` needs a branch for `outboxId`).
10. **Intake** (§4.1): restate the goal, fill gaps with listed defaults, ask at most three questions on one card, pick
    a pattern (§12), check each service, draft the blueprint and ceilings, then one Apply card.
11. **Cards** for a rules summary and for a skill that acts (§13.1).

**Likely files** (names that do not exist yet are suggestions):
- a new browser-safe module for profile and skill rules (suggested `shared/services.js`; not built yet; spec §11),
  listed in `shared/assets.js`;
- `src/sqlite-store.js` and `src/backup.js` for kv `services`;
- a route file for profiles and skills (suggested `src/routes-services.js`), registered in `src/app.js` and
  `tests/route-roles.test.js`;
- `shared/bot-browser.js` (the `go` template checks, `actionPaths` on navigation), `src/bot-browser.js`
  (`dispatchBrowserRequest`, `expireBrowserTasks` for `outboxId`), and the device's step runner in
  `agent/shared-browser.mjs` for the skill's `check`;
- the Phase 4 outbox (suggested `src/outbox.js`) for the skill action shape;
- `shared/ui-asks.js` or `shared/ui-conversation.js` for the cards.

#### Rules and constraints

- "Since `allowed` only narrows, the powers are two: which account a service uses, and pacing faster than your
  floor" (§11.3). Loosening an `allowed` is a card.
- "A skill is always written after reading the page, so it is always written by a marked run" (§11.4). So it is
  always owner-approved before it is trusted.
- A step toward people or money becomes an outbox item.
- Out on purpose (§12): trading, moving money, purchases without a per-order yes, actions a service's rules forbid,
  and anything that hides automation or gets past a human check.

#### Risks (Review Focus candidates)

1. A parameter that injects a path (`../cart/remove`) or a host. It is refused before the step runs.
2. A run that read outside text writes `"update": "yes"` into a profile. It gains nothing.
3. A skill's fixed address changes something on a plain GET (`/cart/remove?sku=A1`). It can never be trusted as a
   read.
4. A browser outbox item released hours later meets a changed page. `check` fails, and the item fails without
   improvising.
5. Intake never grants: the Apply card is the only way its accounts, lanes and ceilings take effect.

#### Dependencies

- Inferred: needs Phase 4 (outbox, lanes, timers) and Phase 7 (blueprints and apply, which intake writes).
- Inferred: uses Phase 6's `render` for the profile's `render: true`.

#### Open owner decisions (§16)

None of the four is specific to Phase 8. §16.1 (whether a lane offers Always allow) also applies to browser lanes.

### Phase 9: Free changes

**Goal.** Changes that grant nothing new apply by themselves, but only from the stand-up's own run, at most 5 a day,
each with one-tap Undo.

**Definition of done (§15, quoted):** "The stand-up shifts a role's job by itself from code-computed numbers, and the
change shows with Undo."

**§15's scope (quoted):** "10.2 second step: sorting free, power and never; the stand-up's own-key rule; 5 a day;
undo of free changes".

**Spec sections:** §10.2 (the second step, the table and steps 3 to 6), §9.2 (the stand-up), §14 step 6.

**Size:** 3 to 4 days.

#### What exists today

- After Phase 7: blueprints, the diff and the apply route.
- After Phase 4: the stand-up under `goal:<id>:standup`, handed inside data only.
- The outside marks: `tainted`, `outsideRead`, `outsideInput`, `outsideMemory`, and `outsideRecord` from Phase 4.
- The sorting is **not built yet; spec §10.2**.

#### What must be built

1. **Sorting the diff** (the §10.2 table):
   - **Free** (applies by itself): a role's job text; a playbook using primitives the team already holds; a wider lane
     gap; a new collection or field; retiring a role; a permissionless role within the bot cap.
   - **Power** (a card): a new schedule, timer pattern or watch; a new account, connection, site or permission; any
     Always allow; a higher ceiling; a gap below the owner's floor; deleting a collection's data; touching another
     goal.
   - **Never** (refused): core code, the permission registry, approval rules, guards, secrets.

   Write the free list as an allow-list, so anything new is power by default.
2. **The outside hold:** a free change written by any marked run becomes a card. Only a change made in the stand-up's
   own run can be free.
3. **At most 5 free changes per goal per day.**
4. **Undo:** one tap. A free change is logged with its reason and shown in the next stand-up.
5. **Failure rollback:** a playbook that fails 3 runs in a row is paused, and if its last change was free, that change
   alone is undone.

**Likely files** (names that do not exist yet are suggestions):
- the sorting, as a pure function in `shared/blueprints.js` (Phase 7);
- the stand-up runner from Phase 4 (wherever it lands; spec §9.2), so a change from its own run can apply;
- the apply route from Phase 7, which gains a path that applies a free change without the card;
- the Undo control on the stand-up line in `shared/ui-feed.js` or `shared/ui-conversation.js`;
- the daily count of free changes on the goal record in kv `goals`.

#### Rules and constraints

- "Marks follow a run and its chat (2.2, item 17), so only a change made in the stand-up's own run (9.2) can be free"
  (§10.2 step 4).
- "A change you applied is never undone by itself, because a flaky site would otherwise revert your decisions"
  (§10.2 step 6).

#### Risks (Review Focus candidates)

1. A change proposed in the group chat, where scouts' replies sit, is always a card, even if its kind is free.
2. The stand-up handed an outside-marked note line, or a group label from a `text` field, becomes marked, so its
   changes are cards.
3. The sixth free change in a day is a card.
4. Undo of a free change after a later owner-applied change touches the same field.
5. A free-change rollback never reverts an owner-applied change.

#### Dependencies

- Inferred: needs Phase 7 (blueprints, diff, apply) and Phase 4's stand-up.

#### Open owner decisions (§16)

| Decision | Default if unanswered |
|---|---|
| Call: only the stand-up's own run may make a free change | As the spec says |
| §16.4: a new schedule or watch stays a power change | Power change |

### Phase 10: Goal templates

**Goal.** A goal can be installed from a template, a blueprint with blanks, through the same single Apply card.

**Definition of done (§15, quoted):** "You install "price watch" from a template with one card."

**§15's scope (quoted):** "10.3: format, Apply, a few built-ins (lead finding, support triage, price watch, repo
upkeep)".

**Spec sections:** §10.3; §12 (patterns the built-ins follow); §9.1 (`Templates/` in the tree).

**Size:** 2 to 3 days.

#### What exists today

- Message templates in `shared/templates.js`: `BUILT_IN_TEMPLATES`, `addTemplate`, `removeTemplate`,
  `MAX_TEMPLATES = 30`, `templateChips`.
  - They are stored as `state.templates` (kv `templates`, an owner setting in `src/backup.js`) through
    `POST/DELETE /api/templates`.
  - The UI is `shared/ui-templates.js`.
- After Phase 7: blueprints and apply. After Phase 8: services and intake.
- Goal templates are **not built yet; spec §10.3**.

#### What must be built

1. **The goal template kind** beside message templates, kept separate: a blueprint with blanks (accounts, topic,
   times) and the list of powers it needs.
2. **Install:** fill the blanks, then the same Apply card as a blueprint.
3. **Built-ins:** lead finding, support triage, price watch, repo upkeep.
4. A team may save a working blueprint as a template for the owner to keep.

**Likely files** (names that do not exist yet are suggestions):
- `shared/templates.js` (a separate goal-template kind beside the message templates, or a new browser-safe module
  listed in `shared/assets.js`);
- `shared/ui-templates.js` for the install sheet;
- the goals route file from Phase 4 (suggested `src/routes-goals.js`) for install, reusing the Phase 7 apply path;
- `src/backup.js` if goal templates get their own kv key (add it to `OWNER_SETTINGS`).

#### Rules and constraints

- Installing a template grants nothing until the owner's Apply. The card lists every power the template needs.
- Built-ins follow §12's "stays approval-first or out" column. For example, a price watch may notify, and a purchase
  asks every time.
- Don't invent services or sites in built-ins. Leave them as blanks the owner fills.

#### Risks (Review Focus candidates)

1. A template whose blanks are left empty installs nothing half-done.
2. A template naming a power the goal's ceilings forbid is refused at install.
3. Saving a team's blueprint as a template must not carry account ids, secrets or outside-marked text as if trusted.

#### Dependencies

- Inferred: needs Phase 7. The price-watch built-in uses watch playbooks (Phase 7, §10.4). The others are better after
  Phase 8 (services).

#### Open owner decisions (§16)

None specific.

### Later, when a real use asks

These are §15's "Later" row: the profile fallback (§5.1, `storage: "profile"`; §16.3 is the owner's memory decision
about it), named tabs (§5.3), experiments, record-change triggers, the best-time preference, the skill repair
lifecycle, one ACP adapter on the device for many coding CLIs (§5.5, feature `acp-v1`), and a password-manager
connector that hands a bot only an item id (§6.2, feature `vault-fill-v1`). Don't build them unless asked.

---

## 6. Carried leftovers

### 6.1 Carried from Phase 2

Copied from the "Carried from Phase 2" section of `docs/superpowers/plans/2026-11-27-phase-3-signin-from-phone.md`.
These are from the Phase 2 final review's LEAVE rows and the final re-review's Minors and Out-of-Scope notes. Line
numbers are as that plan gave them.

**Re-pairing**
- A second pair proof, so that removing either computer between the pair and the first heartbeat keeps the accounts.
  `finishReplacement` skips an old row the owner revoked (`src/bot-browser.js:349`).
- `agent_replaces:<id>` records never expire. Drop one whose old id beats again, or give it a TTL
  (`src/agent.js:287`).
- A persistent `finishReplacement` failure leaves the computer reading online while it gets no work, because
  `touchAgent` runs first (`src/routes-public.js:209-211`).
- A beat that retries after the move writes the "A local agent was replaced…" activity line twice
  (`src/bot-browser.js:353`).
- A crash between the revoke and the page finish of `finishReplacement` leaves the old row's requests `dispatched`
  until browser expiry (`src/bot-browser.js:356-367`).
- An owner PATCH that moves an account to the old id while the move runs lands on a row that is then revoked. It fails
  closed (`src/bot-browser.js:349-354`).

**Device and pages**
- `blockedRequests` counts other tabs' proxy refusals (`agent/browser.mjs:479`, `:570`, `:595`).
- `MAX_ELEMENTS = 60` can hide a login form from `signinPage` (`agent/browser.mjs:68`).
- On the default profile, the `signinPage` host fallback accepts localhost, an IP or `.internal`
  (`shared/bot-browser.js:291`).
- `KEEPER` is not a reserved bot id. A one-line refusal in `runBrowserTask` is optional
  (`agent/shared-browser.mjs:69`, `:639`).
- `savedAt` is stamped after a failed save, so the retry comes 10 minutes later instead of 1
  (`agent/shared-browser.mjs:569`, `:575`).
- The `scrub` account argument is dead (`agent/shared-browser.mjs:616`). The unused `current` and `jars` on the host
  are test seams (`agent/browser-host.mjs`).
- The conflict sentence says "another bot's tab" for one bot on two accounts (`agent/shared-browser.mjs:335`).

**Jars and the lock**
- Jars:
  - there is no folder fsync after a jar or config rename (`agent/account-jars.mjs:61-75`, `agent/agent.mjs:79-100`);
  - `retain` leaves a stray `<id>.jar.tmp` for kept ids;
  - `chmodSync(dir)` follows a symlinked folder (`agent/account-jars.mjs:64`);
  - the failed-rename path of `rekeyJars` is untested (`agent/account-jars.mjs:123-135`).
- Lock staleness on pid reuse, a server-started `run` refused while the previous one drains (about 60 s), and the
  judge-then-unlink window, all in `agent/agent-lock.mjs`.

**Server and routes**
- The stale `agent_accounts:` and `agent_features:<oldId>` rows survive a revoke (`src/agent.js:545`).
- The route's existence checks run before `c.store.update`. This fails closed (`src/routes-browser-accounts.js`).
- The route has no tests of its own for a 404, the limit, a duplicate or `storage: 'profile'`. The pure tests cover
  each (`tests/browser-accounts.test.js:14-60`).
- An account with no `deviceId` would fall back to the bot's pin. This cannot be reached
  (`shared/browser-accounts.js:106`).
- The `ACCOUNT_NOT_PINNED` wording is used for a computer that lacks the permission (`src/bot-browser.js:50`).
- "This bot's browser account changed. Approve again." is not in Phase 2's sentence list (`src/bot-browser.js:121`).
- The live view's refusal hand-builds `hub.view`'s shape, and unadopted spaces are kept (`src/routes-live.js:90`).
- The live hub is not told on a revoke, so it is at most about 45 s stale (`src/routes-account.js:145`).
- An unheld, unpinned bot's view follows the last poller. This is Phase 2 Call 13, by design
  (`src/routes-live.js:62-67`).

**UI**
- `pairedChoices` offers computers that lack `browser-accounts-v1` (`shared/ui-admin.js:191`).
- Cosmetics on the accounts page (`shared/ui-admin.js:191-215`, `:731`, `:915`):
  - run the two fetches with `Promise.all`;
  - "No computer" repeats;
  - a textarea name;
  - "is removed".

**Tests**
- `serverIn` should pass `LOCAL_AGENT: '0'`. Without the npm preload the spawned server runs its own agent and can
  wipe the test's jar (`tests/agent-accounts-e2e.test.js:49`).
- Wall-clock sleeps (a 1500 ms race) in `tests/shared-browser-accounts.test.js`.
- A misnamed test in `tests/browser-account-dispatch.test.js`.
- The wrong-proof test passed before the feature existed (`tests/browser-account-heartbeat.test.js`).

**Phase 1b**
- The parked 1b minors, left as they are:
  - the helper turn note;
  - the `''` key;
  - `fallbacksOf` by model name;
  - the `ui-admin` fallback select;
  - handoff ranking;
  - the `search_chat` cap;
  - the block-only fallback;
  - the fallback e2e timing.

**Rulings kept**
- A restore to the same install loses every jar (§9.4).
- The lock is stale on our own pid, a dead pid, or an mtime over 2 minutes.
- The `CRM` and `crm.example.com` placeholders stay.
- Phase 2's manual two-account check on a real site, with a device restart, is still the owner's to do, because it
  needs their sign-ins.

### 6.2 Carried from Phase 3

These come from Phase 3's final whole-branch review and its per-task reviews. The final fix wave fixed:
- the false wall on a clicked identity-provider landing (`clicked` in `accountWall`);
- the repeat card after Not now;
- the hand-back toast;
- the Not now toast;
- `carryOn`'s per-item guard;
- the delete route's 409;
- two weak tests;
- the doc wording.

The review of the Phase 3 PR then fixed:
- a card follows its account, not its bot (`signinBotFor` in `shared/asks.js`): Take control opens the tab of a bot
  that still signs in as the account, and a card whose bot was moved or deleted stays open while another bot on the
  account can answer it;
- the wall is decided by the host showing the form, never by its `next` or `continue` address (`accountWall`);
- a beat that reports a sign-out late makes no second card after the wall's card was answered (`since` from
  `recordAccountReports`, used by `signinFromKeeper`), while a sign-out after a card the owner signed in from still
  makes a new card (the newest card decides).

One edge is left on purpose: when no bot signs in as the account any more, Take control says so and the owner taps
Not now (or the card lapses after 24 hours).

The items below are still open. Line numbers are from Phase 3's tree, so grep before you fix.

**Do first (a real gap in Phase 3's promise)**
- **A sign-in card made in quiet hours never buzzes, and later walls reuse it silently.**
  - Where: `src/push.js` (`deliver` returns `'quiet'`), `notifySignin` in `src/ask-cards.js`, and the reuse path in
    `holdForSignin` in `src/signin-wait.js`.
  - What happens: keepers look every 30 minutes, so an overnight sign-out is found during `QUIET_HOURS`. Its one push
    is dropped, and every wall after it reuses the open card with no push. The owner wakes to no notice, while a
    morning schedule waits on the card for up to 24 hours.
  - Smallest fix the review suggested:
    1. The hourly ask sweep (`startAskExpiry` → `expirePendingAsks` in `src/ask-runs.js`) pushes each pending sign-in
       card made in quiet hours, once, after quiet hours end.
    2. Stamp it `latePushAt` on the ask, so it never repeats.
    3. Update the AGENTS.md "Sign-in from the phone" sentence ("waits in the app and is not pushed later (a push when
       quiet hours end is a planned follow-up)") and "The notice is not pushed during `QUIET_HOURS`" in
       `docs/DEPLOYMENT.md` in the same change.
  - Test: a card made inside the window, the sweep run inside it (no push) and after it (one push), and after it
    again (no second push).

**Optional**
- **A visible password field on the account's own site reads as the wall.** An example is a signed-in bot that clicks
  into a change-password form (`accountWall` in `shared/browser-accounts.js`).
  - It fails safe: two holds, then the bot gets the page.
  - The `clicked` flag could also gate this branch, for an end page that is not a sign-in path.

- **An account whose site is the parent of the IdP host reads signed in after a clicked wall.**
  - What happens: a signed-out account typed as `google.com` (or `live.com`, `apple.com`) runs a step task that lands
    on `accounts.google.com`. The `clicked` gate in `accountWall` passes, then `noteResult` in
    `agent/shared-browser.mjs` falls through to `onSite` and records `signed-in`. It heals at the keeper's next look
    (30 minutes), and it contradicts `docs/AGENT-PROTOCOL.md` ("the account's state is left as it was").
  - Fix: in `noteResult`, return with no finding when `clicked && isSigninHost(finalHost)`, before the `onSite` branch.
    Add a keeper test with site `google.com`.
- **A run whose resume write fails stays `awaiting_ask` forever.** `carryOn` in `src/ask-runs.js` now logs the
  failure, but `lapseOrphans` and `expireAsks` only look at pending asks, and `markInterrupted` skips `awaiting_ask`.
  Fix: give such a run the orphan treatment, or retry it on the next ask sweep.
- **The decline path skips a round's bookkeeping.** A sibling page that returns while the run is `awaiting_ask` is
  consumed by `resumeBrowserRun`. On Not now, `resumeAfterAsks` takes its `start` branch (`src/coordination.js`) and
  skips the `browserDepth` increment and the `failStreak` count. The cost is bounded: one undercount per declined card,
  and an account is declined at most once per run.
- **Test gaps from the fix wave:**
  - the smoke does not assert that closing the Computer view after a hand back with `resumed: 0` says nothing;
  - the per-account decline scope (`|| a.accountId` in `src/coordination.js`) is pinned only by the end-to-end test
    in `tests/signin-release.test.js`.

**Left as they are (low value; fix only if you are in the file)**
- A run-less 1:1 chat with two pages, one of them held, takes two turns and sees page 1 twice.
- An unguarded `JSON.parse` in `declineRestoredSignin` (`src/backup.js`). It matches `interruptRestoredRun`.
- A `team-` chat key with unusual characters loses its push route. Group ids are server-made.
- Weak spots in the tests:
  - a vacuous `sent.length` assertion in the "cannot be posted" test (`tests/browser-account-heartbeat.test.js`);
  - the keeper's restore case is simulated with `kvSet`, not `importBackup`;
  - no test that forget or close clears the device's typed-secret memory;
  - there is no failed re-dispatch test for a released sign-in hold.
- `BROWSER_STATUS.signin` is unreachable in chat (a harmless label).
- The `AGENT_API` patch in the usability smoke is fragile.
- The account delete route makes two non-atomic writes (`src/routes-browser-accounts.js`). It fails closed.

**Owner check:** Phase 3's manual phone check (§7 item 2) is still to do.

### 6.3 How to handle them

- **Fold a leftover into the phase that already touches its file.** For example:
  - a phase that edits `shared/ui-admin.js` takes the UI cosmetics;
  - Phase 6, which edits `agent/browser.mjs`, can take `MAX_ELEMENTS` and `blockedRequests` if they fit.

  List each one taken in a "Leftovers taken in this phase" table in the plan, as Phase 3's plan does.
- **Collect the rest into a small cleanup PR** between phases, with one commit per leftover and a test for each fix.
  Keep that PR off `shared/` if a phase branch that touches `shared/` is open (lesson 2).
- **Leave "Rulings kept" alone.** They are decisions, not bugs.
- **Re-check before fixing.** The line numbers are from Phase 2's tree, and Phase 3 changed some of these files. Grep
  for the function first.
- Carry whatever is still open into your phase plan's own "Carried from Phase N" section.

---

## 7. Things only the owner can do

Don't attempt these, and don't mark them done. Ask the owner, or list them in your report.

1. **Phase 2's manual real-site check. Not done yet.** Two accounts of one real site on one computer, one bot on each,
   each bot reads its own account, and both are still signed in after the device app restarts. The steps are Task 13
   Step 5 in `docs/superpowers/plans/2026-11-27-phase-2-browser-accounts.md`. It needs the owner's own sign-ins.
2. **Phase 3's manual phone check. Not done yet.** The phone reaches the app over HTTPS (`tailscale serve`, or Caddy
   with `TRUST_PROXY=1`); push is on; a keeper finds an account signed out; the phone buzzes; the owner signs in from
   the phone through the Password and Code fields; the waiting run carries on. The steps are Task 7 Step 5 in
   `docs/superpowers/plans/2026-11-27-phase-3-signin-from-phone.md`.
   - Whether `tailscale serve` sends `X-Forwarded-Proto` is read from Tailscale's source, not tested
     (`docs/DEPLOYMENT.md`, "TLS via a reverse proxy").
   - The Cloudflare path is also untested.
3. **The §16 decisions:**
   - the publishing boundary (Phase 4);
   - sending without asking inside a goal (Phase 4);
   - the profile fallback's memory (later);
   - schedules and watches made by a team (Phase 7).

   Also the "Calls I made, which you can change" list in §16. Build on the defaults in §5 until the owner answers, and
   say in the plan which default you used.
4. **Anything that needs credentials:** real AI keys, OAuth clients (`GOOGLE_CLIENT_ID` and the others in `.env`),
   real mailboxes for Phase 5's "two mailboxes", a real site's sign-in, push on a real phone.
5. **Anything that spends money or publishes:** a real send to a real person, a post, a purchase, a paid provider
   call beyond tests. In tests use the stub model and fake connectors.
6. **Confirming a service's rules summary** (Phase 8). By design that is the owner's tap.

---

## 8. Start here

For a new agent opening the repo for the first time:

1. **Read this file.**
2. **Read `AGENTS.md`, all of it.** It is the project contract. Its Security paragraphs describe each finished
   feature in detail.
3. **Run the gate on a clean tree**, so you know your starting point is green:
   `npm run check && AGENT_SKIP_DOTENV=1 npm test && npm run build:pages && git status --porcelain docs`, then
   `npm run test:ui`. If something is red, re-run that file alone (lesson 4) before you suspect the tree.
4. **Read the spec sections for your phase** (§5 of this file lists them), plus spec §2.2, §3.1, §15 and §16.
5. **Read the finished plans** as models:
   - `docs/superpowers/plans/2026-11-27-phase-2-browser-accounts.md`;
   - `docs/superpowers/plans/2026-11-27-phase-3-signin-from-phone.md`.
6. **Open the code this file names for your phase and confirm it.** Grep each function before you cite it. Note what
   differs from the spec.
7. **Write the plan** at `docs/superpowers/plans/<date>-phase-<N>-<name>.md` (§4 of this file). Record each §16
   default you rely on as a Call. Commit it: `docs: plan phase <N>, <name>`.
8. **Make the phase branch** `feat/phase-<N>-<name>` off `main`, and a branch per task off it.
9. **Build each task test-first.** Run the gate before each commit. Commit with explicit paths.
10. **Merge each task** into the phase branch. Resolve `docs/` stamp conflicts as in lesson 1, and run
    `npm run test:ui` at every merge.
11. **Review each task**, then the whole branch, then do one fix wave.
12. **Finish:** run the end-to-end test for §15's "done when", make the doc edits (AGENTS.md, README, the protocol or
    deployment docs), tick `docs/BUILD-PLAN.md`, open the PR, and merge it once CI is green.
13. **Report:** what was built, what was left out and why, any flaky test you re-ran, and the owner's manual check for
    the phase.
