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

## Email, without a gateway

The email notification channel submits over SMTP when `SMTP_HOST` is set
(`src/mail.js`; the settings are listed in
[`DEPLOYMENT.md`](DEPLOYMENT.md)). `STARTTLS` is required by default, so a
server that does not offer it fails the send rather than accepting a password
in cleartext. Check a mailbox without waiting for a notification:

```bash
cd /path/to/agent_control
SMTP_HOST=smtp.example.com SMTP_USER=agent@example.com SMTP_PASS=… \
SMTP_FROM='Agent Control <agent@example.com>' node --input-type=module -e '
  import {smtpConfig, sendMail} from "./src/mail.js";
  console.log(await sendMail({to: "you@example.com", subject: "SMTP check", text: "It works."}, smtpConfig()));
'
```

`{sent:true}` means the server accepted the message. A throw carries the
server's reply code (`SMTP RCPT TO failed: 550 …`), which is the same text the
queue logs and retries on. The recipient address in the notification feed is
redacted from that message. `EMAIL_RELAY_URL` still works for an HTTPS gateway
and is ignored when `SMTP_HOST` is set.

## Backup & restore — proven drill

Backups are a single JSON document (workflow + relational surfaces; **credential
ciphertext and sessions are deliberately excluded**). Run a drill before you
need one:

```bash
# 1. Export from the running app (owner session).
curl -fsS -b cookie.txt http://127.0.0.1:4173/api/admin/backup > backup.json

# 2. Restore into a throwaway instance on another port and compare.
PORT=4174 DATA_FILE=/tmp/drill.json DASHBOARD_PASSWORD=x node --experimental-sqlite src/server.js &
#   POST the document itself (plus force:true) as the JSON body:
curl -fsS -X POST http://127.0.0.1:4174/api/admin/restore \
  -H 'Content-Type: application/json' -b cookie2.txt -d "$(cat backup.json | jq -c '. + {force:true}')"
```

A restore replaces the `users` table, so **everyone signs in again**; the
credentials vault is re-entered by hand.

**What a backup carries.** Besides the tables, a backup holds the files attached
to messages (`tables.attachments`, base64) and the owner's settings kept in kv
(`tables.owner_settings`: saved templates, token usage, limits, **Browse and read
without asking** and Hands-off). Files go newest first up to 16 MB in all, so the
document stays under the restore route's 32 MB body limit; any file past that is
listed in the backup's `attachmentsLeftOut` and named in the restore result and
the activity log, and shows as missing in its chat. A restore checks every file
as an upload is checked (a generated id, at most 10 MB, a type read from the
bytes that matches what the row says) and every setting through the same rules
its Settings route uses; a backup that fails either is refused before anything
is written. Grants keep their end time, and one that has ended is dropped. A
backup written before files and settings travelled still restores and leaves
the live files and settings as they were. Still **not** carried: credentials,
sessions, pairing codes, model providers (they point at vault credentials),
connectors, held sends, pending page requests and the runaway guard.

**Last drill (automated, 2026-10-13):** seeded records + a credential + a
provider → export (checksummed) → restore into a fresh instance → **the
records restored**, credentials/providers `0/0` (excluded by design), and a
**tampered document refused** (checksum).
Covered by `tests/persistence-api.test.js` (checksum tampering, force-restore). Backups made before the X-engage removal (schema v10 and earlier) still restore.

**Provider keys after a restore.** A backup excludes the credential vault and
the `kv` document that holds AI providers, so a restored instance has none: add
each provider and key again under **Settings → Models and keys**. To rotate a key
without a restore, edit the same provider there and paste the new value — a
blank key field keeps the stored one, and a new key, endpoint, header set or
API version re-reads that provider's model catalogue. A wrong or expired key is
not silent: the provider's own error is shown next to that provider, and
**Test** makes one small call to say whether the key works before a bot uses it.

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
`/api/notifications` → **300× `200`** (≈0.2–0.7s), then 60 writes →
**60× `201`**, **no 5xx**, container RSS ~60 MiB. The store serializes through one
SQLite connection per workspace; model calls are bounded by `AI_MAX_CONCURRENCY`
(default 4) and refused with `429` above it rather than queued without bound.

## Contabo: tunnel, Access, encrypted backups (2026-11-20)

The live install runs in Docker on the Contabo server from `/srv/agent-control/deploy`, with
`compose.cloudflare.yaml`. Nothing is published on the host. The tunnel `agent-control` (Cloudflare
Zero Trust) routes `https://agent-control.harshitsehgal.online` to the app's loopback, and a
Cloudflare Access application (`agent-control`, policy "Owner only") lets in only the owner's
email. An anonymous request gets a 302 to the Access login, and `/api/health` behind it does too.

**Why the hostname is `agent-control`, not `agent`.** `agent.harshitsehgal.online` already points at
another tunnel (`dsh`). Do not overwrite a DNS record that serves another service.

**Timezone.** `TZ` defaults to `Asia/Kolkata` in `compose.cloudflare.yaml`. Quiet hours are read in
the server's local zone, so keep `TZ` set to the owner's zone. A weekdays or weekends schedule made in
the app carries the browser's zone and keeps the owner's days whatever `TZ` is; one made before that
change, or without a zone, uses the server's.

**Quiet hours.** Set `QUIET_HOURS=22:00-07:00` in `deploy/.env` to hold non-urgent phone pushes
overnight. Approval requests (`ask` notifications) are always pushed. A held message stays in the app;
it is not sent to the phone later.

**Kill switch.** Schedules on a bot's page have a "Pause every schedule" button. It sets
`schedulesPaused`, pauses every waiting schedule, and makes new schedules start paused. A run already
in progress finishes. Turning it off resumes only the schedules the switch paused.
API: `POST /api/automation/pause-all` and `POST /api/automation/resume-all`.

**Encrypted backups.** `deploy/backup-encrypted.sh` runs on the server at 03:30 UTC (cron; 09:00 in Kolkata). It copies the
database with sqlite's `.backup`, packs it with `vault.key` and `local-agent.json`, and encrypts it to
a public certificate. The server holds only `/var/backups/agent-control/backup-cert.pem`; the private key
is kept on the owner's machine (`~/.config/agent-control/backup-key.pem`, mode 600).
The server keeps 14 copies. Backups live outside `/srv/agent-control` so a sync with `--delete`
cannot remove them.

- Copy the private key somewhere safe off the laptop (a password manager). Without it no backup can
  be opened. Losing it means losing the backups.
- `~/.local/bin/agent-control-pull-backup.sh` copies the newest encrypted backup to
  `~/Backups/agent-control` at 03:45 laptop time. It runs only while the laptop is awake.
- Restore check, on the owner's machine:

  ```bash
  deploy/restore-encrypted.sh ~/Backups/agent-control/<file>.tgz.enc ~/.config/agent-control/backup-key.pem /tmp/restore-check
  ```

  It decrypts, unpacks, and runs `PRAGMA integrity_check`. Delete the restored folder afterwards: it
  holds the vault key in plain form.

**Phone approvals.** Approval requests reach the phone as web push. Install the app on the phone and
allow notifications once.

## Known limits

- One Node process per install; SQLite is single-writer. Scale vertically, not
  by running many copies against the same database file.
- Push delivery, restore drills and long-running workloads are operational and
  must be validated on your own host (see above) — the code and tests prove the
  mechanics, not your environment.

## Event triggers and memory switches (2026-11-21)

- **Make a trigger.** `POST /api/triggers` with `name`, `botId`, `groupId`, `instruction`, and optionally
  `cooldownMinutes` (0 to 1440) and `match: {path, op: "equals" | "contains", value}`. The response holds the
  secret once and the event path, `/api/events/<workspace>/<trigger>`. Save the secret in the sender now.
- **The sender** posts the raw JSON body with `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body, keyed by the secret>`.
  GitHub's webhook setup does this when given the same secret. Set GitHub's content type to `application/json`;
  the form-encoded option is refused (400), because the signed bytes must be JSON. A GitHub `ping` (sent when the
  webhook is made) is signed and answered `ignored`, so it starts nothing.
- **Answers.** `queued` (a run started), `duplicate` (same body within 24 hours), `cooldown`,
  `ignored` (the condition did not match), `held` (kill switch on). Any refusal (bad signature, unknown or disabled trigger, unknown workspace) is the same 401. After 20 refused events in a minute from one address to one trigger, that address gets 429 for the rest of the minute; correctly signed events are never counted.
- **Cloudflare Access.** Senders cannot log in, so the event path needs a bypass rule for
  `agent-control.harshitsehgal.online/api/events/*`. That is your decision; the app does not
  change Access. Without it, the sender gets the Access login page.
- **Rotate or switch off.** `POST /api/triggers/:id/rotate` (old secret stops at once),
  `PATCH /api/triggers/:id` with `{enabled}`, `DELETE /api/triggers/:id`.
- **Run safety.** A triggered run gets the event body fenced as outside data. Its sends and posts ask for
  an answer even when Hands-off is on (a public issue or PR body is written by anyone). Payments and deletes ask as before.
  The same holds for any run that has read outside content (a connector result or an opened page), not only event runs.
- **Rules on and off.** `PATCH /api/memory/rules/:id` with `{bot, enabled: false}` keeps a rule and stops it
  reaching the bot. A tidy-up pass keeps it off. A "next time ..." sentence from the owner is saved as a rule.

## Hardening pass (2026-11-21)

- **Secrets file.** `.env` should be owner-only (`chmod 600 .env`). The server warns at boot if it is not.
- **Vault key.** Without `MASTER_KEY` the key is `vault.key` beside the database. Set `MASTER_KEY` from a secret store to keep the key apart from the data.
- **Database files.** The database, its WAL and its shared-memory file are owner-only. The process also sets `umask 077`, so backups and the vault key it writes are private.
- **Health.** `/api/health` answers 503 when a store cannot be read or a started queue has stopped sweeping for over a minute. The container health check reads that.
- **Sign-in.** The password check runs on the thread pool, so a sign-in does not stop the event loop.
- **Rollback.** `deploy/rollback.sh <commit>` takes an encrypted backup first (it refuses to run without a backup certificate unless `ROLLBACK_SKIP_BACKUP=1`), builds that commit from a temporary checkout, restarts the app and waits for it to become healthy. The data volume is not reverted, and a build older than the database schema refuses to start: then restore the backup taken before the upgrade. Not yet run against the live host.

