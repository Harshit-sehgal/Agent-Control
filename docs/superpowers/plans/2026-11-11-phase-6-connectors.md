# Phase 6: Connectors (Google and MCP), Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. TDD per task.

**Goal:** Bots reach Gmail, Drive and any MCP server through connectors. Every use goes through the ask mechanism.

**Spec:** `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md`, sections:
- "Connectors"
- Owner answer 2 (Google OAuth with PKCE; MCP preferred; annotations feed the classifier)
- Owner answer 3 (no hard-coded localhost; redirect from config)

## Global Constraints
- Zero npm dependencies. The OAuth client and the JSON-RPC 2.0 MCP client are hand-written.
- Secrets (client secret, refresh and access tokens, MCP headers) live only in the vault (`src/vault.js`, `src/credentials.js`). They are never returned by an API, logged or put in a backup in plain text.
- A connector is `{id, kind:'google'|'mcp', name, account, actions:[{name, write:boolean, description}]}`. Actions are `connector.<id>.read` / `connector.<id>.write`, plus a per-tool name for MCP. Tools with no annotations count as write. `destructiveHint` makes a tool a write; `readOnlyHint` makes it a read.
- A bot asks the first time it uses a connector, scoped per account (`shared/asks.js` grantScope). Writes default to ask. Sending email logs an `outside` activity entry, and the 30-second Undo window applies to Always-allowed email sends (`undoUntil`).
- The OAuth redirect URL comes from config (`PUBLIC_BASE_URL` env, falling back to the request origin). The code has no localhost literal.
- Tests never touch real Google or real MCP servers. They use fake HTTP and stdio servers.

## Tasks
1. **MCP client** (`src/mcp-client.js`).
   - Transports:
     - streamable HTTP, from the server;
     - stdio, through the local agent with a new agent task `mcp.call`, with the server command configured on the agent side only.
   - Handshake: `initialize`, then `tools/list`, then `tools/call`. Timeouts apply, and output is capped.
   - Routes: `POST /api/connectors {kind:'mcp', name, url|agentServer, headers?}`, `GET /api/connectors`, `DELETE /api/connectors/:id`, and `POST /api/connectors/:id/refresh` (re-lists tools).
2. **Bot tool fence `connector`.**
   - The block is ```` ```connector {"use":"<connector id or name>","tool":"<tool>","args":{...}} ``` ````.
   - It is parsed in `shared/reply-blocks.js`, classified as read or write, and goes through `verdict()` and the ask flow.
   - When allowed, it runs, and the result returns to the same bot for one more turn, the way a peer answer does. The result is untrusted data and is said so in the envelope.
   - The envelope lists the connectors and their tools by name and description.
3. **Google** (`src/google.js`).
   - Owner setup: `POST /api/connectors/google/setup {clientId, clientSecret}` (owner only, kept in the vault).
   - `GET /api/connectors/google/start` uses PKCE, a state nonce and the scopes `gmail.modify` + `drive.readonly`. The callback exchanges the code, stores the refresh token in the vault, and records the account email.
   - Token refresh. When refresh fails with `invalid_grant`, the connector status becomes `reconnect`.
   - Built-in actions:
     - `gmail.search` / `gmail.read` (read)
     - `gmail.draft` (write)
     - `gmail.send` (write, with the Undo window and an outside log)
     - `drive.search` / `drive.read` (read)
4. **Docs.** Cover Google Cloud OAuth client setup, "Testing" status and the 7-day refresh, and adding an MCP server. Tick Phase 6.

## Review Focus
1. A tampered OAuth `state` or a reused code. Refuse it.
2. An MCP server that returns a huge or never-ending response. Time out, cap it, and keep the server alive.
3. A tool that has no annotations is treated as a write and asks.
4. A secret appears in GET /api/connectors, a backup or a log. That must never happen.
5. A connector is deleted while an ask for it is pending. The answer resolves cleanly.
