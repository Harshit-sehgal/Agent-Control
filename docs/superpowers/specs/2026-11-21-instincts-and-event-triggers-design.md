# Agent instincts and event triggers (design, 2026-11-21)

Status: built, with the calls below marked as ours. Written after reviewing the
"next features" list (instincts, event-driven agents, interruptions, capture and others).

## Intent
Bots should learn a working preference from one correction, and start from an outside
event (a failed deploy, a new issue) without someone typing a prompt. Both must keep
permissions where they are: nothing new may send, post, delete or pay on its own.

## Goals
- A correction ("next time put it in a table") becomes an editable rule.
- A rule can be switched off without losing it, and a tidy-up pass cannot revive it.
- An outside event with a valid signature starts one run for a named bot.

## Non-goals (this round)
- Natural-language conditions on events. A structured condition (one field, equals or
  contains) is used instead, because it is testable and cannot be talked around.
- Task-type scoping of rules. Rules still apply to every turn of their bot.
- Shadow mode, the hybrid deterministic engine, budget autopilot, project rooms,
  presence, walkie-talkie, skill packs, onboarding and workspace pulse. Each is a UI or
  product project with its own design; none is started here.

## Approaches considered
1. A new instincts store beside memory. Rejected: it duplicates the rulebook, which
   already reaches every bot turn and is editable and deletable.
2. Extend the rulebook with an `enabled` flag and a "next time" cue. Chosen.
3. Event triggers with a bearer token. Rejected: GitHub and most deploy hooks cannot send
   a bearer header, and the Access rule blocks them anyway. HMAC over the raw body is what
   they send.
4. Event triggers with HMAC and the secret in the vault. Chosen. A hash cannot verify an
   HMAC, so the secret itself is stored, encrypted, the same way provider keys are.

## Our calls (not discussed with the owner)
- Event body limit 64 KB; run sees at most 8000 characters, fenced as outside data with a fence longer than any backtick run in the body.
- Hands-off does not cover a run an event started: its text came from outside, so its sends and posts ask. Found in review, after the first build.
- A GitHub ping is signed but starts nothing.
- Duplicate window 24 hours; at most 200 dedup records per trigger.
- A kill-switched workspace answers 202 `held` and queues nothing.
- Events run two seconds after arrival, because the one-off timing check needs a future time.
- Public route `POST /api/events/:workspace/:trigger` with a written exemption in
  `tests/route-roles.test.js`. The route is public only in the sense that it takes no
  session; the signature is the check.

## Left for the owner
- Cloudflare Access must allow the event path for senders that cannot log in. This is a
  bypass rule for one path, and it is the owner's decision.
- A UI for triggers is not built. The API is complete, and the page can call it later.
