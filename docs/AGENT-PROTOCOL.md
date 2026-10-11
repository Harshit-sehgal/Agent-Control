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
(the latter limited to an explicit `AGENT_BROWSER_ALLOWLIST`). The **server**
decides an agent's permissions; a heartbeat body is never trusted to widen its
own scope (`setAgentPermissions` is admin-only). There is deliberately no
`publish.*` permission anywhere in the system.
