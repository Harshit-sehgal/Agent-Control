# Owner Sign-in with Google Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner signs in with the Google address named in `OWNER_EMAIL`, a password becomes optional, and the server stops making up and printing a random password.

**Architecture:** `src/google-owner.js` holds the OpenID Connect flow: an in-memory flow map, a URL builder and a callback check, with Google's endpoints and `fetch` injectable. `src/routes-public.js` adds three public routes over it, plus `Auth.loginOwner`. The sign-in sheet shows a Google button when `/api/auth/methods` says Google is available. Change password becomes Set a password when the account has no password.

**Tech Stack:** Node 22, `node:crypto`, `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-google-owner-sign-in-design.md`

## Global Constraints

- Zero npm runtime dependencies. `shared/` stays browser-safe.
- Google sign-in is available only when `OWNER_EMAIL`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are all set.
- Callback path: `/api/auth/google/callback`. Start path: `/api/auth/google/start`. Methods path: `/api/auth/methods`.
- Scope `openid email`, `response_type=code`, PKCE S256, plus `state` and `nonce`. Flows live 10 minutes, at most 20 of them.
- Accept only when `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud` is the client id, `exp` is in the future (60 s skew), `nonce` matches, `email_verified` is true, and `email` matches `OWNER_EMAIL` ignoring case.
- A refused sign-in redirects to `/?signin=google-refused`. The UI copy is "That Google account can't sign in here."
- An existing `DASHBOARD_PASSWORD`, an existing stored password, invited members and password reset behave as before.

## Review Focus

- A Google account other than `OWNER_EMAIL` with a verified email must be refused (Task 1 test).
- `email_verified: false`, or a string `"false"`, must be refused (Task 1 test).
- A callback with a `state` that is unknown, replayed or missing its cookie must be refused and must not spend a real flow (Task 1 and Task 2 tests).
- With `OWNER_EMAIL` set but no client secret, `/api/auth/methods` says `google: false` and `/start` refuses (Task 2 test).
- An owner with no password can set one without a current password; once one is set, the current password is required again (Task 3 test).

---

### Task 1: The Google owner flow

**Files:**
- Create: `src/google-owner.js`
- Test: `tests/google-owner.test.js`

**Interfaces:**
- Produces:
  - `OWNER_CALLBACK = '/api/auth/google/callback'`
  - `ownerGoogleConfig(env = process.env) -> {clientId, clientSecret, ownerEmail} | null`
  - `startOwnerSignIn(config, baseUrl) -> {url, state}`
  - `takeOwnerFlow(state, cookieValue) -> flow | null`
  - `finishOwnerSignIn(config, flow, {code, error}, {fetcher = fetch, now = Date.now}) -> Promise<{ok: true, email} | {ok: false, reason}>`
  - `ownerFlows` (Map, exported for tests)
- Google endpoints come from `googleEndpoints()` in `src/google.js` (`auth`, `token`).

- [ ] Write tests:
  - Config is null unless all three variables are set.
  - The start URL carries `client_id`, `redirect_uri=<base>/api/auth/google/callback`, `scope=openid email`, `code_challenge_method=S256`, a `state` and a `nonce`.
  - `takeOwnerFlow` refuses a mismatched cookie without spending the flow, and refuses a second take.
  - Finish with a fake `fetcher` returning an id_token: OK for the owner email in other case. Refused for: another email, `email_verified` false, a wrong `aud`, a wrong `iss`, a wrong `nonce`, an expired token, a token reply that is not 200, and `error=access_denied`.
- [ ] Run `node --test tests/google-owner.test.js`. Expected: fail (module missing).
- [ ] Implement it. Decode the id_token payload, which came directly from Google's token endpoint over TLS. The token request is form-encoded with `code_verifier`.
- [ ] Run the tests. Expected: pass.
- [ ] Commit `feat: the Google flow that signs in the owner`.

### Task 2: Routes, owner session and boot

**Files:**
- Modify: `src/auth.js`: add `loginOwner(meta)`. `ensureBootstrap('')` stores an empty hash. `changePassword` skips the current-password check when the stored hash is empty. Add `hasPassword(userId)`.
- Modify: `src/routes-public.js`: `GET /api/auth/methods`, `GET /api/auth/google/start` (rate-limited per IP like `forgot`), and `GET /api/auth/google/callback`. The callback sets a session cookie and the flow cookie `owner_google_state` (HttpOnly, SameSite=Lax, Path=`/api/auth/google`).
- Modify: `src/routes-account.js`: `/api/me` adds `hasPassword`.
- Modify: `src/server.js`: no random password. New boot lines; the preflight warning names `OWNER_EMAIL`.
- Modify: `tests/route-roles.test.js`: add the three public routes to `PUBLIC_ROUTES`.
- Test: `tests/google-owner-routes.test.js` (spawns the server like `tests/api.test.js`).

- [ ] Write tests:
  - `methods` gives `{password: true, google: false}` without the variables, and `google: true` with them.
  - `start` gives a 302 to the configured auth URL plus the flow cookie.
  - The callback with a bad state gives a 302 to `/?signin=google-refused`.
  - The callback against a fake token server (`GOOGLE_TOKEN_URL` pointing at a local server) for the owner gives a 302 to `/` with an `agent_session` cookie, and `/api/me` then says `role: owner`.
  - With no `DASHBOARD_PASSWORD`, `/api/login` refuses every password and the boot log prints no password. `/api/me.hasPassword` is false.
- [ ] Run, fail, implement, run, pass.
- [ ] Commit `feat: the owner signs in with Google, and no password is made up`.

### Task 3: Sign-in button and Set a password

**Files:**
- Modify: `shared/ui-sheets.js`: `showLogin` takes `{google}` and puts a `Continue with Google` link (`href="/api/auth/google/start"`) above the form. `changePasswordSheet({hasPassword})` leaves out the current-password field when there is none, with the title `Set a password`.
- Modify: `shared/app.js`: on a 401, fetch `/api/auth/methods` (falling back to no Google) and show the button. Read `?signin=google-refused`, show the message, and strip it from the address.
- Modify: `shared/ui-actions.js`: pass `hasPassword` from `/api/me`.
- Modify: `shared/ui-settings.js`: the button reads `Set a password` when `hasPassword` is false.
- Test: `tests/google-owner.test.js` covers the Auth rule (no-password owner sets one; then the current password is required). The UI is checked with a Playwright script against a server with a fake Google.

- [ ] Write the Auth test, run it, see it fail, implement, see it pass.
- [ ] Wire the UI. Check in a browser: the button shows, a refused return shows the message, and Settings offers Set a password.
- [ ] Commit `feat: Continue with Google on the sign-in screen, and Set a password`.

### Task 4: Docs and gate

- [ ] README (Quick start, Security), SECURITY.md, `.env.example` (`OWNER_EMAIL` and the redirect URI to register), AGENTS.md (Security), CHANGELOG.
- [ ] `npm run check && npm test && npm run build:pages`, with `git status` clean afterwards. Then `npm run test:ui`.
- [ ] Commit `docs: owner sign-in with Google`.
