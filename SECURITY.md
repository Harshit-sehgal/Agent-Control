# Security model

Agent Control is a single-operator, local-first control plane. This is the honest
description of what is and is not defended.

## Trust boundaries
- The Node server (`src/server.js`) is the only component with database access.
- The dashboard (browser) and the local agent (`agent/agent.mjs`) are clients.
- Model-provider output is **untrusted data**, never authority. It can never
  reach a publication or filesystem tool. It reaches a browser only when a user
  gives a bot `browser.use`. Each request then goes to a paired local agent,
  after approval unless the user turned approval off for that bot. Device-side
  allowlist, private-address proxy and an empty profile still apply. Click
  or type on X is always refused. Scroll only moves the page.

## Connected accounts
This product does not OAuth into X or any other platform.

- **X.** Posts enter through paste or the Chrome capture extension (`POST /api/capture`). That token cannot approve, edit, or mark posted. Drafts never publish; the person copies the text and clicks Post on X, then taps **I posted it**. A bot may read an X page only through opt-in `browser.use` on a paired local agent; click and type on X are refused, and the agent blocks write requests to X and Twitter hosts.
- **AI providers.** Optional bring-your-own key. Keys stay on the server. Provider output is untrusted data.
- **Web Push.** A browser subscription on a secure origin, not a social login.
- **Email.** Optional JSON POST to `EMAIL_RELAY_URL`, not an IMAP or SMTP mailbox login. A configured bearer token is sent only over HTTPS.

## Authentication & authorization
- Multi-user accounts with server-side, revocable sessions (`src/auth.js`).
- Roles: `viewer < member < admin < owner`. Every route is registered with the
  access it needs (`public`, `agent`, or a least role) in `src/router.js` and
  `src/routes-*.js`. `tests/authz-matrix.test.js` exercises the matrix
  (anonymous 401, wrong role 403, escalation blocked).
- CSRF: the session cookie is `HttpOnly` + `SameSite=Strict`, and `checkOrigin`
  rejects cross-origin writes (403).
- Sign-in and `POST /api/auth/forgot` are rate-limited (8 attempts / 15 minutes
  / IP). `POST /api/auth/reset` consumes a one-hour, single-use token. The
  server prints that token to the console unless `RESET_TOKEN_CONSOLE=0`.

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
- The local agent executes only permission-gated kinds: `http.check`,
  allowlisted `browser.capture`, and `browser.action` (click, type, read
  steps) granted per device and refused on X. With `AGENT_BROWSER=1` capture
  and action run in a real browser with an empty profile. Bots reach a
  browser only through opt-in `browser.use`. Nothing the agent does can post.
- TLS: for anything beyond loopback, terminate HTTPS at a reverse proxy
  (recommended) or set `TLS_CERT` and `TLS_KEY` together for in-process
  HTTPS. HSTS, startup validation and `docs/DEPLOYMENT.md` cover the rest.
- Model providers are third-party and optional; treat their output as untrusted.

## Reporting
Open an issue with reproduction steps. Do not include secrets or live tokens.
