# Changelog

## 0.7.0

Bring-your-own-key AI, permissioned local-agent actions, and a hardening pass.

### Added
- **BYOK AI providers** — add any OpenAI-compatible provider (OpenAI, Groq,
  OpenRouter, Ollama/vLLM, a router) under *You → AI and models*. Keys are
  AES-256-GCM encrypted in the workspace vault; model lists come from the
  provider's own `GET /v1/models`. A workspace sets a default provider + model,
  and each bot can override both.
- **Permissioned local-agent browser actions** — a `browser.action` task kind
  drives an allowlisted page (navigate/click/type/waitFor/read, ≤25 steps)
  through the agent's real browser, inside the same allowlist and private-address
  proxy as a read, in a fresh profile unless `AGENT_BROWSER_PROFILE` opts in.
- **Opt-in signed-in journeys** — set `AGENT_BROWSER_PROFILE` to keep a browser
  profile; `TRUST_PROXY=1` makes the rate limiter and secure-cookie hint use
  `X-Forwarded-For`/`X-Forwarded-Proto` behind a reverse proxy.
- Operations runbook (`docs/OPERATIONS.md`), deployment units
  (`deploy/*.service`, `deploy/cloudflared-config.yml`) and a proven
  backup/restore drill.

### Fixed
- Output contracts validate every declared field **type**, not just presence.
- Pairing codes carry the admin's permission scope; a device can only narrow it.
- The agent's plain HTTP checks are pinned to the vetted address (no DNS-rebind
  window) and the SSRF guard decodes 6to4/NAT64 and more reserved ranges.
- Backups require a checksum, omit agent secret ciphertext, and clear sessions on
  restore; restore accepts documents larger than 128 KB.
- Agent task attempts are counted once (max-attempts off-by-one); retry backoff
  starts at 1s; task kinds validate the field they need.
- A corrupt stored password hash is refused instead of throwing; changing your
  password keeps your own session.
- Route/UI fixes: the AI admin page is a real route, legacy tabs map only for
  x-engage, history depth is read from the entry, clearing a conversation lets
  queued sends land first, overlapping sends keep the typing indicator, the push
  subscription key is validated at subscribe, and idle ticks no longer rewrite
  the store.

## 0.6.0 and earlier
See the git history and the delivered phases in `docs/BUILD-PLAN.md`.
