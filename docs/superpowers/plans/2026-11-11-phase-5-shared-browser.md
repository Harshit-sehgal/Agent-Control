# Phase 5: Shared browser with takeover, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. TDD per task.

**Goal:** The local agent keeps one persistent browser profile shared by all bots. Sign-ins made there work for every bot. The owner can watch a bot's tab live, take it over, and hand it back.

**Spec:** `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md`, sections:
- "Shared browser with takeover"
- "Computer" (mock v46)
- Owner answer 1 (risk classifier)

## Global Constraints
- Zero npm dependencies: raw CDP over WebSocket, the way `agent/browser.mjs` does it today.
- The profile directory sits in the agent's config dir with mode 0700. Never upload it, log it or back it up.
- One bot drives the browser at a time and the others queue. Each bot gets its own tab.
- Every browser use goes through the Phase 3 ask mechanism (`shared/asks.js`). Submit, send, post, delete and pay clicks get their own ask. Pay clicks ask every time. The X click/type refusal stays.
- While the owner holds the browser, bots wait. Hand back resumes them.
- No frame or page text is persisted beyond the existing run records. Screencast frames are streamed live and never stored.

## Tasks
1. **Persistent shared profile.** `agent/browser.mjs` launches Chrome with `--user-data-dir=<agent config>/browser-profile` (0700) instead of a throwaway profile, and keeps one browser alive between tasks. A tab is assigned per bot (`botId → targetId`), and a lock means one bot drives at a time. Tests use the existing fake-CDP harness in `tests/agent*.test.js`.
2. **Screencast and input in agent mode.**
   - The agent runs `Page.startScreencast` (jpeg, quality 60, max 1280x800, every 2nd frame) for the watched tab only, while a viewer is subscribed. It posts frames to the server over the existing agent HTTP channel, either a long-poll or a new `POST /api/agent/frames` (latest frame only, kept in memory, about 10 fps max).
   - The server serves the frames to the owner's browser at `GET /api/browser-live/:botId` (viewer role or above, latest-frame polling or SSE).
   - Owner input travels as `POST /api/browser-live/:botId/input {type:'click'|'key'|'type'|'scroll', ...}`, is queued to the agent, and is applied with `Input.dispatch*`. It is accepted only while the owner holds the browser.
3. **Takeover state.**
   - `POST /api/browser-live/:botId/takeover` pauses that bot's browser work. Its run parks, and the line reads "You are driving".
   - `POST .../handback` resumes it.
   - The status comes from `GET /api/browser-live` → `[{botId, state:'idle'|'browsing'|'driving', url, title, pages:[{url,title,at}]}]`. Pages lists this run's pages, or the last run's when idle. A run's progress pill carries `site` (the hostname) while it browses.
   - Reuse `src/bot-browser.js` takeover and `ui-takeover.js` concepts where possible. Server-runtime takeover keeps working.
4. **Docs.** Update `docs/DEPLOYMENT.md` and README with sign-in once in the shared browser, where the profile lives, and how to wipe it. Tick Phase 5 in BUILD-PLAN.

## Review Focus
1. Two bots ask for the browser at once. One waits, and neither steals the other's tab.
2. The owner takes over mid-click. The bot's in-flight action finishes or is cancelled, and is never applied twice.
3. The agent restarts. The profile survives, and stale tab ids are dropped.
4. A viewer who isn't signed in polls the frames endpoint. The answer is 401, and frames never leak.
5. Owner input arrives while the owner is not driving. The answer is 409.
