# Security model

Agent Control is a single-operator, local-first control plane. This is the honest
description of what is and is not defended.

## Trust boundaries
- The Node server (`src/server.js`) is the only component with database access.
- The dashboard (browser) and the local agent (`agent/agent.mjs`) are clients.
- Model-provider output is **untrusted data**, never authority. It can never
  reach a publication, browser or filesystem tool.

## Authentication & authorization
- Multi-user accounts with server-side, revocable sessions (`src/auth.js`).
- Roles: `viewer < member < admin < owner`. Every mutating route is gated twice:
  the `WRITE_ROUTES` table in `src/server.js` and a per-route `requireRole`.
  `tests/authz-matrix.test.js` exercises the matrix (anonymous 401, wrong role
  403, escalation blocked).
- CSRF: the session cookie is `HttpOnly` + `SameSite=Strict`, and `checkOrigin`
  rejects cross-origin writes (403).
- Login is rate-limited (8 attempts / 15 minutes / IP).

## Secrets
- `.env` is git-ignored and loaded at startup by `src/env.js`. Never commit or
  print secrets.
- Stored secrets (paired-agent secrets, credentials) are AES-256-GCM encrypted
  under a master key: `MASTER_KEY`, else a `0600` keyfile beside the database
  (`src/vault.js`). A corrupt keyfile is **never** silently overwritten — the
  server refuses to boot rather than rotate the key and brick the data.
- AI provider keys are read only on the server; the browser never sees them.

## The hard boundary: no automated publishing
- `shared/contracts.js` `ACTIONS` deliberately contains no publish/post action,
  so **no** bot contract can ever grant automated posting.
- Every model output is validated against the bot's declared output contract
  before a handoff (`assertContractOutput`), so a bot cannot smuggle an
  unexpected payload forward.
- The final Post click is always human. `tests/prompt-injection.test.js` locks
  this behaviour in.

## Local agent protocol
See [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md). Requests are HMAC-signed
over method, path, timestamp and body hash; a timestamp window plus a per-agent
replay cache reject replays; agents run only permission-gated task kinds.

## Known limitations
- Workspaces are separated by database file, and a session can only reach the
  workspace it is in. An owner of the first workspace administers the
  installation; this is not a boundary between mutually hostile tenants, who
  would still share one process, one vault key and one AI provider key.
- The local agent executes only `http.check` and an explicitly allowlisted
  `browser.capture`. With `AGENT_BROWSER=1` the capture runs in a real
  headless browser with an empty profile; it reads pages and cannot click,
  type or post.
- No built-in TLS termination — run it behind a reverse proxy. HSTS, startup
  validation and `docs/DEPLOYMENT.md` are tracked in `docs/BUILD-PLAN.md`.
- Model providers are third-party and optional; treat their output as untrusted.

## Reporting
Open an issue with reproduction steps. Do not include secrets or live tokens.
