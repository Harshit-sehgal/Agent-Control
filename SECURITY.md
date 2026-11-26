# Security model

Agent Control is a single-operator, local-first control plane. This is the honest
description of what is and is not defended.

## Trust boundaries
- The Node server (`src/server.js`) is the only component with database access.
- The dashboard (browser) and the local agent (`agent/agent.mjs`) are clients.
- Model-provider output is **untrusted data**, never authority. It can never
  reach a publication or filesystem tool. Every bot has basic access with no
  grant: it may open a web page and read a connected app (`BASIC_ACCESS` in
  `shared/asks.js`), unless the owner set that site or account to Ask each time
  or Deny, or switched **Browse and read without asking** off. A send, post,
  delete, payment or connector write asks the owner unless a grant says Always
  allow, and once a run has read private data (mail, files, a connector) a page
  on a site with no Always allow asks again. Pages run on a paired local agent
  (or this server's own browser), under the device-side allowlist and
  private-address proxy, in one shared browser profile the owner signs in to.
  A human check (CAPTCHA) is handed to the owner, never solved. A bot given
  `subagent.spawn` may spawn a helper model, which holds no permissions and no
  tools at all: it cannot reach a page, a post or the network.

## Connected accounts
This product does not OAuth into X or any other platform.

- **X.** There is no X integration and no X credential. A bot reads an X page like any other page, through the shared browser; X is an ordinary site for the bot browser: click and type are allowed, and a click on Post asks unless the owner set Always allow for posting on x.com.
- **AI providers.** Optional bring-your-own key. Keys stay on the server. Provider output is untrusted data.
- **Web Push.** A browser subscription on a secure origin, not a social login.
- **Email.** The notification channel can submit over SMTP directly (`SMTP_HOST`, with `STARTTLS` required by default) or POST JSON to an `EMAIL_RELAY_URL` gateway. Neither reads a mailbox: there is no IMAP and no inbound mail. Credentials and the relay token are only ever sent to a verified TLS peer.

## Authentication & authorization
- Multi-user accounts with server-side, revocable sessions (`src/auth.js`).
- Roles: `viewer < member < admin < owner`. Every route is registered with the
  access it needs (`public`, `agent`, or a least role) in `src/router.js` and
  `src/routes-*.js`. `tests/authz-matrix.test.js` exercises the matrix
  (anonymous 401, wrong role 403, escalation blocked).
- CSRF: the session cookie is `HttpOnly` + `SameSite=Strict`, and `checkOrigin`
  rejects cross-origin writes (403).
- Sign-in is rate-limited before the request body is read: 8 attempts / 15
  minutes per client address and per address+account, and 32 per account across
  addresses (`LOGIN_ACCOUNT_ATTEMPTS = LOGIN_ATTEMPTS * 4` in
  `src/routes-public.js`; the looser account bucket still cuts off guesses spread
  over many addresses). `POST /api/auth/forgot` allows 8 per account. Behind `TRUST_PROXY=1` the client address is the rightmost
  `X-Forwarded-For` hop, which is the one the proxy wrote. `POST
  /api/auth/reset` consumes a one-hour, single-use token. The
  server prints that token to the console unless `RESET_TOKEN_CONSOLE=0`.

## What each role is trusted with
Routes and their least role are in `src/routes-*.js` (registered through
`src/router.js`). In one workspace:

- **Viewer** reads: the workspace state, chats, runs, memory, activity, the
  connector and stored-credential lists (names, never values), and attachments.
  A viewer manages only their own account: password, sessions, push and
  notification settings.
- **Member** runs the bots. A member can send in any chat and start threads,
  runs and schedules (`POST /api/groups/:group/chat`, `/api/threads`,
  `/api/tasks`), continue, plan or stop a run, and attach files. Those runs use
  the workspace's connected apps and its signed-in shared browser as the bots'
  basic access allows, so a member can have a bot read the owner's connected
  mail or a site the owner is signed in to; anything that sends, posts, deletes,
  pays or writes still waits on an admin's answer unless an Always allow
  already covers it. A member can watch a bot's
  browser live (`GET /api/browser-live`), but not take it over. A member also
  creates, edits and deletes bots (job, settings, `permissions`, model choice)
  and edits memory and templates.
- **Admin** decides what leaves the app: answers asks (`POST /api/asks/:id`),
  sets Always allow / Ask each time / Deny rules (`POST /api/grants`, payments
  included: Ask each time or Deny for any site, Always allow for one bot on one
  site from the ask card), switches basic access and limits, pauses everything,
  takes over and drives the browser, and manages providers, connectors, paired
  devices, users, retention and stored credentials (a reveal is logged).
- **Owner** alone applies the Careful / Balanced / Hands-off presets and their
  undo (`POST /api/permissions/preset`, `/restore`), takes a backup and
  restores one (`GET /api/admin/backup`, `POST /api/admin/restore`), manages the agent's own MCP servers, and renames or deletes
  the workspace.

Because a member's run reads what the workspace is connected to, give member
access only to people you would let read the owner's connected accounts.

## Secrets
- `.env` is git-ignored and loaded at startup by `src/env.js`. Never commit or
  print secrets.
- Stored secrets (paired-agent secrets, credentials) are AES-256-GCM encrypted
  under a master key: `MASTER_KEY`, else a `0600` keyfile beside the database
  (`src/vault.js`). A corrupt keyfile is **never** silently overwritten — the
  server refuses to boot rather than rotate the key and brick the data.
- AI provider keys are read only on the server; the browser never sees them.

## Data at rest
- The store is SQLite (`src/sqlite-store.js`, `node:sqlite`) with a migration
  ledger. A database whose schema version is newer than the build knows is
  refused at boot, with both versions in the message, instead of being opened
  against columns this build cannot write correctly.
- `src/store.js`, the older JSON store, is gone. A `state.json` written by 0.6
  is imported once (and a corrupt one is moved aside, not crash-looped) and then
  left beside the database.

## The hard boundary: no automated publishing
- `shared/contracts.js` `ACTIONS` deliberately contains no publish/post action,
  so **no** bot contract can ever grant automated posting.
- Every model output is validated against the bot's declared output contract
  before a handoff (`assertContractOutput`), so a bot cannot smuggle an
  unexpected payload forward.
- A send, post, delete or payment click asks the owner unless they set Always
  allow for that bot on that site; a payment Always allow is confirmed first.
  `tests/prompt-injection.test.js` and `tests/owner-choices.test.js` lock this in.

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
  steps) granted per device. With `AGENT_BROWSER=1` capture and action run in
  one real Chrome with a saved profile (`browser-profile/`, mode 0700) that
  every bot shares, so a site the owner signed in to there is signed in for
  every bot. A click that sends, posts or pays runs only after the ask for it
  was answered (or an Always allow covers it).
  A spawned sub-agent is a model call, not a client: it never sees a token, a
  device or a request queue.
- TLS: for anything beyond loopback, terminate HTTPS at a reverse proxy
  (recommended) or set `TLS_CERT` and `TLS_KEY` together for in-process
  HTTPS. HSTS, startup validation and `docs/DEPLOYMENT.md` cover the rest.
- Model providers are third-party and optional; treat their output as untrusted.
- A saved provider, an HTTP MCP server and the sign-in addresses an MCP server
  names may be a public host or this machine, never another private,
  link-local or metadata address (`AGENT_ALLOW_PRIVATE=1` lifts that). Each
  call resolves the name once, checks every address and connects to the
  checked one (`guardedFetch` in `src/reach-guard.js`), so a name rebound after
  the check is not used. The environment's own `AI_BASE_URL` is the operator's
  and is not checked.

## Reporting
Open an issue with reproduction steps. Do not include secrets or live tokens.
