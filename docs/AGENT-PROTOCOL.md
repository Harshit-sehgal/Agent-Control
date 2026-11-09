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
   `POST /api/agent/pair {code, name, permissions}` →
   `{agentId, secret, workspaceId, permissions, pollIntervalMs}`.
   The plaintext `secret` is returned once; the server keeps only an
   AES-256-GCM-encrypted copy and a SHA-256 hash.

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
- `POST /api/agent/tasks/:id/result` `{status, result, error}` → records a
  result. Completing an already-completed task is rejected (409); a `failed`
  result re-queues while attempts remain, then fails permanently.

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
returns the title and visible text, so pages that need JavaScript can be read.
That browser starts with an empty profile that is deleted afterwards, so it is
signed in to nothing, unless `AGENT_BROWSER_PROFILE` points at a directory to
keep. A page, a frame or a redirect outside the allowlist is
blocked, and so is any request the page makes to a private or local address.

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

`browser.action` payload:

```json
{"url": "https://app.example.com/tickets",
 "steps": [{"op": "type", "selector": "#q", "text": "open"},
           {"op": "click", "selector": "#search"},
           {"op": "read", "selector": "#results"}]}
```

Boundaries — the same as a read, plus interaction:

- every host (the page **and** any step's `navigate`) must be in
  `AGENT_BROWSER_ALLOWLIST`, including after a redirect;
- the browser reaches the network only through the agent's proxy, which refuses
  private/local addresses, so a step cannot pivot to your LAN;
- actions run in a **fresh, empty profile** that is deleted afterwards, so the
  agent is never signed in to anything; authenticated flows would need an
  explicit, opt-in persistent profile (`AGENT_BROWSER_PROFILE`) and are not on
  by default;
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
  *Browser requests* setting is "Run on my local agent without asking";
- refuses any click or type on x.com or twitter.com, whatever the setting.
  Bots may read X; posting stays a human action;
- allows at most 2 requests per reply and 3 browser round trips per
  conversation turn;
- sends the request to the most recently seen paired agent that holds the
  permission the request needs (`browser.capture` or `browser.action`). The
  device allowlist, proxy and fresh profile above still apply.

When the device reports back, the result is posted in the chat and the same bot
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
