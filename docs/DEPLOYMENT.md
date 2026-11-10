# Deployment

Agent Control is a local-first app. For anything beyond `127.0.0.1` you
terminate HTTPS — usually at a reverse proxy. Optional in-process TLS is
`TLS_CERT` plus `TLS_KEY`. This guide covers that setup and the operational
knobs.

## Requirements
- **Node.js 22.5 or newer** (`.nvmrc`). The SQLite store uses `node:sqlite`,
  which needs `--experimental-sqlite` before Node 23.4. Every `npm` script
  (`start`, `dev`, `test`, `test:coverage`, `backup`) and the Dockerfile `CMD`
  pass the flag; a bare `node src/server.js` has to pass it too.
- No npm runtime dependencies.
- A writable directory for the data file and the vault keyfile.

## Configuration (environment or `.env`)
`.env` is loaded at startup by `src/env.js`; real environment variables win.

| var | purpose |
|---|---|
| `DASHBOARD_PASSWORD` | bootstraps the owner on first run; **set a long one** |
| `HOST` / `PORT` | bind address (default `127.0.0.1:4173`) |
| `DATA_FILE` | JSON sibling path (default `data/state.json`), used to find the database and to import a 0.6 `state.json` once; the SQLite file is the same name with `.db`, or `DATA_DB` |
| `PUBLIC_ORIGIN` | absolute `https://…` URL; enables the origin/CSRF check for that host |
| `HSTS` | `1` to send `Strict-Transport-Security` (only behind TLS) |
| `TLS_CERT` / `TLS_KEY` | optional paths to a certificate and key; both must be set to serve HTTPS in-process |
| `TRUST_PROXY` | `1` when a reverse proxy sets `X-Forwarded-For` / `X-Forwarded-Proto`. The rate limiter then keys on the rightmost `X-Forwarded-For` hop and the Secure-cookie hint follows `X-Forwarded-Proto` |
| `RESET_TOKEN_CONSOLE` | `0` on a hosted install so password-reset tokens are not printed to the process log |
| `SMTP_HOST` | the mail server for the email channel. Set, and the app submits over SMTP itself; unset, the channel needs a relay (below) |
| `SMTP_PORT` | submission port: `587` by default, `465` with `SMTP_SECURE=1` |
| `SMTP_SECURE` | `1` for TLS from the first byte (port 465). Otherwise the connection starts plaintext and must upgrade with `STARTTLS` |
| `SMTP_USER` / `SMTP_PASS` | credentials for `AUTH` (`PLAIN`, or `LOGIN` when that is all the server offers). Omitted, no `AUTH` is attempted |
| `SMTP_FROM` | sender, `agent@example.com` or `"Agent Control <agent@example.com>"`; defaults to `SMTP_USER` |
| `SMTP_REQUIRE_TLS` | `1` by default: a server without `STARTTLS` fails the send instead of continuing in cleartext. `0` is for a relay on your own network only |
| `SMTP_TIMEOUT_MS` | whole-session idle budget, default 20000 |
| `WEBHOOK_ALLOW_PRIVATE` | `1` to let webhook and email-relay notifications reach private or local addresses |
| `EMAIL_RELAY_URL` | optional HTTPS gateway, used only when `SMTP_HOST` is unset. The email channel POSTs `{to, title, body, meta, at}` there. Unset too, delivery fails instead of claiming the message was sent |
| `EMAIL_RELAY_TOKEN` | optional bearer token for `EMAIL_RELAY_URL`; the relay must use HTTPS when set |
| `VAPID_SUBJECT` | contact for push services, `mailto:you@example.com` or an https URL; defaults to `PUBLIC_ORIGIN`. Apple rejects pushes without a real one |
| `MASTER_KEY` | 32-byte key (64 hex chars) for the credential vault; else a `0600` keyfile is generated beside the DB |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | optional provider from the environment: the endpoint, the key (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` are the older names) and the model id, or `auto` for a router that chooses |
| `AI_API_STYLE` | the wire protocol: `chat` (`/chat/completions`), `responses` (OpenAI's `/responses`), `anthropic` (Claude's `/messages`), `gemini` (Google's `generateContent`), `azure` (an Azure deployment). Aliases `messages`/`claude` mean anthropic, `google` means gemini, `openai`/`compatible` mean chat; blank infers it from the host (`api.anthropic.com` → anthropic, `generativelanguage.googleapis.com` → gemini, `*.openai.azure.com` → azure, `api.openai.com` → responses, anything else → chat). `AI_API_PROTOCOL` is read as the same value |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` | alternative key and endpoint for `AI_API_KEY` / `AI_BASE_URL`. With no base URL, either key alone picks `https://api.anthropic.com/v1` |
| `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` | same, for Gemini: alone and without a base URL they pick `https://generativelanguage.googleapis.com/v1beta` (`GOOGLE_API_KEY` is the older name) |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI: the key, the resource endpoint (`https://NAME.openai.azure.com`, needed — a bare Azure key picks no endpoint) and the API version (default `2024-10-21`). `AZURE_OPENAI_ENDPOINT` also serves as the base URL, and its host selects the `azure` protocol |
| `AI_TIMEOUT_MS` / `AI_MAX_CONCURRENCY` | request budget in milliseconds (default 180000) and the cap on model calls in flight (default 4) |

AI providers do not need a restart and do not need these variables. **You →
AI and models** saves a provider at run time — a preset or a typed endpoint, a
key, one of the five protocols above (`openai-chat`, `openai-responses`,
`anthropic`, `gemini`, `azure-openai`), optional custom headers
(one `Name: value` per line) and, for Azure, an API version — and the key and
the header values go into the credential vault, encrypted with `MASTER_KEY`. A
saved provider wins over the environment for any bot or workspace default that
points at it. Saving reads that provider's model catalogue with the key just
given (both the chat-capable ids and the full list), **Refresh models** re-reads
it, and **Test** makes one small call and reports the model and the latency.

Local-agent knobs (`AGENT_BROWSER`, allowlist, profile, path) are read by
`node agent/agent.mjs`, not this process. They are listed in `.env.example`
and [`AGENT-PROTOCOL.md`](AGENT-PROTOCOL.md).

### The browser a bot may use

An approved `browser.use` request runs in a headless browser. `BROWSER_RUNTIME`
picks whose:

| Variable | Meaning |
| --- | --- |
| `BROWSER_RUNTIME` | `auto` (default), `server` or `agent`. `auto` uses this server when it has an allowlist and a browser, and a paired local agent otherwise |
| `AGENT_BROWSER_ALLOWLIST` | the hosts a bot may open, read by both runtimes; `*` means any public host (the egress proxy still refuses private and local addresses) |
| `AGENT_BROWSER_PATH` | the browser binary; else the first Chrome, Chromium or Edge found on `PATH` |
| `BROWSER_TIMEOUT_MS` / `BROWSER_IDLE_MS` | the per-request budget (25s) and how long an idle browser is kept (120s) |
| `BROWSER_NO_SANDBOX` | `1` in a container, where Chrome's own sandbox cannot start. The allowlist, the egress proxy and the fresh context per page still apply |

The server browser is one child process: started with the first request, closed
after `BROWSER_IDLE_MS` without work, and closed again when the server drains.
Each page gets a new, empty context, so a warm browser is never signed in to
anything. It reaches the network only through a proxy in this process that
refuses private and local addresses.

The image in `Dockerfile` does not ship Chrome by default. Both compose files
build with `INSTALL_BROWSER=1`, which installs Chromium and sets
`BROWSER_NO_SANDBOX=1` (a container has no user namespaces for Chrome's own
sandbox); the allowlist, the egress proxy and the fresh context per page still
apply. Building without that argument keeps the image small, and requests then
fall back to a paired local agent — with neither, the chat says which one is
missing.

`preflight()` refuses to boot on an invalid `PUBLIC_ORIGIN` and warns when HSTS
is on without HTTPS, when no `DASHBOARD_PASSWORD` is set, or when the server is
bound off-loopback without HTTPS. The store refuses to open a database written
by a newer build: the message names the database's schema version and the one
this build understands, so an accidental downgrade stops instead of running
against columns it does not know.

## TLS via a reverse proxy
Terminate TLS at the proxy and forward to the loopback server. **Caddy** is the
shortest path:

```
dash.example.com {
  reverse_proxy 127.0.0.1:4173
}
```

**nginx** equivalent:

```nginx
location / {
  proxy_pass http://127.0.0.1:4173;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

Set `PUBLIC_ORIGIN=https://dash.example.com` so same-origin writes pass the CSRF
check, and `HSTS=1` once HTTPS is confirmed working. HSTS is a one-way door —
browsers will refuse plain HTTP for `max-age`, so enable it last.

With `TRUST_PROXY=1`, sign-in is limited to 8 attempts / 15 minutes per client
address and per address+account, and 32 per account across addresses (so a proxy
that rotates addresses does not multiply the guesses available against one
mailbox). The client address is the **rightmost** `X-Forwarded-For` hop, which is the one your proxy wrote, not the leftmost one a
caller can invent. A proxy that appends rather than replaces is fine for the same
reason; one that passes the header through untouched is not.

## Secrets & the vault
- Without `MASTER_KEY`, a `vault.key` (mode `0600`) is created beside the
  database. **Back it up with the database** — losing it makes every encrypted
  credential unreadable. The server refuses to overwrite a corrupt keyfile.
- For managed hosts, set `MASTER_KEY` to a 32-byte secret from your secret
  manager instead of shipping the keyfile.

## Backups & retention
- `scripts/backup.mjs` exports a checksum-protected JSON backup (credentials
  and sessions excluded; the file is not encrypted). Paired-agent credentials
  are not restored: agent records are revoked and queued or running agent tasks
  are failed, so pair devices again after a restore. `POST /api/admin/restore`
  imports one (owner only, with a validation step). Back up the vault key
  alongside the export. Protect the JSON file like the database.
- Retention has three knobs (`events` 90 days, `doneTasks` 30, `runs` 30) and
  prunes only exhaust: events, finished tasks, runs and settled group runs —
  never drafts, candidates, evidence, memory or notifications. The notification
  feed is capped separately at 200 in-app entries, oldest dropped first.
  `GET /api/retention/preview` shows what a prune would remove before you run it.

## Keeping it on
The scheduler, the task queue and push only run while the server does. Two
ready-made ways to keep it up on a machine that stays on (a small VPS, a home
server, a Raspberry Pi):

**Docker with HTTPS.** `deploy/compose.yaml` runs the app and Caddy, which gets
and renews the certificate by itself. Point your domain's DNS at the host, open
ports 80 and 443, then:

```sh
cd deploy
cp ../.env.example .env     # then set DASHBOARD_PASSWORD and DOMAIN (the example ships dash.example.com)
docker compose up -d --build
```

The databases and the vault key are kept in the `data` volume. An install that
predates the volume and bind-mounted `./data` keeps its database: copy it in once
with `docker compose cp ../data/. app:/data/` before the first start, or the app
opens on an empty database while the old one sits untouched on the host. The image runs
as a non-root user and reports its health from `/api/health`.

**Your own machine, over Tailscale.** No domain and no open ports: Tailscale
gives the machine an HTTPS name that only your own devices can reach.

```sh
TS_HOST=<machine>.<tailnet>.ts.net docker compose -p agent-control -f deploy/compose.tailscale.yaml up -d --build
sudo tailscale serve --bg 4173
```

It reads the repository's `.env`, keeps data in the repository's `data/`
folder, and can call an AI gateway on the same machine. It is on only while
that machine is.

**systemd, without Docker.** Copy the repository to `/srv/agent-control`, write
its `.env`, install `deploy/agent-control.service` and put a reverse proxy in
front as described above. The unit's `ExecStart` must pass
`--experimental-sqlite` on Node 22 (`/usr/bin/node --experimental-sqlite
src/server.js`), the way `npm start` does. The unit restarts the server on
failure and can write only to the data directory.

Nothing in this repository creates the host or the DNS record for you.

## Workspaces
Every workspace after the first has its own database file beside the main one
(`state.ws-<id>.db`). A file-level backup is the whole data directory: every
`*.db` file plus `vault.key`. The in-app backup under **Data and security**
covers the workspace you are in, so each workspace owner exports their own.
Deleting a workspace deletes its file.

## Push notifications
Browsers only allow push on a secure origin, so it works over HTTPS or on
`localhost`, not over plain HTTP on a LAN address. Each person turns it on per
device under **You → Notifications**. On an iPhone or iPad the app has to be
added to the Home Screen first. The key pair that identifies this installation
to push services is created on first use and stored encrypted with the vault
key; if the vault key changes, devices have to subscribe again.

The service worker caches the app shell while it installs, so an installed app
opens from the cache when the server or the network is down; `/api/*` is never
cached. Tapping a notification opens the app on the screen that message is
about.

## Health & smoke
`GET /api/health` returns `{ok:true,version}` and supports `HEAD`. It is
unauthenticated, so it is safe for uptime probes.

## Security checklist
- [ ] `DASHBOARD_PASSWORD` set to a long random value.
- [ ] TLS terminated at a proxy (or `TLS_CERT`/`TLS_KEY` set together); `PUBLIC_ORIGIN=https://…` set.
- [ ] `HSTS=1` only after HTTPS works.
- [ ] `TRUST_PROXY=1` only when a trusted proxy sets the forwarded headers.
- [ ] `RESET_TOKEN_CONSOLE=0` if the process log is not private.
- [ ] `MASTER_KEY` set (managed) or `vault.key` backed up.
- [ ] Backups scheduled and one restore rehearsed.
- [ ] Server bound to loopback (`HOST=127.0.0.1`) behind the proxy.
- [ ] See [`../SECURITY.md`](../SECURITY.md) for the threat model.
