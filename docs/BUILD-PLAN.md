# Build plan — complete (39/39)

All v0.2/v0.3 roadmap items are delivered. Every phase ended green
(`npm run check && npm test && npm run build:pages`). The items below are kept
as the record of what shipped; new work should be added as a fresh section.

## Phase A — transactional store
- [x] `node:sqlite` store behind the existing `read()`/`update()` interface (Node 22 re-exec guard)
- [x] Schema v1 + `schema_meta` migration ledger
- [x] Legacy `state.json` import on boot (mtime-guarded, supports operator JSON restore)
- [x] Atomic WAL transactions; `recoveredFrom` quarantine kept
- Also landed: completed the in-flight `.env` loader + provider-agnostic AI client

## Phase B — multi-user control plane
- [x] users, server-side sessions (revocable), password reset tokens
- [x] workspaces + membership roles (owner/admin/member/viewer)
- [x] First-run owner bootstrap from `DASHBOARD_PASSWORD`; `/api/login` unchanged
- [x] Authz matrix on every route; session list/revoke endpoints

## Phase C — structured tasks + durable queue
- [x] `shared/tasks.js` transition rules (pure, replaces reminder events)
- [x] `src/queue.js` worker: idempotency keys, leases, backoff, crash recovery
- [x] `schedules` → tasks migration; scheduler keeps draft release + task dispatch

## Phase D — source evidence model
- [x] `shared/evidence.js`: link, claim, confidence, verification status, reuse
- [x] Evidence attached to drafts; Researcher emits evidence refs
- [x] UI: add/review evidence on draft cards

## Phase E — bot contracts + tool permissions
- [x] `shared/contracts.js`: versioned bot schema, declared I/O, action permissions
- [x] Coordination engine validates outputs; actions gated by permissions
- [x] UI: edit contract + permission toggles (publish always denied)

## Phase F — local agent
- [x] Pairing codes (hashed, short-lived) + HMAC-signed outbound protocol
- [x] `agent/agent.mjs` device process: heartbeat, poll, execute, report
- [x] Permission-scoped task kinds; browser adapter behind explicit opt-in
- [x] Disconnect/duplicate-delivery recovery tests

## Phase G — credentials, retention, deletion, backups
- [x] AES-256-GCM vault (`MASTER_KEY` / local dev keyfile)
- [x] Retention pruning, account deletion, encrypted backup export/import

## Phase H — notifications
- [x] Preferences (in-app/webhook/email-relay) + dispatcher w/ retry

## Phase I — deployment readiness
- [x] Optional TLS termination, HSTS, startup validation, `docs/DEPLOYMENT.md`

## Phase J — UI surfaces
- [x] Run timeline visualization + failure reporting
- [x] Human checkpoint gates between bot steps
- [x] Tasks, evidence, credentials, agents, notifications, users panels

## Phase K — tests
- [x] Disconnect, duplicate delivery, partial-execution recovery
- [x] Adversarial prompt-injection suite
- [x] Authorization matrix tests

## Phase L — docs
- [x] ROADMAP/README/COORDINATION updates, AGENT-PROTOCOL.md, SECURITY.md

## Phase M — chat-first redesign
- [x] Chat list, thread, and info panel shell; one pane at a time on phones
- [x] Drafts and posts as in-thread cards with in-place actions
- [x] Workspace tabs folded into the X-engage chat info panel
- [x] In-app sheets replace native confirm and prompt dialogs
- [x] UI split into `shared/ui-*.js` modules with a pure view-model layer
- [x] Single stylesheet (`shared/app.css`), system fonts, tightened CSP
- [x] Tests and Playwright smokes updated for the new UI

## Phase N — server structure and durable history
- [x] Route table with declared access per route (`src/router.js`, `src/routes-*.js`)
- [x] Lossless restarts: every workflow record keeps its whole document (schema v3)
- [x] Reminders survive a restart
- [x] Conversations stored with the workspace, with a one-time import from the browser
- [x] Sheets take focus as they open (fixes text landing in the wrong field)
- [x] Group runs report into their conversation from the server

## Phase O — adversarial security review
- [x] Owner-only backup and restore; restore validates roles, links and column names
- [x] Hashed session ids; one answer for unknown address and wrong password
- [x] Sign-in and reset attempts counted before the body is read
- [x] Capture token withheld from viewers; request-made notification tasks refused
- [x] Local agent refuses private-network targets; model calls and posts are bounded
- [x] Only the server can mark a chat message as model output or name its sender
- [x] Webhooks refuse private-network targets unless allowed on purpose

## Phase P — workspaces, push, browser reader, deploy files
- [x] One database per workspace; sessions carry a workspace and can switch (schema v5)
- [x] Create, rename and delete workspaces; members invited per workspace
- [x] Web Push without a library: encryption, VAPID, queue delivery, service worker, manifest
- [x] Local agent reads allowlisted pages with the installed browser over DevTools
- [x] Dockerfile, Compose with Caddy, and a systemd unit
- [ ] Push verified from a real phone; server running on an always-on host
