# Operations

Runbook for keeping Agent Control running and proving it works. Pairs with
[`DEPLOYMENT.md`](DEPLOYMENT.md) (setup) and [`../SECURITY.md`](../SECURITY.md).

## Run it as a service (survives reboot)

The app has no runtime dependencies, so run it directly under systemd rather
than through Docker if you prefer:

```bash
sudo cp deploy/agent-control.service /etc/systemd/system/agent-control.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-control
systemctl status agent-control
```

The unit (`deploy/agent-control.service`) reads `.env`, binds `127.0.0.1:4173`,
and restarts on failure. (Docker is equivalent: `compose.tailscale.yaml` already
sets `restart: unless-stopped`.)

## A stable public URL (named Cloudflare Tunnel)

A Quick Tunnel is ephemeral and random. For a permanent URL on your domain, use
a named tunnel and run it as a service:

```bash
cloudflared tunnel login                       # one browser sign-in
cloudflared tunnel create agent-control        # note the UUID + credentials file
sudo cp deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo sed -i "s/TUNNEL_UUID/<uuid>/;s/app.example.com/<your hostname>/" /etc/cloudflared/config.yml
cloudflared tunnel route dns agent-control <your hostname>
sudo cp deploy/cloudflared.service /etc/systemd/system/
sudo systemctl enable --now cloudflared        # stable https://<hostname>
```

The ingress in `deploy/cloudflared-config.yml` points `<hostname>` at
`http://127.0.0.1:4173`. Set `PUBLIC_ORIGIN=https://<hostname>` in `.env` so the
CSRF check matches, and add a **Cloudflare Access** policy on the hostname to
restrict it to your email.

## Monitoring

`GET /api/health` returns `{ok:true, version}` (unauthenticated, supports HEAD).
Probe it from a timer and alert on failure:

```bash
# /etc/systemd/system/agent-control-health.service + .timer, or a cron line:
*/2 * * * * curl -fsS http://127.0.0.1:4173/api/health >/dev/null || logger -t agent-control "health check FAILED"
```

Watch the process log for `config:` warnings (startup validation) and
`Group execution:` errors from failed runs.

## Backup & restore — proven drill

Backups are a single JSON document (workflow + relational surfaces; **credential
ciphertext and sessions are deliberately excluded**). Run a drill before you
need one:

```bash
# 1. Export from the running app (owner session).
curl -fsS -b cookie.txt http://127.0.0.1:4173/api/admin/backup > backup.json

# 2. Restore into a throwaway instance on another port and compare.
PORT=4174 DATA_FILE=/tmp/drill.json DASHBOARD_PASSWORD=x node src/server.js &
#   POST the document itself (plus force:true) as the JSON body:
curl -fsS -X POST http://127.0.0.1:4174/api/admin/restore \
  -H 'Content-Type: application/json' -b cookie2.txt -d "$(cat backup.json | jq -c '. + {force:true}')"
```

A restore replaces the `users` table, so **everyone signs in again**; the
credentials vault is re-entered by hand.

**Last drill (automated, 2026-10-13):** seeded 3 candidates + 1 draft + a
credential + a provider → export (21 tables, checksummed) → restore into a
fresh instance → **3 candidates + 1 draft restored**, credentials/providers
`0/0` (excluded by design), and a **tampered document refused** (checksum).
Covered by `tests/persistence-api.test.js` (checksum tampering, force-restore).

## Sustained load

A quick concurrency check against a running instance:

A small Node script is the reliable way to drive this (shell `xargs`+`curl`
mishandles the HttpOnly cookie). Log in once, then fire concurrent reads and
writes with `fetch`:

```js
const r = await fetch(base + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password})});
const cookie = r.headers.get('set-cookie').split(';')[0];
for (let i = 0; i < 12; i++)                       // 12 x 25 = 300 reads
  await Promise.all(Array.from({length:25}, () => fetch(base + '/api/state', {headers:{Cookie:cookie}})));
```

**Observed (2026-10-13):** 300 read requests across `/api/state`, `/api/ai`,
`/api/notifications` → **300× `200`** (≈0.2–0.7s), then 60 reminder writes →
**60× `201`**, **no 5xx**, container RSS ~60 MiB. The store serializes through one
SQLite connection per workspace; model calls are bounded by `AI_MAX_CONCURRENCY`
(default 4) and refused with `429` above it rather than queued without bound.

## Known limits

- One Node process per install; SQLite is single-writer. Scale vertically, not
  by running many copies against the same database file.
- Push delivery, restore drills and long-running workloads are operational and
  must be validated on your own host (see above) — the code and tests prove the
  mechanics, not your environment.
