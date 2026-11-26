# Goals, services and self-organising teams

Design, 26 Nov 2026, written against `main` at `e20fb2d` (all branches merged). No product code changes with this document. It replaces the two drafts written earlier the same day (`architecture.md` and `browser-accounts-teams-plan.md`): their ideas are kept, checked against the code as it is, and generalised. Nothing here is tied to one website, one platform or one kind of work. Where a draft named a social network, the same thing now holds for any service: a CRM, a job board, a supplier's shop, a ticket desk, a bank's statement page, a code host.

Marks: **[measured]** was run on this machine; **[untested]** is a design I expect to work but have not run.

---

## 1. The idea

You give a goal in plain words: "find 20 qualified leads a week for my studio", "keep my repos' CI green", "tell me when any supplier's price for these parts drops below what I paid", "answer support mail within a day", "grow the newsletter to 2,000 readers by March". A lead bot turns it into a short **brief** you approve, picks a **pattern** for that kind of work, and lays out a **team** as a **blueprint**. To work on a website or app it has never seen, the team writes a **service profile** (how to reach it, what its rules allow per action, how fast to go) and learns **skills** (saved step lists) it reuses. Results go into **records** and **notes**, never only into a chat. Anything that acts for you outside the app (a send, a post, a form, a booking, an update in someone else's system) goes through the **outbox**, is approved as you saw it, and goes out on a **timer** in its **lane**. Under all of it sits a **core** (permissions, asks, accounts, secrets, the queue, the network guard, budgets, the audit log) that no bot, blueprint or outside text can change.

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

What this design leans on (every piece is on `main`):

| Piece | Where | Used for |
|---|---|---|
| Durable task queue with leases, retries and kinds `bot-task`, `group-run`, `agent-job`, `notification` | `shared/tasks.js`, `src/queue.js` | Timers and outbox sends become stored tasks |
| Claim-before-call with `unknown` after a crash | `src/connector-runs.js` (a call is marked `running` in its own store update; one still `running` at start is `unknown`, never repeated, and the bot is told) | Every outbox send |
| Exact-argument approval | `argsHash` in `shared/connectors.js`, read by `shared/asks.js` (connectors only) | Outbox approvals, extended to browser actions |
| Asks and grants per bot, action and site, with `until` | `shared/asks.js`, `shared/presets.js` | Unchanged; the outbox is one more client |
| Outside-text taint: `tainted`, `outsideRead`, `run.outsideInput`, `outsideMemory`, `keepOutsideMarks` | `shared/asks.js`, `src/coordination.js`, `shared/memory.js` | Holding self-made changes written after reading outside text |
| Limits: per run (`pages`, `rounds`, `steps`), `BACKSTOP`, `FAIL_STREAK`, per site per day (`perSite`, `state.siteVisits`) | `shared/limits.js` | Goal ceilings extend this |
| Token and cost metering per run and per bot per UTC day | `shared/usage.js`, `src/usage.js` | Goal budgets read it |
| Setup cards the owner applies with a tap (22 actions) | `shared/setup.js` (`SETUP_ACTIONS`), `src/setup-cards.js` | The goal and blueprint Apply cards |
| The workspace brief and run budget in every turn, after the cached head | `workspaceBrief` (`shared/setup.js`), `runBudget` (`shared/limits.js`), `STABLE_KEYS` (`src/ai.js:127`) | The capability card |
| Tracked tasks: `run.task` with `summary` and `doneWhen` | `src/coordination.js:177` | A goal is the lasting form of this |
| Daily briefing built from real state | `shared/briefing.js` | The goal stand-up |
| Watches compared by code, under their own key | `shared/watches.js`, `src/watches.js` | Monitor patterns |
| Signed event triggers | `src/triggers.js`, `src/routes-events.js` | `on` playbooks |
| Per-bot rulebooks and a company notebook no bot writes | `shared/memory.js` | The team notebook sits beside them |
| Attachments in a per-workspace table, carried by backups | `src/attachments.js`, `TABLE_SHAPES` in `src/sqlite-store.js` | The shape for the records table |
| Offline group simulator | `shared/group-simulator.js` | Blueprint dry runs (coordination only, see 9.2) |
| Activity log | `shared/activity-log.js` | The audit trail, with new kinds |

What has to change first, found by reading the code:

1. **Typed text leaks to the model.** The control list (`SNAPSHOT`, `agent/browser.mjs:83`) and the click-label reader (`:113`) take an element's `value` when it has no other text. That is any filled field, not only passwords: a card number, an address, a one-time code, a draft. It reaches the page text a bot is handed, the stored result, chat lines and the refusal reason `riskGuard` builds from the label. Both takeover UIs type through a plain `<input>` (`shared/ui-computer-view.js:109`, `shared/ui-takeover.js:46`), so a password shows on screen and a phone's password manager won't fill it.
2. **One cookie jar for every bot.** One Chrome, one profile, every tab in the default context (`newTab`, `agent/browser.mjs:606`); tabs are keyed by bot only (`agent/shared-browser.mjs:52`). Signing in to a second account of any service signs the first out for everyone.
3. **One driver and one task at a time.** `acquire()` (`agent/shared-browser.mjs:101`) lets one bot drive while all others wait, even on another site; a takeover parks every bot. The device runs its inbox one task at a time (`agent/agent.mjs:311`), so a long CLI model turn holds back every browser step.
4. **No device choice.** Three copies of `pickAgent` (`src/bot-browser.js:38`, `src/cli-model.js:32`, `src/mcp-client.js:167`) each pick "a" paired device. Nothing pins a bot or an account to one. With `BROWSER_RUNTIME=auto` a read may run in the server's own browser (`src/browser-runtime.js`), which has throwaway contexts only, so any account rule written for the device would be skipped there.
5. **A timer has nowhere to live.** A `once` schedule is a `bot-task`, which runs a model turn. Firing a send must not cost or depend on a model.
6. **Approval is by class, not by payload, in the browser.** Connector writes carry `argsHash`; a browser click is cleared as `class@origin` (`approvedFor`). An approval should cover exactly the text you saw.
7. **The audit log is thin.** `ACTIVITY_KINDS` is `outside`, `perm`, `bots`, and `perm` records only Always allow.
8. **No per-day budgets** apart from `perSite`. Usage is metered, but nothing stops on it.
9. **One connection per app, for every bot.** Connectors have no per-bot filter and no second account of the same app.
10. **Setup cards are applied by the UI** replaying existing routes; there is no server route that validates and applies a multi-part change at once.
11. **Hands-off is on for a new install** (an absent kv `hands_off` reads as on). That is fine for a chat, but a goal that sends on a timer for days needs its own, stricter default.

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
| Device runtime | A task runs on the device and in the account the server stamped on it, never one the model named. |
| Accounts & secrets | Passwords, codes, cookie jars and tokens never reach a model, a chat line, memory, a log or a backup. |
| Network guard | Bots reach only allowed sites and never a private network (`agent/net-guard.mjs`, `src/reach-guard.js`). |
| Budgets & guards | Ceilings per goal and per day that bots cannot raise; the runaway guard and kill switch over everything. |
| Store | Schema changes only by migration in a release. |
| Activity log | Every outward action, approval, account change and blueprint change is logged with who, what and why. |
| Chats, cards & push | Only the owner's own words or taps count as the owner. |

### 3.2 Primitives

| Primitive | What it does | Today | Change |
|---|---|---|---|
| read | A page, feed, file, JSON, PDF or image | Exists (`capture`, `readPlain`) | Plain first, content types, redirects (section 7) |
| browse | Steps in a tab of the bot's own account | Exists, one shared jar | Accounts, tabs, parallel (section 5) |
| look | A screenshot or image in the next turn | Owner attachments only | New for pages (section 7) |
| call | A connector tool | Exists | Per-bot connector accounts (5.4) |
| think | A model turn | Exists | Roles name a model tier |
| timer | Do one thing after a delay, a window or at a time | None | New task kind (8.1) |
| schedule | Repeat a playbook | Exists as cards | Inside a blueprint, within ceilings, no card |
| watch | Tell when a page or query changes | Pages | Feeds and connector queries; may start a playbook (10.4) |
| on | Start a playbook on an event | Signed webhooks | Unchanged |
| outbox | Queue an outward action for approval, timing and pacing | None | New (8.2) |
| record | Add, update, query rows; simple stats in code | None | New table (9.1) |
| note | Append to and read the team notebook | Bots cannot write any shared notes | New, marked by taint (9.1) |
| ask-owner, ask-bot, create-bot | Cards, questions, new teammates | Exist | Unchanged |
| notify | A short push to the owner | App only | A bot primitive with a daily cap |

A blueprint step is either a **deterministic primitive** (call, read, record, outbox, timer), which costs no model run, or a **role turn**, where a bot thinks and writes blocks. Routine work (refresh numbers, copy rows, check a page) stays exact and cheap.

---

## 4. How bots turn words into work

### 4.1 Intake (leads)

1. **Restate** the outcome, a measurable target, a deadline, the scope (which services and accounts) and your constraints, in your words where you gave them.
2. **Fill gaps with defaults and list them** ("assumed: approve every send", "assumed: your time zone"). Ask only what would change the plan: at most three questions, one card, each with options and the lead's pick.
3. **Pick a pattern** (section 6), or two.
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

Each turn a bot is told only what it holds: its account per service, its primitives, its skills, its lanes and what is left of its budget, its teammates. It is generated from records, so it cannot drift from the truth. The parts that rarely change (the account names and primitives a role holds) belong in the bot's `tools`, one of the `STABLE_KEYS` that stay byte-stable for prompt caching; the per-turn parts (budget left, today's numbers, pending outbox) go after the head, the way `workspace` and `budget` already do (`src/coordination.js:338`). A line per thing held, because it is paid on every turn.

---

## 5. Accounts, devices and tabs

### 5.1 Browser accounts: one Chrome, one context per account

A **browser account** is a named, isolated cookie space in the one Chrome: `work-crm`, `studio-mail`, `supplier-a`. Bots on the same account share its sign-in; bots on different accounts cannot see each other's cookies.

**[measured]** on this laptop, 26 Nov 2026. Method: a local HTTP page set an HttpOnly cookie, a session cookie, a `localStorage` key and an IndexedDB row inside a context made with `Target.createBrowserContext` in headless Chrome; that Chrome was closed and a new one started on a fresh `--user-data-dir`; memory is the PSS sum from `/proc/<pid>/smaps_rollup` over the processes whose command line names that `user-data-dir`. Result: cookies read with `Storage.getCookies({browserContextId})` and written into a new context of a new Chrome with `Storage.setCookies` came back whole, HttpOnly included; `localStorage` and IndexedDB did not; a second context in the same Chrome saw none of the first one's cookies. One headless Chrome with one small tab was about 397 MB PSS; an extra context added about 45 MB. A Chrome per account would cost about eight times as much as a context per account.

So:
- **Default, `storage: "cookies"`:** a context per account, and its cookies saved to `browser-accounts/<id>.jar` (folder 0700, file 0600, AES-256-GCM under a key derived with HKDF from the agent's pairing secret, so a copied file alone is useless). Saved after every task that touched the account and every 10 minutes; restored when the context is created.
- **Fallback, `storage: "profile"`:** for a service whose sign-in lives in local storage, the account gets its own Chrome with its own `--user-data-dir`. The device finds out by itself: if the keeper tab (5.3) shows a sign-in page right after a restore, the account is marked as needing a profile and a card offers the switch, naming the memory cost.
- The `default` account is today's persistent profile, so a bot with no account behaves as now.

**Owner-only.** The server keeps `browserAccounts: [{id, name, site, deviceId, storage}]`. A bot's `browserAccount` is set by the owner on its profile or by applying a blueprint; never from a model's block (the same rule `shared/bot-create.js` uses to refuse permission fields).

### 5.2 Stamping the account at every hop

An account is checked at four places, so no single slip mixes accounts:

1. **The block.** A model's `browser` block (`shared/bot-browser.js`) has no account field; one that names an account is refused.
2. **Dispatch.** `dispatchBrowserRequest` (`src/bot-browser.js:49`) adds `account` and `deviceId` from the bot record to the agent task payload (`:87`).
3. **The device.** `runBrowserTask` (`agent/agent.mjs:174`, `:186`) hands the account to the shared browser, which keys tabs by `(account, botId, tab)` and checks before every step that the tab's context is the payload's account.
4. **Live and takeover.** The live channel and takeover (`agent/live-channel.mjs`, `src/browser-live.js`) open and show the tab in that bot's account, and the screen names it.

A request whose bot has an account never runs in the server runtime: with `BROWSER_RUNTIME=auto` it goes to the account's device, and with `server` it is refused with one line saying why.

### 5.3 Tabs, keepers and session checks

- A block may say `"tab": "new"` or `"tab": "<name>"`; the result names the tab. Default is the bot's main tab, so today's blocks keep working. At most 6 tabs per bot and 12 per account.
- A tab untouched for 10 minutes is closed after its cookies are saved.
- One **keeper tab** per signed-in account stays on the service's home page. It does not keep a sign-in alive by itself (the cookie's own expiry and the site do that); it gives a warm page and an early warning. Every 30 minutes the device looks at each keeper; a sign-in page marks the account "signed out" and the sign-in card goes out (section 6) before a routine hits it.
- `AGENT_BROWSER_QUIT_IDLE=1` quits Chrome after 30 quiet minutes for anyone who wants the memory back; sign-ins come back from the jars.

### 5.4 Connector accounts

Today a connector is one connection per app, used by every bot. The same rule as browser accounts applies: a connector may have several **connections** (two mailboxes, two workspaces of a chat app, a personal and a work calendar), each a vault credential, and a bot is pinned to the connections it may use. `useConnector` receives the connection from the bot record, never from the block. An app with one connection and no pins behaves as today.

### 5.5 Devices and parallel work

- One `pickDevice(store, {kind, botId, account})` replaces the three `pickAgent` copies: an account or a bot pinned to a device goes only there; otherwise the rules of each copy today are kept.
- One queue per tab instead of one global driver: bots in different tabs or accounts run at once, and a takeover parks only the tab being driven.
- A small worker pool on the device: `AGENT_CONCURRENCY` (default 3) tasks at once, at most one `model.run` per CLI engine, leases renewed in the keepalive as today.

---

## 6. Sign-in from the phone

1. **The server posts the card.** When a result is a sign-in page (`signinSite`, `shared/bot-browser.js:272`) or a keeper finds its account signed out, the server posts one "Sign-in needed" card per account (naming the account, the service and the bot) with **Take control**, and pushes it. Today the app only does this by itself after a site refused the browser twice (`:596`) or for an unattended run (`signinNotice`); otherwise it depends on the bot sending a `signin` setup block.
2. **The run waits.** The run that hit the page parks as "waiting for sign-in" and goes on from the page as left after hand back. Other accounts keep working.
3. **Masked fields, in both takeover UIs.** Beside "Type into the page" in the Computer view and in the takeover sheet: **Password** (`type="password"`, `autocomplete="current-password"`) and **Code** (`inputmode="numeric"`, `autocomplete="one-time-code"`). Both send `{type: "type", text, secret: true}` to the focused field. `secret` text is held only in the in-memory command queue until the device acks it, and appears in no toast, echo, activity line, run record, model context or error.
4. **Nothing typed reaches a model.** The control list and click labels stop reading `value` from any field (`input`, `textarea`, `select`, contenteditable); a field is named by its label, `aria-label`, placeholder or name only. `riskGuard`'s reason uses the same label, so it cannot carry typed text either. This is phase 0 and ships alone.
5. **Only over a safe transport.** `secret` input is refused over plain HTTP from anything but localhost.

---

## 7. Reading

1. **Plain first.** A read with no steps tries a plain fetch first and Chrome only when the text is under 300 characters, the site turned it away, the bot asked `"render": true`, or the page needs the bot's account. A short list of hosts known to draw everything with scripts goes straight to Chrome; the list is data, learned per service (the profile records `render: true` once a plain read of it came back empty twice). Today, with `AGENT_BROWSER=1`, Chrome goes first (`agent/agent.mjs:166-183`).
2. **Content types.** JSON, plain text, CSV and Markdown come back as text; a PDF is turned to text with `pdftotext` where installed (else a clear line naming it and its pages; 20 MB cap); an image is handed to the model as an image.
3. **Redirects** are followed up to 5 hops, each checked against the allowlist and the private-address guard, instead of costing a model turn.
4. **Seeing.** `"look": true` returns a screenshot (JPEG, at most 1280 wide) as an image for the next turn; `"images": true` lists the page's main images (at most 12); a URL that is an image arrives as one. At most 4 images a turn, 5 MB each, through the same image paths owner files use (`userContent` in `src/ai.js`, `cleanImages` in `agent/cli-model.mjs`). Opt-in, sent once per page, and off for signed-in pages unless the role's blueprint allows it, because a screenshot of a signed-in page sends private data to the model provider.
5. **Images on handoffs.** When a bot asks or hands off about an image, that turn's images (up to 4) go along.

---

## 8. Timers, the outbox and lanes

### 8.1 Timers

```timer
{"after": {"min": "2m", "max": "4m"}, "then": {"outbox": "ob_7f3a"}, "label": "Send 2 of 5"}
```

- **When:** `"after": "90s"`, a window `{"min", "max"}`, or `"at"` in the owner's zone. A window is drawn once, when the timer is made, to the second, and stored, so a restart does not move it.
- **Then:** release an outbox item, start a playbook, wake a role with a message, or run a device task the bot may already run. A timer never does what its bot could not do directly and never skips an approval.
- **Stored:** a new task kind `timer` in `PAYLOAD_KINDS` (`shared/tasks.js`), fired by the queue without a model. Not a `once` `bot-task`, which would run a model turn.
- **Limits:** 10 seconds to 30 days, at most 50 pending per bot and 500 per goal; each firing counts against the goal's budget.
- **Visible:** the chat line shows a countdown with Do it now, Cancel and Edit; a bot may cancel its own; the goal page lists them all.

### 8.2 The outbox

Any action that acts for you outside the app can go through it: a message, an email, a post, a comment, a form submission, a booking, a record changed in someone else's system.

`outbox: {id, goalId, lane, account, action: {connector call | browser steps}, payload, payloadHash, status: draft → approved → scheduled → sending → sent | failed | unknown | cancelled, approval: {mode, by, at}, timerId, result: {url, externalId}}`

- **Approval covers the exact payload.** `payloadHash` extends today's `argsHash` to browser actions: account, origin, and every step with its text. Editing sends the item back to draft.
- **Approval modes per lane:** one card per item; one card per batch ("5 drafts for studio-mail": approve, edit or drop each); or an Always allow grant, which only the owner gives, as a power change. Payments and deletes still ask every time, as today.
- **Hands-off does not reach a goal's lanes.** A goal sends without asking only if its ceilings say so (default off), whatever the workspace's Hands-off switch says. Chats outside goals keep today's Hands-off rules.
- **Sending is claimed.** The release marks the item `sending` in its own store update before the call, the pattern of `src/connector-runs.js`; an item still `sending` at start-up becomes `unknown`, is never resent, and the owner is told. Late items after downtime go one per gap, in order, never in a burst. (Held email sends, `src/held-sends.js`, keep their own rule: their undo window lives in memory and a restart sends nothing. Both are right for what they are.)
- **Results are recorded:** a sent item writes its link and id into a collection, and the blueprint may attach follow-up timers (check replies after an hour, a day, a week).
- **Logged:** every approval and every send goes into the activity log (`outside` for sends, a new `goal` kind for approvals and ceilings), not only Always allow.

### 8.3 Lanes and the pacer

A lane is one per account and channel: a gap window, a daily cap, quiet hours, an optional best-time preference (prefer the best hours found so far, keep a share elsewhere so early luck doesn't freeze the data), and `startAfter`: `approval` (default) or `now` (counts at once; goes when the timer has ended and it is approved). The pacer draws `fireAt = max(now + random(window), lastFireAt + random(window))`, each gap on its own. Controls on the line: Send now (skips the timer, not the approval), Cancel, Edit, Pause lane. Lanes are for spacing your actions and staying inside a service's published limits. They are not for hiding automation, and nothing here simulates a person, changes fingerprints or solves a CAPTCHA.

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

- **Records:** a new per-workspace table `records(goalId, collection, id, data, createdAt, updatedAt)` added by migration, listed in `TABLE_SHAPES`, carried by backups with a size cap like attachments, pruned by the retention sweep. Collections and field types come from the blueprint. `record` adds, updates, queries (filter, sort, limit) and computes count, sum, median, and by hour or weekday in code, so a report doesn't depend on a model's arithmetic. Numbers written by deterministic steps from a connector count as inside data.
- **Team notes:** one notebook per goal every team role may append to and read. A line written in a run that read outside text carries the existing outside mark, and a marked line cannot approve, grant or auto-apply anything. The company notebook stays read-only to bots.
- **Rule of the place:** nothing important lives only in a chat. A role added tomorrow can do its job from these places alone.

### 9.2 Goals

A goal is the lasting form of a tracked task (`run.task` with `summary` and `doneWhen`): `{id, title, leadBotId, metrics, deadline, status, ceilings, blueprintVersion}`. You make one in chat or the lead proposes one; either way your Apply sets its ceilings. Its **stand-up** is the daily briefing (`shared/briefing.js`) narrowed to the goal: each role writes one line to the notes, and the lead posts one status from real records (progress against metrics, blueprint changes, what's next). You can move it or turn it off.

### 9.3 Ceilings and budgets

Set once per goal, read-only to bots: max bots; model runs and tokens per day; outward actions per lane per day; the minimum gap per lane; which accounts, connections, sites and model tiers; quiet hours; whether anything may send without asking (default no); and whether signed-in pages may be seen as images. They sit beside `state.limits` and use the same `BACKSTOP` idea: a ceiling can only be raised by the owner, and never past a backstop.

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
    {"key": "writer", "job": "…", "model": "standard", "connections": ["studio-mail:draft"], "lanes": ["studio-mail"]}
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

Roles become bots with an explicit `reportsTo` (today a new bot reports to its creator only when the creator leads a team). Playbooks are a trigger (`on`: schedule, timer, watch, event, record change) plus steps.

### 10.2 How a change is judged

The lead (or a role the blueprint allows) sends a `blueprint` block. The server:

1. **Validates** the schema, every reference (roles, collections, lanes, accounts, connections, skills) and every number against the ceilings.
2. **Dry-runs** what it can: the group simulator (`shared/group-simulator.js`) runs the handoffs with canned replies; playbook steps are checked by a resolver that confirms each trigger, primitive and reference exists, without running them. The simulator covers coordination only today, so this is not a full rehearsal, and the card says so.
3. **Diffs** against the live version and sorts each change:

| Kind | Examples | What happens |
|---|---|---|
| Free | A role's job text; a playbook using granted primitives; a timer, schedule or watch within budget; a wider lane gap; a new collection or field; an experiment; retiring a role; a permissionless role within the bot cap | Applies by itself, logged with its reason, in the next stand-up, one-tap undo |
| Power | A new account, connection, site or permission; any Always allow; a higher ceiling; a gap below your floor; deleting a collection's data; touching another goal | A card with Apply, Edit or Decline, showing only the diff |
| Never | Core code, the permission registry, approval rules, guards, secrets | Refused, with one line why |

4. **Outside text holds it.** A free change written by a run marked by the existing taint (`tainted`, `outsideRead`, `outsideInput`, `outsideMemory`) becomes a card instead. A stranger's mail, page or form entry cannot rewrite a role's job. A lead that plans from its own records (inside data) can still change its team without asking.
5. **Applied on the server.** A new owner-only `POST /api/goals/:id/apply` validates the whole diff again, applies it in one store update and logs it under `goal`. Today's setup cards are applied by the UI calling routes one by one; a blueprint is too many parts for that.
6. **Rollback and pace.** Every version is kept and any can be restored in one tap. If a new version's playbooks fail 3 times in a row (`FAIL_STREAK`), the server goes back to the last good one and says so. At most 5 free changes per goal per day, and an experiment cannot be ended before its minimum sample.

### 10.3 Templates

A goal template is a blueprint with blanks (accounts, topic, times) and the list of powers it needs; installing one shows the same Apply card. It lives beside today's message templates (`shared/templates.js`) but is a separate kind, so neither list grows the other's rules. A team may save a working blueprint as a template for you to keep.

### 10.4 Watches and events that start work

Today a watch tells and never starts work, and a trigger is a signed webhook. A playbook may now begin `on: {watch: id}` or `on: {event: trigger}`. Because both carry text from outside, a run they start is marked `outsideInput`, exactly as event runs are today: it may read, record and draft, and every outbox item it makes waits for approval whatever the ceilings say.

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
    "read_item":  {"method": "browser", "skill": "read_part_price@2", "allowed": "yes"},
    "search":     {"method": "browser", "skill": "search_parts@1", "allowed": "yes"},
    "purchase":   {"method": "browser", "allowed": "ask-each", "lane": "supplier-a"},
    "message":    {"method": "connector:mail", "allowed": "approve-each", "lane": "studio-mail"}
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

A digest says `read_list`; a pipeline says `create`; outreach says `message`. The profile says how that is done on this service.

### 11.2 The access ladder

Per action the team takes the highest rung that exists and that the service's rules allow:

1. **An official API through a connector.** Returns data, not scraped text, and is what most services intend for automation.
2. **Official exports, feeds and notification mail** (RSS, CSV export, "you have a new order" mail read through a mail connector).
3. **Reading pages in the browser**, signed out or in the bot's account, within the pacing.
4. **Acting in the browser**, only where the rules don't forbid it, and always through the outbox.

**The rules are the service's own.** The lead reads the service's published terms and developer pages, writes a short summary with links and the date, and you confirm it once per service. An action the rules forbid on every rung is `never`. An action whose rules were not found or not confirmed defaults to `approve-each`, never to `yes`. Rules change, so the summary carries its date and the lead re-reads it when a skill breaks in a way that looks like a block or when a month has passed.

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

| Domain | Typical goals | Built from | Needs or stays out |
|---|---|---|---|
| Sales and outreach | Leads, follow-ups, CRM hygiene | read, record, outbox, lanes, call (CRM, mail) | Every first message approved |
| Support | Triage, draft replies, weekly themes | on, watch (mail query), think, outbox, record | Customer replies approval-first |
| Recruiting | Screen applications, schedule interviews | on, record, call (mail, calendar), outbox | Rejections approved per person |
| Operations and purchasing | Prices, stock, reorder suggestions | watch, read, record, notify, outbox | A purchase asks every time; no card typed by a bot |
| Finance admin | Receipts, bills due, statement checks | look (images, PDF), record, call (sheets), notify | No trading, no money moved by a bot |
| Research | Briefs with sources, literature watch | read, look, note, schedule | Sources kept with every claim |
| Engineering | CI upkeep, dependency checks, release notes | on (webhooks), call (code host), outbox | A PR or merge only on your yes |
| Content and community | Drafts in your voice, any channel, measured | outbox, lanes, record, experiments | Only actions the channel's rules allow |
| Personal and household | Travel, plans, renewals, documents | schedule, record, call (calendar), notify | Health and family data stay private |

Gaps that need something new but no core change: a phone chat channel for approvals (Telegram, WhatsApp), audio in, a sandboxed code runner for data work and charts, and an image generation connector. Out on purpose: trading, money movement, purchases without a per-order yes, actions a service's rules forbid, and anything meant to hide automation or get past a human check.

---

## 13. A walk-through outside social media

"Find 20 qualified leads a week for my design studio and draft a first email to each."

1. **Intake.** The lead restates: qualified means small product companies in your city without an in-house designer; 20 a week; every email approved by you; no buying lists. One card asks two questions with picks: which mailbox, and where leads should go (records here, or a sheet you already use).
2. **Services.** A business directory site (no API found): the lead reads its terms, which allow personal browsing and forbid bulk export, so `read_list` and `read_item` are browser rungs with a 200-pages-a-day pace, and `export` is `never`. The mailbox is the mail connector: `message` through the connector, `approve-each`. You confirm both summaries once.
3. **Pattern.** Pipeline into draft and approve.
4. **Blueprint.** Scout (cheap model, signed out, saves `read_listing@1` as a skill), qualifier (reads each company's own site and records `why`), writer (drafts into the outbox on lane `studio-mail`, 5 to 15 minutes apart, 10 a day, quiet after 19:00), lead (stand-up at 18:00 from `records:leads`).
5. **Apply.** One card: the brief, four roles, the mailbox, "10 emails a day at most, each approved by you", a daily budget of 300 model runs.
6. **Work.** Each morning the scout adds rows; the qualifier marks them; in the afternoon you approve a batch of drafts with a few taps and the lane sends them over the evening. After two weeks the lead sees replies come mostly from one district and shifts the scout's job text there. That grants nothing new, so it applies by itself and shows in the stand-up. If it wanted a second mailbox or 30 sends a day, that would be a card.

Swap the directory for a tender portal, a marketplace, a CRM or a code host and steps 1 to 6 are the same. Only the profile, its skills and the pattern differ.

---

## 14. Build order

Rough focused days for one person who knows the code, tests included. Each phase ends green and is its own PR.

| Phase | What | Days | Why here |
|---|---|---|---|
| 0. Typed-text leak | Stop reading `value` in the control list, click labels and `riskGuard`'s reason; masked Password and Code fields in both takeover UIs with `secret`; refuse `secret` over plain HTTP; tests that no typed text reaches a result, chat line, log or store | 1 | A live leak; ships alone |
| 1. Devices and parallel work | One `pickDevice` with pinning; per-tab queues; takeover parks one tab; device worker pool with a per-engine cap | 2 to 3 | Accounts need a known device, and they are useless while one bot blocks all |
| 2. Browser accounts | Account records and bot pinning; a context per account; encrypted jars; stamping at four hops; no account in the server runtime; tabs, reaper, keepers, session check; the profile fallback and its card | 4 to 6 | Fixes mixed accounts |
| 3. Sign-in from the phone | Server-posted card with push; parked runs; resume after hand back | 2 | Makes 2 usable without the VM |
| 4. Connector accounts | Several connections per app; per-bot pins | 2 | Same rule for API accounts |
| 5. Timers, outbox, lanes | `timer` task kind; outbox with `payloadHash` for browser actions, batch cards, claimed sends and `unknown`; pacer; activity log kinds and every approval logged | 4 to 5 | The general primitive for anything that acts outside |
| 6. Reading | Plain first; content types; redirects; `look`, `images`, image links; images on handoffs | 3 to 4 | Independent; can run beside 4 or 5 |
| 7. Records and notes | Records table, migration, backups, retention, stats; team notebook with outside marks | 2 to 3 | Goals and every metric need them |
| 8. Goals, ceilings, budgets | Goal object from tracked tasks; ceilings beside `state.limits`; per-goal daily counting and pause; the stand-up from the briefing | 3 to 4 | Bounds everything after it |
| 9. Blueprints | Schema, validation, simulator dry run plus step resolver, diff and sorting, outside hold, `POST /api/goals/:id/apply`, versions, auto-revert, watch and event playbooks | 5 to 7 | The self-redesign layer |
| 10. Services and skills | Profiles, the action vocabulary, the ladder, rule summaries you confirm, skills and their lifecycle; intake and the work loop in every lead and role | 4 to 6 | Any service without a hand-built integration |
| 11. Capability card | Generated per bot, stable part in `tools`, live part after the head | 1 | After what it describes exists |
| 12. Goal templates | Format, Apply, a few built-ins (lead finding, support triage, price watch, repo upkeep) | 2 to 3 | Uses everything above |

About 35 to 47 days in all. Phases 0 to 3 (9 to 12 days) fix the problems reported: mixed accounts, bots blocking each other, and signing in from the phone. Phase 0 should go first and on its own, because it closes a leak in today's code.

The earlier draft put the worker pool after accounts and the leak fix as passwords only; both are corrected here.

---

## 15. Decisions for you

1. **The publishing boundary.** `shared/contracts.js` says no contract can grant automated publishing, yet a click on Post with an Always allow grant already goes out. My suggestion: say instead "every outward action goes through an ask or the outbox, with an approval or a grant you gave", in that comment and the README. If you'd rather keep publishing impossible without a per-item yes, lanes simply never offer Always allow.
2. **Sending without asking inside a goal.** I've made it off by default whatever Hands-off says (8.2). If you want Hands-off to carry into goals, that's one ceiling default to flip.
3. **The profile fallback's memory.** About 400 MB per account that needs its own Chrome [measured on a small page; real sites more]. The card asks each time; the alternative is to refuse such services.

---

## 16. Risks

- **Cookie jars are as valuable as passwords.** Encrypted, 0600, never in a backup or upload, wiped with the account. A stolen disk together with the agent config still opens them.
- **Some services keep sign-in outside cookies** [measured: local storage and IndexedDB don't restore]. The keeper check finds it, and the profile fallback costs memory.
- **Acting from the wrong account.** Four stamped hops, a device check before every step, and the account named on every card and countdown.
- **Self-redesign going wrong within its powers.** Ceilings, the dry run, the outside hold, 5 free changes a day, auto-revert, one-tap rollback, every change in the stand-up.
- **Prompt injection through outside content.** Marked as outside, can't approve, grant or auto-apply, and runs it starts ask before every send.
- **Rules and terms change.** Summaries are dated and re-read; unknown means approve-each.
- **More parallel work, more spend.** Per-goal budgets, deterministic steps, cheap tiers for routine roles, spend per goal on the usage page.
- **Screenshots of signed-in pages** go to the model provider: opt-in, once per page, off by default for signed-in pages.
- **Store growth.** Records in their own table with per-goal caps and retention.

---

## Glossary

**Account:** your identity on a service, a browser cookie space or a connector connection. **Blueprint:** a team's design for one goal. **Brief:** the approved restatement of a goal. **Ceiling:** a per-goal limit only you raise. **Lane:** pacing for one account's outward actions. **Outbox:** where outward actions wait for approval and their timer. **Pattern:** a reusable shape of work. **Playbook:** a trigger plus steps. **Primitive:** one of the verbs bots use. **Service profile:** what the team knows about one website or app. **Skill:** saved steps for one action on one service.
