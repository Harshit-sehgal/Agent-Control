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

- `src/workflow.js` owns every workflow transition; the HTTP routes no longer contain business rules.
- Versioned state schema (`SCHEMA_VERSION`) with an idempotent `migrate()` run at startup.
- One UI in `shared/`, served directly by Node and copied to `docs/` for Pages with `npm run build:pages`.
- `shared/transport.js` selects the real `/api` backend under Node and the browser-local backend on Pages, so both run identical rules.
- The browser-local demo (`shared/local-api.js`) reuses `shared/workflow.js` instead of duplicating lifecycle logic.

## Next milestone: v0.2 local agent + structured workflows

1. ~~Extract workflow state management from route handlers.~~ Done: see `src/workflow.js`.
2. Introduce versioned bot/group schemas, explicit input/output contracts.
3. Build independent local agent with device pairing and outbound authenticated connection.
4. Add per-action tool permissions and a local browser adapter for sites that authorize automation.
5. Replace text reminder events with structured runnable tasks and status events.
6. Build a source evidence model: links, confidence, verification status, and allowed reuse.
7. Add workflow run visualization, failure reporting and human checkpoints.
8. Add tests for disconnects, duplicate task delivery and partial execution recovery.

## Next milestone: v0.3 cloud control plane

1. Move dashboard, authentication and scheduling to an always-on HTTPS backend.
2. Replace local JSON store with transactional SQL and migrations.
3. Separate users, organizations, workspace-level roles and bot permissions.
4. Add workers and queues with explicit idempotency and lease control.
5. Send approved task instructions to local agents through outbound secure channels.
6. Implement encrypted credential storage, retention limits, account deletion, and backups.
7. Implement mobile push/email notification preferences.
8. Conduct a security review and adversarial prompt-injection tests.

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
