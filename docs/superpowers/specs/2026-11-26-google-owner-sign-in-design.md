# Owner sign-in with Google

## Why

The owner gets stuck on the sign-in screen. On first boot the server creates the owner account from `DASHBOARD_PASSWORD`, or prints a random password that is different on every restart, and the owner does not know what it is. The app is reached through a Cloudflare tunnel, so the way back in must be one nobody else can use.

## Goals

- The owner can always get in with their own Google account, named once in `.env`.
- A password is optional. The owner sets one in Settings if they want one.
- The server no longer makes up a random password or prints it.
- Installs that already work keep working: an existing password, `DASHBOARD_PASSWORD`, invited members and password reset are unchanged.

## Non-goals

- Google sign-in for invited members. It is for the owner only, for now.
- Other identity providers.
- A first-run "pick your password" page. Behind a tunnel, whoever opens it first would win.

## Anti-goals

- Any Google account other than `OWNER_EMAIL` gets in.
- An unverified Google address gets in.
- A new install that cannot be entered at all, with nothing telling the operator why.

## Approaches

1. **Google sign-in for the owner. Chosen.** `OWNER_EMAIL` plus the Google OAuth client already in `.env` (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, used today for Gmail, Drive and Calendar). Only that verified address signs in as the owner.
2. A first-run setup page (set a password or link Google). Rejected: anyone who reaches a fresh install first can claim it, and through the tunnel every visitor looks local.

## Design

**Config**
- `OWNER_EMAIL`: one Google address.
- Google sign-in is offered only when `OWNER_EMAIL`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are all set.
- The redirect address is `<PUBLIC_BASE_URL or the request's own address>/api/auth/google/callback`, through the existing `publicBaseUrl`. The operator adds it to the Google client's authorized redirect URIs, and `.env.example` says so.

**Routes** (in `src/routes-public.js`, all public)
- `GET /api/auth/methods` answers `{password: true, google: bool}`. Nothing else is revealed.
- `GET /api/auth/google/start` redirects to Google's authorization endpoint. It sends `scope=openid email`, a random `state`, PKCE (S256) and a `nonce`, and keeps the flow in memory with a 10-minute lifetime and a capped count, like `src/mcp-oauth.js`. It is rate-limited per address, like `/api/login`.
- `GET /api/auth/google/callback`:
  - Checks `state` and takes the flow out of memory.
  - Exchanges the code at Google's token endpoint with the client secret.
  - Reads the `id_token` it was handed directly over TLS. It checks `iss` (Google), `aud` (our client id), `exp`, `nonce`, `email_verified === true`, and that `email` equals `OWNER_EMAIL` (case-insensitive).
  - On success it creates a normal owner session (the same cookie as a password sign-in) and redirects to `/`.
  - On any failure it redirects to `/?signin=google-refused`, and the sign-in screen says "That Google account can't sign in here." The reason goes to the server log only.

**The owner account**
- Google signs in as the account that is `owner` of the first workspace. Its stored email (`owner@localhost` on older installs) is not changed.
- A new install with no `DASHBOARD_PASSWORD` creates the owner with no usable password. Nothing random is made or printed.
- When the owner has no password, Settings → Change password becomes **Set a password**, with no current-password field. That is allowed only when the stored hash is empty.

**Boot messages**
- These replace the "temporary dashboard password" line.
- With Google configured: "Sign in with Google as <OWNER_EMAIL>."
- With neither Google nor a password: a warning that the owner cannot sign in until `OWNER_EMAIL` is set or `npm run reset-password` is run.

**Sign-in screen**
- A "Continue with Google" button above the email and password form, shown only when `/api/auth/methods` says so.
- The form stays for passwords and invited members.

**Docs**
- README, SECURITY, `.env.example`, AGENTS.md and CHANGELOG.

## Left to the builder

- Where the flow map lives: a small `src/google-signin.js`.
- How the sign-in screen markup is split.
- The exact copy, kept plain.
- Test layout: HTTP tests with a fake token endpoint injected through a `fetcher` option.
