# Goals, services and self-organising teams

Design, 26 Nov 2026, written against `main` at `90bb68f` (every branch merged). No product code changes with this document. It replaces two drafts from the same day that were never in the repo: their ideas are kept, checked against the code as it is, and generalised. Nothing here is tied to one website, one platform or one kind of work. The same design holds for a CRM, a job or tender board, a supplier's shop, a ticket desk, a bank's statement page, a code host, a newsletter tool or a social network.

Marks: **[measured]** was run on this machine; **[untested]** is a design I expect to work but have not run.

---

## 1. The idea

You give a goal in plain words: "find 20 qualified leads a week for my studio", "keep my repos' CI green", "tell me when any supplier's price for these parts drops below what I paid", "answer support mail within a day", "grow the newsletter to 2,000 readers by March". A lead bot turns it into a short **brief** you approve, picks a **pattern** for that kind of work, and lays out a **team** as a **blueprint**. To work on a website or app it has never seen, the team writes a **service profile** (how to reach it, what its rules allow per action, how fast to go) and learns **skills** (saved step lists) it reuses. Results go into **records** and **notes**, never only into a chat. Anything that acts for you outside the app (a send, a post, a form, a booking, a change in someone else's system) goes through the **outbox**, is approved as you saw it, and goes out on a **timer** in its **lane**. Under all of it sits a **core** (asks and grants, accounts, secrets, the queue, the network guard, budgets, the activity log) that no bot, blueprint or outside text can change.

```
                    You
                     │ a goal in plain words          ▲ cards: approve, choose, apply
                     ▼                                │
   ┌──────────────────────────────────────────────────────────────────┐
   │ Lead bot: intake → brief → pattern → blueprint                    │
   ├──────────────────────────────────────────────────────────────────┤
   │ Team bots, each running the same work loop on the same primitives │
   ├──────────────────────────────────────────────────────────────────┤
   │ Services: one profile + skills per website or app                 │
   ├──────────────────────────────────────────────────────────────────┤
   │ Core: asks & grants · accounts & secrets · task queue · device    │
   │ runtime · network guard · budgets · store · activity log · chats  │
   └──────────────────────────────────────────────────────────────────┘
```

A new use is new data (a blueprint, a profile, a skill, a template). A new kind of outside system is a new MCP connector, as today. The core changes only when a genuinely new primitive is needed.

---

## 2. What exists today, and what this design must fix

### 2.1 What it builds on

| Piece | Where | Used for |
|---|---|---|
| Durable task queue: leases, retries, kinds `bot-task`, `group-run`, `agent-job`, `notification` | `shared/tasks.js`, `src/queue.js` | Timers and outbox sends become stored tasks |
| Claim before call, `unknown` after a crash | `src/connector-runs.js`: a call is marked `running` in its own store update; one still `running` at start is `unknown`, never repeated, and the bot is told | Every outbox send |
| Exact-argument approval | `argsHash` (`shared/connectors.js`), checked when the call is made (`src/connector-runs.js:37`); connectors only | Outbox approvals, extended to browser actions |
| The browser approval queue | `state.browserRequests`: `pending → dispatched → done`, approved per class and origin (`approvedFor` in `shared/bot-browser.js`) | Browser items in the outbox extend it |
| A timed, undoable send | `src/held-sends.js`: an Always-allowed `gmail.send` waits 30 s with Undo; a restart sends nothing | Absorbed by the outbox as one lane setting |
| Asks and grants per bot, action and site, with `until`, 24 h expiry for unattended asks | `shared/asks.js` (`ASK_EXPIRY_MS`, `expireAsks`), `src/ask-runs.js` | Unchanged; sign-in waits reuse them |
| Run states, one list | `shared/run-state.js`: `awaiting_browser`, `awaiting_ask` and others are busy, stoppable and survive a restart | Sign-in waits park as `awaiting_ask` |
| Outside-text taint | `tainted`, `outsideRead` (`shared/asks.js`), `run.outsideInput` and `outsideMemory` (`src/coordination.js`), `keepOutsideMarks` (`shared/retention.js`) | Holding self-made changes written after reading outside text |
| Limits per run, `BACKSTOP`, `FAIL_STREAK`, pages per site per day | `shared/limits.js` (`state.limits`, `perSite`, `state.siteVisits`) | Goal ceilings extend this |
| Token and cost metering per run and per bot per day | `shared/usage.js`, `src/usage.js` | Goal budgets read it |
| Quiet hours and the owner's clock | `shared/quiet-hours.js`; `tz`, `keepWallTime` in `shared/schedules.js` | Lanes and `at` timers |
| Setup cards, 22 actions, applied by the owner's tap calling the ordinary routes | `shared/setup.js` (`SETUP_ACTIONS`), `src/setup-cards.js:3`, the card in `shared/ui-conversation.js` | The Apply cards for goals and blueprints |
| The `signin` card and the unattended notice | `shared/setup.js` (`signin`), `signinSites`/`signinNotice` (`src/health-watch.js`), the twice-refused card (`shared/bot-browser.js:596`) | Sign-in from the phone |
| The workspace brief and run budget in every turn, after the cached head | `workspaceBrief` (`shared/setup.js`), `runBudget` (`shared/limits.js`), `STABLE_KEYS` (`src/ai.js:127`) | The capability card |
| A bot's manager | `reportsTo` (`shared/bot-settings.js:133`); a new bot reports to its creator if the creator leads a team, else to the creator's manager (`shared/bot-create.js:13`) | Blueprint roles set it |
| Daily briefing from real state | `shared/briefing.js` | The goal stand-up |
| Watches compared by code, under their own key | `shared/watches.js`, `src/watches.js` | Monitor patterns |
| Signed event triggers | `src/triggers.js`, `src/routes-events.js` | `on` playbooks |
| Per-bot rulebooks; a company notebook no bot writes | `shared/memory.js` | The team notebook sits beside them |
| A table kept outside the state document | `attachments` (v13, `src/sqlite-store.js:441`, direct SQL), carried by `src/backup.js` as `tables.attachments` with a size cap | The shape for records |
| Offline group simulator | `shared/group-simulator.js` | Blueprint dry runs (coordination only) |
| Activity log, kinds `outside`, `perm`, `bots` | `shared/activity-log.js` | The audit trail, plus one kind |
| Browser test harness | `tests/fake-cdp.js`, `tests/agent-browser.test.js` | Phase 0 to 2 tests |

### 2.2 What has to change, found by reading the code

1. **Typed text reaches the model.** The control list (`SNAPSHOT`, `agent/browser.mjs:83`) labels an element with `innerText || value || aria-label || placeholder || name`, and `riskGuard`'s label reader (`words`, `:113`, inside `riskGuard` at `:96`) reads `value` too. So the contents of a filled text field (a password, a card number, a code, a draft) and the text typed into a contenteditable (through `innerText`) go into the page a bot is handed, the stored result, chat lines, and the refusal reason `riskGuard` writes. After a takeover, `handBackTakeover` hands `page.elements` (`src/bot-browser.js:245`) to the bot, so a password the owner typed during the takeover goes to the model on hand back. Both takeover UIs type through a plain `<input>` (`shared/ui-computer-view.js:109`, `shared/ui-takeover.js:46`): a password shows on screen and a phone's password manager won't fill it.
2. **One cookie jar for every bot.** One Chrome, one profile, every tab in the default context (`newTab`, `agent/browser.mjs:606`); tabs keyed by bot only (`agent/shared-browser.mjs:52`). Signing in to a second account of any service signs the first one out for everyone.
3. **One driver and one task at a time, in two places.** On the device, `acquire()` (`agent/shared-browser.mjs:101`) lets one bot drive while all others wait, even on another site, and a takeover parks every bot; the device runs its inbox one task at a time (`agent/agent.mjs:311`) and its keepalive gates on one `busy` flag (`:281`), so a long CLI model turn holds back every browser step. In the server's own browser (`src/browser-runtime.js`) requests run one after another, and every bot gets a 409 while anyone holds a takeover (`:110`).
4. **No device choice, and a runtime that skips the device.** Three copies of `pickAgent` (`src/bot-browser.js:38`, `src/cli-model.js:32`, `src/mcp-client.js:167`) pick "a" device with different rules (below, 5.5). Nothing pins a bot or an account to one. With `BROWSER_RUNTIME=auto` and a configured server browser, every browser request, reads and actions alike, runs in the server runtime (`here`, `src/bot-browser.js:53`), which has throwaway contexts only.
5. **A timer has nowhere to live.** A `once` schedule is a `bot-task`, which runs a model turn. Firing a send must not cost or depend on a model.
6. **Browser approval is by class and origin, not by payload.** Connector writes are bound to `argsHash`; a browser click is cleared as `class@origin`. An approval should cover exactly the text you saw.
7. **The activity log has no record of individual approvals of outward items or of goal changes.** `perm` logs every grant (Always allow, Ask each time, Deny), rule removals, Hands-off, the basics switch and limit changes (`shared/asks.js:157,173,192,202`; `shared/limits.js:74`); `outside` logs dispatched pages and connector writes. A one-off Allow of a single item, and anything about goals, is not logged.
8. **No per-day budgets** apart from `perSite`. Usage is metered, but nothing stops on it.
9. **One connection per app, for every bot.** Connectors have no per-bot filter and no second account of one app.
10. **Setup cards are applied by the UI** calling routes one by one (`src/setup-cards.js:3`). Nothing on the server validates and applies a many-part change at once.
11. **Hands-off is on for a new install** (an absent kv `hands_off` reads as on). That suits a chat; a goal that sends on a timer for days needs its own, stricter default.
12. **Sign-in pages are recognised narrowly.** `signinSite` matches a few identity hosts (`SIGNIN_HOSTS`, `shared/bot-browser.js:270`: Google, Microsoft, Yahoo, Apple) and a list of login paths. A service with its own sign-in form at another path is missed.
13. **Tracked tasks are not a base for goals.** `planTracked` (`shared/coordination.js:91`) names no workers, and `createRun` sets `run.task` only when it does (`:232`), so `run.task` is null in practice.

---

## 3. The layers

```
┌──────────── Adaptable layer: data the team may change ─────────────┐
│ Goals · blueprints (roles, playbooks, lanes, collections, metrics,  │
│ experiments) · service profiles · skills · team notes · templates   │
├──────────── Primitives: a small, versioned instruction set ────────┤
│ read · browse · look · call · think · timer · schedule · watch · on │
│ outbox · record · note · ask-owner · ask-bot · create-bot · notify  │
├──────────── Core: code, changed only by a release ─────────────────┤
│ Asks & grants · task queue & clock · device runtime · accounts &    │
│ secrets · network guard · budgets & guards · store · activity log · │
│ chats, cards & push                                                 │
└────────────────────────────────────────────────────────────────────┘
```

### 3.1 The core and its one rule each

| Core service | Rule nothing above it can change |
|---|---|
| Asks & grants | Only the owner widens what a bot may do. A model proposes; it never grants. |
| Approvals | An outward action runs only with a matching approval or grant, and an approval covers only the exact payload shown. |
| Task queue & clock | Anything delayed or repeated is a stored task. Nothing waits inside a model turn or only in a process timer. |
| Device runtime | A task runs on the device and in the account the server stamped on it, never one a model named. |
| Accounts & secrets | Passwords, codes, cookie jars and tokens never reach a model, a chat line, memory, a log or a backup. |
| Network guard | Bots reach only allowed sites and never a private network (`agent/net-guard.mjs`, `src/reach-guard.js`). |
| Budgets & guards | Ceilings per goal and per day that bots cannot raise; the runaway guard and kill switch over everything. |
| Store | Schema changes only by migration in a release. |
| Activity log | Every outward action, approval, account change and blueprint change is logged with who, what and why. |
| Chats, cards & push | Only the owner's own words or taps count as the owner. |

### 3.2 Primitives

| Primitive | What it does | Today | Change |
|---|---|---|---|
| read | A page, feed, file, JSON, PDF or image | `capture`, `readPlain` | Plain first, content types, redirects (7) |
| browse | Steps in a tab of the bot's own account | One shared jar | Accounts, tabs, parallel (5) |
| look | A screenshot or image in the next turn | Owner attachments only | New for pages (7) |
| call | A connector tool | Exists | Per-bot connections (5.4) |
| think | A model turn | Exists | Roles name a model tier |
| timer | One thing after a delay, a window or at a time | None | New task kind (8.1) |
| schedule | Repeat a playbook | Bot proposes, owner applies | Unchanged unless you decide otherwise (15.4) |
| watch | Tell when a page or query changes | Pages, made by the owner | Feeds and connector queries; may start a playbook (10.4) |
| on | Start a playbook on an event | Signed webhooks | Unchanged |
| outbox | Queue an outward action for approval, timing and pacing | `browserRequests`, held sends | One general queue (8.2) |
| record | Add, update, query rows; simple stats in code | None | New table (9.1) |
| note | Append to and read the team notebook | No shared notes bots write | New, marked by taint (9.1) |
| ask-owner, ask-bot, create-bot | Cards, questions, teammates | Exist | Unchanged |
| notify | A short push to the owner | App only | A bot primitive with a daily cap |

A blueprint step is either a **deterministic primitive** (call, read, record, outbox, timer), which costs no model run, or a **role turn**, where a bot thinks and writes blocks. Routine work (refresh numbers, copy rows, check a page) stays exact and cheap.

---

## 4. How bots turn words into work

### 4.1 Intake (leads)

1. **Restate** the outcome, a measurable target, a deadline, the scope (which services and accounts) and your constraints, in your words where you gave them.
2. **Fill gaps with defaults and list them** ("assumed: approve every send", "assumed: your time zone"). Ask only what would change the plan: at most three questions, one card, each with options and the lead's pick.
3. **Pick a pattern** (12), or two.
4. **Check each service**: find or draft its profile, choose an access rung per action (11.2), list what its rules forbid.
5. **Draft the blueprint and ceilings.**
6. **One Apply card**: brief, team, accounts, what goes out and how it is approved, the daily budget.

The brief is what every role re-reads at the start of its work, so a team that runs for weeks keeps aiming at the same thing.

### 4.2 The work loop (every role)

```
Orient → Plan → Check → Act → Verify → Record → Report
```

Orient on the brief, the role, recent notes and the records it depends on. Plan the smallest next step. Check that it holds the primitive, the service allows the action, budget is left, and whether it needs the outbox. Act one primitive at a time, through a skill if one exists. Verify by evidence (a link, a row, a changed page), never by assumption. Record the result in its place. Report one or two lines to whoever the role reports to, and to you only what needs you. When unsure: a cheap, reversible step is taken and noted; a step that reaches people or costs money waits; a question to you carries options and the bot's own pick.

### 4.3 The capability card

Each turn a bot is told only what it holds: its account per service, its primitives, its skills, its lanes and budget left, its teammates. It is generated from records, so it cannot drift from the truth. What changes only when the owner changes it (the account names and primitives a role holds) may go in `tools`, one of the `STABLE_KEYS` kept byte-stable for prompt caching. Everything that changes on its own (an account signed out, budget left, today's numbers, pending outbox) goes after the head, the way `workspace` and `budget` do (`src/coordination.js:338`). A line per thing held, because it is paid on every turn.

---

## 5. Accounts, devices and tabs

### 5.1 Browser accounts: one Chrome, one context per account

A **browser account** is a named, isolated cookie space in the one Chrome: `work-crm`, `studio-mail`, `supplier-a`. Bots on the same account share its sign-in; bots on different accounts cannot see each other's cookies.

**[measured]** on this laptop, 26 Nov 2026. Method: a local HTTP page set an HttpOnly cookie, a session cookie, a `localStorage` key and an IndexedDB row inside a context made with `Target.createBrowserContext` in headless Chrome; that Chrome was closed and a new one started on a fresh `--user-data-dir`; memory is the PSS sum from `/proc/<pid>/smaps_rollup` over the processes whose command line names that `user-data-dir`. Result: cookies read with `Storage.getCookies({browserContextId})` and written into a new context of the new Chrome with `Storage.setCookies` came back whole, HttpOnly included; `localStorage` and IndexedDB did not; a second context in the same Chrome saw none of the first one's cookies. One headless Chrome with one small tab was about 397 MB; an extra context added about 45 MB.

So:
- **Default, `storage: "cookies"`:** a context per account, its cookies saved to `browser-accounts/<id>.jar` (folder 0700, file 0600, AES-256-GCM under a key derived with HKDF from the agent's pairing secret). Saved after every task that touched the account and every 10 minutes; restored when the context is created. The key protects a copied file, not a compromised server: the server can decrypt the pairing secret (`secret_enc`, `src/agent.js:150`), so it could derive the key too. Jars never leave the device. On re-pair the device re-encrypts its jars under the new secret before dropping the old one; if that fails, the accounts show signed out and the owner signs in again.
- **Fallback, `storage: "profile"`:** for a service whose sign-in lives in local storage, the account gets its own Chrome on its own `--user-data-dir`, started and stopped by the shared browser, its tabs in the same tab map and its screencast through its own CDP connection. The device finds out by itself: if the keeper tab (5.3) shows a sign-in page right after a restore, the account is marked as needing a profile and a card offers the switch, naming the memory cost (about 400 MB, more on a real site).
- The `default` account is today's persistent profile, so a bot with no account behaves as now.

**Records.** `browserAccounts: [{id, name, site, deviceId, storage}]` live in kv `browser_accounts` in the workspace store, travel in backups as names only (never jars), and are managed by owner-only routes `GET/POST/PATCH/DELETE /api/browser-accounts`. A bot's `browserAccount` is a bot setting validated in `shared/bot-settings.js` (must name an existing account), set only by the owner or by an applied blueprint, never from a model's block, the way `shared/bot-create.js` refuses permission fields. The pure rules (validation, which account a bot uses) go in a new browser-safe module listed in `shared/assets.js`; jar crypto stays in `agent/`, since `shared/` may not import `node:` builtins. The Pages demo answers these routes as it answers connectors: it says they need the server.

**State from the device.** The heartbeat gains `accounts: [{id, state: "signed-in" | "signed-out" | "unknown", storage}]`, read from the keepers; the server keeps the last report per account.

### 5.2 Stamping the account at every hop

1. **The block.** A model's `browser` block has no account field. `validateBrowserRequest` (`shared/bot-browser.js:169-201`) keeps only known fields, so an `account` in a block is dropped; a test pins that it never reaches the payload.
2. **Dispatch.** `dispatchBrowserRequest` (`src/bot-browser.js:49`) adds `account` and the account's `deviceId` from the bot record to the agent task payload (`:87`).
3. **The device.** `runBrowserTask` (`agent/shared-browser.mjs:263`, called from `agent/agent.mjs:174` and `:186`) passes the account to the shared browser, which keys tabs by `(account, botId, tab)` and checks before every step that the tab's context is the payload's account.
4. **Live and takeover.** The live channel and takeover (`agent/live-channel.mjs`, `src/browser-live.js`) open and show the tab in that bot's account, and the screen names it.

A request whose bot has an account never runs in the server runtime: under `BROWSER_RUNTIME=auto` it goes to the account's device even when the server has a browser, and under `server` it is refused with one line saying why.

### 5.3 Tabs, keepers and session checks

- A block may say `"tab": "new"` or `"tab": "<name>"`; the result names the tab. The default is the bot's main tab, so today's blocks keep working. At most 6 tabs per bot and 12 per account.
- A tab untouched for 10 minutes is closed after its cookies are saved.
- One **keeper tab** per signed-in account stays on the service's home page. It does not keep a sign-in alive by itself (the cookie's own expiry and the site do that); it gives a warm page and an early warning. Every 30 minutes the device looks at each keeper; a sign-in page marks the account signed out and the sign-in card goes out (6) before a routine hits it.
- **Sign-in detection** widens: `signinSite` keeps its hosts and paths, and a page with a visible password field also counts.
- `AGENT_BROWSER_QUIT_IDLE=1` quits Chrome after 30 quiet minutes; sign-ins come back from the jars.

### 5.4 Connector accounts

A connector may have several **connections** (two mailboxes, two workspaces of a chat app, a personal and a work calendar), each a vault credential, and a bot is pinned to the connections it may use. The connection comes from the bot record, never from the block, and is passed to `useConnector(store, connector, tool, args)` (`src/connector-use.js:15`) as the connector it runs. An app with one connection and no pins behaves as today.

### 5.5 Devices and parallel work

**One chooser.** `chooseDevice(store, {kind, deviceId = null, nowMs}) → {agent} | {reason}`, in `src/agent.js`, replaces the three copies. It reads the same rows; `reason` is one of `no-agent` (none paired), `no-permission` (none holds `kind`), `agent-offline` (those that do are not seen lately), `not-pinned` (the pinned device is revoked or lacks `kind`). Online means `last_seen_at` within `AGENT_ONLINE_MS`, or `paired_at` within it for a device never seen yet (the browser copy's rule today, kept so a just-paired device is usable). A `deviceId` (from an account or a bot pin) restricts the choice to that device. Each caller maps the reason to the answer it gives today, so behaviour outside pins does not change:

| Caller | `no-agent` / `no-permission` | `agent-offline` | `not-pinned` |
|---|---|---|---|
| Browser (`src/bot-browser.js`) | request stays pending (null) | 409, the offline sentence | 409, "this bot's computer is not available" |
| CLI model (`src/cli-model.js`) | 422 with that code (read by `cliSignIn`) | 422 `agent-offline` | 422 `not-pinned` |
| MCP over the device (`src/mcp-client.js`) | 422 with that code | 422 `agent-offline` | 422 `not-pinned` |

Two other places enqueue device work and keep their rules: an `agent-job` fans out to every capable device (`src/handlers.js:87`), and `POST /api/agents/:id/tasks` names its device (`src/routes-account.js:93`).

**Pins.** A bot setting `device` (validated in `shared/bot-settings.js`, owner-only, set on the bot's profile through the existing bot settings route), and an account's `deviceId`. An account's device wins over a bot's.

**Parallel on the device.**
- One queue per bot instead of one global driver in Phase 1 (every bot has one tab today); Phase 2 turns it into one queue per `(account, tab)`. A takeover parks only the tab being driven.
- A worker pool: `AGENT_CONCURRENCY` (default 3) tasks at once, at most one `model.run` per CLI engine. The keepalive's `busy` flag becomes a count of running tasks, and every running lease is renewed.
- One CDP WebSocket carries many sessions: replies are matched by id (`waiting` in `agent/browser.mjs`) and every page command names its `sessionId`. Phase 1 adds a test that two captures in different tabs interleave on one connection and each gets its own page.

**Parallel in the server runtime.** Its single tail becomes one queue per bot, and a takeover refuses only the bot whose page is held.

**Tests Phase 1 must add:** two bots' browser tasks overlap in time on the fake CDP; a takeover of bot A's tab does not delay bot B; two `model.run` tasks on the same engine never overlap, and one on each engine do; a pinned bot's task goes only to its device, and a revoked pin gives `not-pinned`; each caller's answers in the table above stay as today for an unpinned bot.

---

## 6. Sign-in from the phone

### 6.1 Nothing typed reaches a model (Phase 0)

- **Text-entry controls are never labelled by their contents.** In `SNAPSHOT` and in `riskGuard`'s `words`, `value` is read only for button-like inputs (`type` `button`, `submit`, `reset`, `image`), where it is the only label ("Pay now", "Send"); for every other `input`, `textarea` and `select`, the label comes from `aria-label`, an associated `<label>`, `placeholder` or `name`. A contenteditable element is labelled the same way, never by its `innerText`. `riskGuard` keeps classifying Pay and Send buttons exactly as now.
- **Page text skips what was typed.** `MAIN_TEXT` (`agent/browser.mjs:80`) is the `innerText` of the main element or the body, so it carries whatever was typed into a contenteditable, and both capture paths put it in the result (`:403`, `:510`). It becomes a walk over the same root that leaves out every contenteditable subtree and form control, writing `[text field]` in their place. The `read` step (`:130`) returns `textContent` of its target; it refuses a target that is, or holds, a text-entry control or contenteditable.
- **The hand back is covered by the same fixes**, since `handBackTakeover` passes on the `text`, `excerpt` and `elements` these produce (`src/bot-browser.js:244`).
- **Tests** (on `tests/fake-cdp.js` and `tests/agent-browser.test.js`): a page with a filled password field, text field, textarea and contenteditable, each holding a marker string; the marker appears in none of the snapshot labels, the click label, a `riskGuard` refusal reason, the page `text` and `excerpt` of either capture path, a `read` result, or the text and elements of a hand back; after a run through the server, it appears in none of the state document, `browserRequests` results, chat lines, activity entries or `agent_tasks` results. A `<input type=submit value="Pay now">` is still classified as a payment.

### 6.2 Masked fields in both takeover paths

The two takeover UIs reach the page by different routes, and both get a **Password** field (`type="password"`, `autocomplete="current-password"`) and a **Code** field (`inputmode="numeric"`, `autocomplete="one-time-code"`) beside the plain one:

- **Device path.** The Computer view (`shared/ui-computer-view.js`) posts input to `POST /api/browser-live/:botId/input`; the server holds it in memory (`sp.commands`, `src/browser-live.js:124`) until the device drains it on its next poll. A masked field sends `{type: "type", text, secret: true}`. `secret` means: never merged with a neighbouring type event (`shared/ui-computer.js:67` merges consecutive ones today), never echoed in the tray or a toast, and absent from every error and log line on the way (including the error line in `agent/live-channel.mjs:44`). The text is already kept only in memory and dropped when drained; `secret` adds that guarantee and the tests for it.
- **Server-runtime path.** The takeover sheet (`shared/ui-takeover.js:159`) posts `{op: "type", index, text}` to `POST /api/browser-sessions/:session/act` (`src/routes-groups.js:321`), run by `liveAct` (`src/browser-runtime.js:204`). It gets the same masked fields and the same `secret` rule. Its contexts are throwaway, so a sign-in there does not last: accounts are signed in on the device path only.
- **Only over a safe transport.** `secret` input is refused unless the request is HTTPS or from loopback. A small helper in `src/http.js` decides it from what is already there: the request's own scheme, or `x-forwarded-proto` only when `trustProxy()` holds (`src/http.js:41`), and the peer address from `clientIpOf` (`:44`). `PUBLIC_BASE_URL` (`publicBaseUrl`, `src/connectors.js:157`) is not enough alone, since it says where the app should be reached, not how this request came.

### 6.3 The card and the wait (Phase 3)

1. **The server posts the card.** When a result is a sign-in page (5.3) or a keeper finds its account signed out, the server posts a `signin` card naming the account, the service and the bot, and pushes it. One card per account until it is answered, across runs (kv `signin_pending: {accountId → askId}`, replacing the per-run `signinOffered` and `signinNoticed` for accounts). The push is not urgent: it respects quiet hours, like `signinNotice` today.
2. **The run waits as an ask.** The run parks as `awaiting_ask` on a sign-in ask, so `BUSY_STATUSES`, follow-ups and the chat's busy state already treat it right, and the existing 24-hour expiry ends it if nobody signs in. Its browser request is held in a new `signin` status that `expireBrowserTasks` skips (it would otherwise fail after `BROWSER_WAIT_MS`, 10 minutes). Late-work checks in the health watch ignore it, as they ignore other asks.
3. **Hand back answers it.** Take control opens the account's tab (the `signin` card's button already takes over and navigates, `shared/ui-conversation.js:558`); Hand back marks the ask answered and re-dispatches the request from the page as left. On the device, `gate()` (`agent/shared-browser.mjs:125`) today parks the task and then drops its remaining steps; the re-dispatch is what continues the work.

---

## 7. Reading

1. **Plain first.** A read with no steps tries a plain fetch first and Chrome only when the text is under 300 characters, the site turned it away, the bot asked `"render": true`, or the page needs the bot's account. A service profile records `render: true` once a plain read of it came back empty twice, so script-drawn services go straight to Chrome after that. Today, with `AGENT_BROWSER=1`, Chrome goes first (`agent/agent.mjs:166-183`).
2. **Content types.** JSON, plain text, CSV and Markdown come back as text; a PDF is turned to text with `pdftotext` where installed (else a clear line naming it and its pages; 20 MB cap); an image is handed to the model as an image.
3. **Redirects** are followed up to 5 hops, each checked against the allowlist and the private-address guard, instead of costing a model turn.
4. **Seeing.** `"look": true` returns a screenshot (JPEG, at most 1280 wide) for the next turn; `"images": true` lists the page's main images (at most 12); a URL that is an image arrives as one. At most 4 images a turn, 5 MB each, through the image paths owner files use (`userContent` in `src/ai.js`, `cleanImages` in `agent/cli-model.mjs`). Opt-in, sent once per page, and off for signed-in pages unless the goal's ceilings allow it, because a screenshot of a signed-in page sends private data to the model provider.
5. **Images on handoffs.** When a bot asks or hands off about an image, that turn's images (up to 4) go along.

---

## 8. Timers, the outbox and lanes

### 8.1 Timers

```timer
{"after": {"min": "2m", "max": "4m"}, "then": {"outbox": "ob_7f3a"}, "label": "Send 2 of 5"}
```

- **When:** `"after": "90s"`, a window `{"min", "max"}`, or `"at"` on the owner's clock (`tz`, `keepWallTime` from `shared/schedules.js`). A window is drawn once, when the timer is made, to the second, and stored, so a restart does not move it.
- **Then:** release an outbox item, start a playbook, wake a role with a message, or run a device task the bot may already run. A timer never does what its bot could not do directly and never skips an approval.
- **Stored:** a new task kind `timer` in `PAYLOAD_KINDS` (`shared/tasks.js`), fired by the queue without a model. Not a `once` `bot-task`, which runs a model turn.
- **Limits:** 10 seconds to 30 days, at most 50 pending per bot and 500 per goal; each firing counts against the goal's budget.
- **Visible:** the chat line shows a countdown with Do it now, Cancel and Edit; a bot may cancel its own; the goal page lists them all.

### 8.2 The outbox

Any action that acts for you outside the app can go through it: a message, an email, a post, a comment, a form submission, a booking, a record changed in someone else's system. It grows out of two things that exist, instead of sitting beside them:

- **Browser items extend `state.browserRequests`.** A browser outbox item is a browser request with a `payloadHash` (account, origin, and every step with its text) in place of `class@origin` clearance, plus the lane fields below.
- **Connector items reuse `connectorCalls` and `argsHash`.** The held email send becomes a lane setting: a lane with `startAfter: "now"`, a fixed 30 s window and Cancel as Undo does what `src/held-sends.js` does for `gmail.send`, for any connector write. The in-memory rule stays for that case: an undo window that a restart cut is settled as not sent.

`outbox item: {id, goalId, lane, account, action: {connector call | browser steps}, payload, payloadHash, status: draft → approved → scheduled → sending → sent | failed | unknown | cancelled, approval: {mode, by, at}, timerId, result: {url, externalId}}`

- **Approval covers the exact payload.** Editing sends it back to draft.
- **Approval modes per lane:** one card per item; one card per batch ("5 drafts for studio-mail": approve, edit or drop each); or an Always allow grant, which only the owner gives, as a power change. Payments and deletes still ask every time.
- **Hands-off does not reach a goal's lanes.** A goal sends without asking only if its ceilings say so (default off), whatever the workspace's Hands-off switch says. Chats outside goals keep today's rules.
- **Sending is claimed.** The release marks the item `sending` in its own store update before the call, as `src/connector-runs.js` does; an item still `sending` at start-up becomes `unknown`, is never resent, and the owner is told. Paced items late after downtime go one per gap, in order, never in a burst.
- **Results are recorded:** a sent item writes its link and id into a collection, and the blueprint may attach follow-up timers (check replies after an hour, a day, a week).
- **Logged:** every send under `outside`, and every approval, batch answer and ceiling change under a new activity kind `goal`.

### 8.3 Lanes and the pacer

A lane is one per account and channel: a gap window, a daily cap, quiet hours (`shared/quiet-hours.js`), an optional best-time preference (prefer the best hours found so far, keep a share elsewhere so early luck doesn't freeze the data), and `startAfter`: `approval` (default) or `now` (counts at once; goes when the timer has ended and it is approved). The pacer draws `fireAt = max(now + random(window), lastFireAt + random(window))`, each gap on its own. Controls on the line: Send now (skips the timer, not the approval), Cancel, Edit, Pause lane. Lanes space your actions and keep you inside a service's published limits. They are not for hiding automation: nothing here imitates a person, changes fingerprints or solves a CAPTCHA.

---

## 9. Records, notes, goals and budgets

### 9.1 Where things live

```
Workspace
├─ Your rulebook and the company notebook   your words; bots read, never write
├─ Services/<service>/                       profile · rules summary · skills · accounts (names only)
├─ Goals/<goal>/
│   ├─ brief          you approved it
│   ├─ blueprint      every version kept
│   ├─ records/       typed collections
│   ├─ notes          the team notebook, dated lines, outside lines marked
│   ├─ outbox         draft → approved → scheduled → sent
│   ├─ timers
│   └─ files          attachments as today
└─ Templates/         goal templates (beside today's message templates)
```

- **Records** follow the attachments model, not `TABLE_SHAPES`: `TABLE_SHAPES` mirrors the in-memory state document and is diffed on every write, so rows there would sit in memory and in the snapshot. A new per-workspace table `records(goal_id, collection, id, data, created_at, updated_at)` is created by migration and read and written by direct SQL through `src/records.js` and its routes. `src/backup.js` carries it as `tables.records` with a size cap and a `recordsLeftOut` list, as it does for attachments; restore checks each row through the live function; the retention sweep prunes it. Collections and field types come from the blueprint. `record` adds, updates, queries (filter, sort, limit) and computes count, sum, median, and by hour or weekday in code, so a report doesn't depend on a model's arithmetic. **Rows carry where they came from.** A row written by a run marked by the outside taint, or copied from a page, a connector result or a form, is stored with `outside: true` on each text field it wrote. A run that is handed a marked field is itself marked (`outsideRecord`, beside `outsideRead` and `outsideMemory`), so a stranger's words cannot reach a lead's plan through a collection. Only numbers count as inside data: a `number` field written by a deterministic step, and aggregates the `record` primitive computes in code (count, sum, median, by group), which a run may be handed without the mark even when the rows they count came from outside, since a count cannot carry an instruction.
- **Team notes:** one notebook per goal every team role may append to and read. A line written in a run that read outside text carries the existing outside mark, and a marked line cannot approve, grant or auto-apply anything. The company notebook stays read-only to bots.
- **Rule of the place:** nothing important lives only in a chat. A role added tomorrow can do its job from these places alone.

### 9.2 Goals

A goal is new state, not a reuse of `run.task` (2.2, item 13): `{id, title, leadBotId, metrics, deadline, status, ceilings, blueprintVersion}`. You make one in chat or the lead proposes one; either way your Apply sets its ceilings. Its **stand-up** is the daily briefing (`shared/briefing.js`) narrowed to the goal: each role writes one line to the notes, and the lead posts one status from real records (progress against metrics, blueprint changes, what's next). You can move it or turn it off.

### 9.3 Ceilings and budgets

Set once per goal, read-only to bots: max bots; model runs and tokens per day; outward actions per lane per day; the minimum gap per lane; which accounts, connections, sites and model tiers; quiet hours; whether anything may send without asking (default no); and whether signed-in pages may be seen as images. They sit beside `state.limits` and use the same `BACKSTOP` idea: only the owner raises a ceiling, and never past a backstop.

The server counts each goal's model runs and tokens (from `src/usage.js`), outward actions and timers per day. When one runs out it pauses **that goal's** playbooks, not the app, with a card to raise it or wait until tomorrow. The runaway guard and the kill switch still hold over everything.

---

## 10. Blueprints and self-redesign

### 10.1 Shape

One versioned JSON document per goal (trimmed):

```json
{
  "goal": {"title": "20 qualified leads a week", "metrics": [{"name": "qualified", "target": 20, "per": "week", "source": "records:leads.status=qualified"}]},
  "roles": [
    {"key": "lead", "job": "…", "model": "strong", "reportsTo": "owner"},
    {"key": "scout", "job": "…", "model": "cheap", "browserAccount": null, "reportsTo": "lead"},
    {"key": "writer", "job": "…", "model": "standard", "connections": ["studio-mail:draft"], "lanes": ["studio-mail"], "reportsTo": "lead"}
  ],
  "playbooks": [
    {"key": "find", "on": {"daily": "09:00"}, "steps": [{"role": "scout", "say": "Find ten studios that match the brief and add them to leads."}]},
    {"key": "count", "on": {"daily": "18:00"}, "steps": [{"record": "leads", "stat": "count", "by": "status"}]}
  ],
  "lanes": [{"key": "studio-mail", "gap": {"min": "5m", "max": "15m"}, "dailyCap": 10, "quiet": "19:00-08:30", "startAfter": "approval"}],
  "collections": [{"name": "leads", "fields": {"name": "text", "site": "url", "contact": "text", "status": "text", "why": "text"}}],
  "experiments": [{"key": "subject-line", "arms": ["question", "plain"], "metric": "reply_rate", "minSample": 20}]
}
```

Roles become bots, and each role's `reportsTo` sets the bot's existing `reportsTo` setting. Playbooks are a trigger (`on`: schedule, timer, watch, event, record change) plus steps.

### 10.2 How a change is judged

The lead (or a role the blueprint allows) sends a `blueprint` block. The server:

1. **Validates** the schema, every reference (roles, collections, lanes, accounts, connections, skills) and every number against the ceilings.
2. **Dry-runs** what it can: the group simulator runs the handoffs with canned replies; playbook steps are checked by a resolver that confirms each trigger, primitive and reference exists, without running them. The simulator covers coordination only, so this is not a full rehearsal, and the card says so.
3. **Diffs** against the live version and sorts each change:

| Kind | Examples | What happens |
|---|---|---|
| Free | A role's job text; a playbook using primitives the team already holds; a wider lane gap; a new collection or field; an experiment; retiring a role; a permissionless role within the bot cap | Applies by itself, logged with its reason, in the next stand-up, one-tap undo |
| Power | A new schedule, timer pattern or watch (see 15.4); a new account, connection, site or permission; any Always allow; a higher ceiling; a gap below your floor; deleting a collection's data; touching another goal | A card with Apply, Edit or Decline, showing only the diff |
| Never | Core code, the permission registry, approval rules, guards, secrets | Refused, with one line why |

4. **Outside text holds it.** A free change written by a run marked by the existing taint (`tainted`, `outsideRead`, `outsideInput`, `outsideMemory`) becomes a card instead. A stranger's mail, page or form entry cannot rewrite a role's job. A lead that plans from numbers and code-computed aggregates (inside data, 9.1) can still change its team without asking; a lead handed the text of an outside-marked row cannot.
5. **Applied on the server.** A new owner-only `POST /api/goals/:id/apply` validates the whole diff again, applies it in one store update and logs it under `goal`. Setup cards today are applied by the UI calling routes one by one; a blueprint is too many parts for that.
6. **Rollback and pace.** Every version is kept and any can be restored in one tap. If a new version's playbooks fail 3 times in a row (`FAIL_STREAK`), the server goes back to the last good one and says so. At most 5 free changes per goal per day, and an experiment cannot be ended before its minimum sample.

### 10.3 Templates

A goal template is a blueprint with blanks (accounts, topic, times) and the list of powers it needs; installing one shows the same Apply card. It lives beside today's message templates (`shared/templates.js`) as a separate kind. A team may save a working blueprint as a template for you to keep.

### 10.4 Watches and events that start work

Today a watch tells and never starts work, and a trigger is a signed webhook. A playbook may now begin `on: {watch: id}` or `on: {event: trigger}`. Both carry outside text, so a run they start is marked `outsideInput`, as event runs are today: it may read, record and draft, and every outbox item it makes waits for approval whatever the ceilings say.

---

## 11. Services and skills

### 11.1 The service profile

One per service, shared by every goal that uses it:

```json
{
  "service": "supplier-a",
  "domains": ["supplier-a.example"],
  "accounts": ["supplier-a"],
  "rules": {"summary": "…", "sources": ["…"], "checkedAt": "2026-11-26", "confirmedByOwner": true},
  "actions": {
    "read_item": {"method": "browser", "skill": "read_part_price@2", "allowed": "yes"},
    "search":    {"method": "browser", "skill": "search_parts@1", "allowed": "yes"},
    "purchase":  {"method": "browser", "allowed": "ask-each", "lane": "supplier-a"},
    "message":   {"method": "connector:mail", "allowed": "approve-each", "lane": "studio-mail"}
  },
  "pacing": {"read_item": {"perDay": 200}},
  "render": false
}
```

Actions use one vocabulary across every service, so patterns never name a platform:

- **Reads:** `read_item`, `read_list`, `search`, `read_metrics`, `export`
- **Changes inside your own space there:** `create`, `update`, `upload`, `organise`
- **Acting toward people:** `message`, `reply`, `publish`, `comment`, `invite`, `submit`, `book`
- **Money and removal:** `purchase`, `pay`, `delete`
- **Upkeep:** `sign_in_check`

A digest says `read_list`; a pipeline says `create`; outreach says `message`. The profile says how that is done on this service. A per-site rule the owner set (`shared/asks.js`) always wins over a profile's `allowed`.

### 11.2 The access ladder

Per action the team takes the highest rung that exists and that the service's rules allow:

1. **An official API through a connector.** Returns data, not scraped text, and is what most services intend for automation.
2. **Official exports, feeds and notification mail** (RSS, CSV export, "you have a new order" mail read through a mail connector).
3. **Reading pages in the browser**, signed out or in the bot's account, within the pacing.
4. **Acting in the browser**, only where the rules don't forbid it, and always through the outbox.

**The rules are the service's own.** The lead reads the service's published terms and developer pages, writes a short summary with links and the date, and you confirm it once per service. An action the rules forbid on every rung is `never`. An action whose rules were not found or not confirmed defaults to `approve-each`, never to `yes`. The summary carries its date, and the lead re-reads it when a skill breaks in a way that looks like a block, or after a month.

### 11.3 What needs you

Bots may create and fill a profile. Three fields are powers: which account a service uses, `allowed` for any action toward people or money, and pacing faster than your floor. Those change only through your Apply.

### 11.4 Skills

When a bot works out how to do an action on a service without an API, it saves the steps:

```json
{"service": "supplier-a", "action": "read_part_price", "version": 2,
 "steps": [{"go": "https://supplier-a.example/part/{sku}"}, {"find": "the price next to Add to basket", "save": "price"}],
 "check": "the page shows {sku}", "status": "trusted", "worked": 41, "failedInARow": 0}
```

- Steps name things by meaning ("the price next to Add to basket"), not by position, so small layout changes don't break them.
- Draft → trial (first runs checked against `check`) → trusted → broken after 2 failures in a row → the bot that hit it repairs it as a new version. Old versions are kept.
- Steps use only primitive vocabulary, can't reach a domain outside the profile, and a step toward people or money becomes an outbox item. A page's text never adds steps, so a stranger can't plant an action in a skill.
- Every goal using the service reuses its skills.

---

## 12. Patterns and the domains they cover

| Pattern | Shape | Examples across domains |
|---|---|---|
| Monitor | watch → filter → notify | Prices, stock, job or tender boards, a regulator's page, server health, mentions |
| Digest | gather on a schedule → summarise → deliver | Morning briefing, inbox, sales pipeline, papers, competitors |
| Triage | event → classify → route or draft | Support mail, applications, invoices, CI failures, form entries |
| Draft and approve | draft → outbox → you approve → send on timer | Outreach, replies, quotes, proposals, posts |
| Growth loop | measure → learn → plan → draft → approve → act → measure | Any audience or funnel: a newsletter, a shop, a channel, a sales list |
| Pipeline | ingest → transform → record → report | Receipts to a sheet, leads to a CRM, orders to a ledger, metrics to a page |
| Research | questions → read → note → synthesise with sources | Market checks, buying decisions, literature, due diligence |
| Maintenance | failure → diagnose → propose a fix → you approve | Repos, servers, broken skills, stale records |
| Account care | keep a session warm → notice sign-out → ask you | Every signed-in service |

| Domain | Typical goals | Built from | Stays approval-first or out |
|---|---|---|---|
| Sales and outreach | Leads, follow-ups, CRM hygiene | read, record, outbox, lanes, call (CRM, mail) | Every first message approved |
| Support | Triage, draft replies, weekly themes | on, watch (mail query), think, outbox, record | Customer replies approved |
| Recruiting | Screen applications, schedule interviews | on, record, call (mail, calendar), outbox | Rejections approved per person |
| Operations and purchasing | Prices, stock, reorder suggestions | watch, read, record, notify, outbox | A purchase asks every time; no card typed by a bot |
| Finance admin | Receipts, bills due, statement checks | look (images, PDF), record, call (sheets), notify | No trading, no money moved by a bot |
| Research | Briefs with sources, literature watch | read, look, note, schedule | Sources kept with every claim |
| Engineering | CI upkeep, dependency checks, release notes | on (webhooks), call (code host), outbox | A PR or merge only on your yes |
| Content and community | Drafts in your voice, on any channel, measured | outbox, lanes, record, experiments | Only actions the channel's rules allow |
| Personal and household | Travel, plans, renewals, documents | schedule, record, call (calendar), notify | Health and family data stay private |

Gaps that need something new but no core change: a phone chat channel for approvals, audio in, a sandboxed code runner for data work and charts, and an image generation connector. Out on purpose: trading, money movement, purchases without a per-order yes, actions a service's rules forbid, and anything meant to hide automation or get past a human check.

---

## 13. A walk-through: finding sales leads

"Find 20 qualified leads a week for my design studio and draft a first email to each."

1. **Intake.** The lead restates: qualified means small product companies in your city without an in-house designer; 20 a week; every email approved by you; no bought lists. One card asks two questions with picks: which mailbox, and where leads should go (records here, or a sheet you already use).
2. **Services.** A business directory site with no API: the lead reads its terms, which (in this example) allow personal browsing and forbid bulk export, so `read_list` and `read_item` are browser rungs at 200 pages a day, and `export` is `never`. The mailbox is the mail connector: `message` through the connector, `approve-each`. You confirm both summaries once.
3. **Pattern.** Pipeline into draft and approve.
4. **Blueprint.** Scout (cheap model, signed out, saves `read_listing@1` as a skill), qualifier (reads each company's own site and records `why`), writer (drafts into the outbox on lane `studio-mail`, 5 to 15 minutes apart, 10 a day, quiet after 19:00), lead (stand-up at 18:00 from `records:leads`).
5. **Apply.** One card: the brief, four roles, the mailbox, "10 emails a day at most, each approved by you", a daily budget of 300 model runs.
6. **Work.** Each morning the scout adds rows; the qualifier marks them; in the afternoon you approve a batch of drafts with a few taps and the lane sends them over the evening. After two weeks the lead's stand-up is handed a code-computed count of replies by district (an aggregate, so inside data, though the rows came from outside pages) and shifts the scout's job text toward the district with most replies. That grants nothing new and no outside text reached the lead, so it applies by itself and shows in the stand-up. Had the lead read the rows' `why` text, the same change would come to you as a card. A second mailbox or 30 sends a day would be a card.

Swap the directory for a tender portal, a marketplace, a CRM, a code host or a social network and steps 1 to 6 are the same. Only the profile, its skills and the pattern differ.

---

## 14. Build order

Rough focused days for one person who knows the code, tests included. Each phase ends green (`check`, `test`, `build:pages`, the UI smokes where UI changed) and is its own PR.

| Phase | What | Days | Why here |
|---|---|---|---|
| 0. Typed-text leak | 6.1 and 6.2: labels without field contents in `SNAPSHOT` and `riskGuard`; page text and `read` without editable contents; the same for the hand back; masked Password and Code fields in both takeover paths with `secret`; `secret` only over HTTPS or loopback; the tests listed | 1 to 2 | A live leak; ships alone |
| 1. Devices and parallel work | 5.5: `chooseDevice` and its table; bot device pins; a queue per bot on the device and in the server runtime; a takeover parks one bot; worker pool, per-engine cap, busy count; the tests listed | 2 to 3 | Accounts need a known device, and they are little use while one bot blocks all |
| 2. Browser accounts | 5.1 to 5.3: account records, routes and backups; bot pinning; a context per account; encrypted jars and re-pair; stamping at four hops; never in the server runtime; tabs, reaper, keepers, heartbeat state, wider sign-in detection; the profile fallback and its card | 4 to 6 | Fixes mixed accounts |
| 3. Sign-in from the phone | 6.3: the server-posted card per account with push; the `awaiting_ask` park and `signin` request status; re-dispatch on hand back | 2 | Makes 2 usable without the VM |
| 4. Connector accounts | 5.4: several connections per app; per-bot pins | 2 | Same rule for API accounts |
| 5. Timers, outbox, lanes | 8: the `timer` task kind; outbox items on `browserRequests` and `connectorCalls`; `payloadHash`; batch cards; claimed sends and `unknown`; held sends as a lane; the pacer; the `goal` activity kind | 4 to 5 | The general primitive for anything that acts outside |
| 6. Reading | 7: plain first; content types; redirects; `look`, `images`, image links; images on handoffs | 3 to 4 | Independent; can run beside 4 or 5 |
| 7. Records and notes | 9.1: the records table, migration, backups, retention, stats; outside marks on record fields and `outsideRecord` on runs handed them; the team notebook with outside marks | 2 to 3 | Goals and every metric need them |
| 8. Goals, ceilings, budgets | 9.2, 9.3: goal state; ceilings beside `state.limits`; per-goal daily counting and pause; the stand-up | 3 to 4 | Bounds everything after it |
| 9. Blueprints | 10: schema, validation, dry run and step resolver, diff and sorting, the outside hold, `POST /api/goals/:id/apply`, versions, auto-revert, watch and event playbooks | 5 to 7 | The self-redesign layer |
| 10. Services and skills | 11: profiles, the action vocabulary, the ladder, rule summaries you confirm, skills and their lifecycle; intake and the work loop in every lead and role | 4 to 6 | Any service without a hand-built integration |
| 11. Capability card | 4.3 | 1 | After what it describes exists |
| 12. Goal templates | 10.3: format, Apply, a few built-ins (lead finding, support triage, price watch, repo upkeep) | 2 to 3 | Uses everything above |

About 35 to 48 days in all. Phases 0 to 3 (9 to 13 days) fix what was reported: mixed accounts, bots blocking each other, and signing in from the phone. Phase 0 goes first and alone, because it closes a leak in today's code. Every new `shared/` module is added to `shared/assets.js` and followed by `npm run build:pages` (AGENTS.md, invariant 1).

---

## 15. Decisions for you

None of these blocks Phases 0 to 4.

1. **The publishing boundary (Phase 5).** `shared/contracts.js` says no contract can grant automated publishing, yet a click on Post with an Always allow grant already goes out. My suggestion: say instead "every outward action goes through an ask or the outbox, with an approval or a grant you gave", in that comment and the README. If you'd rather keep publishing impossible without a per-item yes, lanes never offer Always allow.
2. **Sending without asking inside a goal (Phase 5).** Off by default whatever Hands-off says (8.2). If you want Hands-off to carry into goals, that is one ceiling default to flip.
3. **The profile fallback's memory (Phase 2).** About 400 MB per account that needs its own Chrome. The card asks each time; the alternative is to refuse such services.
4. **Schedules and watches made by a team (Phase 9).** Today every bot-proposed schedule waits for your Apply, and only you make watches. I've kept that: a new schedule or watch in a blueprint is a power change. Making them free within a goal's budget would let a team run itself more, and widens what bots may do without you.

---

## 16. Risks

- **Cookie jars are as valuable as passwords.** Encrypted, 0600, never in a backup or upload, wiped with the account; the key protects a copied file, not a compromised server.
- **Some services keep sign-in outside cookies** [measured: local storage and IndexedDB don't restore]. The keeper check finds it, and the profile fallback costs memory.
- **Acting from the wrong account.** Four stamped hops, a device check before every step, and the account named on every card and countdown.
- **Self-redesign going wrong within its powers.** Ceilings, the dry run, the outside hold, 5 free changes a day, auto-revert, one-tap rollback, every change in the stand-up.
- **Prompt injection through outside content.** Marked as outside, can't approve, grant or auto-apply, and runs it starts ask before every send.
- **Rules and terms change.** Summaries are dated and re-read; unknown means approve-each.
- **More parallel work, more spend.** Per-goal budgets, deterministic steps, cheap tiers for routine roles, spend per goal on the usage page.
- **Screenshots of signed-in pages** go to the model provider: opt-in, once per page, off by default for signed-in pages.
- **Store growth.** Records in their own table, outside the state document, with per-goal caps and retention.

---

## Glossary

**Account:** your identity on a service, a browser cookie space or a connector connection. **Blueprint:** a team's design for one goal. **Brief:** the approved restatement of a goal. **Ceiling:** a per-goal limit only you raise. **Lane:** pacing for one account's outward actions. **Outbox:** where outward actions wait for approval and their timer. **Pattern:** a reusable shape of work. **Playbook:** a trigger plus steps. **Primitive:** one of the verbs bots use. **Service profile:** what the team knows about one website or app. **Skill:** saved steps for one action on one service.
