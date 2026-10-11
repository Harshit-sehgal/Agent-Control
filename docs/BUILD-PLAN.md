# Build plan — remaining roadmap work

Tracks execution of the v0.2/v0.3 roadmap items. Update as phases land; every phase ends with `npm run check && npm test && npm run build:pages` green.

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
- [ ] `shared/evidence.js`: link, claim, confidence, verification status, reuse
- [ ] Evidence attached to drafts; Researcher emits evidence refs
- [ ] UI: add/review evidence on draft cards

## Phase E — bot contracts + tool permissions
- [ ] `shared/contracts.js`: versioned bot schema, declared I/O, action permissions
- [ ] Coordination engine validates outputs; actions gated by permissions
- [ ] UI: edit contract + permission toggles (publish always denied)

## Phase F — local agent
- [ ] Pairing codes (hashed, short-lived) + HMAC-signed outbound protocol
- [ ] `agent/agent.mjs` device process: heartbeat, poll, execute, report
- [ ] Permission-scoped task kinds; browser adapter behind explicit opt-in
- [ ] Disconnect/duplicate-delivery recovery tests

## Phase G — credentials, retention, deletion, backups
- [ ] AES-256-GCM vault (`MASTER_KEY` / local dev keyfile)
- [ ] Retention pruning, account deletion, encrypted backup export/import

## Phase H — notifications
- [ ] Preferences (in-app/webhook/email-relay) + dispatcher w/ retry

## Phase I — deployment readiness
- [ ] Optional TLS termination, HSTS, startup validation, `docs/DEPLOYMENT.md`

## Phase J — UI surfaces
- [ ] Run timeline visualization + failure reporting
- [ ] Human checkpoint gates between bot steps
- [ ] Tasks, evidence, credentials, agents, notifications, users panels

## Phase K — tests
- [ ] Disconnect, duplicate delivery, partial-execution recovery
- [ ] Adversarial prompt-injection suite
- [ ] Authorization matrix tests

## Phase L — docs
- [ ] ROADMAP/README/COORDINATION updates, AGENT-PROTOCOL.md, SECURITY.md
