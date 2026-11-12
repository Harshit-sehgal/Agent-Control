# End-to-end report

What a real owner's day looks like on this app, what was missing from the basics, and where each gap stands.
Last full pass: 2026-11-12. All 108 everyday prompts ran on a scratch workspace, through the owner's own
`claude` sign-in on haiku, with the local agent and its real headless Chrome started by `npm start` itself.
No setup step was done by hand.

## How it was tested

- **Gates:** `npm run check`, `npm test` (1910 tests), `tests/polish_smoke.py` (10 scenarios) and
  `tests/usability_smoke.py` (60 scenarios). All green.
- **Real bots:** 108 prompts an owner would type, covering search, prices, news, weather, long pages, YouTube,
  careers pages, schedules, bot changes, team set-up, sign-in sites, Gmail, a test order form, a live
  restaurant booking site, and (new) the date and its own budget, a declined post next to a second job, paying
  on one site without asking, limits, team routing, schedule and memory edits, threads, Connect Notion, opening
  Settings, bots that make bots, off-job questions, pausing everyone, a summary of its own permissions, a model
  switch, a page carrying instructions, and two sites compared. 107 of 108 completed on the first pass (the one
  failure was X refusing the browser, fixed below). Each flagged reply was read by hand; the real gaps are
  listed below and were fixed, then those prompts were run again.

## Gaps found and fixed

The ideal is that the owner never has to know how the app works: the bot knows, and offers a one-tap card for
anything only the owner may do.

| Gap | Now |
|---|---|
| A model had to be chosen and pasted before anything worked | With no model, one tap uses this computer's Claude or ChatGPT sign-in |
| The browser needed its own set-up | `npm start` starts the local agent with the real browser; without Chrome, pages are still read plainly |
| Settings could only be changed in Settings | Any bot changes jobs, names, models, effort, rules, teams and schedules from chat, behind an Apply card |
| Regular work meant coming back to ask again | Bots propose schedules, daily, hourly or on a weekday |
| Bots said they would look, and stopped | A promise to open a page is turned into the page read; a bot that circles is stopped and answers |
| Scripted pages (YouTube) and compressed pages (Amazon) read as empty or noise | YouTube results are read from the page data; gzip, deflate and brotli are decoded |
| A click that opens a booking page read the old page | The read waits for the page the click opens, including a new tab |
| A refused page request vanished, so the run ended on "asked to open a web page" | The reason goes back to the bot, which fixes the request or answers |
| A form could be submitted twice in one task | A second submit on the same site in a task is not sent; the first result is handed back |
| A site that blocks bots or needs the owner signed in was a dead end | The bot offers a Sign in card: the owner signs in once in the shared browser, and bots read it there |
| A signed-out Gmail or Reddit read was reported as if it were the answer | A sign-in page is recognised; the bot is told not to type a password and offers the Sign in card |
| Gmail and Drive needed a Google Cloud OAuth client | With no client saved, Connect Gmail is a Sign in card for Gmail; a saved client keeps the real Google sign-in |
| A run that read a connector could open any site after that result was used | A run that read private data (a connector, or signed-in mail or files) asks before any new site for the rest of the run |
| "Delete this bot" sent the owner to the devices page | Bot changes are always cards; "devices" is named as computers, and a bots page request is refused with the Remove block |
| The same setup card could be offered twice | An identical card from the last ten minutes is not added again |
| "I'll propose…" with a setup card was said twice: the promise nudge ran the bot again | A reply that made a setup card did what it said and ends the turn |
| A lead saw only the first 600 characters of a teammate's answer, so a grocery list read as cut off | Each teammate answer reaches the lead whole, up to 2,000 characters |
| Posting on X by selector (`tweetButtonInline`) asked as a Send, and the card named the text box | Selector words are read (camelCase, underscores), so it asks as a Post, and the card names the button that posts |
| A site that refused the browser (`ERR_HTTP_RESPONSE_CODE_FAILURE`) was retried until the run failed, hiding an answer already found | A site that refuses twice is not opened again; a run that read something answers from it before it stops |

## Accessibility pass

Sixteen screens (chats, a bot chat, profile, New bot, New thread, Company, Activity and every Settings section)
were checked at laptop and phone width, in light and dark. The checks covered accessible names, form labels, text
contrast (WCAG AA), 24px targets, the keyboard focus ring, duplicate ids, landmarks, and dialogs.

- Contrast, names, labels, landmarks and dialogs passed everywhere. Settings is a labelled modal dialog that keeps
  Tab inside it, its switches report on or off, and every text field has a name.
- **Fixed:** a screen reader never heard the first reply in a chat that had no reply yet (only later ones were
  spoken). The first reply is now announced, and a smoke scenario covers it.
- **Fixed:** "or start a new thread" on the empty laptop panel was a 21px target; it is now 32px.

## Running the app from chat

Everything the owner can change by hand, a bot can now propose from chat, behind a card the owner taps. Bots already
had cards for:

- jobs, names and settings;
- models and effort;
- teams and permission rules;
- schedules;
- removing a bot;
- sign-in.

They now also have cards for:

- a bot's **colour and shape** (colours have names, such as "make it blue");
- **pausing** every bot;
- **run limits** (pages per reply, rounds, team steps);
- **asking before every page** or browsing freely;
- **forgetting** what a bot learned;
- **removing a connector**;
- **renaming or deleting a thread**.

Every bot is also told whether bots are running, the limits, and each bot's look, so "what is my setup?" gets the
whole picture.

Sixteen plain requests went to a real bot ("make the researcher blue and an egg", "stop all my bots", "cap how many
pages a bot reads to 2", "delete the Goa thread", "rename the writer, make it short and have it report to the
researcher"). Each one now produces the right card, or the right "nothing to change". The run found and fixed these:

| Gap | Now |
|---|---|
| A card that could not be used sat beside a reply saying the change was proposed | The reason goes back to the bot once; it sends a corrected card or says plainly that nothing was set up |
| New fields (asking first, limits, threads, connectors) were dropped by the block reader | The reader carries them, and a test reads real reply blocks end to end |
| "Turn my bots back on" offered cards that changed nothing | A change already in place gets no button; the bot hears it and says so |
| A fourth change in one reply vanished | A reply carries up to eight; more are reported, never dropped |
| "Bots should open at most 3 pages" was read as being about the bot's own reply | It is a limits card |
| The colour picker read "Colour 1" to "Colour 10" to a screen reader | Each colour is read by name |

## Resume, and Connect in one tap

- **Pausing every bot** now leaves a line in the chat with a **Resume** button. One tap starts them again
  and says so. A pause from the guard (a run that went too far) still has no button, so a runaway is not
  restarted by a stray tap.
- **Connect apps is one tap per app.** An app with a web sign-in (Notion, GitHub, Slack, Linear, Figma,
  Airtable, Stripe and more) opens its sign-in page in the shared browser, in the owner's hands. The owner
  signs in, hands back control, and bots read it there as the owner. Its row then says "Signed in through the
  browser" with Sign in again, Add a token and Remove. Google with no client saved does the same at Gmail.
  An app that needs nothing (Time, Files with its default folder) connects at once. Only an app with no web
  sign-in (Obsidian, Git) still asks for its token or folder.
- Pages read on a signed-in app are private to the run: the run asks before it opens a site it has no
  Always allow for, so what it read cannot leave in an address.

## Apps used directly on the owner's account

- **Connect signs in to the app's own MCP server** for Notion, Linear, Atlassian, Sentry, Cloudflare, Supabase,
  Stripe, Zapier, Todoist and Airtable, the way Connect Google works: no token to paste. The app registers itself
  with that server, the owner signs in on the app's own page, and the bots then use its tools on the owner's account.
  The tokens are kept encrypted in the vault and renewed before they run out; a renewal the app refuses shows
  "Sign in again". Checked against each real server: every one of the ten registered this app and showed its
  sign-in page. No account was signed in to, because that is the owner's step.
- **GitHub, Slack, Figma, Asana and HubSpot** do not let an app register itself, so Connect signs in to them in the
  shared browser, with Add a token to switch them to their MCP server. Gmail through Google's API needs the one-time
  Google client; until then Connect signs in to Gmail in the shared browser.
- **Tools first, the browser for the rest.** Bots are told a connected app works on the owner's account directly.
  A bot that opens a connected app's own site (Notion pages with Notion connected, Gmail with Google connected) is
  sent back once per task to use its tools; asked again, the page opens. Sites with no connector, like X, open in
  the shared browser, signed in as the owner.

## Files, presets, briefing, usage and the fallback (Phase 9 pass)

A second real-model pass on the same scratch workspace, haiku through the owner's `claude` sign-in, ran the
Phase 9 features: 11 prompts, then the four that showed a gap again after each fix.

- **An attached invoice image is read.** With a subscription CLI the bot first said it could not see the
  image. The agent's runner was ready for images, but the server's `model.run` payload check rebuilt the
  payload without them (and without the effort). Both now reach the paired computer: claude gets image blocks
  over `--input-format stream-json`, codex gets `-i` files. Asked again, the bot gave the invoice number and the
  total. An image too big for one request is named to the bot instead of sent, so the turn still answers.
- **A CSV is totalled correctly**, by category and in all.
- **Careful asks before a page; the 1-hour Always allow saves an end; the next page in that hour does not ask.**
- **Hands-off fills and submits a test form** (httpbin's echo form, test data) with no ask, and says what the
  server echoed. Payments and deletes still ask under Hands-off.
- **The fallback model answers** when the bot's own model is busy (a stub that always answers 503). The chat
  line reads "…'s model (busy-model) couldn't answer (the provider is having trouble), so the fallback model
  haiku answered instead."
- **Bots can set up what Phase 9 added.** Asked to save a template, Atlas proposed a note; asked for the
  briefing, a plain schedule; asked for today's tokens, it said it could not see them. A bot can now propose a
  template (save or delete), a safety preset (with Undo) and the real daily briefing (on, off, or moved to a new
  time in one tap), and its brief names the templates, the preset, the briefing, the fallback model, and the
  tokens used this month and today (UTC). A template card sent with `"remove": false` now saves instead of
  failing. Asked again, each answer was right and came with a card.
- **The scheduled briefing ran** with the real facts it is handed (what is waiting on the owner, the day's
  schedules), and every run recorded its tokens.

## Left to the owner, by design

Each needs the owner's own account or details, which a bot must not supply.

- **Signing in** to Gmail, Reddit, LinkedIn or a shop: one tap on the Sign in card, then the owner signs in.
  The hand-over itself was run: the owner's tap took the shared browser, a session cookie was set on
  httpbin.org as a sign-in would set one, control was handed back, and Atlas then read that session's cookie
  back exactly. So a bot reads whatever the owner is signed in to there. A real Gmail or Reddit sign-in has
  not been made, because it is the owner's.
- **A real booking or order:** the bot clicks through to the form and asks for the name and phone, and the
  submit is an ask card. A live booking has not been made, because it needs the owner's details.
- **Google's own API sign-in** (for sending through Gmail's API rather than the browser): the owner's Google
  Cloud client, pasted once in Settings → Connectors.
- **Bot checks and CAPTCHAs** (LinkedIn showed one) are never solved by a bot; the Sign in card hands the page
  to the owner.
- **Posting on X** is a Post like any other: bots click and type on X, and the Post asks the owner unless they set Always allow.
