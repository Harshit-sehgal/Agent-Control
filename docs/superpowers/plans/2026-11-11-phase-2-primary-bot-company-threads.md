# Phase 2: Primary bot, company model and threads, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-Atlas workspace into a company of bots. Every bot has one continuous chat. Atlas and the managers hand work to their teams. Threads are new chats that Atlas runs. The UI follows mock v46 with the Chats home.

**Architecture:** The company is the existing `home` group. All bots live there, and `settings.reportsTo` draws the org chart. A thread is a group record with `settings.kind = 'thread'` and no bots of its own. Atlas and the bots it hands work to take part as guests through the guest mechanism that already exists. A bot chat stays the existing per-bot direct chat (chat key = bot id). Routing is the lead's own model call: the lead sees its team's names and jobs, and it hands work out with `@Name` (`handoffTargets` stays the only path). A closing step for the lead is appended so the lead can report back. The UI is rebuilt from the mock in new `shared/ui-*.js` files plus new CSS files, so parallel workers never edit the same file.

**Tech Stack:** Node >= 22, `node --test`, zero npm runtime dependencies, browser-safe `shared/`, Python Playwright smokes.

**Spec:** `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md`. The UX reference is `docs/superpowers/specs/2026-11-11-primary-bot-platform-mock.html` (v46). Owner answers 4 to 6 override the mock: one user, out-of-job buttons, Chats home only.

## Global Constraints

- Follow the repo rules in `AGENTS.md`:
  - Every new `shared/*.js` or `.css` file is added to `shared/assets.js`.
  - `scripts/check.mjs` ROOTS still cover every folder.
  - `npm run build:pages` runs, and `docs/` is committed with every `shared/` change.
  - CSP parity holds.
  - No `node:` import in `shared/`.
  - No import cycles.
  - Every `TABLE_SHAPES` entry matches its table.
- No schema migration is needed. New bot fields (`reportsTo`, `shape`, `color`, `pinned`, `order`) live in the bot `settings` JSON. Thread fields (`kind`, `members`, `ownerId`) live in the group `settings` JSON.
- These checks stay green at every commit:
  - `npm run check`
  - `timeout 600 npm test`
  - `npm run build:pages` with no drift
  - `npm run test:ui`
- The final Post click is always human. Click/type on X stays refused in validation.
- Bot-to-bot limits, verbatim from the spec:
  - A chain goes at most 6 bots deep.
  - The same two bots exchange at most 12 messages per task.
  - One task uses at most 60 bot-to-bot messages.
  - A loop is the same question three times with no new answer.
- Runaway guard, verbatim: more than about 50 creations or 300 bot-initiated runs in 5 minutes pauses all bot-initiated work. The card offers Keep going / Stop. Owner-initiated chats keep working.
- Copy, verbatim:
  - Checkpoint buttons: **Keep going**, **Keep going, don't ask again**, **Stop**.
  - Out-of-job buttons: **Do it anyway**, **Ask Atlas**, **Make a new bot**.
  - Bot chat header status: "One continuous chat" / "Hands work to its team" / "Hands work to any bot".
  - Thread header: "Atlas runs this thread".
- Atlas cannot be deleted or hidden. The primary is the bot with `settings.lead === true` in `home`, and exactly one exists.

## Review Focus

1. A workspace from before Phase 2 that has several groups. Its bots must survive as company bots. Each old lead reports to Atlas, and each old member reports to its old lead.
2. A cycle via `reportsTo`: A→B→A, or a bot made its own manager. This is refused with a 400, never stored.
3. Deleting a manager. Its reports become Solo (`reportsTo: null`), and their chats and threads stay.
4. A thread whose Atlas reply @mentions a bot that was deleted mid-run. The run skips it and does not crash.
5. A model reply that spams `ask` blocks or `create-bot` blocks in a loop. The checkpoint card and the runaway guard trip, and the run never spins unbounded.

---

### Task 1: Company model (`shared/company.js`)

**Files:**
- Create: `shared/company.js`, `tests/company.test.js`
- Modify:
  - `shared/assets.js` (register)
  - `shared/bot-settings.js` (allow `reportsTo`, `shape`, `color`, `pinned`, `order` in `validateBotSettings`; `SHAPES` list)
  - `shared/workflow.js` (`migrate` folds legacy groups)
  - `src/routes-groups*.js` / `shared/local-api.js` (delete guards and manager validation on bot PATCH)

**Interfaces (produces):**
- `SHAPES = ['rounded','circle','hexagon','pebble','drop','shield','arch','egg','blob','bean']`
- `COLORS` is an array of 10 pastel tint names taken from the mock.
- `company(state) -> group` returns the `home` group, creating none.
- `primaryOf(state) -> bot`
- `managerOf(state, botId) -> bot|null`
- `reportsOf(state, botId) -> bot[]` gives direct reports.
- `teamOf(state, botId) -> bot[]` gives the whole subtree, excluding the bot itself. For the primary it is every other bot.
- `isLead(state, botId) -> boolean`: true for the primary, or for any bot that has reports.
- `setManager(state, botId, managerId|null)` throws a 400 on an unknown id, on self, or on a cycle. The primary's manager is always null.
- `removeFromCompany(state, botId)`: the bot's reports become Solo, and it throws a 409 for the primary.
- `foldLegacyGroups(state)`:
  - Each non-thread group other than `home` moves its bots into `home`.
  - The old lead, or else the first bot, reports to the primary.
  - Its other bots report to that lead.
  - The group is then deleted, along with its `team-<id>` chat. Bot chats are kept.

- [ ] Step 1: write tests in `tests/company.test.js`:
  - 'a manager is a bot with reports and the primary leads everyone'
  - 'a reporting cycle is refused'
  - 'the primary cannot be deleted or given a manager'
  - 'deleting a manager leaves its reports solo'
  - 'an old workspace with three groups becomes one company with the old leads under Atlas' (Review Focus 1)
  - 'bot settings accept shape, colour, manager and pin'
- [ ] Step 2: run `node --experimental-sqlite --import ./tests/ai-env.js --test tests/company.test.js`. Expected: FAIL (module missing).
- [ ] Step 3: implement. `migrate` calls `foldLegacyGroups` after its existing work. Bot DELETE on the primary returns 409 with "Atlas is the primary bot and cannot be deleted." Bot PATCH with `settings.reportsTo` goes through `setManager`.
- [ ] Step 4: run the test file and the full suite. Expected: PASS. Then fix the fallout: tests that build several groups now see them folded. Rule each one in the ledger.
- [ ] Step 5: run `npm run build:pages`, then commit with `feat: company model with managers and a primary bot`.

### Task 2: Threads (`shared/threads.js`)

**Files:**
- Create: `shared/threads.js`, `tests/threads.test.js`
- Modify:
  - `shared/coordination.js`: `assertGroup` accepts a thread with no bots. `createRun` in a thread recipients the primary as a guest, and the chat key is `team-<threadId>`.
  - `src/coordination.js`: the guest roster for a thread is every company bot.
  - `src/routes-*.js` (threads route), `shared/local-api.js`
  - `shared/assets.js`

**Interfaces (produces):**
- `createThread(state, {title='', now, makeId}) -> group`. The result is `{id:'th-…', name:title||'New thread', description:'', settings:{kind:'thread', ownerId:primaryId, members:[]}, bots:[]}`.
- `isThread(group) -> boolean`
- `threadsOf(state) -> group[]`, newest activity first.
- `titleFrom(text) -> string`: the first line, at most 60 chars, cut at a word boundary.
- `noteMember(group, botId)` adds a bot id to `settings.members` once.
- Route: `POST /api/threads {message}` creates a thread, titles it from the message, and starts the Atlas run. It returns `{thread, run}`. The least role is `member`.
- Follow-ups use the existing `POST /api/groups/:thread/chat` with no `directBotId`. They always go to the primary, and `@` in a thread is ignored for routing (spec: "The owner does not pick bots in a thread").

- [ ] Step 1: write tests:
  - 'starting a thread creates a new chat run by Atlas'
  - 'a follow-up in a thread goes to Atlas again, even with an @mention'
  - 'a thread never reuses a bot chat'
  - 'bots Atlas hands work to become thread members'
  - 'a thread title is the first line of the first message'
- [ ] Step 2: run it. Expected: FAIL.
- [ ] Step 3: implement on the server and in `local-api.js`. The Pages engine must pass the same test through `localApi`; mirror the pattern in `tests/engine-parity.test.js`.
- [ ] Step 4: run the tests and the suite. Expected: PASS.
- [ ] Step 5: build:pages, then commit with `feat: threads are new chats run by Atlas`.

### Task 3: Lead routing and the out-of-job reply

**Files:**
- Modify:
  - `shared/coordination.js`: `createEnvelope` and the lead closing step
  - `src/coordination.js`: run loop
  - `shared/reply-blocks.js`: new `not-my-job` fence
  - `shared/group-simulator.js` / `shared/local-api.js`
- Create: `shared/off-job.js`, `tests/lead-routing.test.js`, `tests/off-job.test.js`

**Decisions:**
- **Lead envelope.** When the recipient bot `isLead`, `team` is `teamOf(state, bot.id)` mapped to `{name, job: instructions.slice(0,160)}`. The envelope gets one restriction line: "You lead this team. Hand each part of the request to the teammate whose job it is by writing @Name and what you need; answer yourself only what is your own job. If nobody on your team does this work, say so and offer to create a bot for it." A lead's `handoffTargets` roster is its team (Atlas: every company bot).
- **Closing step.** When a lead's reply adds recipients, the run appends the lead once more after them (`run.closeWith = leadId`, at most once per run). The closing envelope's `previous` is every teammate reply joined (each `Name: text`, 600 chars each). This is how "the lead gives the owner the result there".
- **Plain bot.** A non-lead in its own chat gets the line: "If the request is not part of your job, do not do it: reply only with a not-my-job block giving one short reason." The grammar is ```` ```not-my-job\n{"reason":"…"}\n``` ````. `shared/off-job.js` exports `parseOffJob(output) -> {reason}|null` and `offJobMessage({bot, reason, request}) -> message`. The message has kind `offjob` and carries `request` (the owner's text, max 4000) and `botId`.
- **Do it anyway.** `POST /api/groups/home/chat {message, directBotId, anyway:true}` sets `run.anyway = true`. The envelope then gets "The owner asked you to do this once even though it is outside your job." In that case there is no not-my-job line.
- **Ask Atlas** is client-side. It starts a thread with the original request (`POST /api/threads`).
- **Make a new bot** is client-side. It opens the New bot page with the job prefilled.
- Leads (primary and managers) never get the not-my-job line.

- [ ] Step 1: write tests:
  - 'Atlas sees every bot by name and job and hands work out by @mention'
  - 'a manager hands work only to its own team'
  - 'after the team replies the lead speaks once more with their answers'
  - 'a plain bot asked for another job replies not-my-job and the chat shows three choices'
  - 'do it anyway runs the same request once without the not-my-job rule'
  - 'a deleted bot named by the lead is skipped' (Review Focus 4)
  Use the injectable executor that `tests/coordination*.test.js` already use.
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run the tests and the suite. Expected: PASS.
- [ ] Step 5: build:pages, then commit with `feat: leads route work to their team; bots say when it is not their job`.

### Task 4: Any bot can ask any bot, with checkpoints

**Files:**
- Modify:
  - `shared/bot-link.js`: limits
  - `src/bot-link.js`: the multi-round ask
  - `shared/contracts.js`: `bot.ask`, `bot.create`, `schedule.set` are basic kit. `canBot` returns true for them whatever the permission list says.
  - `shared/coordination.js`: `createEnvelope` always offers the ask tool. Its roster is every company bot (`{name, job}`), not only the team.
  - `shared/run-state.js`: new status `awaiting_limit`
- Create: `shared/ask-limits.js`, `tests/ask-limits.test.js`

**Interfaces (produces):**
- `ASK_LIMITS = {depth: 6, pair: 12, total: 60, repeats: 3}`
- `tallyAsk(run, {from, to, task}) -> {ok:true} | {ok:false, limit:'depth'|'pair'|'total'|'loop'}`. The tally is stored on `run.asks = {total, pairs:{'a>b':n}, depth, seen:{normalizedTask:{count, lastAnswer}}}`. A repeat counts toward a loop only when the previous answer to that same question was identical (a "no new answer" loop).
- When `run.unlimitedAsks === true`, the checkpoint limits are skipped. The runaway guard (Task 5) still applies.
- On a limit, the run status becomes `awaiting_limit`, and the run gets `run.limit = {kind, at}`. Its note text is "Bots have sent N messages for this task." plus the three buttons.
- Route: `POST /api/groups/:group/runs/:run/continue {choice:'more'|'unlimited'|'stop'}`, extending the existing continue route.
  - `more` adds one round of the same size: limits are measured from `run.limitBase`.
  - `unlimited` sets `unlimitedAsks`.
  - `stop` ends the run, and the asking bot reports what it has (one closing step with "Stop here and report what you have.").
- The asked bot answers within its own job. That answer is never added to the asked bot's own chat. It appears in the run trace with `kind: 'peer'`.

- [ ] Step 1: write tests:
  - 'a bot asks a bot on another team without any permission'
  - 'a chain stops for the owner at 6 bots deep'
  - 'two bots pause after 12 messages and keep going for another 12'
  - 'keep going, don't ask again lifts the checkpoints for this task only'
  - 'the same question three times with the same answer is a loop'
  - 'stop makes the asking bot report what it has'
  - 'a peer answer is not written into the asked bot's own chat'
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: implement. Delete the `MAX_ASK_DEPTH = 1` comment and the "cannot ask another bot again" restriction.
- [ ] Step 4: run the tests and the suite. Expected: PASS.
- [ ] Step 5: build:pages, then commit with `feat: bots ask any bot with keep-going checkpoints`.

### Task 5: Bot creation from a sentence and the runaway guard

**Files:**
- Modify:
  - `shared/bot-create.js`: drop `MAX_BOTS_PER_GROUP` for the company (keep a hard 500 safety cap). A created bot gets `reportsTo` the creator when the creator `isLead`, else the creator's manager. It gets a `color` from the first unused tint and the default shape.
  - `src/bot-create.js`
  - `src/coordination.js`: guard checks
- Create: `shared/runaway.js`, `tests/runaway.test.js`

**Interfaces (produces):**
- `GUARD = {windowMs: 300000, creations: 50, runs: 300}`
- `noteBotWork(state, kind:'run'|'creation', now) -> {paused:boolean}`. It keeps `state.settings.guard = {since, runs, creations, paused, pausedAt}`. The settings row is JSON in `retention`? No: put it in the `kv` table through the store's existing kv pass-through if one exists. Otherwise keep it in memory per workspace in `src/runaway.js` and in `state.guard` for Pages. Ledger the choice.
- `paused(state) -> boolean`. Bot-initiated work (handoff step beyond the first, ask round, scheduled `bot-task`, `create-bot`) is refused while paused. The run moves to `awaiting_limit` with `limit.kind = 'guard'`.
- `resumeGuard(state)` handles **Keep going**: it clears the paused flag and resets the window. **Stop** cancels every awaiting_limit run that has `kind:'guard'`.
- On a pause, the primary posts a system message in Atlas's chat: "Bots were very busy: N runs and M new bots in 5 minutes. Everything bots started is paused." It shows Keep going / Stop.

- [ ] Step 1: write tests:
  - 'a bot creates a bot from one sentence and it reports to its creator'
  - '51 creations in five minutes pause every bot-started run'
  - 'the owner can still chat while bots are paused'
  - 'keep going resumes and stop cancels'
  - 'create-bot spam in replies trips the guard' (Review Focus 5)
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run the tests and the suite. Expected: PASS.
- [ ] Step 5: build:pages, then commit with `feat: unlimited bot creation behind a runaway guard`.

### Task 6: Automatic context and per-bot memory

**Files:**
- Modify:
  - `shared/bot-settings.js`: remove `contextMessages` and similar knobs from validation. Old values are ignored on read.
  - `shared/coordination.js` / `src/coordination.js`: thread context is automatic, with the last messages up to `MAX_CONTEXT_CHARS`. Older parts are replaced by the stored chat summary from `memory.js` when there is one.
  - `shared/memory.js`: rulebook keys `bot:<id>` and `company`.
  - `src/routes-memory.js`, `shared/local-api.js`
- Test: `tests/bot-memory.test.js`

**Decisions:**
- Each bot's prompt memory is the rulebook `bot:<id>` plus the company notebook `company` (read-only to bots, marked as notes).
- `noteTurn` writes to the bot's own rulebook.
- Routes:
  - `GET /api/memory?bot=<id>` returns that bot's lines and the company notebook.
  - `POST /api/memory/rules {bot, text}`
  - `PATCH /api/memory/rules/:id {text}`
  - `DELETE /api/memory/rules/:id`
- The existing per-model rulebooks are migrated by copying them into `bot:<id>` for each bot using that model, once. Ledger the choice.

- [ ] Step 1: write tests:
  - 'each bot remembers only its own notes'
  - 'every bot reads the company notebook'
  - 'the owner edits and deletes a bot's memory line'
  - 'context needs no setting'
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run the tests and the suite. Expected: PASS.
- [ ] Step 5: build:pages, then commit with `feat: automatic context and per-bot memory`.

### Task 7: Pages engine for the company

**Files:** `shared/local-api.js`, `shared/group-simulator.js`, `tests/engine-parity.test.js`, `tests/pages.test.js`

**Decisions:** The offline Atlas answers with canned replies, picked by keyword:
- a greeting
- a "make/create a bot that …" sentence creates a bot from that sentence: its name is derived from the first noun phrase, or "Helper N"
- a request that names an existing bot's job hands work to that bot, and that bot answers with a canned "On it: <request>" plus Atlas's closing line
- anything else gets a short reply

Threads, `not-my-job` (a canned trigger when the request shares no word with the bot's job), checkpoints and the guard run through the same shared modules. There is no browser, connector or subscription.

- [ ] Steps: write the parity tests 'Pages creates a bot from a sentence' and 'Pages threads are run by Atlas'. Run them (FAIL), implement, run them (PASS), run build:pages, then commit with `feat: Pages demo runs the company offline`.

### Task 8: UI foundations (pure, Node-tested)

**Files:**
- Create: `shared/ui-face.js` (face SVG builder), `shared/ui-company.js` (view models), `tests/ui-face.test.js`, `tests/ui-company.test.js`
- Register both files in `shared/assets.js`.

**Interfaces (produces):**
- `face(bot, {size=40, state='awake'|'asleep'|'working'|'waiting', primary=false, motion=true}) -> string`.
  - It returns SVG markup copied from the mock's face drawing (three-quarter, 30° right, 30° up, eyes in the top fifth, blush, catch-lights, far eye narrower, star badge bottom-left for the primary at `size >= 40`).
  - The bot's `shape` is used, or the role default: circle for the primary, hexagon for a manager, rounded for the rest.
  - The `color` tint is used, muted on dark.
  - Animation classes: `face--sway`, `face--nod`, `face--blink2`, `face--hop`. They are CSS only.
- `botRows(state, {query='', order=[], pins=[], hidden=[]}) -> [{id,name,job,face,status:'asleep'|'working'|'waiting',preview,at,needs,pinned,isPrimary,isManager}]`.
  - The sidebar order is the saved order; activity never reorders it.
  - Pinned bots are listed separately.
  - While Atlas is pinned, the list starts with Atlas's reports (spec v32).
- `threadRows(state) -> {waiting:[], today:[], earlier:[]}`.
- `progressPill(run, state) -> {botId, text, site?}|null`. Its texts are:
  - "Atlas is working out who does what"
  - "Asking <Bot>: <first 60 chars>"
  - "<Bot> is on it"
  - "<Bot> needs your OK"
  - "Atlas is putting it together"
  Done → `{done:true, text:'<A> and <B> helped · N messages'}`.
- `handoffs(run) -> [{from, to, text}]` for the tap-open card.
- `chatStatus(state, botId) -> 'One continuous chat'|'Hands work to its team'|'Hands work to any bot'`.
- `parseRoute` / `routeHash` gain:
  - `{bot:id}` (bot chat)
  - `{thread:id}`
  - `{profile:id, sub?:'memory'|'activity'|'permissions'|'model'|'computer'|'team'|'edit'}`
  - `{settings:section?}`
  - `{newBot:true, job?}`
  - `{newThread:true}`
  - `{company:true}`
  - `{activity:true}`
  Old hashes map to the nearest new route.

- [ ] Steps:
  - Write tests for each function, with the spec's exact strings.
  - Run them: FAIL.
  - Implement.
  - Run them: PASS.
  - Run build:pages, then commit with `feat: face and company view models for the new UI`.

### Task 9: UI shell, bot chats and threads (browser)

**Files:**
- Create: `shared/ui-shell.js`, `shared/ui-conversation.js`, `shared/shell.css`
- Modify: `shared/index.html` (load `shell.css`), `shared/app.js` (render the new routes), `shared/assets.js`
- Old `ui-views.js` list/thread renderers are removed once nothing imports them.

**Decisions (from the mock v46, owner answers 6):**
- Desktop is 1024px and wider:
  - Left sidebar with search and + New bot at the top.
  - Then a status line, "● Atlas on watch · others asleep".
  - Then pinned large faces (72px, "Drop to pin" only while dragging).
  - Then bot chat rows, then a Threads section.
  - At the bottom, the owner row (initials) opens Settings, beside New thread.
  - The right side shows the open chat. It opens on Atlas's chat, or shows "Select a chat" with a link to start a new thread.
- Phone:
  - Avatar top left (opens Settings), the Bots | Threads indicator top centre, + top right.
  - The pinned row, then bot rows.
  - The bottom search pill sits 16px from each edge with a fade behind it, and the New thread button carries the waiting badge.
  - Swiping switches Bots/Threads; swipes are ignored on the pinned row and the bottom bar.
  - Chat screens hide the avatar, the bottom bar and +.
- Chat header:
  - A round back button with no label, then the title and a status line.
  - A bot chat adds its small face (opens the profile). A thread has no face and the status "Atlas runs this thread".
  - There is no threads button.
- Messages:
  - Owner messages are mint bubbles on the right.
  - Bot bubbles sit on the left, lightly tinted, with the face and name.
  - System pills are centred.
  - The live progress pill updates in place. The done pill opens the handoffs card.
  - The checkpoint card and the out-of-job card each get one sentence and their three buttons.
  - The asking bot's face waits above an ask card.
  - No tinted wash, no routing chatter.
- Search: ⌘K / Ctrl+K / T / `/` focuses it. Results are bot names and jobs plus thread titles.
- Motion: view fade 240 ms, button press-in, hello hop on chat open, done hop on the first reply. Everything stops under `prefers-reduced-motion`.

- [ ] Steps:
  - Port the mock's markup and CSS for these screens into the new files, wired to `ui-company.js` and `ui-store.js`.
  - Update `tests/polish_smoke.py` and `tests/usability_smoke.py` for the new selectors, keeping every scenario's intent: send in a bot chat, a thread run, a handoff pill, reduced motion, phone width.
  - Run `npm run test:ui`: PASS.
  - Run build:pages, then commit with `feat: chats home, bot chats and threads from mock v46`.

### Task 10: Bot profile, New bot page, Settings and Company

**Files:**
- Create: `shared/ui-profile.js`, `shared/ui-settings.js`, `shared/profile.css`
- Modify: `shared/index.html`, `shared/assets.js`, `shared/app.js` (route hooks only)

**Decisions:**
- **Profile (v34/v46):**
  - A round back button goes to the bot's chat, or to the thread it was opened from. A round ⋯ button opens the menu (Message, Pin, Move to…, Hide, Delete; Atlas offers neither Hide nor Delete).
  - Centred: the 84px face (tap → hop), the name, the role and team, the job in two lines, and an Edit pill (name, manager, colour, shape).
  - A card of rows: Memory (count), Activity (count), Permissions (count, current grants, read-only list until Phase 3), Model, Computer (non-Atlas, "Idle"), Team (managers).
  - A Notifications switch.
  - Delete says what goes: "Its job, memory and permissions are deleted. This can't be undone. Its reports move to Solo. Its threads stay."
- **New bot (v36/v37):**
  - An 84px live preview, a "Name your bot" field, a 5-column grid of ten 32px shapes, two rows of five 26px colour dots (the first unused one picked), and an optional Manager picker.
  - The note reads "You set its job in the chat."
  - A 48px Create button, disabled until there is a name, creates the bot and opens its chat.
  - With `job` prefilled (from Make a new bot), the first message is sent for the owner.
- **Settings:**
  - Desktop: a dialog with sections on the left (General, Appearance, Models and keys, Connectors, Permissions, Usage, Computer, plus Go to: Activity, Company).
  - Phone: grouped cards (v32).
  - Models and keys reuses the existing AI provider admin forms (`ui-admin.js`) inside the section.
  - Connectors shows "Coming in a later phase" rows for Google and MCP.
  - The Bots running switch is the guard's Pause all, using `POST /api/guard {paused}`, owner only. It is added in Task 5 if missing; otherwise add the route here and ledger it.
- **Company:** the org chart as a fall-open tree (Atlas, then managers, then teams) with Move to… in each row's menu.

- [ ] Steps:
  - Port the screens from the mock.
  - Add smoke scenarios: create a bot with a shape and colour, rename it in Edit, a manager move, delete with Solo reports, Atlas has no Delete.
  - Run `npm run test:ui`: PASS.
  - Run build:pages, then commit with `feat: bot profile, new bot page, settings and company chart`.

### Task 11: Pin and reorder gestures, docs

**Files:** `shared/ui-gestures.js` (new), `shared/assets.js`, `README.md`, `docs/BUILD-PLAN.md`, `CHANGELOG.md`, `AGENTS.md` (module list)

**Decisions:**
- Long-press, or press-and-move, drags a bot row or pinned face. Dropping it in the pinned area pins it; dragging it out unpins it.
- Order and pins are saved per person in `localStorage` through `saveLocal`, wrapped in try/catch.
- Right-click, the menu key or Shift+F10 opens the menu. Alt+arrows move, and Esc closes.
- Drag motion follows the spec's "Drag motion" list, using transform and opacity only.

- [ ] Steps:
  - Add a smoke scenario that pins via the menu, then reorders with Alt+ArrowDown.
  - Implement.
  - Update the docs, and tick Phase 2 in BUILD-PLAN.
  - Run the full gate, then commit with `feat: pin and reorder bots; docs for the company model`.

## Parallel execution map

- Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7 run in order: they share `coordination.js`.
- Task 8 depends only on Task 1's field names and can run beside Tasks 2 to 7.
- Tasks 9 and 10 depend on Task 8. They run in parallel because their files are disjoint (`app.js` route hooks are one small edit each, and they are merged by the controller).
- Task 11 runs last.
