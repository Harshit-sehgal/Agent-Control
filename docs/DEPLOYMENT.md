# Deployment

Agent Control is a local-first app. It ships **no TLS termination and no
authentication proxy** of its own; for anything beyond `127.0.0.1` you put it
behind a reverse proxy that terminates HTTPS. This guide covers that setup and
the operational knobs.

## Requirements
- **Node.js 22+** (`.nvmrc`). The SQLite store uses `node:sqlite`, which the
  server re-execs itself with `--experimental-sqlite` to load on Node 22.
- No npm runtime dependencies.
- A writable directory for the data file and the vault keyfile.

## Configuration (environment or `.env`)
`.env` is loaded at startup by `src/env.js`; real environment variables win.

| var | purpose |
|---|---|
| `DASHBOARD_PASSWORD` | bootstraps the owner on first run; **set a long one** |
| `HOST` / `PORT` | bind address (default `127.0.0.1:4173`) |
| `DATA_FILE` | path to the SQLite database (default under the repo) |
| `STORE_BACKEND` | `json` forces the legacy JSON store (escape hatch/tests) |
| `PUBLIC_ORIGIN` | absolute `https://…` URL; enables the origin/CSRF check for that host |
| `HSTS` | `1` to send `Strict-Transport-Security` (only behind TLS) |
| `WEBHOOK_ALLOW_PRIVATE` | `1` to let webhook notifications reach private or local addresses |
| `MASTER_KEY` | 32-byte key (64 hex chars) for the credential vault; else a `0600` keyfile is generated beside the DB |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_API_STYLE` / `AI_TIMEOUT_MS` / `AI_MAX_CONCURRENCY` | optional OpenAI-compatible provider |

`preflight()` refuses to boot on an invalid `PUBLIC_ORIGIN` and warns when HSTS
is on without HTTPS, when no `DASHBOARD_PASSWORD` is set, or when the server is
bound off-loopback without HTTPS.

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

## Secrets & the vault
- Without `MASTER_KEY`, a `vault.key` (mode `0600`) is created beside the
  database. **Back it up with the database** — losing it makes every encrypted
  credential unreadable. The server refuses to overwrite a corrupt keyfile.
- For managed hosts, set `MASTER_KEY` to a 32-byte secret from your secret
  manager instead of shipping the keyfile.

## Backups & retention
- `scripts/backup.mjs` exports an encrypted backup; `POST /api/admin/restore`
  imports one (admin only, with a validation step). Back up the vault key
  alongside the export.
- Retention is configurable and prunes only exhaust (events, finished tasks,
  sent notifications, runs) — never drafts, candidates or evidence.
  `GET /api/retention/preview` shows what a prune would remove before you run it.

## Run under systemd
```ini
[Service]
WorkingDirectory=/srv/agent-control
EnvironmentFile=/srv/agent-control/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
User=agent-control
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/agent-control/data
```

## Health & smoke
`GET /api/health` returns `{ok:true,version}` and supports `HEAD`. It is
unauthenticated, so it is safe for uptime probes.

## Security checklist
- [ ] `DASHBOARD_PASSWORD` set to a long random value.
- [ ] TLS terminated at a proxy; `PUBLIC_ORIGIN=https://…` set.
- [ ] `HSTS=1` only after HTTPS works.
- [ ] `MASTER_KEY` set (managed) or `vault.key` backed up.
- [ ] Backups scheduled and one restore rehearsed.
- [ ] Server bound to loopback (`HOST=127.0.0.1`) behind the proxy.
- [ ] See [`../SECURITY.md`](../SECURITY.md) for the threat model.
