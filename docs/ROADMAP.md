# Product roadmap — from private proof-of-concept to hosted agent platform

## Delivered: v0.1 private prototype

- Functional HTTP dashboard and persistent local state.
- Groups and configurable custom text bots.
- X-engage candidate intake, deterministic scoring, drafts, revisions and approval locks.
- Randomized manual handoff scheduling, recurring/one-off reminders.
- Intentional browser extension capture; no automated X scraping or posting.
- Optional AI provider integration and offline template mode.
- Basic auth, capture scopes, audit trail, Node test suite.

## Delivered: unified UI and shared workflow core

- `shared/workflow.js` owns every workflow transition; the HTTP routes no longer contain business rules.
- Versioned state schema (`SCHEMA_VERSION`) with an idempotent `migrate()` run at startup.
- One UI in `shared/`, served directly by Node and copied to `docs/` for Pages with `npm run build:pages`.
- `shared/transport.js` selects the real `/api` backend under Node and the browser-local backend on Pages, so both run identical rules.
- The browser-local demo (`shared/local-api.js`) reuses `shared/workflow.js` instead of duplicating lifecycle logic.

## Delivered: platform (v0.2 / v0.3)

- **Transactional store.** `node:sqlite` behind the same `read()`/`update()` interface, with a schema-migration ledger and legacy JSON import (`src/sqlite-store.js`).
- **Multi-user control plane.** Accounts, revocable server-side sessions, workspaces and `viewer < member < admin < owner` roles; every write is gated by a route matrix and verified by `tests/authz-matrix.test.js` (`src/auth.js`).
- **Structured tasks + durable queue.** Reminders became real tasks with status, attempts, leases and idempotency keys (`shared/tasks.js`, `src/queue.js`).
- **Source evidence model.** Claims carry links, confidence, verification status and reuse policy; disputed evidence blocks approval (`shared/evidence.js`).
- **Bot contracts + tool permissions.** Versioned input/output contracts validated before each handoff; actions are permission-gated, and no publish action exists anywhere (`shared/contracts.js`).
- **Local agent.** Hashed, single-use pairing codes; HMAC-signed outbound protocol; lease-based tasks; permission-scoped kinds (`agent/agent.mjs`, `src/agent.js`, [`AGENT-PROTOCOL.md`](AGENT-PROTOCOL.md)).
- **Credentials, retention, backups.** AES-256-GCM vault (`src/vault.js`), configurable retention pruning (`shared/retention.js`), audited export/restore (`src/backup.js`).
- **Provider-agnostic AI.** Any OpenAI-compatible endpoint via `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` (`src/ai.js`).
- **Interface.** Chat-first, messenger-style redesign: a chat list, open thread and info panel, with X-engage drafts as in-thread cards, evidence review on drafts, admin Team & Agents surfaces, and keyboard quick navigation.

## Delivered: multi-bot coordination UI + admin

- **Real multi-bot orchestration in the UI.** On the Node build with a provider configured, the group chat runs on the server orchestrator (`src/coordination.js`): each specialist is called with the running context and hands off to the next, streamed into the conversation. The static demo keeps the deterministic simulator.
- **Run timeline.** The group's Runs section in its info panel shows every coordination run with per-step traces, handoffs, status, and one-click **Retry** for failed/interrupted runs.
- **Human checkpoint gates.** An "Approve between steps" toggle pauses a run before each handoff; the run waits in `awaiting_checkpoint` until an admin approves the next step (`POST /api/groups/:id/runs/:id/continue`).
- **Admin surfaces (Node build).** Team & access (users, roles, sessions), Local agents (pairing, permissions, revoke), and **Data & security** (credential vault, retention preview/prune, encrypted backup export/restore).
- **Notifications** (`src/notifications.js`): an unread count under You, an in-app feed, and per-user channel preferences (in-app/webhook/email relay).
- **Server structure.** API routes are declared in a route table with the access each one needs (`src/router.js`, `src/routes-*.js`); `src/server.js` only starts services and dispatches.
- **Durable history.** Conversations are stored with the workspace and follow the account across devices; the orchestrator writes each run's messages and outcome into its conversation, so a run shows up even if the tab that started it was closed; every workflow record reads back unchanged after a restart (`src/sqlite-store.js`, `shared/chats.js`).
- **Deployment hardening**: optional in-process HTTPS (`TLS_CERT`/`TLS_KEY`), HSTS, startup validation, and [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Delivered: workspaces, push, a real browser reader, deploy files

- **More than one workspace.** Each workspace has its own database file, members and roles; a session works on one workspace at a time and can switch (`src/workspaces.js`, `src/routes-workspaces.js`). Local agents, credentials, notifications, capture tokens and backups are per workspace.
- **Mobile push.** Web Push to any subscribed device, encrypted and signed with `node:crypto` (`src/push.js`), delivered through the task queue with retries. A service worker shows the notification (`shared/sw.js`), and a web manifest lets the app be installed, which iOS requires for push.
- **A real browser reader.** With `AGENT_BROWSER=1` the local agent opens allowlisted pages in the installed Chrome over the DevTools protocol (`agent/browser.mjs`). No dependency was added, and it only reads.
- **Deploy files.** `Dockerfile`, `deploy/compose.yaml` (Caddy for HTTPS) and `deploy/agent-control.service`.

## What is left

- **A host that is actually on.** The deploy files are tested locally, but nothing here rents a machine or points a domain at it. Until the server runs somewhere always on, the scheduler and queue only work while your machine is up.
- **Push on a real phone.** A test push was delivered end to end through Google's push service (the one Android uses) to desktop Chrome. Apple's push service, and a physical phone, are not yet tried.
- **Email delivery.** The email channel records a relay-ready notification; sending mail needs an SMTP client or gateway this project does not embed.
- **Workspaces for hostile tenants.** Workspaces share one process, vault key and AI provider key. Billing-grade isolation is a different design.

## Future milestones

- Configurable bot workflows using a visual graph.
- More bot groups with their own permitted integrations.
- Model routing, caching and budgets per group/user.
- Usage analytics and validated writing-style memory.
- Multi-user billing only after core reliability and compliance are validated.

## Non-goals

- Bypassing platform automation rules.
- Posting to X without manual final action in this workflow.
- Pretending template output or unverified source material is independently verified.
- Automatically granting tools or permissions based on text from a webpage.

## Exit conditions for any public beta

- Multi-tenant authorization audit is complete.
- Password resets and session revocation are implemented.
- Durable job state and duplicate execution prevention are tested.
- All sensitive actions have enforced least-privilege permissions.
- Connected account rules are documented for each platform.
- System costs, failures and user support load are measured under realistic workloads.
