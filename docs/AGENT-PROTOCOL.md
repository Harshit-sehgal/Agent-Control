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
Task kinds are permission-gated: `http.check` and `browser.capture`
(the latter limited to an explicit `AGENT_BROWSER_ALLOWLIST`). `http.check`
refuses hosts that are, or resolve to, private or local addresses, and reports
a redirect instead of following it; `AGENT_ALLOW_PRIVATE=1` on the device
lifts that on purpose.

`browser.capture` is a plain HTTP read by default. With `AGENT_BROWSER=1` on
the device, the agent opens the page in the Chrome, Chromium or Edge already
installed there (`AGENT_BROWSER_PATH` names one explicitly;
`AGENT_BROWSER_ARGS` adds flags such as `--no-sandbox` for containers) and
returns the title and visible text, so pages that need JavaScript can be read.
That browser starts with an empty profile that is deleted afterwards, so it is
signed in to nothing. A page, a frame or a redirect outside the allowlist is
blocked, and so is any request the page makes to a private or local address.
The agent never clicks, types, uploads or posts.

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
| `browser.action` | `browser.action` | **Interact** with an allowlisted page: `steps` of `navigate` / `click` / `type` / `waitFor` / `read` (max 25). |

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
- a human dispatches the task. The model never triggers it — that is the same
  hard boundary as publishing.
