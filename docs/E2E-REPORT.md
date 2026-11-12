# End-to-end report

What a real owner's day looks like on this app, what was missing from the basics, and where each gap stands.
Last full pass: 2026-11-12. All 72 everyday prompts ran on a fresh scratch workspace, through the owner's own
`claude` sign-in on haiku, with the local agent and its real headless Chrome started by `npm start` itself.
No setup step was done by hand.

## How it was tested

- **Gates:** `npm run check`, `npm test` (1641 tests), `tests/polish_smoke.py` (10 scenarios) and
  `tests/usability_smoke.py` (47 scenarios). All green.
- **Real bots:** 72 prompts an owner would type, covering search, prices, news, weather, long pages, YouTube,
  careers pages, schedules, bot changes, team set-up, sign-in sites, Gmail, a test order form, and a live
  restaurant booking site. Every run completed. Each flagged reply was read by hand; the ones that were real
  gaps are listed below and were fixed, then that prompt was run again.

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
- **Posting on X** stays refused for bots; the bot writes the post for the owner to send.
