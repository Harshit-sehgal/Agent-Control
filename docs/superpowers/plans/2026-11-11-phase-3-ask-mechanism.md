# Phase 3: Ask mechanism, grants and the activity log, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps are TDD: test first, watch it fail, implement, run the suite.

**Goal:** A bot never answers "I don't have permission". It asks the owner. The ask card offers Decline, Allow, and Always allow for this bot, except for payments. Each bot's grants are listed on its profile, each with Always allow / Ask each time / Deny. Everything that left the app goes into one clean activity log.

**Spec:** `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md`, sections:
- "One ask mechanism"
- "Activity log and Pause all"
- "Calls made after the builder check" (classifier, grant scope, pending asks)
- Owner answers 1 and 4

## Global Constraints

- The repo rules in `AGENTS.md` hold, along with every gate:
  - `npm run check`
  - `timeout 600 npm test`
  - `npm run build:pages` with no drift
  - `npm run test:ui`, for UI tasks
- The basic kit is never asked about: `bot.ask`, `bot.create`, handoff, `schedule.set` and memory.
- These actions ask: `browser.use`, `connector.<name>.read`, `connector.<name>.write`, `send`, `post`, `delete`, `spend`.
- `spend` only ever offers Decline / Allow. It never offers Always allow, and a stored grant for `spend` is refused.
- Grant scope is per bot, per action, per origin for `browser.use`, and per account for connectors. Bots never inherit their creator's grants.
- A pending ask holds nothing. Asks from unattended runs (no owner message in the run) expire after 24 hours as declined.
- The activity table is append-only: `activity(id, at, bot_id, kind 'outside'|'perm'|'bots', text, thread_id, undo_until)`. It is a new schema migration (v12) with a `TABLE_SHAPES` entry, and retention follows the existing rules.
- Copy, verbatim:
  - Ask card buttons: **Decline**, **Allow**, **Always allow for this bot**.
  - Grant choices: **Always allow**, **Ask each time**, **Deny**.
  - Pause banner: "All bots are paused. Nothing runs until you resume."
  - Activity filter chips: *Left the app*, *Permissions*, *Bots*, *All*.
- The X click/type refusal in validation stays. The final Post is always human.

## Review Focus

1. An ask answered after its run was cancelled or deleted. The answer is recorded and nothing resumes.
2. Always allow sent for `spend` through a crafted request. The server refuses it with a 400.
3. A Deny grant. The bot stops and its reply tells the owner where to change the grant. It never retries in a loop.
4. Two asks pending in one run, answered out of order.
5. A restored backup carrying grants for a bot that no longer exists. The grant is ignored, and nothing crashes.

### Task 1: `shared/asks.js` and the grant store

- Create `shared/asks.js` exporting:
  - `ASK_ACTIONS`
  - `isBasicKit(action)`
  - `scopeOf({action, target})`, giving the origin for `browser.use` and the account for connectors
  - `grantFor(state, botId, action, scope)`, returning `'always'|'ask'|'deny'|null`
  - `setGrant(state, botId, action, scope, choice)`, which refuses `'always'` for `spend`
  - `createAsk(state, {botId, runId, chatKey, action, target, detail, now, makeId})`
  - `answerAsk(state, askId, answer:'decline'|'allow'|'always', now)`, which returns `{ask, resumeRunId|null}`
  - `expireAsks(state, now)`
  - `pendingAsks(state)`
- State: `state.asks[]` and `state.grants[]` `{botId, action, scope, choice, at}`, persisted as two TABLE_SHAPES tables (migration v12, together with `activity`).
- `canBot` (`shared/contracts.js`): basic kit → allowed. Otherwise a grant of always → allowed, deny → refused with a "change it on <Bot>'s profile → Permissions" message, and ask or no grant → an ask is needed.
- Tests: `tests/asks.test.js` covers each export, plus Review Focus 2 and 5.

### Task 2: Runs wait on asks

- New run status `awaiting_ask` in `shared/run-state.js`. It is busy and stoppable, and it survives a restart.
- When a bot's step needs an asked action (a browser request today; send, post and delete via the classifier for browser clicks), the engine:
  - releases the browser,
  - creates the ask,
  - parks the run, and
  - writes a chat line `{kind:'ask', askId, text}` in the run's chat and in Atlas's chat ("Needs you").
- Answering:
  - `POST /api/asks/:id {answer}`, owner/admin only, with a Pages twin.
  - It resumes the run on allow or always (always also stores the grant).
  - On decline, the bot gets one closing turn told "The owner declined: <action>".
- The existing browser approval flow (`browserApproval`, `/api/browser-requests/:id/approve|deny`) folds into this. Keep the old routes as thin aliases for one phase, and ledger the choice.
- Push notification on a new ask: reuse `notify`.
- Tests: `tests/ask-runs.test.js` covers Review Focus 1, 3 and 4, plus 'an always grant lets the next run go without asking' and 'an unattended ask expires declined after 24 hours'.

### Task 3: Activity log

- Create `shared/activity-log.js` exporting:
  - `logActivity(state, {botId, kind, text, threadId, undoUntil, now, makeId})`
  - `activityPage(state, {filter:'outside'|'perm'|'bots'|'all', before, limit})`, newest first
- Entries are written for:
  - anything that left the app (a browser page opened with a signed-in session, a send, a post);
  - grant changes;
  - bots created, moved, paused or deleted;
  - Pause all and Resume.
- Never written for routing, thinking, bot-to-bot messages or reads inside the app.
- Route: `GET /api/activity?filter=&before=` (viewer), with a Pages twin.
- Retention prunes it with `events`.
- Tests: `tests/activity-log.test.js`.

### Task 4: UI

- The ask card: one sentence, the asking bot's waiting face above it, and the three buttons (two for spend). An answered card collapses to one muted line ("You allowed it once").
- Profile → Permissions lists the grants with Always allow / Ask each time / Deny (spend shows no Always allow).
- Settings → Permissions lists every grant across bots, editable in place.
- Settings → Activity and each profile's Activity section (five newest, "Show all N") use the four filter chips.
- The pause banner appears while `state.guard.paused`.
- Remove the per-bot permission checkboxes and `browserApproval` from every UI.
- Smokes cover:
  - allow once
  - always allow, then no second ask
  - deny shown on the profile
  - the activity filter
