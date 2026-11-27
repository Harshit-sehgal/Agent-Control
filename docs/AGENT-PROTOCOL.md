# Local agent protocol

The control plane never dials your device. Every request in this protocol is
**outbound from the agent**. This document is the contract between
`agent/agent.mjs` (device) and `src/agent.js` + the `/api/agent/*` routes
(server).

## 1. Pairing
1. An **admin** creates a one-time code: `POST /api/agents/pair` →
   `{code, expiresAt, ttlSeconds}`. The code is 10 minutes old at most and is
   stored only as a SHA-256 hash, so a database leak cannot redeem a pending
   pairing.
2. The **device** exchanges it exactly once:
   `POST /api/agent/pair {code, name, permissions, features}` →
   `{agentId, secret, workspaceId, permissions, pollIntervalMs}`.
   The plaintext `secret` is returned once; the server keeps only an
   AES-256-GCM-encrypted copy and a SHA-256 hash. `features` is what the app
   can do (`shared/device-features.js`), the same list every heartbeat sends,
   so work that needs a feature is not refused before the first beat. An app
   that sends none still pairs and reports none until it beats. A device whose
   app lacks a feature the server needs shows "Needs an update" on its card in
   Settings, naming what it cannot do.
3. **Pairing again.** A computer that already holds a working pairing with the
   same server adds `previous: {agentId, proof}` to the request. `proof` is the
   hex HMAC-SHA256, keyed by the old secret, of `re-pair\n` and the new code.
   The server accepts it only for an agent of the code's workspace that is not
   revoked, and compares it in constant time. A proven `previous` makes the new
   agent that computer's replacement: its browser accounts and bot pins move to
   the new id, its old row is retired and its pages in flight are failed. Any
   other `previous` (or none) pairs a new computer and moves nothing. The reply
   does not say which happened.

   The device does a re-pair in two steps, so a stop in the middle strands
   nothing. It first finishes any earlier re-key. When the server answers it
   saves the config with both secrets (`rekeyFrom` holds the old one), then
   re-encrypts the browser-account jars under the new secret, then saves the
   config again without `rekeyFrom`. A start that finds `rekeyFrom` finishes the
   job before it opens a jar. If the re-key cannot be done, browser accounts
   are off for that run and no jar is touched. A pairing with a different
   server, or none before it, wipes every jar, because no secret the computer
   holds opens them. The config is saved whole to a temp file and renamed, and a
   config that is a symlink stays one.

   `pair` and `run` each hold `<config>.lock` (named from the config's real
   path), so a pair never runs while the agent runs, and `pair` stops without
   changing anything when the config is a link to a file that is not there, or
   cannot be read or parsed. The lock is created with `wx`, mode 0600, and holds
   `{pid, token, at}`. It is stale when its process is the one asking or is gone,
   or when it was last refreshed over 2 minutes ago; `run` refreshes it every 30
   seconds. A folder that cannot be written stops `pair`, and lets `run` go on
   without a lock.

## 2. Signed requests
Every subsequent agent request carries three headers:

| header | value |
|---|---|
| `X-Agent-Id` | the id from pairing |
| `X-Agent-Ts` | current time, milliseconds since epoch |
| `X-Agent-Sig` | hex HMAC-SHA256 |

```
signature = HMAC_SHA256(secret, METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + SHA256(rawBody))
```

Verification (`verifyAgentRequest`):
- reject if `|now − timestamp| > 5 min` (401);
- reject unknown agents (401) and revoked agents (403);
- constant-time compare of the HMAC (401 on mismatch);
- reject a signature already seen for that agent (409) — a per-agent replay
  cache that bounds the immediate-replay window.

## 3. Endpoints (all signed, all agent-initiated)
- `POST /api/agent/heartbeat` → marks the agent online and returns due tasks.
  The body may carry `cli: {claude, codex}`, each `signed-in`, `signed-out`,
  `missing` or `unknown`, taken from the CLIs' own status commands; the server
  keeps only those four words and shows them in `GET /api/agents`. It also
  carries `features: ["secret-input-v1"]`, what the app can do (`shared/device-features.js`);
  each beat replaces the last list, a beat without it means none, and the server
  queues a masked `secret` input (`secret: true`) only for a device that lists `secret-input-v1`.
  It also carries `accounts: [{id, state, storage, lost?}]`, one entry for each
  browser account the computer holds: `state` is `signed-in`, `signed-out` or
  `unknown`, `storage` is `cookies`, and `lost: true` says the jar was put back
  and the site still showed its sign-in page. The server keeps only those
  fields, only for accounts that name this computer, one entry each; a
  cookie value is not a field, so none can be stored. A beat without a list
  leaves the last report as it was. The answer carries `accounts: [{id, site}]`,
  the accounts that name this computer. The device wipes any jar that is not on
  that list, and refuses a task for an account that is not on it. A beat with no
  list in the answer (an older server) wipes nothing. A device lists
  `browser-accounts-v1` in its `features`, and the server sends it account work
  only when it does.
- `POST /api/agent/live` `{tabs:[{botId,account,url,title}], owner, failed?}` → a long
  poll (held up to 20 s) that answers `{commands, watch, watchAccount?}`: `watch` is the bot
  whose tab the owner is looking at (or null) and `watchAccount` the browser account that
  tab is in, when it has one. `commands` are `takeover`,
  `handback` and `input` for the device to apply, in order. A tab is named by its
  account (none for the computer's own profile) and its bot, so one bot on two
  accounts has two tabs. A command for an account's tab carries `account`, and the
  device applies an `input` only to the tab the owner took over. A `handback` is
  always honoured. `owner` says which
  bot's tab the owner holds on the device; `failed` reports a takeover that
  could not start. Only a device with `AGENT_BROWSER=1` and a browser permission
  opens this line.
- `POST /api/agent/frames` `{botId, account?, image, w, h}` → one JPEG frame (base64) of
  the watched tab; answers `{watch, watchAccount?}`. The server keeps only the newest, in
  memory, while someone is watching.
- `POST /api/agent/tasks/:id/result` `{status, result, error}` → records a
  result. Completing an already-completed task is rejected (409); a `failed`
  result re-queues while attempts remain, then fails permanently.

## 3b. The shared browser (owner side)
The owner's page, signed in as a member or above (a read-only viewer gets no
frame), uses these; `src/browser-live.js` keeps what they carry in memory:

- `GET /api/browser-live` → `[{botId, state: idle|browsing|driving, url, title,
  site, pages: [{url, title, at}], runId, requestId, live, account}]`. `account` is
  `{id, name}` when the bot signs in as a browser account, else null. `pages` are this
  run's, or the last run's when idle. `site` is the host of the page now while
  the bot is browsing or driven, else null.
- `GET /api/browser-live/:botId?after=<seq>` → the same line plus the newest
  frame: `{seq, changed, w, h, at, image, agent, notice?, state, url, title,
  site}`. `image` is a `data:image/jpeg;base64,…` URL and is present only when
  `seq` moved past `after`. Polling is what tells the device to cast that tab.
- `POST /api/browser-live/:botId/takeover` and `/handback` → `{botId, state}`.
  Takeover is 409 when no device is running the shared browser.
- `POST /api/browser-live/:botId/input` `{type: click|key|type|scroll|navigate,
  …}` → 409 unless the owner is driving that bot, 400 for a malformed event, 429
  when 100 are already queued. The page is 1280×800; `click {x, y, double?}`,
  `scroll {x?, y?, dx?, dy}`, `type {text}` (≤ 2000), `key {key}` (Enter, Tab,
  Backspace, Delete, Escape, arrows, Home, End, PageUp, PageDown),
  `navigate {url}` (held to the allowlist).

### Browser accounts in the shared browser

A browser account is a named sign-in of one site whose cookies live on one paired
computer (`browserAccounts` records, owner-only `GET/POST /api/browser-accounts`,
`PATCH/DELETE /api/browser-accounts/:id`). A bot signs in as one through its
owner-only `browserAccount` setting, never through a model's block. The server
stamps the account at four hops, and the device checks it before every step:

1. A model's `browser` block has no account field; one in a block is dropped.
2. Dispatch adds `account` and `deviceId` (the account's computer) to the task
   payload from the bot's record, and only to a computer that lists
   `browser-accounts-v1`. A bot whose account is on a computer never runs in the
   server's own browser: under `BROWSER_RUNTIME=auto` the task goes to that
   computer, and under `server` it is refused with a line saying why.
3. The device refuses a task whose `account` is not an id it was told it holds, or
   whose `deviceId` is not its own id, or that names no `deviceId`. A task for
   an account runs only in the real browser (`AGENT_BROWSER=1`); the plain
   read, which has no cookies, never serves it.
4. A takeover and the live view open the bot's tab in its account, and the
   screen names it (`account` above, `watchAccount`, and `account` on a command
   or a frame).

On the device the shared browser keeps one Chrome and gives each listed account a
browser context of its own, made when a task first needs it and filled from that
account's jar. A tab belongs to one (account, bot) and has its own queue, so one
bot's tasks on two accounts run side by side and two bots on one account each
have a tab in its context. Before every step the device checks that the tab sits
in the account's current context, and it refuses the step if it does not. A bot
with no account uses the persistent profile, as before.

A jar is `browser-accounts/<id>.jar` next to the agent's config (or in the folder
named by `AGENT_BROWSER_ACCOUNTS`), folder mode 0700 and file mode 0600. It is
AES-256-GCM under a key derived with HKDF from the pairing secret, bound to its
account id. It is written after a task that used the account, when an idle tab is
closed, about every 10 minutes while the context is open, and when the browser
closes. A jar is never sent to the server, logged or put in a backup. A jar the
server's list omits is wiped, and so is one that this computer's secret does not
open.

The housekeeping `sweep` runs about once a minute (`agent/browser-host.mjs`):

- a bot's tab untouched for 10 minutes is closed after its account's cookies are
  saved;
- an account context with no tab and no keeper is saved and closed, and comes back
  from its jar;
- a **keeper** tab reads each signed-in account's site (`https://<site>/`, only
  when the allowlist names it) every 30 minutes. A sign-in page, or any page with
  a visible password field, marks the account `signed-out`; any other page of the
  site marks it `signed-in`. A task's own page says the same. The keeper's read is
  not use of the browser;
- with `AGENT_BROWSER_QUIT_IDLE=1`, Chrome is closed after 30 minutes in which no
  task ran and no one drove or watched a tab. Every jar is saved first, and the
  next task starts Chrome again with each account signed in from its jar. Without
  it the browser is never quit for being idle.

While the owner drives a bot's tab, only that bot waits. A running task of
that bot finishes the step it is in, runs no later step (the page is no longer
the one the steps were planned for), waits for the hand back and answers with
the page as the owner left it and `tookOver: true`. Other bots' tasks, and
`model.run` tasks, keep running. A takeover has no clock unless
`AGENT_TAKEOVER_IDLE_MS` is set.

The device runs up to `AGENT_CONCURRENCY` claimed tasks at once (default 3,
whole number 1 to 8). One bot's browser tasks run one at a time, at most one
`model.run` runs per CLI engine, and the keepalive counts every running task.
The pairing request and each heartbeat carry the device's `features`; the
server uses them to choose a device (`chooseDevice`) and marks one that lacks
a feature it relies on as needing an update, without refusing the rest of its
work.

## 4. Task leases & recovery
- `claimAgentTasks` leases a due task (`status='running'`, `lease_until`).
- A heartbeat arriving after the lease expired means the agent disconnected, so
  `recoverAgentTasks` re-arms the task to `queued` — work is **never lost**.
- `idempotencyKey` is unique per agent, so a double-clicked button or a retried
  poll cannot enqueue (or run) the same job twice.

## 5. Permissions
Task kinds are permission-gated: `http.check`, `browser.capture`, and
`browser.action` (the browser kinds limited to an explicit
`AGENT_BROWSER_ALLOWLIST`). `http.check` refuses hosts that are, or resolve
to, private or local addresses, and reports a redirect instead of following
it; `AGENT_ALLOW_PRIVATE=1` on the device lifts that on purpose.

`browser.capture` is a plain HTTP read by default. With `AGENT_BROWSER=1` on
the device, the agent opens the page in the Chrome, Chromium or Edge already
installed there (`AGENT_BROWSER_PATH` names one explicitly;
`AGENT_BROWSER_ARGS` adds flags such as `--no-sandbox` for containers) and
returns the title, the visible text and a numbered list of the controls on the
page (see the index steps below), so pages that need JavaScript can be read.
That browser is **one Chrome kept between tasks on one saved profile**
(`browser-profile/` next to the agent's config, mode 0700, or the directory in
`AGENT_BROWSER_PROFILE`), shared by every bot: a sign-in made in it is there for
all of them, except a bot that signs in as a browser account, which has a context
of its own (see "Browser accounts in the shared browser" above). Each bot has its
own tab (the task's `botId`; a task with none uses one shared tab), and one bot
drives at a time. See "The shared browser" above. A
page, a frame or a redirect outside the allowlist is blocked, and so is any
request the page makes to a private or local address.

`AGENT_BROWSER_ALLOWLIST` is read by the device and by the server the same way:
one host name per entry, compared on the host, so a trailing dot or a `:port`
on either side does not name a second site. A whole URL in the list names its
host. Write `*` instead of a list to allow **any public host**; that is a
statement about names only — the proxy below still refuses private and local
addresses, and X and Twitter still refuse click and type.

`browser.action` may click, type, wait, read or scroll on an allowlisted
page. Click and type on X are always refused. The agent never uploads or
posts.

A device belongs to the workspace whose admin created its pairing code. The
device does not need to know which: the server finds the workspace from the
code or the agent id. The **server**
decides an agent's permissions; a heartbeat body is never trusted to widen its
own scope (`setAgentPermissions` is admin-only). There is deliberately no
`publish.*` permission anywhere in the system.

## 6. Task kinds

`GET /api/agents` returns `actions`, the list an admin grants per agent.
`POST /api/agents/:id/tasks` queues one (member role; the kind's own permission
is required).

| kind | permission | what it does |
|---|---|---|
| `http.check` | `http.check` | GET a URL, report status and latency. Redirects are reported, not followed. |
| `browser.capture` | `browser.capture` | Read a page on an allowlisted host with the installed browser (or a plain fetch). |
| `browser.action` | `browser.action` | **Interact** with an allowlisted page: `steps` of `navigate` / `click` / `type` / `waitFor` / `read` / `scroll` (max 25). `scroll` only moves the page. |
| `model.run` | `model.run` | Run one prompt through the owner's signed-in `claude` or `codex` CLI. Payload `{engine, model?, instructions?, input, timeoutMs?}`. The prompt goes in on stdin, the CLI's own tools are off, and it is never retried. The result is `{ok: true, text, engine, model, ms}` or `{ok: false, code, message}` with `code` one of `not-signed-in`, `usage-limit`, `cli-missing`, `timeout`, `output-too-large`, `empty-reply`, `bad-request`, `cli-failed`. |
| `mcp.call` | `mcp.call` | List the tools of, or call one tool on, a stdio MCP server **named in this machine's agent config** (`mcpServers`). Payload `{server, op: "list"\|"call", tool?, args?, timeoutMs?}`; the payload carries only the server's name, never a command or an environment. The agent starts the program fresh, speaks JSON-RPC over its stdin and stdout, and kills it on timeout or after 2 MiB of output; its stderr is dropped. Never retried (a tool may already have changed something). The result is `{ok: true, tools}` for a list, `{ok, text}` for a call (`ok: false` means the tool reported an error), or `{ok: false, code, message}` with `code` one of `not-configured`, `bad-request`, `cannot-start`, `exited`, `timeout`, `output-too-large`, `mcp-error`. |

`browser.action` payload:

```json
{"url": "https://app.example.com/tickets",
 "steps": [{"op": "type", "selector": "#q", "text": "open"},
           {"op": "click", "selector": "#search"},
           {"op": "read", "selector": "#results"}]}
```

A step names an element either with a CSS `selector` (above) or with the
`index` the browser printed in its last result. Every capture returns the
controls a person would see as a numbered list — `[3] button Sign in` — so a
bot that has just read a page it has never seen can act on it by number:
`{"op": "click", "index": 3}`. Both spellings run under the same rules.

Boundaries — the same as a read, plus interaction:

- every host (the page **and** any step's `navigate`) must be in
  `AGENT_BROWSER_ALLOWLIST`, including after a redirect;
- the browser reaches the network only through the agent's proxy, which refuses
  private/local addresses, so a step cannot pivot to your LAN;
- the real browser runs on a **persistent profile shared by every bot**, so
  what the owner signed in to is available to all of them. That is the design
  (see "The shared browser"); the allowlist and the egress proxy still decide
  where it may go;
- interaction requires the real browser (`AGENT_BROWSER=1`); the fetch fallback
  is read-only;
- a task reaches the device only through a human decision. Either a person
  queues it, or a person gives a bot the `browser.use` permission (see below).

### Bots that use the browser (`browser.use`, opt-in)

A bot holding `browser.use` may ask for a page by putting a fenced `browser`
block in its reply: `{"url": "...", "steps": [...]}`, with the same step ops as
above. `shared/bot-browser.js` validates the block and then:

- strips it from the chat and shows a request card instead;
- dispatches nothing until a member presses **Approve**, unless that bot's
  *Browser requests* setting is "Run approved pages without asking";
- refuses any click or type on x.com or twitter.com, whatever the setting.
  Bots may read X; posting stays a human action;
- allows at most 2 requests per reply and 3 browser round trips per
  conversation turn;
- sends the request to the most recently seen paired agent that holds the
  permission the request needs (`browser.capture` or `browser.action`). The
  device allowlist, proxy and fresh profile above still apply.

`BROWSER_RUNTIME` decides who opens the page. `auto` (the default) uses **this
server's own** headless browser when `AGENT_BROWSER_ALLOWLIST` and a browser are
present there, and a paired agent otherwise; `server` or `agent` forces one.
The server path exists so a bot can read a page with no device paired and
nothing of the user's awake — the same allowlist and egress proxy apply to it,
and each page still gets a fresh, empty context, so a warm browser is never a
signed-in one. Whichever runtime runs it, the request is the same record and the
result is handled the same way.

### Taking the page over (a person signs in)

A page behind a sign-in — a 2FA prompt, a CAPTCHA, an account wall — is one a
headless browser cannot reach on its own, and a fresh empty context is exactly
what makes that true. The request card carries a **Take over** action
(`POST /api/browser-sessions`) that opens the same page in a context the server
**keeps** until the person is done, and lets them drive it:

- the server sends a JPEG of the page and a numbered list of its controls, and
  the person sends back one click, one type or a navigation at a time
  (`POST /api/browser-sessions/:id/act`, `GET /api/browser-sessions/:id`);
- the same `AGENT_BROWSER_ALLOWLIST`, the same egress proxy and the same
  click/type refusal on X and Twitter apply to every step and every navigation,
  so a takeover is a way to **sign in**, never a way around the rules;
- **Hand back to the bot** reads the page as the person left it and finishes the
  request with it, so the bot continues from the page now that the sign-in is
  done. Closing without handing back discards it and the request stays waiting;
- the kept context exists only for that takeover and is disposed when it ends,
  so nothing the next capture sees is signed in. A takeover has no clock unless
  `BROWSER_LIVE_MS` (no action) or `BROWSER_LIVE_MAX_MS` (outright) is set;
- while a person holds the page, the runtime refuses both a second takeover and
  a bot's own browser run, so one Chromium serves one page at a time.

When the browser reports back, the result is posted in the chat and the same bot
is asked to continue with it. A failure is posted as a message and is never
handed to the bot as a page.

### Bots that spawn a sub-agent (`subagent.spawn`, opt-in)

A bot holding `subagent.spawn` may hand one small job to a helper model by
putting a fenced `spawn` block in its reply: `{"name": "...", "task": "..."}`,
with the task capped at 2000 characters. `shared/subagents.js` validates the
block and then:

- strips it from the chat and shows a `started a sub-agent` line instead;
- runs the task as one separate model call. The helper holds no permissions,
  gets no tools, cannot reach a page, and has no memory of the conversation, so
  everything it needs must be in the task;
- never parses the helper's own reply for a block, so a helper cannot spawn a
  helper and the tree stays one level deep;
- allows one block per reply and one round per task;
- feeds the answer back to the bot that asked, marked as untrusted text, and
  asks for the real reply. A failed helper is reported in the chat and the bot
  answers without it.

A sub-agent is extra thinking, not extra authority: it can neither approve
anything nor post anything, and it never sees a server token or a bare key.
