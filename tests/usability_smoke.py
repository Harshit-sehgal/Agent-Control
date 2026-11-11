"""Interactive browser checks for the chats shell: new bots, the profile, Settings, the cards that wait on you, faces and keyboard.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/usability_smoke.py   (screenshots of failures land in a temp dir)
No network and no credentials.
"""
import asyncio
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = {'width': 1360, 'height': 860}
PHONE = {'width': 390, 'height': 844}
PRIMARY = 'atlas'
# The starting workspace is one company (the Home group) with one bot (Atlas), pinned.
# Scenarios that need more bots create them through the app's own API first.
EXTRA_BOTS = {
    'Researcher': 'Find and summarise what the user asks about.',
    'Writer': 'Write clear, concise drafts from what the others found.',
    'Reviewer': 'Check the draft for unsupported claims.',
}
expect.set_options(timeout=6000)


def build_site(tmp):
    """Run scripts/build-pages.js against a copy of shared/, so docs/ is untouched."""
    shutil.copytree(ROOT / 'shared', tmp / 'shared')
    # The whole scripts/ directory: the build imports its own helper modules, and
    # a hardcoded copy list breaks the moment one is added (ERR_MODULE_NOT_FOUND).
    shutil.copytree(ROOT / 'scripts', tmp / 'scripts')
    (tmp / 'package.json').write_text('{"type":"module"}')
    subprocess.run(['node', 'scripts/build-pages.js'], cwd=tmp, check=True, capture_output=True)
    return tmp / 'docs'


def serve(directory):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(directory), **k)

        def log_message(self, *a):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def known_noise(msg):
    """The meta CSP cannot carry frame-ancestors (the server header does), and no favicon is shipped."""
    url = (msg.location or {}).get('url', '')
    # A takeover with no device running answers 409 on purpose; the browser logs every failed fetch.
    return 'frame-ancestors' in msg.text or 'favicon' in url or '409 (Conflict)' in msg.text


class Harness:
    def __init__(self, browser, base, shots):
        self.browser, self.base, self.shots = browser, base, shots
        self.results = []

    async def scenario(self, name, fn, viewport=DESKTOP):
        # SMOKE_ONLY=<text> runs just the scenarios whose name contains it (a shortcut while developing).
        if os.environ.get('SMOKE_ONLY') and os.environ['SMOKE_ONLY'] not in name:
            return
        context = await self.browser.new_context(viewport=viewport)
        page = await context.new_page()
        page.set_default_timeout(6000)
        problems, dialogs = [], []
        page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
        page.on('console', lambda m: m.type == 'error' and not known_noise(m) and problems.append(f'console: {m.text}'))
        page.on('dialog', lambda d: (dialogs.append(d.message), asyncio.create_task(d.dismiss())))
        try:
            await fn(page, self.base)
            assert not dialogs, f'native dialog opened: {dialogs}'
            assert not problems, problems
            self.results.append((name, None))
            print(f'  ok   {name}')
        except Exception as error:  # noqa: BLE001 - report every scenario, then exit non-zero
            shot = self.shots / (re.sub(r'\W+', '-', name) + '.png')
            try:
                await page.screenshot(path=str(shot))
            except Exception:  # noqa: BLE001
                shot = None
            self.results.append((name, error))
            print(f'  FAIL {name}: {type(error).__name__}: {str(error).splitlines()[0] if str(error) else ""}')
            traceback.print_exc(limit=-3)
            if shot:
                print(f'       screenshot: {shot}')
        finally:
            await context.close()


SCREEN = '#main .cv, #main .hv, #main .rail-none, #main .nv, #main .pg, #main .st-wrap'


async def open_app(page, base, hash_='', bots=None):
    """Open the app; with `bots` ({name: instructions}) first add them to the company through
    the app's own local API, reload so the UI reads them, and return {name: bot id}."""
    await page.goto(f'{base}/index.html{hash_}')
    await page.locator(SCREEN).first.wait_for()
    if not bots:
        return {}
    ids = await page.evaluate('''async bots => {
        const made = {};
        for (const [name, instructions] of Object.entries(bots)) {
            made[name] = (await window.AGENT_API('/api/groups/home/bots', 'POST', {name, instructions})).id;
        }
        return made;
    }''', bots)
    await page.reload()
    await page.locator(SCREEN).first.wait_for()
    return ids


async def overflow(page):
    return await page.evaluate('() => document.documentElement.scrollWidth - innerWidth')


async def hash_(page):
    return await page.evaluate('location.hash')


# ---------------------------------------------------------------- helpers

KEY = 'agent-control-ghpages-v1'


async def patch_state(page, script):
    """Edit the demo's stored workspace (`s`) and reload, to stage what only a live server
    writes: an out-of-job reply, a run paused at a limit, a page request."""
    await page.evaluate('''([key, body]) => {
        const s = JSON.parse(localStorage.getItem(key));
        new Function('s', body)(s);
        localStorage.setItem(key, JSON.stringify(s));
    }''', [KEY, script])
    await page.reload()
    await page.locator(SCREEN).first.wait_for()


async def toast_text(page):
    return await page.locator('#toast').inner_text()


# ---------------------------------------------------------------- scenarios

async def api_state(page):
    return await page.evaluate('() => window.AGENT_API("/api/state")')


def company_bot(state, name):
    return next(b for g in state['groups'] for b in g['bots'] if b['name'] == name)


async def create_bot_from_page(page, base):
    await open_app(page, base)
    await page.locator('#sidebar [data-action="new-bot"]').click()
    assert await hash_(page) == '#new-bot'
    form = page.locator('#new-bot-form')
    await expect(form).to_be_visible()
    await expect(form.locator('input[name=name]')).to_be_focused()
    # Create waits for a name; the first unused colour is already picked.
    create = form.locator('.nb-go')
    await expect(create).to_be_disabled()
    await expect(form.locator('input[name=tint]:checked')).to_have_value('1')
    await form.locator('input[name=name]').fill('Publishing assistant')
    await expect(create).to_be_enabled()
    # A shape and a colour: the live preview follows both.
    await form.locator('.lk-shape[title="Hexagon"]').click()
    await form.locator('.lk-dot:nth-child(8)').click()
    await expect(form.locator('.lk-preview svg')).to_have_attribute('data-shape', 'hexagon')
    await create.click()
    # Lands in the new bot's own chat, which asks for its job.
    await expect(page.locator('#main h1')).to_have_text('Publishing assistant')
    assert (await hash_(page)).startswith('#bot/'), await hash_(page)
    await expect(page.locator('#cv-log .cv-empty')).to_contain_text('Tell it what it should do')
    await expect(page.locator('#toast')).to_contain_text('Publishing assistant is ready')
    await expect(page.locator('#sidebar .crow', has_text='Publishing assistant')).to_have_count(1)
    await expect(page.locator('#sidebar .crow.on')).to_contain_text('Publishing assistant')
    await expect(page.locator('#sidebar .crow.on svg.face')).to_have_attribute('data-shape', 'hexagon')
    made = company_bot(await api_state(page), 'Publishing assistant')
    assert made['settings']['shape'] == 'hexagon' and made['settings']['tint'] == 7, made['settings']
    # The first message is its job, and the bot answers in its own chat.
    await page.locator('#chat-form textarea').fill('Check drafts for unsupported facts.')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.cv-bot .cv-body').last).to_be_visible(timeout=10000)
    made = company_bot(await api_state(page), 'Publishing assistant')
    assert made['instructions'] == 'Check drafts for unsupported facts.', made['instructions']
    await page.reload()
    await expect(page.locator('#main h1')).to_have_text('Publishing assistant')


async def edit_rename_and_move(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer, researcher = ids['Writer'], ids['Researcher']
    await page.locator(f'#sidebar .crow[data-id="{writer}"]').click()
    await page.locator('#main .cv-who').click()
    assert await hash_(page) == f'#profile/{writer}', await hash_(page)
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Writer')
    await expect(page.locator('#main .pr-hero small')).to_have_text('Bot · reports to Atlas')
    # Edit changes the name, and nothing else when nothing else is touched.
    await page.locator('#main .pill-btn', has_text='Edit').click()
    assert await hash_(page) == f'#profile/{writer}/edit', await hash_(page)
    await page.locator('#edit-bot-form input[name=name]').fill('Drafter')
    await page.locator('#edit-bot-form button[type=submit]').click()
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Drafter')
    await expect(page.locator('#sidebar .crow', has_text='Drafter')).to_have_count(1)
    await expect(page.locator('#sidebar .crow', has_text='Writer')).to_have_count(0)
    drafter = company_bot(await api_state(page), 'Drafter')
    assert drafter.get('settings', {}).get('shape') in (None, ''), drafter.get('settings')
    # Move it under a manager from the options menu: Researcher gets its first report.
    await page.locator('#main [data-action="bot-menu"]').click()
    await expect(page.locator('#cmenu')).to_be_visible()
    await page.locator('#cmenu [data-action="menu-move"]').click()
    await page.locator('#cmenu [data-action="menu-move-to"]', has_text='Researcher').click()
    await expect(page.locator('#toast')).to_contain_text('Drafter now reports to Researcher')
    await expect(page.locator('#main .pr-hero small')).to_have_text("Bot · Researcher's team")
    moved = company_bot(await api_state(page), 'Drafter')
    assert moved['settings']['reportsTo'] == researcher, moved['settings']
    # Researcher is a manager now: its profile lists a Team, and the Company chart nests Drafter.
    await page.goto(f'{base}/index.html#profile/{researcher}')
    await page.reload()
    await expect(page.locator('#main .pr-hero small')).to_have_text('Manager · reports to Atlas')
    await expect(page.locator('#main .rw', has_text='Team')).to_contain_text('1 bot')
    await page.goto(f'{base}/index.html#company')
    await page.reload()
    await expect(page.locator('#main .co-tree ul .co-node', has_text='Drafter')).to_have_count(1)
    # Esc leaves a menu before it leaves a page; Esc on the page goes back.
    await page.goto(f'{base}/index.html#profile/{researcher}')
    await page.reload()
    await page.locator('#main [data-action="bot-menu"]').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#cmenu')).to_have_count(0)
    assert await hash_(page) == f'#profile/{researcher}'


async def delete_bot_reports_go_solo(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    researcher, writer, reviewer = ids['Researcher'], ids['Writer'], ids['Reviewer']
    for child in (writer, reviewer):
        await page.evaluate('([g, id, boss]) => window.AGENT_API(`/api/groups/${g}/bots/${id}`, "PATCH", {settings: {reportsTo: boss}})', ['home', child, researcher])
    await page.goto(f'{base}/index.html#profile/{researcher}')
    await page.reload()
    await expect(page.locator('#main .rw', has_text='Team')).to_contain_text('2 bots')
    # Team and the demo's Model value have no page of their own: Team is the Company chart, Model is plain text.
    await expect(page.locator('#main .rw', has_text='Model')).not_to_have_attribute('data-action', re.compile('.'))
    await page.locator('#main .rw', has_text='Team').click()
    assert await hash_(page) == '#company', await hash_(page)
    await page.go_back()
    await page.locator('#main [data-action="bot-menu"]').click()
    await page.locator('#cmenu [data-action="menu-delete"]').click()
    sheet = page.locator('#modal .sheet')
    await expect(sheet).to_contain_text('Delete Researcher?')
    await expect(sheet).to_contain_text("Its job, memory and permissions are deleted. This can't be undone.")
    await expect(sheet).to_contain_text('Its 2 reports move to Solo.')
    await expect(sheet).to_contain_text('Its threads stay.')
    await sheet.get_by_role('button', name='Delete', exact=True).click()
    await expect(page.locator('#toast')).to_contain_text('Researcher deleted')
    # The profile closes, and the bot leaves the list; its reports stay, and are Solo.
    assert await hash_(page) == '#chats', await hash_(page)
    await expect(page.locator('#sidebar .crow', has_text='Researcher')).to_have_count(0)
    await expect(page.locator('#sidebar .crow', has_text='Writer')).to_have_count(1)
    state = await api_state(page)
    for name in ('Writer', 'Reviewer'):
        assert company_bot(state, name)['settings'].get('reportsTo') in (None, ''), company_bot(state, name)['settings']
    assert not any(b['name'] == 'Researcher' for g in state['groups'] for b in g['bots'])


async def atlas_has_no_delete(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await page.goto(f'{base}/index.html#profile/{PRIMARY}')
    await page.reload()
    await expect(page.locator('#main .pr-hero small')).to_have_text('Primary')
    await page.locator('#main [data-action="bot-menu"]').click()
    items = await page.locator('#cmenu [role=menuitem]').all_inner_texts()
    # Atlas starts pinned for everyone, so its pin item is Unpin; it has no Move, Hide or Delete.
    assert items == ['Message Atlas', 'Unpin'], items
    # The chart's row menu for Atlas offers the same two, and a bot offers all five.
    await page.keyboard.press('Escape')
    await page.goto(f'{base}/index.html#company')
    await page.reload()
    await page.locator('#main .co-row', has_text='Atlas').locator('[data-action="bot-menu"]').click()
    assert await page.locator('#cmenu [role=menuitem]').all_inner_texts() == ['Message Atlas', 'Unpin']
    await page.keyboard.press('Escape')
    await page.locator('#main .co-row', has_text='Writer').locator('[data-action="bot-menu"]').click()
    items = await page.locator('#cmenu > [role=menuitem]').all_inner_texts()
    assert items == ['Message Writer', 'Pin', 'Move to…', 'Hide', 'Delete…'], items
    # Pin from the menu puts a bot in the pinned row.
    await page.locator('#cmenu [data-action="menu-pin"]').click()
    await expect(page.locator('#sidebar .pin', has_text='Writer')).to_have_count(1)


async def settings_from_avatar_and_esc(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .rail-me').click()
    assert await hash_(page) == '#settings', await hash_(page)
    dialog = page.locator('#main .st-dlg')
    await expect(dialog).to_be_visible()
    await expect(dialog.locator('.st-nav button')).to_have_text(['General', 'Appearance', 'Models and keys', 'Connectors', 'Permissions', 'Usage', 'Activity', 'Company'])
    # The Bots running switch is the pause switch, and it works in place.
    switch = dialog.locator('[data-pause]')
    await expect(switch).to_have_attribute('aria-checked', 'true')
    await switch.click()
    await expect(switch).to_have_attribute('aria-checked', 'false')
    await expect(dialog.locator('[data-pause-sub]')).to_have_text('Everything is paused')
    await switch.click()
    await expect(switch).to_have_attribute('aria-checked', 'true')
    # Tab stays inside the dialog.
    for _ in range(25):
        await page.keyboard.press('Tab')
        assert await page.evaluate("!!document.activeElement.closest('.st-dlg')"), 'Tab left the Settings dialog'
    await dialog.locator('.st-nav [data-section="conn"]').click()
    await expect(dialog.locator('.st-head h2')).to_have_text('Connectors')
    await expect(dialog).to_contain_text('Connectors need the Node server')
    # Esc closes it and the chat behind it is back.
    await page.keyboard.press('Escape')
    await expect(page.locator('#main .st-dlg')).to_have_count(0)
    assert (await hash_(page)).startswith('#bot/'), await hash_(page)
    # So does the close button and a click outside.
    await page.locator('#sidebar .rail-me').click()
    await page.locator('#main [data-action="settings-close"][aria-label]').click()
    await expect(page.locator('#main .st-dlg')).to_have_count(0)
    await page.locator('#sidebar .rail-me').click()
    await page.mouse.click(1330, 840)
    await expect(page.locator('#main .st-dlg')).to_have_count(0)


async def activity_page_and_counts(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer = ids['Writer']
    # Settings links to Activity and Company; the chips are Left the app, Permissions, Bots, All.
    await page.locator('#sidebar .rail-me').click()
    await page.locator('#main .st-nav [data-action="go-activity"]').click()
    assert await hash_(page) == '#activity', await hash_(page)
    chips = page.locator('#main .ay-chips button')
    await expect(chips).to_have_text(['Left the app', 'Permissions', 'Bots', 'All'])
    await expect(chips.first).to_have_attribute('aria-selected', 'true')
    await expect(page.locator('#ay-list')).to_contain_text('Nothing has left the app yet.')
    # Making bots is logged under Bots, one plain sentence with the bot's name and a time.
    await chips.nth(2).click()
    await expect(chips.nth(2)).to_have_attribute('aria-selected', 'true')
    await expect(page.locator('#ay-list .ay-row', has_text='Writer')).to_have_count(1)
    await expect(page.locator('#ay-list .ay-day').first).to_have_text('Today')
    await chips.nth(3).click()
    assert await page.locator('#ay-list .ay-row').count() >= 3
    # A profile shows its own count, and its Activity page lists only what names it.
    await page.goto(f'{base}/index.html#profile/{writer}')
    await page.reload()
    await expect(page.locator('#main [data-activity-count]')).to_have_text('1')
    await page.locator('#main .rw', has_text='Activity').click()
    await expect(page.locator('#pr-activity .ay-row')).to_have_count(1)
    await expect(page.locator('#pr-activity .ay-row')).to_contain_text('Writer')


async def phone_settings_cards(page, base):
    await open_app(page, base)
    await page.locator('.ch-me').click()
    cards = page.locator('#main .st-phone')
    await expect(cards).to_be_visible()
    # The phone root is the list of sections: the pause switch is behind General, once.
    await expect(cards.locator('.rw', has_text='Bots running')).to_have_count(0)
    await expect(cards.locator('.rw', has_text='General')).to_be_visible()
    await expect(cards.locator('.rw', has_text='Activity')).to_be_visible()
    assert await overflow(page) <= 0
    # A row opens its section; Back returns to the cards; Esc closes the page.
    await cards.locator('.rw', has_text='Permissions').click()
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Permissions')
    await page.locator('#main [data-action="settings-back"]').click()
    await expect(page.locator('#main .st-phone h1')).to_have_text('Settings')
    await page.keyboard.press('Escape')
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    # The phone profile menu is a sheet from the bottom.
    await page.goto(f'{base}/index.html#profile/{PRIMARY}')
    await page.reload()
    await page.locator('#main [data-action="bot-menu"]').click()
    await expect(page.locator('#cmenu.sheet')).to_be_visible()


async def phone_create_bot(page, base):
    await open_app(page, base)
    await page.locator('.ch-new').click()
    await page.locator('#new-bot-form input[name=name]').fill('Market scanner')
    await page.locator('#new-bot-form .lk-shape[title="Drop"]').click()
    await page.locator('#new-bot-form .nb-go').click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'chat')
    await expect(page.locator('#main h1')).to_have_text('Market scanner')
    assert await overflow(page) <= 0
    await page.locator('#main .cv-head .rbtn').first.click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    await expect(page.locator('#main .crow', has_text='Market scanner')).to_have_count(1)
    await expect(page.locator('#main .crow', has_text='Market scanner').locator('svg.face')).to_have_attribute('data-shape', 'drop')


async def out_of_job_card(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer = ids['Writer']
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.chats[{writer!r}] = [
          {{id: 'o1', role: 'user', text: 'Book me a table for Friday', at}},
          {{id: 'o2', role: 'bot', senderId: {writer!r}, senderName: 'Writer', mode: 'ai', kind: 'offjob', botId: {writer!r}, request: 'Book me a table for Friday', text: 'That is not part of my job. I write drafts.', at}},
        ];''')
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    card = page.locator('.cv-card')
    await expect(card).to_have_count(1)
    labels = await card.locator('.btn').all_inner_texts()
    assert labels == ['Do it anyway', 'Ask Atlas', 'Make a new bot'], labels
    # Make a new bot opens the New bot page with the request as the job.
    await card.get_by_role('button', name='Make a new bot').click()
    assert (await hash_(page)).startswith('#new-bot/'), await hash_(page)
    await expect(page.locator('#new-bot-form .nb-job')).to_contain_text('Book me a table for Friday')
    await page.go_back()
    # Ask Atlas starts a thread with the request; the owner's line is written once.
    await page.locator('.cv-card').get_by_role('button', name='Ask Atlas').click()
    await expect(page.locator('#cv-line')).to_have_text(re.compile(r'^Atlas( runs this thread|, | and )'), timeout=10000)
    assert (await hash_(page)).startswith('#thread/'), await hash_(page)
    await expect(page.locator('.cv-me')).to_have_count(1)
    await expect(page.locator('.cv-me')).to_have_text('Book me a table for Friday')
    # Do it anyway runs the same request in the bot's chat and settles the card.
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    await page.locator('.cv-card').get_by_role('button', name='Do it anyway').click()
    await expect(page.locator('.cv-bot .cv-body').last).to_contain_text('Book me a table', timeout=10000)
    await expect(page.locator('.cv-card')).to_have_count(0)


async def checkpoint_and_ask_cards(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer = ids['Writer']
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.chats[{writer!r}] = [{{id: 'c1', role: 'user', text: 'Keep checking with the others', at}}];
        s.groupRuns.unshift({{id: 'run-limit', groupId: 'home', chatKey: {writer!r}, status: 'awaiting_limit', recipients: [{writer!r}], currentStep: 1,
          trace: [{{botId: {writer!r}, output: 'Asked'}}], createdAt: at, limit: {{kind: 'pair', at: 12}}, asks: {{total: 12}}}});''')
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    card = page.locator('.cv-card')
    await expect(card.locator('p')).to_have_text('Bots have sent 12 messages for this task.')
    labels = await card.locator('.btn').all_inner_texts()
    assert labels == ['Keep going', "Keep going, don't ask again", 'Stop'], labels
    # The asking bot's face waits above the card, and the header says so.
    await expect(page.locator('.cv-wait svg.face--waiting')).to_be_visible()
    await expect(page.locator('.cv-wait')).to_contain_text('Writer is waiting on you')
    await expect(page.locator('#cv-line')).to_have_text('Waiting on you')
    await expect(page.locator('.cv-done')).to_have_count(0)  # a paused run shows its card, not a pill
    # A bot's request to open a page is an ask card with the same waiting face.
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.groupRuns = s.groupRuns.filter(r => r.id !== 'run-limit');
        s.browserRequests = [{{id: 'br1', botId: {writer!r}, botName: 'Writer', groupId: 'home', chatKey: {writer!r}, status: 'pending', url: 'https://example.com/', steps: [{{op: 'navigate', url: 'https://example.com/'}}], createdAt: at, updatedAt: at}}];
        s.chats[{writer!r}].push({{id: 'browser-br1', role: 'system', kind: 'browser', text: 'Writer wants to open a page.', at}});''')
    await expect(page.locator('.cv-wait svg.face--waiting')).to_be_visible()
    await expect(page.locator('.cv-card .btn')).to_have_text(['Approve', 'Decline'])
    await expect(page.locator('.cv-card a')).to_have_attribute('rel', 'noopener noreferrer')


async def faces_come_alive(page, base):
    """A chat opens with a hello hop, a first reply hops once, and the hop does not stick."""
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator(f'#sidebar .crow[data-id="{ids["Writer"]}"]').click()
    await expect(page.locator('#main .cv-who .face')).to_have_class(re.compile('face--hop'))
    await expect(page.locator('#main .cv-who .face')).not_to_have_class(re.compile('face--hop'), timeout=3000)
    await expect(page.locator('#main .cv-who .face')).to_have_class(re.compile('face--awake'))
    await page.locator('#chat-form textarea').fill('hi')
    await page.locator('#chat-form textarea').press('Enter')
    reply = page.locator('.cv-bot .face').last
    await expect(reply).to_be_visible(timeout=10000)
    await expect(reply).not_to_have_class(re.compile('face--hop'), timeout=3000)
    # Sleepers breathe, the primary is awake and sways.
    await expect(page.locator('#sidebar .crow .face--asleep')).to_have_count(3)
    await expect(page.locator('#sidebar .pin .face--sway')).to_have_count(1)


async def keyboard_and_escape(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    # Everything is reachable by keyboard: Tab walks the sidebar, Enter opens a bot.
    await page.locator('#rail-q').focus()
    for _ in range(4):
        await page.keyboard.press('Tab')
    focused = await page.evaluate('document.activeElement.dataset.action')
    assert focused in ('open-bot', 'new-bot'), focused
    await page.locator('#sidebar .crow', has_text='Reviewer').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main h1')).to_have_text('Reviewer')
    # Esc leaves the search box and clears what was typed.
    await page.keyboard.press('Control+k')
    await page.keyboard.type('zzz')
    await expect(page.locator('#sidebar .hv-empty')).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#rail-q')).not_to_be_focused()
    await expect(page.locator('#sidebar .hv-empty')).to_have_count(0)


async def phone_search_and_escape(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator('#sq').focus()
    await expect(page.locator('#ch-res')).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#ch-res')).to_be_hidden()
    await expect(page.locator('#sq')).not_to_be_focused()
    # Ctrl+K from inside a chat goes home and lands in the bottom search.
    await page.locator('#main .pin').click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'chat')
    await page.keyboard.press('Control+k')
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    await expect(page.locator('#sq')).to_be_focused()
    # A tap outside closes the results.
    await page.locator('#main').click(position={'x': 200, 'y': 300})
    await expect(page.locator('#ch-res')).to_be_hidden()


# ---------------------------------------------------------------- pin and reorder

async def row_names(page, root='#sidebar'):
    return await page.locator(f'{root} .crow').evaluate_all('els => els.map(e => e.querySelector("b").textContent)')


async def pin_names(page, root='#sidebar'):
    return await page.locator(f'{root} .pin').evaluate_all('els => els.map(e => e.querySelector("span").textContent)')


async def poll_equal(page, read, want, timeout=4000):
    """Wait until `read()` (an async function of nothing) returns `want`; the lists settle after a spring."""
    for _ in range(timeout // 50):
        if await read() == want:
            return
        await page.wait_for_timeout(50)
    assert await read() == want, (await read(), want)


async def drag(page, source, target, to_y=None, to_x=None, steps=14):
    """Press on `source` and move to the middle of `target` (or to a point) in small steps. The button stays down."""
    a = await source.bounding_box()
    await page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2)
    await page.mouse.down()
    if target is None:
        x, y = (a['x'] + a['width'] / 2 if to_x is None else to_x), to_y
    else:
        b = await target.bounding_box()
        x, y = (b['x'] + b['width'] / 2 if to_x is None else to_x), (b['y'] + b['height'] / 2 if to_y is None else to_y)
    await page.mouse.move(x, y, steps=steps)
    return x, y


async def pin_by_menu_and_move_by_keyboard(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    assert await row_names(page) == ['Researcher', 'Writer', 'Reviewer'], await row_names(page)
    # Right-click opens the options menu at the pointer; Pin puts the bot in the pinned row.
    await page.locator('#sidebar .crow', has_text='Writer').click(button='right')
    await expect(page.locator('#cmenu')).to_be_visible()
    assert 'Pin' in await page.locator('#cmenu [role=menuitem]').all_inner_texts()
    await page.locator('#cmenu [data-action="menu-pin"]').click()
    await expect(page.locator('#sidebar .pin', has_text='Writer')).to_have_count(1)
    assert await pin_names(page) == ['Atlas', 'Writer'], await pin_names(page)
    assert await row_names(page) == ['Researcher', 'Reviewer'], await row_names(page)
    # The menu key and Shift+F10 open it from the keyboard; Esc closes it and gives focus back.
    row = page.locator('#sidebar .crow', has_text='Researcher')
    await row.focus()
    await page.keyboard.press('ContextMenu')
    await expect(page.locator('#cmenu')).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#cmenu')).to_have_count(0)
    await expect(row).to_be_focused()
    await page.keyboard.press('Shift+F10')
    await expect(page.locator('#cmenu')).to_be_visible()
    await page.keyboard.press('Escape')
    # Alt+ArrowDown moves the focused row down one place and keeps focus on it. It does not go Back.
    await page.keyboard.press('Alt+ArrowDown')
    await poll_equal(page, lambda: row_names(page), ['Reviewer', 'Researcher'])
    await expect(page.locator('#sidebar .crow', has_text='Researcher')).to_be_focused()
    assert await hash_(page) == '#bot/atlas', await hash_(page)
    # Alt+Left on a pinned face moves it left.
    await page.locator('#sidebar .pin', has_text='Writer').focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await poll_equal(page, lambda: pin_names(page), ['Writer', 'Atlas'])
    # Saved per person under one key each, and still there after a reload.
    saved = await page.evaluate('() => [localStorage.getItem("ac-pins"), localStorage.getItem("ac-order")]')
    assert saved[0] and saved[1], saved
    await page.reload()
    await expect(page.locator('#sidebar .crow').first).to_be_visible()
    assert await pin_names(page) == ['Writer', 'Atlas'], await pin_names(page)
    assert await row_names(page) == ['Reviewer', 'Researcher'], await row_names(page)
    # Alt+ArrowDown on a pinned face unpins it, and Alt+ArrowUp on the first row pins it.
    await page.locator('#sidebar .pin', has_text='Writer').focus()
    await page.keyboard.press('Alt+ArrowDown')
    await poll_equal(page, lambda: pin_names(page), ['Atlas'])
    assert 'Writer' in await row_names(page)
    first = await row_names(page)
    await page.locator('#sidebar .crow', has_text=first[0]).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await poll_equal(page, lambda: pin_names(page), ['Atlas', first[0]])


async def drag_to_pin_reorder_and_unpin(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    # A press and a move drags the whole row: it rides under the pointer and leaves an empty slot.
    shelf = page.locator('#sidebar .shelf')
    edge = (await shelf.bounding_box())
    x, y = await drag(page, page.locator('#sidebar .crow', has_text='Reviewer'), shelf, to_x=edge['x'] + edge['width'] - 20)
    await expect(page.locator('#sidebar .gest-ghost')).to_have_count(1)
    await expect(page.locator('#sidebar .gest-hole')).to_have_count(1)
    await expect(shelf).to_have_class(re.compile('drop-on'))
    ghost = await page.locator('#sidebar .gest-ghost').bounding_box()
    assert abs((ghost['x'] + ghost['width'] / 2) - x) < 90 and abs((ghost['y'] + ghost['height'] / 2) - y) < 90, (ghost, x, y)
    await page.mouse.up()
    await expect(page.locator('#sidebar .gest-ghost')).to_have_count(0)
    # Dropping on the pinned row pins it; the click that ends a drag does not open its chat.
    assert await pin_names(page) == ['Atlas', 'Reviewer'], await pin_names(page)
    assert await hash_(page) == '#bot/atlas', await hash_(page)
    # Drag a pinned face past its neighbour to reorder, then out of the row to unpin.
    faces = page.locator('#sidebar .pin')
    first = await faces.nth(0).bounding_box()
    await drag(page, faces.nth(1), None, to_y=first['y'] + first['height'] / 2, to_x=first['x'] + 6)
    await page.mouse.up()
    await poll_equal(page, lambda: pin_names(page), ['Reviewer', 'Atlas'])
    await drag(page, page.locator('#sidebar .pin', has_text='Reviewer'), page.locator('#sidebar .crow', has_text='Writer'))
    await expect(page.locator('#sidebar .gest-out')).to_have_count(1)
    await page.mouse.up()
    await poll_equal(page, lambda: pin_names(page), ['Atlas'])
    assert 'Reviewer' in await row_names(page)
    # Drag a row to the top of the list: it swaps once the pointer is past the middle of its neighbour.
    top = await page.locator('#sidebar .crow').first.bounding_box()
    last = await row_names(page)
    await drag(page, page.locator('#sidebar .crow', has_text=last[-1]), None, to_y=top['y'] + 18)
    await page.mouse.up()
    await poll_equal(page, lambda: row_names(page), [last[-1], *last[:-1]])
    # A plain click still opens the chat.
    await page.locator('#sidebar .crow', has_text='Researcher').click()
    await expect(page.locator('#main h1')).to_have_text('Researcher')
    # Esc cancels a drag: nothing changes and the row is back.
    before = await row_names(page)
    await drag(page, page.locator('#sidebar .crow', has_text='Reviewer'), page.locator('#sidebar .shelf'))
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('#sidebar .gest-ghost')).to_have_count(0)
    assert await pin_names(page) == ['Atlas'] and await row_names(page) == before


async def drag_onto_a_manager_moves_it_to_the_team(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    # Reviewer reports to Writer, so Writer is a manager and Researcher is dropped on its row.
    await page.evaluate("async ids => { await window.AGENT_API(`/api/groups/home/bots/${ids.Reviewer}`, 'PATCH', {settings: {reportsTo: ids.Writer}}); }", ids)
    await page.reload()
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    manager = page.locator('#sidebar .crow', has_text='Writer')
    await expect(manager).to_have_attribute('data-manager', 'true')
    assert await row_names(page) == ['Researcher', 'Writer', 'Reviewer'], await row_names(page)
    await drag(page, page.locator('#sidebar .crow', has_text='Researcher'), manager)
    await expect(manager).to_have_class(re.compile('drop-on'))
    await page.mouse.up()
    await expect(page.locator('#toast')).to_contain_text('Researcher now reports to Writer')
    assert company_bot(await api_state(page), 'Researcher')['settings']['reportsTo'] == ids['Writer']
    # A manager moves with its reports: Alt+ArrowDown on Writer has no team-mate to pass, so nothing changes.
    await manager.focus()
    await page.keyboard.press('Alt+ArrowDown')
    assert (await row_names(page))[0] == 'Writer', await row_names(page)


async def phone_long_press_menu_and_drag(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await expect(page.locator('#main .crow')).to_have_count(3)
    cdp = await page.context.new_cdp_session(page)

    async def touch(kind, x, y):
        await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y, 'id': 1}]})
    box = await page.locator('#main .crow', has_text='Writer').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    # Touch and hold, then let go without moving: the options sheet comes up from the bottom.
    await touch('touchStart', cx, cy)
    await page.wait_for_timeout(700)
    await expect(page.locator('#main .crow.gest-armed')).to_have_count(1)
    await touch('touchEnd', cx, cy)
    await expect(page.locator('#cmenu.sheet')).to_be_visible()
    assert await hash_(page) in ('', '#chats'), await hash_(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('#cmenu')).to_have_count(0)
    # A swipe with no hold scrolls the page and lifts nothing.
    await touch('touchStart', cx, cy)
    await touch('touchMove', cx, cy - 40)
    await touch('touchEnd', cx, cy - 40)
    await page.wait_for_timeout(500)
    await expect(page.locator('#main .gest-ghost')).to_have_count(0)
    # Touch and hold, then move: it lifts and follows the finger; dropping on the pinned row pins it.
    shelf = await page.locator('#main .shelf').bounding_box()
    goal = shelf['y'] + shelf['height'] / 2
    await touch('touchStart', cx, cy)
    await page.wait_for_timeout(700)
    right = shelf['x'] + shelf['width'] - 24
    for step in range(1, 13):
        await touch('touchMove', cx + (right - cx) * step / 12, cy + (goal - cy) * step / 12)
        await page.wait_for_timeout(16)
    await expect(page.locator('#main .gest-ghost')).to_have_count(1)
    await expect(page.locator('#main .shelf')).to_have_class(re.compile('drop-on'))
    await touch('touchEnd', right, goal)
    await poll_equal(page, lambda: pin_names(page, '#main'), ['Atlas', 'Writer'])
    assert await hash_(page) in ('', '#chats'), await hash_(page)


# ---------------------------------------------------------------- asks, permissions, activity and the pause banner

# A send or post is asked about for the site it is on, so its Always allow is for that site only.
ASKS = [
    ['a1', 'send', 'https://mail.example.com/compose', 'send an email to Northwind'],
    ['a2', 'spend', '', 'pay £40 to Northwind Printing'],
    ['a3', 'post', 'https://social.example.com/new', 'post the draft to the company page'],
]


async def primary_id(page):
    state = await api_state(page)
    return next(b['id'] for g in state['groups'] for b in g['bots'] if b['settings'].get('lead'))


async def seed_asks(page, bot_id, asks=ASKS, name='Researcher'):
    """The demo's bots never ask, so put asks (and the chat lines that carry them) into the stored workspace, the way the server writes them."""
    primary = await primary_id(page)
    script = '''
        const [bot, primary, asks, name] = %s;
        const at = new Date().toISOString();
        s.asks = asks.map(([id, action, target, detail]) => ({id, botId: bot, runId: null, chatKey: bot, action, target, detail, grantScope: target ? new URL(target).origin : '', status: 'pending', scope: null, createdAt: at}));
        const line = (id, text) => ({id: 'ask-' + id, role: 'system', kind: 'ask', askId: id, text, at});
        s.chats[bot] = [...(s.chats[bot] || []), ...asks.map(([id, , , detail]) => line(id, name + ' wants to ' + detail + '.'))];
        s.chats[primary] = [...(s.chats[primary] || []), ...asks.map(([id, , , detail]) => line(id, 'Needs you: ' + name + ' wants to ' + detail + '.'))];
    ''' % json.dumps([bot_id, primary, asks, name])
    await patch_state(page, script)


async def ask_cards_answer_and_collapse(page, base):
    ids = await open_app(page, base, bots={'Researcher': EXTRA_BOTS['Researcher']})
    await seed_asks(page, ids['Researcher'])
    # Three things wait on the owner: the bot's row and Atlas's face both carry the count.
    row = page.locator('#sidebar .crow', has_text='Researcher')
    await expect(row.locator('.badge')).to_have_text('3')
    await expect(page.locator('#sidebar .pin', has_text='Atlas').locator('.badge')).to_have_text('3')
    await row.click()
    cards = page.locator('#cv-log .cv-card[data-ask]')
    await expect(cards).to_have_count(3)
    # One sentence, the three buttons in the owner's words, and the asking bot's face waiting above the card.
    first = page.locator('#cv-log .cv-card[data-ask="a1"]')
    await expect(first.locator('p')).to_have_text('Researcher wants to send an email to Northwind.')
    assert await first.locator('.btn').all_inner_texts() == ['Always allow', 'Allow once', 'Decline']
    await expect(page.locator('#cv-log .cv-wait .face--waiting').first).to_be_visible()
    await expect(page.locator('#cv-log .cv-wait').first).to_contain_text('Researcher is waiting on you')
    # A payment is only ever Decline or Allow, and says so.
    spend = page.locator('#cv-log .cv-card[data-ask="a2"]')
    assert await spend.locator('.btn').all_inner_texts() == ['Allow', 'Decline']
    await expect(spend).to_contain_text('Payments are asked every time.')
    await expect(page.locator('#cv-line')).to_have_text('Waiting on you')
    # Allow once: the card leaves the chat and the count drops.
    await first.get_by_role('button', name='Allow once', exact=True).click()
    await expect(page.locator('#cv-log [data-ask="a1"]')).to_have_count(0)
    await expect(row.locator('.badge')).to_have_text('2')
    state = await api_state(page)
    mine = {a['id']: a for a in state['asks']}
    assert mine['a1']['status'] == 'allowed' and mine['a1']['scope'] == 'once', mine['a1']
    assert not [g for g in state.get('grants', []) if g['action'] == 'send'], 'Allow once stores no grant'
    # Always allow: the card leaves too, and the grant is kept for this bot.
    await page.locator('#cv-log .cv-card[data-ask="a3"]').get_by_role('button', name='Always allow', exact=True).click()
    await expect(page.locator('#cv-log [data-ask="a3"]')).to_have_count(0)
    grants = [(g['botId'], g['action'], g['choice']) for g in (await api_state(page))['grants']]
    assert (ids['Researcher'], 'post', 'always') in grants, grants
    # Decline.
    await spend.get_by_role('button', name='Decline').click()
    # Nothing is left: no card, no line about it, no badge, no second ask.
    await expect(page.locator('#cv-log [data-ask]')).to_have_count(0)
    await expect(row.locator('.badge')).to_have_count(0)
    await expect(page.locator('#cv-line')).not_to_have_text('Waiting on you')
    # Atlas's copy of each card is gone as well.
    await page.locator('#sidebar .pin', has_text='Atlas').click()
    await expect(page.locator('#cv-log [data-ask]')).to_have_count(0)
    # The Always allow is a rule on the profile.
    await page.goto(f'{base}/index.html#profile/{ids["Researcher"]}/permissions')
    await page.reload()
    await expect(page.locator('#main .gr', has_text='Post').locator('button[aria-pressed="true"]')).to_have_text('Always allow')


async def permissions_edit_in_place_and_deny(page, base):
    ids = await open_app(page, base, bots={'Researcher': EXTRA_BOTS['Researcher'], 'Writer': EXTRA_BOTS['Writer']})
    r, w = ids['Researcher'], ids['Writer']
    grants = [[r, 'browser.use', 'https://example.com', 'always'], [r, 'spend', '', 'ask'], [r, 'send', 'https://mail.example.com', 'always'], [w, 'post', 'https://social.example.com', 'ask']]
    await patch_state(page, 's.grants = %s.map(([botId, action, scope, choice]) => ({botId, action, scope, choice, at: new Date().toISOString()}));' % json.dumps(grants))
    await page.goto(f'{base}/index.html#profile/{r}')
    await page.reload()
    await expect(page.locator('#main .rw', has_text='Permissions').locator('.pv')).to_have_text('3 rules')
    await page.locator('#main .rw', has_text='Permissions').click()
    # The rules are listed once, in Settings, filtered to this bot; the chip says so and clears the filter.
    assert await hash_(page) == f'#settings/perm%2F{r}', await hash_(page)
    await expect(page.locator('#main .st-chip')).to_contain_text('Showing Researcher')
    rows = page.locator('#main .gr')
    await expect(rows).to_have_count(3)
    assert [t.split('\n')[0] for t in await rows.all_inner_texts()] == ['Open example.com', 'Send on mail.example.com', 'Spend money']
    # Every rule has the three choices; a payment never has Always allow.
    assert await rows.nth(0).locator('button').all_inner_texts() == ['Always allow', 'Ask each time', 'Deny']
    assert await rows.nth(2).locator('button').all_inner_texts() == ['Ask each time', 'Deny']
    await expect(rows.nth(0).locator('button[aria-pressed="true"]')).to_have_text('Always allow')
    # Edited in place: Deny, and the profile shows it at once.
    await rows.nth(0).get_by_role('button', name='Deny').click()
    await expect(page.locator('#main .gr').nth(0).locator('button[aria-pressed="true"]')).to_have_text('Deny')
    await expect(page.locator('#toast')).to_contain_text('Researcher: deny.')
    assert [g for g in (await api_state(page))['grants'] if g['action'] == 'browser.use'][0]['choice'] == 'deny'
    # A payment can be set to Deny but never to Always allow: there is no button, and the server refuses it too.
    await page.locator('#main .gr').nth(2).get_by_role('button', name='Deny').click()
    await expect(page.locator('#main .gr').nth(2).locator('button[aria-pressed="true"]')).to_have_text('Deny')
    refused = await page.evaluate('''botId => window.AGENT_API('/api/grants', 'POST', {botId, action: 'spend', choice: 'always'}).then(() => 'accepted', e => e.message)''', r)
    assert refused != 'accepted', refused
    # Show all clears the filter: every bot's rules, one card each, edited in place.
    await page.locator('#main .st-chip').get_by_role('button', name='Show all').click()
    assert await hash_(page) == '#settings/perm', await hash_(page)
    await expect(page.locator('#main .st-chip')).to_have_count(0)
    dlg = page.locator('.st-dlg')
    await expect(dlg.locator('.st-h', has_text='Researcher')).to_be_visible()
    await expect(dlg.locator('.st-h', has_text='Writer')).to_be_visible()
    await expect(dlg.locator('.gr')).to_have_count(4)
    await dlg.locator('.gr', has_text='Post').get_by_role('button', name='Always allow').click()
    await expect(dlg.locator('.gr', has_text='Post').locator('button[aria-pressed="true"]')).to_have_text('Always allow')
    # The log keeps the changes under Permissions; Left the app does not show them.
    await page.goto(f'{base}/index.html#activity')
    await page.reload()
    chips = page.locator('#main .ay-chips button')
    await expect(chips).to_have_text(['Left the app', 'Permissions', 'Bots', 'All'])
    await chips.nth(1).click()
    await expect(page.locator('#ay-list .ay-row', has_text='not allowed to open example.com')).to_have_count(1)
    await chips.nth(0).click()
    await expect(page.locator('#ay-list .ay-row')).to_have_count(0)


async def pause_banner_and_resume(page, base):
    await open_app(page, base)
    banner = page.locator('#pause')
    await expect(banner).to_be_hidden()
    await page.locator('#sidebar [data-action="open-settings"]').click()
    await page.locator('.st-dlg [data-pause]').click()
    await expect(banner).to_be_visible()
    await expect(banner.locator('.pause-t')).to_have_text('All bots are paused. Nothing runs until you resume.')
    assert (await api_state(page))['guard']['paused'] is True
    await page.keyboard.press('Escape')
    # The bar sits above the app, and the app sits under it (after its slide in).
    await page.wait_for_timeout(450)
    box, shell = await banner.bounding_box(), await page.locator('#main').bounding_box()
    assert box['y'] == 0 and shell['y'] >= box['height'] - 1, (box, shell)
    await page.reload()
    await expect(banner).to_be_visible()
    await page.locator('#sidebar .crow, #sidebar .pin').first.click()
    await expect(banner).to_be_visible()
    # Resume lifts it.
    await banner.get_by_role('button', name='Resume').click()
    await expect(banner).to_be_hidden()
    await expect(page.locator('#toast')).to_contain_text('Bots are running again.')
    assert (await api_state(page))['guard']['paused'] is False
    assert (await page.locator('#main').bounding_box())['y'] == 0


async def phone_ask_card_permissions_and_pause(page, base):
    ids = await open_app(page, base, bots={'Researcher': EXTRA_BOTS['Researcher']})
    await seed_asks(page, ids['Researcher'], asks=ASKS[:2])
    await page.goto(f'{base}/index.html#bot/{ids["Researcher"]}')
    await page.reload()
    await expect(page.locator('#cv-log .cv-card[data-ask]')).to_have_count(2)
    assert await overflow(page) <= 0, await overflow(page)
    buttons = page.locator('#cv-log .cv-card[data-ask="a1"] .btn')
    for i in range(3):
        box = await buttons.nth(i).bounding_box()
        assert box['height'] >= 40 and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
    await page.locator('#cv-log .cv-card[data-ask="a1"]').get_by_role('button', name='Always allow', exact=True).click()
    await expect(page.locator('#cv-log [data-ask="a1"]')).to_have_count(0)
    # Permissions on a phone: full-width choices a thumb can hit.
    await page.goto(f'{base}/index.html#profile/{ids["Researcher"]}/permissions')
    await page.reload()
    row = page.locator('#main .gr').first
    await expect(row.locator('button[aria-pressed="true"]')).to_have_text('Always allow')
    for i in range(3):
        box = await row.locator('button').nth(i).bounding_box()
        assert box['height'] >= 40 and box['x'] + box['width'] <= 390, box
    await row.get_by_role('button', name='Deny').click()
    await expect(page.locator('#main .gr').first.locator('button[aria-pressed="true"]')).to_have_text('Deny')
    assert await overflow(page) <= 0
    # The pause banner sits above the phone chrome, and Resume is a thumb-sized button.
    await page.evaluate('() => window.AGENT_API("/api/guard", "POST", {paused: true})')
    await page.goto(f'{base}/index.html#chats')
    await page.reload()
    banner = page.locator('#pause')
    await expect(banner).to_be_visible()
    box, me = await banner.bounding_box(), await page.locator('.ch-me').bounding_box()
    assert me['y'] >= box['y'] + box['height'], (box, me)
    go = await banner.get_by_role('button', name='Resume').bounding_box()
    assert go['height'] >= 34 and go['x'] + go['width'] <= 390, go
    assert await overflow(page) <= 0
    await banner.get_by_role('button', name='Resume').click()
    await expect(banner).to_be_hidden()


# ---------------------------------------------------------------- the Computer view

def page_picture(hot=0, w=1280, h=800):
    """A 1280x800 stand-in for a mail page, as a PNG data URL (the real device sends JPEG): a header band
    and five rows, one of them highlighted. Built per band, so it takes milliseconds."""
    import base64
    import struct
    import zlib

    def band(segments, fill):
        row = bytearray(bytes(fill) * w)
        for x0, x1, colour in segments:
            row[x0 * 3:x1 * 3] = bytes(colour) * (x1 - x0)
        return b'\x00' + bytes(row)

    paper, line, ink, mint = (251, 250, 248), (236, 234, 228), (200, 198, 192), (190, 232, 214)
    plain = band([], paper)
    head = band([], (34, 38, 43))
    tops = [120 + 110 * i for i in range(5)]
    bars = []
    for i in range(5):
        fill = mint if i == hot else paper
        long_row = band([(60, 100, (106, 75, 214)), (130, 130 + 360 - i * 30, ink), (130, 130 + 640 - i * 60, line)], fill)
        short_row = band([(130, 130 + 520 - i * 40, ink)], fill)
        bars.append((long_row, short_row))
    raw = bytearray()
    for y in range(h):
        if y < 80:
            raw += head
            continue
        for i, top in enumerate(tops):
            if top <= y < top + 90:
                raw += bars[i][0] if (y - top) % 44 < 22 else bars[i][1]
                break
        else:
            raw += plain

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b'')
    return 'data:image/png;base64,' + base64.b64encode(png).decode()


async def eventually(check, timeout=6.0):
    """Wait until `check()` (a plain value or an awaitable) is true. Python's expect has no poll."""
    end = asyncio.get_event_loop().time() + timeout
    while True:
        value = check()
        if hasattr(value, '__await__'):
            value = await value
        if value:
            return
        assert asyncio.get_event_loop().time() < end, 'the condition never held'
        await asyncio.sleep(0.05)


class Live:
    """A stand-in for the device and the routes /api/browser-live*, answered through page.route.
    The page's own transport is pointed at fetch for those paths (see route_live)."""

    def __init__(self, bot, **kw):
        self.bot, self.agent, self.state, self.seq, self.hot = bot, True, 'browsing', 1, 0
        self.url, self.title, self.notice = 'https://mail.google.com/mail/u/0/#inbox', 'Inbox', None
        self.pages = [
            {'url': 'https://mail.google.com/mail/u/0/#inbox', 'title': 'Inbox', 'at': '2026-11-11T10:00:00.000Z'},
            {'url': 'https://mail.google.com/mail/u/0/#inbox/northwind', 'title': 'Northwind: a time next week?', 'at': '2026-11-11T10:01:00.000Z'},
            {'url': 'https://calendar.google.com/calendar/r/week', 'title': None, 'at': '2026-11-11T10:02:00.000Z'},
        ]
        self.posts, self.frame_polls, self.list_polls = [], 0, 0
        self.__dict__.update(kw)

    def entry(self):
        site = None if self.state == 'idle' else re.sub(r'^https?://([^/]+).*$', r'\1', self.url or '') or None
        return {'botId': self.bot, 'state': self.state, 'url': self.url, 'title': self.title, 'site': site, 'pages': self.pages,
                'runId': None, 'requestId': None, 'live': self.agent}

    def inputs(self):
        return [body for path, body in self.posts if path.endswith('/input')]

    async def handle(self, route):
        request = route.request
        path = re.sub(r'^https?://[^/]+', '', request.url).split('?')[0]
        method, body = request.method, (json.loads(request.post_data) if request.post_data else None)

        async def reply(data, status=200):
            await route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if path == '/api/browser-live' and method == 'GET':
            self.list_polls += 1
            return await reply([self.entry()])
        if path == f'/api/browser-live/{self.bot}' and method == 'GET':
            self.frame_polls += 1
            after = int(re.search(r'after=(\d+)', request.url).group(1)) if 'after=' in request.url else 0
            out = {'botId': self.bot, 'agent': self.agent, 'seq': self.seq if self.agent else 0, 'changed': self.agent and after != self.seq,
                   'state': self.state, 'url': self.url, 'title': self.title, 'site': self.entry()['site']}
            if self.agent:
                out.update(w=1280, h=800, at=1)
                if out['changed']:
                    out['image'] = page_picture(self.hot)
            if self.notice:
                out['notice'] = self.notice
            return await reply(out)
        self.posts.append((path, body))
        if path == f'/api/browser-live/{self.bot}/takeover':
            if not self.agent:
                return await reply({'error': 'The local agent is not running the shared browser right now, so there is nothing to take over. Start it with AGENT_BROWSER=1 and try again.'}, 409)
            self.state = 'driving'
            return await reply({'botId': self.bot, 'state': 'driving'})
        if path == f'/api/browser-live/{self.bot}/handback':
            self.state = 'browsing'
            return await reply({'botId': self.bot, 'state': 'browsing'})
        if path == f'/api/browser-live/{self.bot}/input':
            if self.state != 'driving':
                return await reply({'error': 'Take over the browser before you click or type in it.'}, 409)
            return await reply({'ok': True})
        return await reply({'error': 'unexpected'}, 404)


VIA_FETCH = """(() => {
    let real;
    const viaFetch = (path, method, body) => {
        const verb = method || 'GET', options = {method: verb, headers: {'Content-Type': 'application/json'}};
        if (body !== undefined && verb !== 'GET') options.body = JSON.stringify(body);
        return fetch(path, options).then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw Object.assign(new Error(data.error || 'HTTP ' + r.status), {status: r.status});
            return data;
        });
    };
    Object.defineProperty(window, 'AGENT_API', {configurable: true,
        get: () => (path, method, body) => String(path).startsWith('/api/browser-live') ? viaFetch(path, method, body) : real(path, method, body),
        set: v => { real = v; }});
})()"""


async def route_live(page, live):
    """Answer /api/browser-live* from `live`. The static build's transport is the browser-local one, so
    those paths are pointed at fetch (which page.route answers) before any page script runs; every other
    path still goes to the demo."""
    await page.add_init_script(VIA_FETCH)
    await page.route('**/api/browser-live**', live.handle)


async def open_computer(page, base, name='Writer', **kw):
    """The company with one extra bot and the stub installed. Returns the stub and the bot's id."""
    live = Live(None, **kw)
    await route_live(page, live)
    ids = await open_app(page, base, bots={name: EXTRA_BOTS[name]})
    live.bot = ids[name]
    return live, ids[name]


async def goto_profile(page, bot, sub=''):
    await page.locator(f'#sidebar .crow[data-id="{bot}"]').click()
    await page.locator('#main .cv-who').click()
    await expect(page.locator('#main .pr-hero')).to_be_visible()
    if sub:
        await page.locator('#main .rw', has_text='Computer').click()
        assert await hash_(page) == f'#profile/{bot}/{sub}', await hash_(page)


async def computer_row_frame_and_pages(page, base):
    live, bot = await open_computer(page, base)
    await goto_profile(page, bot)
    # The row reads the list: Browsing, from the stub (it said Idle before the first poll).
    row = page.locator('#main .rw', has_text='Computer')
    await expect(row.locator('[data-computer-row]')).to_have_text('Browsing')
    await row.click()
    assert await hash_(page) == f'#profile/{bot}/computer', await hash_(page)
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Computer')
    # A frame arrives, with the address and the line under it.
    img = page.locator('#main .pc-img')
    await expect(img).to_be_visible()
    assert (await img.get_attribute('src')).startswith('data:image/png;base64,')
    assert await img.evaluate('i => i.naturalWidth') == 1280
    await expect(page.locator('#main .pc-url')).to_have_value('https://mail.google.com/mail/u/0/#inbox')
    await expect(page.locator('#main .pc-url')).to_have_js_property('readOnly', True)
    # The whole screen is the tab; one pill says who is in control, the page it is on, and the one switch.
    await page.wait_for_timeout(400)   # the view's opening animation
    pc = await page.locator('#main .pc').bounding_box()
    assert pc['x'] == 0 and pc['y'] == 0 and pc['width'] == page.viewport_size['width'] and pc['height'] == page.viewport_size['height'], pc
    await expect(page.locator('#main .pc-who b')).to_have_text('Writer is in control')
    await expect(page.locator('#main .pc-line')).to_have_text('Inbox')
    await expect(page.locator('#main .pc-dot')).to_have_class(re.compile('live'))
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_have_text('Take control')
    await expect(page.locator('#main .pc-pill button:visible')).to_have_count(2)
    # The poll asks for what is new: a second frame replaces the picture.
    first = await img.get_attribute('src')
    live.seq, live.hot = 2, 3
    await eventually(lambda: img.evaluate('(i, f) => i.getAttribute("src") !== f', first))
    # Idle dims the picture and the line says when it was last used; the pages become the last run's.
    live.state = 'idle'
    await expect(page.locator('#main .pc-line')).to_contain_text('Idle · last used')
    await expect(page.locator('#main .pc-screen')).to_have_class(re.compile('idle'))
    # Leaving the view (its close button) stops the poll: the device only casts while somebody looks.
    await page.locator('#main [data-action="computer-close"]').click()
    await page.wait_for_timeout(500)
    seen = live.frame_polls
    await page.wait_for_timeout(1200)
    assert live.frame_polls == seen, (seen, live.frame_polls)
    await expect(page.locator('#main .rw', has_text='Computer').locator('[data-computer-row]')).to_have_text('Idle', timeout=8000)


async def computer_take_over_drives_the_page(page, base):
    live, bot = await open_computer(page, base)
    await goto_profile(page, bot, 'computer')
    await expect(page.locator('#main .pc-img')).to_be_visible()
    stage = page.locator('#main .pc-screen')
    # Before Take over a click on the picture does nothing but say what to press.
    await page.locator('#main .pc-img').click()
    await expect(page.locator('#toast')).to_contain_text('Press Take control')
    assert live.inputs() == []
    await page.locator('#main [data-action="computer-takeover"]').click()
    await expect(page.locator('#main [data-action="computer-handback"]')).to_have_text('Hand back control')
    assert any(path.endswith('/takeover') for path, _ in live.posts)
    await expect(page.locator('#main .pc-who b')).to_have_text('You are in control')
    await expect(page.locator('#main .pc-dot')).to_have_class(re.compile('you'))
    await expect(stage).to_be_focused()
    # A click goes in 1280x800 page pixels: the middle of the picture is (640, 400).
    box = await page.locator('#main .pc-img').bounding_box()
    await page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    await eventually(lambda: len([e for e in live.inputs() if e['type'] == 'click']) == 1)
    click = [e for e in live.inputs() if e['type'] == 'click'][0]
    assert abs(click['x'] - 640) <= 2 and abs(click['y'] - 400) <= 2, click
    await page.mouse.click(box['x'] + 1, box['y'] + 1)
    await eventually(lambda: len([e for e in live.inputs() if e['type'] == 'click']) == 2)
    corner = [e for e in live.inputs() if e['type'] == 'click'][1]
    assert corner['x'] <= 4 and corner['y'] <= 4, corner
    # Keys: letters are typed (joined), named keys are pressed, and Esc goes to the page, not out of the view.
    await page.keyboard.type('hi there')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await eventually(lambda: [e for e in live.inputs() if e['type'] in ('type', 'key')][-1:] == [{'type': 'key', 'key': 'Escape'}])
    typed = ''.join(e['text'] for e in live.inputs() if e['type'] == 'type')
    assert typed == 'hi there', typed
    assert {'type': 'key', 'key': 'Enter'} in live.inputs()
    assert await hash_(page) == f'#profile/{bot}/computer', await hash_(page)
    # '/' and 't' are the app's search shortcuts everywhere else; here they are typed into the page.
    await page.keyboard.type('t/')
    await eventually(lambda: ''.join(e['text'] for e in live.inputs() if e['type'] == 'type') == 'hi theret/')
    assert not await page.evaluate("!!document.activeElement.closest('#sidebar, #chrome')")
    # The wheel scrolls the page, and the page itself stays put.
    await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    await page.mouse.wheel(0, 100)
    await eventually(lambda: any(e['type'] == 'scroll' for e in live.inputs()))
    scroll = [e for e in live.inputs() if e['type'] == 'scroll'][0]
    # The picture fills the screen, so a turn is scaled by page pixels per displayed pixel.
    assert scroll['dy'] > 50 and abs(scroll['x'] - 640) <= 2, scroll
    # The keyboard button opens the tray: the address field takes a URL; Go (or Enter) sends it.
    await page.locator('#main [data-action="computer-tray"]').click()
    url = page.locator('#main .pc-url')
    await expect(url).to_have_js_property('readOnly', False)
    await url.fill('example.com')
    await page.locator('#main .pc-go').click()
    await eventually(lambda: [e for e in live.inputs() if e['type'] == 'navigate'] == [{'type': 'navigate', 'url': 'https://example.com/'}])
    # After Go the keys go back to the page; an address that is not a web address is refused in a toast.
    await expect(stage).to_be_focused()
    await url.fill('two words')
    await url.press('Enter')
    await expect(page.locator('#toast')).to_contain_text('Type a web address')
    # Phones have no keyboard on the picture: a field and key buttons send the same events.
    await page.locator('#main .pc-type input').fill('abc')
    await page.locator('#main .pc-type button').click()
    await page.locator('#main .pc-key[data-text="Tab"]').click()
    await eventually(lambda: {'type': 'key', 'key': 'Tab'} in live.inputs())
    assert ''.join(e['text'] for e in live.inputs() if e['type'] == 'type').endswith('abc')


async def computer_hand_back(page, base):
    live, bot = await open_computer(page, base)
    await goto_profile(page, bot, 'computer')
    await page.locator('#main [data-action="computer-takeover"]').click()
    await page.locator('#main [data-action="computer-tray"]').click()
    await expect(page.locator('#main .pc-tray')).to_be_visible()
    await page.locator('#main [data-action="computer-handback"]').click()
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_have_text('Take control')
    assert live.posts[-1][0].endswith('/handback')
    await expect(page.locator('#toast')).to_contain_text('Writer has the browser back')
    await expect(page.locator('#main .pc-tray')).to_be_hidden()
    await expect(page.locator('#main .pc-who b')).to_have_text('Writer is in control')
    await expect(page.locator('#main .pc-line')).to_have_text('Inbox')
    await expect(page.locator('#main .pc-url')).to_have_js_property('readOnly', True)
    # Nothing is sent once the bot has it: a click on the picture sends no input.
    before = len(live.inputs())
    await page.locator('#main .pc-img').click()
    assert len(live.inputs()) == before
    # Esc is the app's again: it leaves the view for the profile, where the row says Browsing.
    await page.locator('#main .pc-screen').evaluate('n => n.blur()')
    await page.keyboard.press('Escape')
    await expect(page.locator('#main .pr-hero')).to_be_visible()
    await expect(page.locator('#main .rw', has_text='Computer').locator('[data-computer-row]')).to_have_text('Browsing')


async def computer_no_device_empty_state(page, base):
    live, bot = await open_computer(page, base, agent=False, state='idle', pages=[])
    await goto_profile(page, bot, 'computer')
    veil = page.locator('#main .pc-veil')
    await expect(veil).to_be_visible()
    await expect(veil).to_contain_text('No device is running the shared browser')
    await expect(veil).to_contain_text('AGENT_BROWSER=1')
    await expect(veil.locator('code')).to_have_text('AGENT_BROWSER=1 node agent/agent.mjs run')
    await expect(page.locator('#main .pc-img')).to_be_hidden()
    await expect(page.locator('#main .pc-who b')).to_have_text('No browser running')
    # Nothing to take control of until a device runs the browser.
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_be_hidden()
    # A notice from the device is shown as it came, and once the agent starts the poll finds it.
    live.notice = 'The takeover could not start: no Chrome found.'
    await expect(page.locator('#main .pc-notice')).to_have_text('The takeover could not start: no Chrome found.', timeout=8000)
    live.notice, live.agent, live.state = None, True, 'browsing'
    await expect(page.locator('#main .pc-img')).to_be_visible(timeout=8000)
    await expect(veil).to_be_hidden()
    await expect(page.locator('#main .pc-notice')).to_be_hidden()


async def computer_demo_has_no_browser(page, base):
    ids = await open_app(page, base, bots={'Writer': EXTRA_BOTS['Writer']})
    await page.goto(f'{base}/index.html#profile/{ids["Writer"]}/computer')
    await page.reload()
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Computer')
    veil = page.locator('#main .pc-veil')
    await expect(veil).to_contain_text('The demo has no browser')
    await expect(veil).to_contain_text('local agent')
    await expect(page.locator('#main .pc-who b')).to_have_text('No browser in the demo')
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_be_hidden()
    await expect(page.locator('#main .pc-img')).to_be_hidden()
    # Atlas browses like every bot, so it has a Computer row and the page behind it.
    await page.goto(f'{base}/index.html#profile/{PRIMARY}')
    await page.reload()
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Atlas')
    await expect(page.locator('#main .rw', has_text='Computer')).to_have_count(1)
    await page.goto(f'{base}/index.html#profile/{PRIMARY}/computer')
    await page.reload()
    await expect(page.locator('#main .pc-who b')).to_have_text('No browser in the demo')

async def computer_site_chip_on_the_pill(page, base):
    live, bot = await open_computer(page, base)
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.chats[{bot!r}] = [{{id: 'c1', role: 'user', text: 'Check my mail', at}}];
        s.groupRuns.unshift({{id: 'run-web', groupId: 'home', chatKey: {bot!r}, status: 'running', recipients: [{bot!r}], currentStep: 0, trace: [], createdAt: at}});
        s.browserRequests = [{{id: 'br9', botId: {bot!r}, botName: 'Writer', groupId: 'home', runId: 'run-web', chatKey: {bot!r}, status: 'dispatched', url: 'https://mail.google.com/mail/u/0/#inbox', steps: [], createdAt: at, updatedAt: at}}];''')
    await page.goto(f'{base}/index.html#bot/{bot}')
    await page.reload()
    chip = page.locator('#cv-log .cv-live .pchip')
    await expect(chip).to_be_visible()
    await expect(chip).to_have_text('mail.google.com')
    await expect(chip).to_have_attribute('aria-label', "Watch Writer's browser, on mail.google.com")
    # It opens that bot's live view.
    await chip.click()
    assert await hash_(page) == f'#profile/{bot}/computer', await hash_(page)
    await expect(page.locator('#main .pc-img')).to_be_visible()
    # While you hold the browser the line says so, and the chip stays.
    await page.locator('#main [data-action="computer-takeover"]').click()
    await page.go_back()
    await expect(page.locator('#cv-log .cv-live .cv-cur')).to_have_text('You are driving')
    await expect(page.locator('#cv-log .cv-live .pchip')).to_have_text('mail.google.com')
    # A finished request has no chip.
    await patch_state(page, "s.browserRequests.forEach(r => { r.status = 'done'; });")
    await expect(page.locator('#cv-log .pchip')).to_have_count(0)


async def chat_hops_fold_into_one_line(page, base):
    """A run's bot-to-bot messages are one line that updates and opens; browsing and connector use are not shown."""
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    r, w = ids['Researcher'], ids['Writer']
    await patch_state(page, f'''
        const t = n => new Date(Date.now() - 60000 + n * 1000).toISOString();
        s.chats[{PRIMARY!r}] = [
          {{id: 'q', role: 'user', text: 'Find papers and sum them up', at: t(1)}},
          {{id: 'h1', role: 'bot', senderId: {PRIMARY!r}, senderName: 'Atlas', toBotId: {r!r}, runId: 'run-hops', text: 'Researcher, find three papers.', at: t(2)}},
          {{id: 'x1', role: 'system', kind: 'browser-result', text: 'Browser result for Researcher: Papers · https://example.org', at: t(3)}},
          {{id: 'x2', role: 'system', text: 'Researcher already has that page, so it was not opened again.', at: t(3)}},
          {{id: 'x3', role: 'system', kind: 'connector', text: 'Researcher used Notes: search.', at: t(3)}},
          {{id: 'h2', role: 'bot', senderId: {r!r}, senderName: 'Researcher', toBotId: {w!r}, runId: 'run-hops', text: 'Here are three papers.', at: t(4)}}];
        s.groupRuns.unshift({{id: 'run-hops', groupId: 'home', chatKey: {PRIMARY!r}, status: 'running', recipients: [{PRIMARY!r}, {r!r}, {w!r}, {PRIMARY!r}], currentStep: 2, createdAt: t(1),
          trace: [{{botId: {PRIMARY!r}, output: 'Researcher, find three papers.', toBotId: {r!r}}}, {{botId: {r!r}, output: 'Here are three papers.', toBotId: {w!r}}}]}});''')
    await page.goto(f'{base}/index.html#bot/{PRIMARY}')
    await page.reload()
    line = page.locator('#cv-log .cv-going summary')
    await expect(line.locator('.cv-cur')).to_have_text('Checking with Writer')
    await expect(page.locator('#cv-log .cv-bot')).to_have_count(0)
    for words in ('Browser result', 'already has that page', 'used Notes', 'read Papers'):
        await expect(page.locator('#cv-log', has_text=words)).to_have_count(0)
    # Collapsed by default; the keyboard opens it, and the hops read who wrote to whom.
    await expect(page.locator('#cv-log .cv-plog')).not_to_be_visible()
    await line.focus()
    await page.keyboard.press('Enter')
    hops = page.locator('#cv-log .cv-plog li')
    await expect(hops).to_have_count(2)
    await expect(hops.nth(1)).to_contain_text('Researcher')
    await expect(hops.nth(1)).to_contain_text('to Writer')
    await expect(hops.nth(1)).to_contain_text('Here are three papers.')
    assert await page.evaluate('() => document.documentElement.scrollWidth - innerWidth') <= 0
    # Done: one quiet line with the latest hop, and the final answer is the only bubble.
    await patch_state(page, f'''
        const run = s.groupRuns.find(x => x.id === 'run-hops'), at = new Date().toISOString();
        run.status = 'completed'; run.currentStep = 4;
        run.trace.push({{botId: {w!r}, output: 'Summary drafted.', toBotId: {PRIMARY!r}}}, {{botId: {PRIMARY!r}, output: 'Here is the summary.'}});
        s.chats[{PRIMARY!r}].push({{id: 'h3', role: 'bot', senderId: {w!r}, senderName: 'Writer', toBotId: {PRIMARY!r}, runId: 'run-hops', text: 'Summary drafted.', at}},
          {{id: 'f', role: 'bot', senderId: {PRIMARY!r}, senderName: 'Atlas', runId: 'run-hops', text: 'Here is the summary.', at}},
          {{id: 'run-hops-completed', role: 'system', runId: 'run-hops', text: 'Done in 4 step(s).', at}});''')
    done = page.locator('#cv-log .cv-done summary')
    await expect(done).to_contain_text('Writer messaged Atlas')
    await expect(page.locator('#cv-log .cv-bot')).to_have_count(1)
    await expect(page.locator('#cv-log .cv-bot')).to_contain_text('Here is the summary.')
    await expect(page.locator('#cv-log', has_text='Done in 4 step')).to_have_count(0)
    await done.click()
    await expect(page.locator('#cv-log .cv-plog li')).to_have_count(3)
    assert await page.evaluate('() => document.documentElement.scrollWidth - innerWidth') <= 0


async def phone_computer_view(page, base):
    live, bot = await open_computer(page, base)
    await page.goto(f'{base}/index.html#profile/{bot}/computer')
    await page.reload()
    await expect(page.locator('#main .pc-img')).to_be_visible()
    # The tab takes the whole phone screen; the pill fits inside it with thumb-sized controls.
    await page.wait_for_timeout(400)   # the view's opening animation
    box = await page.locator('#main .pc').bounding_box()
    assert box['x'] == 0 and box['width'] == 390, box
    pill = await page.locator('#main .pc-pill').bounding_box()
    assert pill['x'] >= 0 and pill['x'] + pill['width'] <= 390, pill
    assert await overflow(page) <= 0, await overflow(page)
    take = await page.locator('#main [data-action="computer-takeover"]').bounding_box()
    assert take['height'] >= 36, take
    await page.locator('#main [data-action="computer-takeover"]').click()
    await page.locator('#main [data-action="computer-tray"]').click()
    await expect(page.locator('#main .pc-tray')).to_be_visible()
    assert await overflow(page) <= 0, await overflow(page)
    for key in await page.locator('#main .pc-key').all():
        k = await key.bounding_box()
        assert k['height'] >= 40 and k['x'] >= 0 and k['x'] + k['width'] <= 390, k
    # A tap on the picture is a click on the page.
    img = await page.locator('#main .pc-img').bounding_box()
    await page.mouse.click(img['x'] + img['width'] / 2, img['y'] + img['height'] / 2)
    await eventually(lambda: len([e for e in live.inputs() if e['type'] == 'click']) == 1)


# ---------------------------------------------------------------- connectors, subscriptions, and their chat lines

def via_fetch(prefixes):
    """Like VIA_FETCH, for these path prefixes: the static build's transport is browser-local, so a page.route
    cannot see it. Those paths go to fetch (which page.route answers); everything else still goes to the demo."""
    return VIA_FETCH.replace("String(path).startsWith('/api/browser-live')", f"{json.dumps(prefixes)}.some(p => String(path).startsWith(p))")


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


GOOGLE_STEPS = [
    'Open the Google Cloud Console and create a project, or pick one you already use.',
    'Under APIs & Services, enable the Gmail API and the Google Drive API.',
    'On the OAuth consent screen choose External and add your own account under Test users.',
    'Create an OAuth client ID of type Web application.',
    'Under Authorized redirect URIs add exactly the address shown here.',
    'Copy the Client ID and Client secret, paste them here and save, then choose Connect Google.',
]
REDIRECT = 'http://127.0.0.1:8787/api/connectors/google/callback'
AGENT_ACTIONS = ['http.check', 'browser.capture', 'browser.action', 'model.run', 'mcp.call']
TOOLS = [{'name': 'search_notes', 'write': False, 'description': 'Find notes'}, {'name': 'add_note', 'write': True, 'description': 'Add a note'}]


def connector(name, **kw):
    return {'id': slug(name), 'kind': 'mcp', 'name': name, 'account': 'notes.example.org', 'status': 'ready', 'statusMessage': '', 'transport': 'http',
            'host': 'notes.example.org', 'agentServer': None, 'actions': TOOLS, 'addedAt': '2026-11-11T10:00:00Z', 'checkedAt': '2026-11-11T10:00:00Z', **kw}


class Server:
    """A stand-in for /api/connectors*, /api/ai*, /api/agents and the Undo route, answered through page.route.
    It keeps what a real server would, so a page reload shows the change."""

    def __init__(self, **kw):
        self.connectors = []
        self.google = {'configured': False, 'connected': False, 'status': 'none', 'account': None, 'redirectUri': REDIRECT, 'scopes': [], 'steps': GOOGLE_STEPS,
                       'testingNote': 'While the consent screen is in Testing, Google ends the sign-in after 7 days and this page shows Reconnect Google.'}
        self.providers, self.default_provider, self.default_model = [], None, None
        self.agents = [
            {'id': 'a1', 'name': 'Laptop', 'status': 'online', 'permissions': ['model.run'], 'lastSeenAt': '2026-11-11T10:00:00Z', 'tasks': {'queued': 0, 'running': 0, 'failed': 0},
             'cli': {'claude': 'signed-in', 'codex': 'signed-out', 'checkedAt': '2026-11-11T10:00:00Z'}},
            {'id': 'a2', 'name': 'Desk PC', 'status': 'stale', 'permissions': ['model.run'], 'lastSeenAt': '2026-11-10T10:00:00Z', 'tasks': {'queued': 0, 'running': 0, 'failed': 0},
             'cli': {'claude': 'missing', 'codex': 'signed-in', 'checkedAt': '2026-11-10T10:00:00Z'}},
        ]
        self.late = {'act-late'}
        self.calls = []
        self.__dict__.update(kw)

    def sent(self, method, path):
        return [body for m, p, body in self.calls if m == method and p == path]

    def provider_listing(self, p):
        models = p.get('chatModels', [])
        return {**p, 'baseUrl': '', 'models': models, 'allModels': models, 'chatModels': models, 'labels': {}, 'apiVersion': None, 'hasHeaders': [], 'modelsAt': None, 'modelsError': None, 'modelsTruncated': False, 'keyOptional': False}

    async def handle(self, route):
        request = route.request
        path = re.sub(r'^https?://[^/]+', '', request.url).split('?')[0]
        method = request.method
        body = json.loads(request.post_data) if request.post_data else None
        if method != 'GET':
            self.calls.append((method, path, body))

        async def reply(data, status=200):
            await route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if path == '/api/connectors':
            if method == 'GET':
                return await reply({'connectors': self.connectors, 'google': self.google})
            if any(c['name'].lower() == body['name'].lower() for c in self.connectors):
                return await reply({'error': f"A connector called \"{body['name']}\" is already added."}, 409)
            made = connector(body['name'], **({'transport': 'stdio', 'host': None, 'agentServer': body['agentServer'], 'account': f"agent:{body['agentServer']}"} if 'agentServer' in body else {}))
            self.connectors.append(made)
            return await reply(made, 201)
        if path == '/api/connectors/google/setup':
            self.google.update(configured=True, status='setup')
            return await reply({'ok': True, 'configured': True, 'redirectUri': REDIRECT})
        m = re.match(r'^/api/connectors/([a-z0-9-]+)(/refresh)?$', path)
        if m and m.group(2) and method == 'POST':
            found = next(c for c in self.connectors if c['id'] == m.group(1))
            found.update(status='ready', statusMessage='')
            return await reply(found)
        if m and method == 'DELETE':
            self.connectors = [c for c in self.connectors if c['id'] != m.group(1)]
            if m.group(1) == 'google':
                self.google.update(configured=False, connected=False, status='none', account=None)
            return await reply({'ok': True})
        if path == '/api/agents':
            return await reply({'agents': self.agents, 'actions': AGENT_ACTIONS})
        if path == '/api/agents/pair' and method == 'POST':
            return await reply({'code': 'ABCD-1234', 'expiresAt': '2026-11-11T10:10:00Z', 'ttlSeconds': 600, 'permissions': body.get('permissions', [])}, 201)
        m = re.match(r'^/api/agents/([a-z0-9-]+)$', path)
        if m and method == 'PATCH':
            next(a for a in self.agents if a['id'] == m.group(1)).update(permissions=body['permissions'])
            return await reply({'ok': True})
        if m and method == 'DELETE':
            next(a for a in self.agents if a['id'] == m.group(1)).update(status='revoked', cli=None)
            return await reply({'ok': True})
        if path == '/api/ai' and method == 'PATCH':
            self.default_provider = body.get('providerId', self.default_provider)
            self.default_model = body.get('model', self.default_model)
            return await reply({'ok': True})
        if path == '/api/ai':
            return await reply({'providers': [{k: v for k, v in p.items() if k in ('id', 'label', 'kind', 'engine', 'model', 'protocol', 'host', 'modelCount')} for p in self.providers],
                                'defaultProviderId': self.default_provider, 'defaultModel': self.default_model, 'bots': {}})
        if path == '/api/ai/providers' and method == 'GET':
            return await reply({'providers': [self.provider_listing(p) for p in self.providers], 'defaultProviderId': self.default_provider, 'defaultModel': self.default_model, 'bots': {}})
        if path == '/api/ai/providers' and method == 'POST':
            assert 'apiKey' not in body and 'baseUrl' not in body, 'a subscription holds no key'
            made = {'id': f'p-{len(self.providers) + 1}', 'label': body['label'], 'kind': 'local-cli', 'engine': body['engine'], 'model': body['model'], 'protocol': 'local-cli', 'host': None, 'modelCount': 0}
            self.providers.insert(0, made)
            self.default_provider = self.default_provider or made['id']
            return await reply(self.provider_listing(made), 201)
        m = re.match(r'^/api/ai/providers/([a-z0-9-]+)/models$', path)
        if m and method == 'POST':
            found = next(p for p in self.providers if p['id'] == m.group(1))
            models = found.get('catalogue', found.get('chatModels', []))
            return await reply({'models': models, 'chatModels': models, 'allModels': models, 'labels': {}})
        m = re.match(r'^/api/ai/providers/([a-z0-9-]+)(/test)?$', path)
        if m and m.group(2):
            return await reply({'ok': True, 'status': 'signed-in', 'agent': 'Laptop', 'message': 'Claude is signed in on Laptop.', 'engine': 'claude', 'model': None})
        if m and method == 'DELETE':
            self.providers = [p for p in self.providers if p['id'] != m.group(1)]
            return await reply({'ok': True})
        if re.match(r'^/api/ai/bots/[a-z0-9-]+$', path) and method == 'PATCH':
            return await reply({'ok': True})
        m = re.match(r'^/api/activity/([a-z0-9-]+)/undo$', path)
        if m and method == 'POST':
            if m.group(1) in self.late:
                return await reply({'error': 'It already went out, so it cannot be undone.'}, 409)
            return await reply({'ok': True})
        return await reply({'error': 'unexpected'}, 404)


async def install(page, **kw):
    server = Server(**kw)
    await page.add_init_script(via_fetch(['/api/connectors', '/api/ai', '/api/agents', '/api/activity/']))
    await page.route('**/api/connectors**', server.handle)
    await page.route('**/api/ai**', server.handle)
    await page.route('**/api/agents**', server.handle)
    await page.route('**/api/activity/**', server.handle)
    return server


async def open_settings(page, section):
    """Desktop: the avatar opens the dialog; a nav button picks the section."""
    await page.locator('#sidebar .rail-me').click()
    await page.locator(f'#main .st-dlg .st-nav [data-section="{section}"]').click()


async def goto_settings_section(page, section):
    await page.locator(f'#main .st-dlg .st-nav [data-section="{section}"]').click()


async def connectors_add_and_delete_mcp(page, base):
    server = await install(page)
    await open_app(page, base)
    await open_settings(page, 'conn')
    body = page.locator('#main .st-dlg .st-body')
    # The page opens on the Connect apps catalogue: Recommended first, a live search, category chips.
    await expect(body.locator('#ca-title')).to_have_text('Connect apps')
    await expect(body.locator('.ca-sum')).to_contain_text('0 connected')
    await expect(body.locator('.ca-sec[aria-label="Recommended"] .ca-app').first).to_have_attribute('data-app', 'notion')
    await body.locator('#ca-search').fill('linear')
    await expect(body.locator('#ca-results .ca-app')).to_have_count(1)
    await body.locator('#ca-search').fill('')
    await body.locator('.ca-chip', has_text='Design').click()
    await expect(body.locator('.ca-chip', has_text='Design')).to_have_attribute('aria-pressed', 'true')
    await expect(body.locator('#ca-results .ca-app')).to_have_count(1)
    # An app with a token opens a sheet that asks for it, hidden as it is typed; Escape changes nothing.
    await body.locator('[data-app="figma"] .ca-go').click()
    await expect(page.locator('#modal')).to_contain_text('Connect Figma')
    await expect(page.locator('#modal')).to_contain_text('Runs on this computer')
    await expect(page.locator('#catalog-connect-form input[name="FIGMA_API_KEY"]')).to_have_attribute('type', 'password')
    await page.keyboard.press('Escape')
    await expect(page.locator('#catalog-connect-form')).to_have_count(0)
    await body.locator('.ca-chip', has_text='All').click()
    await expect(body.locator('.st-h', has_text='Connected')).to_be_visible()
    await expect(body).to_contain_text('No servers yet')
    # Add a server over HTTP: the address and a header go out once. The raw form is folded away.
    form = page.locator('#connector-add-form')
    await expect(form).to_be_hidden()
    await body.locator('.cn-custom summary').click()
    await form.locator('input[name="name"]').fill('Notes')
    await form.locator('input[name="url"]').fill('https://notes.example.org/mcp?key=sekrit')
    await form.locator('textarea[name="headers"]').fill('Authorization: Bearer abc123')
    await expect(form.locator('input[name="agentServer"]')).to_be_hidden()
    await form.get_by_role('button', name='Add server').click()
    row = page.locator('.cn-mcp[data-connector="notes"]')
    await expect(row).to_be_visible()
    await expect(row).to_contain_text('notes.example.org')
    await expect(row).to_contain_text('2 tools, 1 can change things')
    await expect(row.locator('.cn-head .tag')).to_have_text('Ready')
    assert server.sent('POST', '/api/connectors') == [{'kind': 'mcp', 'name': 'Notes', 'url': 'https://notes.example.org/mcp?key=sekrit', 'headers': {'Authorization': 'Bearer abc123'}}]
    # The address and the header are never painted back: only the host is.
    html = await page.content()
    assert 'sekrit' not in html and 'abc123' not in html, 'a secret was painted on the page'
    await expect(form.locator('input[name="name"]')).to_have_value('')
    # Its tools open, and a tool that changes things says so.
    await row.locator('.cn-tools summary').click()
    await expect(row.locator('.cn-tools li', has_text='add_note')).to_contain_text('changes things')
    await expect(row.locator('.cn-tools li', has_text='search_notes').locator('.tag')).to_have_count(0)
    # Refresh asks the server again.
    await row.get_by_role('button', name='Refresh tools').click()
    await expect(page.locator('#toast')).to_contain_text('Notes is ready')
    assert len(server.sent('POST', '/api/connectors/notes/refresh')) == 1
    # A server that runs on the agent is only a name: no address, no headers.
    await form.locator('label', has_text='On my computer').click()
    await expect(form.locator('input[name="url"]')).to_be_hidden()
    await expect(form.locator('input[name="agentServer"]')).to_be_visible()
    await form.locator('input[name="name"]').fill('Files')
    await form.locator('input[name="agentServer"]').fill('files')
    await form.get_by_role('button', name='Add server').click()
    files = page.locator('.cn-mcp[data-connector="files"]')
    await expect(files).to_contain_text('On your agent · files')
    assert server.sent('POST', '/api/connectors')[-1] == {'kind': 'mcp', 'name': 'Files', 'agentServer': 'files'}
    # A name that is taken says so and adds nothing.
    await form.locator('label', has_text='Web address').click()
    await form.locator('input[name="name"]').fill('Notes')
    await form.locator('input[name="url"]').fill('https://other.example.org/mcp')
    await form.get_by_role('button', name='Add server').click()
    await expect(page.locator('#toast')).to_contain_text('already added')
    await expect(page.locator('.cn-mcp')).to_have_count(2)
    # Delete asks first; Cancel changes nothing.
    await row.get_by_role('button', name='Delete').click()
    await expect(page.locator('#modal')).to_contain_text('Remove Notes?')
    await page.locator('#modal').get_by_role('button', name='Cancel').click()
    await expect(row).to_be_visible()
    assert server.sent('DELETE', '/api/connectors/notes') == []
    await row.get_by_role('button', name='Delete').click()
    await page.locator('#modal').get_by_role('button', name='Remove').click()
    await expect(page.locator('.cn-mcp[data-connector="notes"]')).to_have_count(0)
    assert len(server.sent('DELETE', '/api/connectors/notes')) == 1
    await expect(page.locator('.cn-mcp')).to_have_count(1)


async def google_setup_form_connect_and_reconnect(page, base):
    server = await install(page)
    await open_app(page, base)
    await open_settings(page, 'conn')
    card = page.locator('[data-connector="google"]')
    # Not set up: the steps, the address to register, the testing note, and no way to sign in yet.
    await expect(card.locator('.cn-steps li')).to_have_count(6)
    await expect(card.locator('.cn-redirect code')).to_have_text(REDIRECT)
    await expect(card.locator('.cn-testing')).to_contain_text('7 days')
    await expect(card.get_by_role('link', name='Connect Google')).to_have_count(0)
    form = card.locator('#google-setup-form')
    await expect(form.locator('input[name="clientSecret"]')).to_have_attribute('type', 'password')
    await form.locator('input[name="clientId"]').fill('1234567890-abc.apps.googleusercontent.com')
    await form.locator('input[name="clientSecret"]').fill('GOCSPX-supersecretvalue')
    await form.get_by_role('button', name='Save client').click()
    # Saved: Connect Google is a plain link to the start route, and the secret is gone from the page.
    link = card.get_by_role('link', name='Connect Google')
    await expect(link).to_have_attribute('href', '/api/connectors/google/start')
    assert await link.evaluate('n => n.tagName') == 'A'
    assert server.sent('POST', '/api/connectors/google/setup') == [{'clientId': '1234567890-abc.apps.googleusercontent.com', 'clientSecret': 'GOCSPX-supersecretvalue'}]
    assert 'GOCSPX-supersecretvalue' not in await page.content()
    await expect(card.locator('[data-google-client]')).to_be_hidden()
    await card.get_by_role('button', name='Change client').click()
    await expect(card.locator('[data-google-client] input[name="clientId"]')).to_be_visible()
    # Connected: the account, the tools, and no Connect link.
    server.google.update(configured=True, connected=True, status='ready', account='me@example.org')
    server.connectors = [{'id': 'google', 'kind': 'google', 'name': 'Google', 'account': 'me@example.org', 'status': 'ready', 'statusMessage': '', 'transport': None, 'host': None, 'agentServer': None,
                          'actions': [{'name': 'gmail.search', 'write': False, 'description': 'Search the mailbox.'}, {'name': 'gmail.send', 'write': True, 'description': 'Send an email.'}], 'addedAt': None, 'checkedAt': None}]
    await goto_settings_section(page, 'general')
    await goto_settings_section(page, 'conn')
    await expect(card).to_contain_text('Signed in as me@example.org')
    await expect(card.locator('.cn-head .tag')).to_have_text('Connected')
    await expect(card.get_by_role('link', name='Connect Google')).to_have_count(0)
    await expect(page.locator('.cn-mcp')).to_have_count(0)
    # Google ended the sign-in: the card says Reconnect and offers it.
    server.google.update(connected=False, status='reconnect')
    server.connectors[0].update(status='reconnect')
    await goto_settings_section(page, 'general')
    await goto_settings_section(page, 'conn')
    await expect(card.locator('.cn-head .tag')).to_have_text('Reconnect')
    await expect(card.get_by_role('link', name='Reconnect Google')).to_have_attribute('href', '/api/connectors/google/start')
    await expect(card).to_contain_text('me@example.org')
    # Disconnect asks first.
    await card.get_by_role('button', name='Disconnect').click()
    await expect(page.locator('#modal')).to_contain_text('Remove Google?')
    await page.locator('#modal').get_by_role('button', name='Remove').click()
    await expect(card.locator('.cn-steps li')).to_have_count(6)
    assert len(server.sent('DELETE', '/api/connectors/google')) == 1


async def google_return_toast_and_clean_address(page, base):
    await install(page)
    await page.goto(f'{base}/index.html?google=connected')
    await page.locator(SCREEN).first.wait_for()
    await expect(page.locator('#toast')).to_contain_text('Google is connected.')
    assert await page.evaluate('location.search') == '', 'the parameter should be stripped'
    await expect(page.locator('#main .st-head h2')).to_have_text('Connectors')
    # A reload does not say it again.
    await page.reload()
    await page.locator(SCREEN).first.wait_for()
    await expect(page.locator('#toast.show')).to_have_count(0)
    # A failure says why, in words.
    await page.goto(f'{base}/index.html?google=error&reason=denied')
    await page.locator(SCREEN).first.wait_for()
    await expect(page.locator('#toast')).to_contain_text('cancelled')
    assert await page.evaluate('location.search') == ''


async def subscription_provider_and_cli_status(page, base):
    server = await install(page)
    await open_app(page, base)
    await open_settings(page, 'models')
    body = page.locator('#main .st-dlg .st-body')
    # Nothing saved yet: one line says so, and "Add a model" is one card with a choice of two.
    await expect(body).to_contain_text('No model yet')
    choose = body.locator('[aria-label="What to add"] button')
    await expect(choose).to_have_text(['Subscription', 'API key'])
    await expect(choose.first).to_have_attribute('aria-pressed', 'true')
    # The five-protocol paragraph is one line now.
    await expect(body.locator('.st-note').first).to_have_text('Bring your own key, or use the Claude or ChatGPT plan you already pay for. Keys are stored encrypted and never shown again.')
    # There is no key field for a subscription, and the engine is a pill, not a select.
    form = page.locator('#cli-provider-form')
    assert await form.locator('input[type="password"], input[name="apiKey"], input[name="baseUrl"]').count() == 0
    # The model is a dropdown of the names the claude command knows, with Other… for anything else.
    assert (await form.locator('select[name="model"] option').evaluate_all('o => o.map(x => x.value)'))[:4] == ['', 'opus', 'sonnet', 'haiku'] and 'claude-haiku-5-5' in await form.locator('select[name="model"] option').evaluate_all('o => o.map(x => x.value)')
    await expect(form.locator('input[name="modelOther"]')).to_be_hidden()
    await expect(form.locator('input[name="engine"][value="claude"]')).to_be_checked()
    await form.locator('input[name="label"]').fill('My Claude')
    await form.get_by_role('button', name='Add subscription').click()
    row = body.locator('.cn-mcp', has_text='My Claude')
    # The row says where it is signed in, in one line. The sign-in of each computer lives on Local agents, not here.
    await expect(row).to_contain_text('Claude subscription · default model · signed in on Laptop')
    await expect(row.locator('.tag')).to_have_text('default')
    await expect(body.locator('.row')).to_have_count(0)
    await expect(body).not_to_contain_text('Sign-in on your paired agents')
    assert server.sent('POST', '/api/ai/providers') == [{'kind': 'local-cli', 'label': 'My Claude', 'engine': 'claude', 'model': ''}]
    # Check sign-in never sends a prompt: it reads the agent's report.
    await row.get_by_role('button', name='Check sign-in').click()
    await expect(page.locator('#toast')).to_contain_text('Claude is signed in on Laptop.')
    assert len(server.sent('POST', '/api/ai/providers/p-1/test')) == 1
    # A model name rides along for the second engine; a bad one is refused before it leaves.
    await form.locator('input[name="label"]').fill('My ChatGPT')
    await form.locator('label', has_text='ChatGPT').click()
    # ChatGPT's names follow the engine: its own models by name, then Other….
    assert await form.locator('select[name="model"] option').evaluate_all('o => o.map(x => x.value)') == ['', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', '__other']
    await form.locator('select[name="model"]').select_option('__other')
    await expect(form.locator('input[name="modelOther"]')).to_be_visible()
    await form.locator('input[name="modelOther"]').fill('--bad')
    await form.get_by_role('button', name='Add subscription').click()
    await expect(page.locator('#toast')).to_contain_text('model name is not valid')
    assert len(server.sent('POST', '/api/ai/providers')) == 1
    await form.locator('input[name="modelOther"]').fill('gpt-5')
    await form.get_by_role('button', name='Add subscription').click()
    await expect(body.locator('.cn-mcp', has_text='My ChatGPT')).to_contain_text('ChatGPT subscription · gpt-5 · signed out on Laptop')
    assert 'apiKey' not in json.dumps(server.calls)
    # Only Check sign-in and Make default are in sight; Delete is under the dots, and asks first.
    await expect(row.get_by_role('button', name='Delete')).to_have_count(0)
    await row.get_by_label('More for My Claude').click()
    await expect(page.locator('#modal .rw')).to_have_text(['DeleteRemoves this subscription'])
    await page.locator('#modal .rw', has_text='Delete').click()
    await page.locator('#modal').get_by_role('button', name='Delete').click()
    await expect(body.locator('.cn-mcp', has_text='My Claude')).to_have_count(0)


async def models_api_provider_menu_and_one_model_picker(page, base):
    gpt = {'id': 'p-9', 'label': 'Groq', 'kind': 'api', 'engine': None, 'model': None, 'protocol': 'openai-chat', 'host': 'api.groq.com', 'modelCount': 2, 'chatModels': ['llama-3.3-70b', 'mixtral']}
    claude = {'id': 'p-8', 'label': 'My Claude', 'kind': 'local-cli', 'engine': 'claude', 'model': '', 'protocol': 'local-cli', 'host': None, 'modelCount': 0}
    server = await install(page, providers=[gpt, claude], default_provider='p-9')
    await open_app(page, base)
    await open_settings(page, 'models')
    body = page.locator('#main .st-dlg .st-body')
    row = body.locator('.cn-mcp', has_text='Groq')
    # Test and Make default stay in sight (the default one has no Make default); the other three actions are under the dots.
    await expect(row.get_by_role('button', name='Test')).to_be_visible()
    await expect(row.get_by_role('button', name='Make default')).to_have_count(0)
    for name in ('Refresh models', 'Edit', 'Delete'):
        await expect(row.get_by_role('button', name=name, exact=True)).to_have_count(0)
    await expect(body.locator('.cn-mcp', has_text='My Claude').get_by_role('button', name='Make default')).to_be_visible()
    await row.get_by_label('More for Groq').click()
    await expect(page.locator('#modal .rw')).to_have_count(3)
    await expect(page.locator('#modal .rw').nth(0)).to_contain_text('Refresh models')
    await page.locator('#modal .rw', has_text='Refresh models').click()
    await expect(page.locator('#modal')).to_be_hidden()
    await expect(page.locator('#toast')).to_contain_text('2 model(s) available')
    assert len(server.sent('POST', '/api/ai/providers/p-9/models')) == 1
    # One model picker: the default form lists this provider's models in a datalist, and the subscription form has the same field.
    default = page.locator('#ai-default-form')
    await expect(default.locator('input[name="providerId"]')).to_have_value('p-9')
    assert await default.locator('select[name="providerId"]').count() == 0, 'the default provider is chosen with Make default, not a second picker'
    assert await default.locator('select[name="model"] option').evaluate_all('o => o.map(x => x.value)') == ['', 'llama-3.3-70b', 'mixtral', '__other']
    await expect(default.get_by_role('button', name='Load models')).to_have_count(0)
    await default.locator('select[name="model"]').select_option('mixtral')
    await default.get_by_role('button', name='Save').click()
    await expect(page.locator('#toast')).to_contain_text('Default model saved')
    assert server.sent('PATCH', '/api/ai') == [{'providerId': 'p-9', 'model': 'mixtral', 'effort': ''}]
    # Make default moves the default provider, and the picker follows it.
    await body.locator('.cn-mcp', has_text='My Claude').get_by_role('button', name='Make default').click()
    await expect(default.locator('input[name="providerId"]')).to_have_value('p-8')
    await expect(page.locator('#ai-default-form .field .field-label')).to_have_text('Default model for My Claude')
    # "API key" swaps the form: the preset, the address and the key, with protocol and headers folded away.
    await body.locator('[data-action="ai-add-kind"][data-kind="api"]').click()
    await expect(page.locator('#cli-provider-form')).to_be_hidden()
    api_form = page.locator('#ai-provider-form')
    await expect(api_form).to_be_visible()
    await expect(api_form.locator('select[name="protocol"]')).to_be_hidden()
    await api_form.locator('summary').click()
    await expect(api_form.locator('select[name="protocol"]')).to_be_visible()
    await expect(api_form.locator('textarea[name="headers"]')).to_be_visible()


async def model_list_loads_by_itself(page, base):
    # A key provider the page has never read: its list arrives without a button, once.
    groq = {'id': 'p-7', 'label': 'Groq', 'kind': 'api', 'engine': None, 'model': None, 'protocol': 'openai-chat', 'host': 'api.groq.com', 'modelCount': 0, 'catalogue': ['llama-3.3-70b', 'qwen-3']}
    server = await install(page, providers=[groq], default_provider='p-7')
    await open_app(page, base)
    await open_settings(page, 'models')
    picker = page.locator('#ai-default-form select[name="model"]')
    await expect(picker.locator('option')).to_have_count(4)
    assert await picker.locator('option').evaluate_all('o => o.map(x => x.value)') == ['', 'llama-3.3-70b', 'qwen-3', '__other']
    assert len(server.sent('POST', '/api/ai/providers/p-7/models')) == 1
    await expect(page.locator('#toast')).not_to_contain_text('model(s) available')
    # Other… opens a box for any id, and that id is what is saved.
    await picker.select_option('__other')
    await page.locator('#ai-default-form input[name="modelOther"]').fill('llama-4-scout')
    await page.locator('#ai-default-form').get_by_role('button', name='Save').click()
    await expect(page.locator('#toast')).to_contain_text('Default model saved')
    assert server.sent('PATCH', '/api/ai') == [{'providerId': 'p-7', 'model': 'llama-4-scout', 'effort': ''}]


async def phone_models_page_fits(page, base):
    gpt = {'id': 'p-9', 'label': 'Groq', 'kind': 'api', 'engine': None, 'model': None, 'protocol': 'openai-chat', 'host': 'api.groq.com', 'modelCount': 2, 'chatModels': ['llama-3.3-70b']}
    await install(page, providers=[gpt], default_provider='p-9')
    await open_app(page, base)
    await page.locator('.ch-me').click()
    await page.locator('#main .st-phone .rw', has_text='Models and keys').click()
    await expect(page.locator('#main .cn-mcp')).to_have_count(1)
    await expect(page.locator('#main .cn-mcp [data-action="ai-more"]')).to_be_visible()
    assert await overflow(page) <= 0, 'Models and keys overflows the phone'


# ---------------------------------------------------------------- the admin pages: Local agents, Team, Notifications, Data
# They only exist on a server build (Settings hides them in the static demo), so each is mounted into a panel the way
# Settings mounts it, and the app's own delegated handlers drive it. Every call goes to the stand-in server below.

class AdminServer(Server):
    def __init__(self, **kw):
        self.users = [{'id': 'u0', 'email': 'owner@localhost', 'role': 'owner', 'disabled': False, 'createdAt': '2026-11-01T10:00:00Z'},
                      {'id': 'u1', 'email': 'sam@example.org', 'role': 'member', 'disabled': False, 'createdAt': '2026-11-02T10:00:00Z'}]
        self.credentials = [{'id': 'c1', 'name': 'ntfy topic', 'kind': 'webhook', 'createdBy': 'owner@localhost', 'createdAt': '2026-11-03T10:00:00Z', 'expiresAt': None, 'expired': False},
                            {'id': 'c2', 'name': 'AI key · Groq', 'kind': 'ai_provider', 'createdBy': 'owner@localhost', 'createdAt': '2026-11-03T10:00:00Z', 'expiresAt': None, 'expired': False}]
        self.prefs = {'inApp': True, 'webhook': False, 'webhookCredentialId': None, 'email': False, 'emailAddress': '', 'emailReady': False}
        self.notifications = [{'id': 'n1', 'title': 'A task failed', 'body': 'Backup check', 'channel': 'in_app', 'status': 'delivered', 'created_at': '2026-11-11T09:00:00Z'}]
        self.preview = {'events': 0, 'doneTasks': 4, 'runs': 1, 'dryRun': True}
        super().__init__(**kw)

    async def handle(self, route):
        request = route.request
        path = re.sub(r'^https?://[^/]+', '', request.url).split('?')[0]
        method = request.method
        body = json.loads(request.post_data) if request.post_data else None
        admin = path in ('/api/users', '/api/notifications', '/api/notifications/read', '/api/notification-prefs', '/api/push', '/api/credentials', '/api/retention/preview', '/api/retention/prune', '/api/admin/restore', '/api/sessions') \
            or re.match(r'^/api/(users|credentials)/[a-z0-9-]+(/reveal)?$', path)
        if not admin:
            return await super().handle(route)
        if method != 'GET':
            self.calls.append((method, path, body))
        else:
            self.calls.append((method, path, None))

        async def reply(data, status=200):
            await route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if path == '/api/users' and method == 'GET':
            return await reply({'users': self.users, 'roles': ['owner', 'admin', 'member', 'viewer']})
        m = re.match(r'^/api/users/([a-z0-9-]+)$', path)
        if m and method == 'PATCH':
            next(u for u in self.users if u['id'] == m.group(1)).update(body)
            return await reply({'ok': True})
        if path == '/api/notifications':
            return await reply({'notifications': self.notifications, 'unread': 1})
        if path == '/api/notification-prefs':
            if method == 'PATCH':
                self.prefs.update(body)
            return await reply(self.prefs)
        if path == '/api/push':
            return await reply({'publicKey': 'AAAA', 'endpoints': []})
        if path == '/api/credentials':
            return await reply({'credentials': self.credentials})
        m = re.match(r'^/api/credentials/([a-z0-9-]+)/reveal$', path)
        if m:
            return await reply({'id': m.group(1), 'name': 'ntfy topic', 'kind': 'webhook', 'value': 'https://ntfy.example/topic'})
        if path == '/api/retention/preview':
            return await reply({'policy': {'events': 90, 'doneTasks': 30, 'runs': 30}, 'preview': self.preview})
        if path == '/api/retention/prune':
            return await reply({'events': 0, 'doneTasks': 4, 'runs': 1})
        if path == '/api/admin/restore':
            return await reply({'restored': 12})
        return await reply({'error': 'unexpected'}, 404)


ADMIN_PREFIXES = ['/api/connectors', '/api/ai', '/api/agents', '/api/activity/', '/api/users', '/api/notification', '/api/push', '/api/credentials', '/api/retention/', '/api/admin/restore', '/api/sessions']


async def install_admin(page, **kw):
    server = AdminServer(**kw)
    await page.add_init_script(via_fetch(ADMIN_PREFIXES))
    for pattern in ('connectors', 'ai', 'agents', 'activity/', 'users', 'notification', 'push', 'credentials', 'retention/', 'admin/restore', 'sessions'):
        await page.route(f'**/api/{pattern}**', server.handle)
    return server


async def mount_admin(page, kind, role='owner'):
    """Mount an admin page into a panel the way Settings does, as the signed-in owner, and wait for it to paint."""
    await page.evaluate("""async ([kind, role]) => {
        // The build stamps every import with the bundle version; the same stamp reaches the app's own module instances.
        const v = new URL(document.querySelector('script[src*="app.js"]').src).search;
        const {store} = await import('./ui-store.js' + v);
        store.state.me = {...(store.state.me || {}), email: 'owner@localhost', role};
        document.querySelector('#admin-panel')?.remove();
        const host = document.createElement('div');
        host.id = 'admin-panel'; host.className = 'st-body'; host.dataset.page = kind;
        host.style.cssText = 'position:fixed;inset:0;z-index:30;overflow:auto;padding:20px;background:var(--bg)';
        document.body.append(host);
        const {reloadAdminPage} = await import('./ui-settings.js' + v);
        await reloadAdminPage();
    }""", [kind, role])
    await page.locator('#admin-panel .ad-panel').wait_for()
    return page.locator('#admin-panel')


async def agents_page_status_signin_and_switches(page, base):
    server = await install_admin(page)
    await open_app(page, base)
    panel = await mount_admin(page, 'agents')
    # One page: each computer says it is online or not, whether claude and codex are signed in there, and what it may do.
    laptop = panel.locator('.st-g', has=page.locator('.st-h', has_text='Laptop'))
    await expect(laptop.locator('.st-h ~ .tag, .ad-hd .tag')).to_have_text('Online')
    await expect(laptop.locator('.rw', has_text=re.compile(r'^Claude'))).to_contain_text('Signed in')
    chatgpt = laptop.locator('.rw', has_text=re.compile(r'^ChatGPT'))
    await expect(chatgpt).to_contain_text('Signed out')
    await expect(chatgpt).to_contain_text('in a terminal on that machine to sign in')
    desk = panel.locator('.st-g', has=page.locator('.st-h', has_text='Desk PC'))
    await expect(desk.locator('.rw', has_text=re.compile(r'^Claude'))).to_contain_text('Not installed')
    await expect(desk.locator('.ad-hd .tag')).to_have_text('Not running now')
    # What a computer may do is a switch per action, each with a plain name and its id.
    switches = laptop.locator('[data-action="toggle-agent-permission"]')
    await expect(switches).to_have_count(5)
    await expect(laptop.locator('.rw', has_text='Run your Claude or ChatGPT plan')).to_contain_text('model.run')
    model_run = laptop.locator('[data-permission="model.run"]')
    await expect(model_run).to_have_attribute('aria-checked', 'true')
    await expect(laptop.locator('[data-permission="browser.action"]')).to_have_attribute('aria-checked', 'false')
    assert await panel.locator('input[type="checkbox"]').count() == 0, 'a native checkbox is left on the page'
    # A switch saves the whole new list and moves only once the server took it.
    await laptop.locator('[data-permission="browser.capture"]').click()
    await expect(laptop.locator('[data-permission="browser.capture"]')).to_have_attribute('aria-checked', 'true')
    assert server.sent('PATCH', '/api/agents/a1') == [{'permissions': ['browser.capture', 'model.run']}]
    await model_run.click()
    await expect(model_run).to_have_attribute('aria-checked', 'false')
    assert server.sent('PATCH', '/api/agents/a1')[-1] == {'permissions': ['browser.capture']}
    # Revoke asks first, and says what it does.
    await laptop.get_by_role('button', name='Revoke').click()
    await expect(page.locator('#modal')).to_contain_text('Revoke this local agent?')
    await page.locator('#modal').get_by_role('button', name='Cancel').click()
    assert server.sent('DELETE', '/api/agents/a1') == []
    await laptop.get_by_role('button', name='Revoke').click()
    await page.locator('#modal').get_by_role('button', name='Revoke').click()
    await expect(panel.locator('.st-g', has=page.locator('.st-h', has_text='Laptop')).locator('.ad-hd .tag')).to_have_text('revoked')
    assert server.sent('DELETE', '/api/agents/a1') == [{}]
    # No X-era line is left on this page.
    await expect(panel).not_to_contain_text('can never publish')


async def agents_page_pairing_form_and_code(page, base):
    server = await install_admin(page, agents=[])
    await open_app(page, base)
    panel = await mount_admin(page, 'agents')
    await expect(panel).to_contain_text('No computer is paired yet')
    form = panel.locator('#pairing-form')
    await expect(form.locator('[data-permission]')).to_have_count(5)
    await expect(form.locator('[data-permission][aria-checked="true"]')).to_have_count(5)
    await form.locator('input[name="label"]').fill('Studio')
    await form.locator('[data-permission="browser.action"]').click()
    await expect(form.locator('[data-permission="browser.action"]')).to_have_attribute('aria-checked', 'false')
    await form.get_by_role('button', name='Create pairing code').click()
    # The scope the admin chose goes out; the code shows once, with the command to run on the computer and a Copy button.
    assert server.sent('POST', '/api/agents/pair') == [{'label': 'Studio', 'permissions': ['http.check', 'browser.capture', 'model.run', 'mcp.call']}]
    code = panel.locator('.st-g', has=page.locator('.st-h', has_text='Pairing code'))
    await expect(code.locator('.code')).to_have_text('ABCD-1234')
    await expect(code.locator('.cn-copy code')).to_contain_text('node agent/agent.mjs pair --server')
    await expect(code.locator('.cn-copy code')).to_contain_text('--code ABCD-1234')
    await expect(code.get_by_role('button', name='Copy')).to_be_visible()


async def team_roles_are_pills_and_sessions_are_not_here(page, base):
    server = await install_admin(page)
    await open_app(page, base)
    panel = await mount_admin(page, 'team')
    sam = panel.locator('.cn-mcp', has_text='sam@example.org')
    assert await panel.locator('select').count() == 0, 'a native select is left on the page'
    await expect(sam.locator('.st-seg button')).to_have_text(['Viewer', 'Member', 'Admin'])
    await expect(sam.locator('.st-seg [aria-pressed="true"]')).to_have_text('Member')
    # The owner has no role to change, no Disable and no Remove.
    owner = panel.locator('.cn-mcp', has_text='owner@localhost')
    await expect(owner.locator('.tag')).to_have_text(['owner', 'you'])
    assert await owner.locator('button').count() == 0
    await sam.locator('.st-seg button', has_text='Viewer').click()
    await expect(page.locator('#toast')).to_contain_text('Role updated')
    assert server.sent('PATCH', '/api/users/u1') == [{'role': 'viewer'}]
    await expect(sam.locator('.st-seg [aria-pressed="true"]')).to_have_text('Viewer')
    # Disable and Remove still ask first.
    await sam.get_by_role('button', name='Remove').click()
    await expect(page.locator('#modal')).to_contain_text('Remove this user from the workspace?')
    await page.locator('#modal').get_by_role('button', name='Cancel').click()
    # Sessions moved to Settings > General > Account: not here, and not even asked for.
    await expect(panel).not_to_contain_text('Your sessions')
    await expect(panel).not_to_contain_text('Sign out everywhere')
    assert not [c for c in server.calls if c[1].startswith('/api/sessions')]
    # The invite form takes its role from the same pills.
    invite = panel.locator('#create-user-form')
    await expect(invite.locator('input[name="role"][value="member"]')).to_be_checked()
    await expect(invite.get_by_label('Temporary password (min 8 chars)')).to_be_visible()


async def notifications_are_switches_and_unwired_channels_are_hidden(page, base):
    server = await install_admin(page)
    await open_app(page, base)
    panel = await mount_admin(page, 'notifications')
    assert await panel.locator('input[type="checkbox"]').count() == 0, 'a native checkbox is left on the page'
    await expect(panel.locator('.rw', has_text='A task failed')).to_contain_text('Backup check')
    channels = panel.locator('.st-g', has=page.locator('.st-h', has_text='Tell me by'))
    await expect(channels.locator('[role="switch"]').first).to_have_attribute('aria-checked', 'true')
    await channels.locator('[data-pref="inApp"]').click()
    await expect(channels.locator('[data-pref="inApp"]')).to_have_attribute('aria-checked', 'false')
    assert server.sent('PATCH', '/api/notification-prefs') == [{'inApp': False}]
    # A webhook is offered because a webhook address is saved; the text box for a credential id is gone.
    await expect(channels.locator('.rw', has_text='Webhook')).to_be_visible()
    await expect(panel).not_to_contain_text('Webhook credential id')
    assert await panel.locator('input[name="webhookCredentialId"]').count() == 0
    await expect(channels.locator('select[name="webhookCredentialId"]')).to_have_value('c1')
    await channels.locator('[data-pref="webhook"]').click()
    await expect(channels.locator('[data-pref="webhook"]')).to_have_attribute('aria-checked', 'true')
    assert server.sent('PATCH', '/api/notification-prefs')[-1] == {'webhook': True, 'webhookCredentialId': 'c1'}
    # Email needs a mailbox or relay on the server; without one it is not offered.
    await expect(channels.locator('[data-pref="email"]')).to_have_count(0)
    await expect(panel).not_to_contain_text('EMAIL_RELAY_URL')
    # With one, it is a switch and an address.
    server.prefs['emailReady'] = True
    panel = await mount_admin(page, 'notifications')
    channels = panel.locator('.st-g', has=page.locator('.st-h', has_text='Tell me by'))
    await expect(channels.locator('[data-pref="email"]')).to_be_visible()
    await channels.locator('#notif-email-form input[name="emailAddress"]').fill('me@example.org')
    await channels.locator('#notif-email-form').get_by_role('button', name='Save').click()
    assert server.sent('PATCH', '/api/notification-prefs')[-1] == {'emailAddress': 'me@example.org'}
    await channels.locator('[data-pref="email"]').click()
    await expect(channels.locator('[data-pref="email"]')).to_have_attribute('aria-checked', 'true')
    assert server.sent('PATCH', '/api/notification-prefs')[-1] == {'email': True, 'emailAddress': 'me@example.org'}


async def notifications_hide_webhook_without_a_saved_address(page, base):
    server = await install_admin(page)
    server.credentials = [c for c in server.credentials if c['kind'] != 'webhook']
    await open_app(page, base)
    panel = await mount_admin(page, 'notifications')
    await expect(panel.locator('[data-pref="inApp"]')).to_be_visible()
    await expect(panel.locator('[data-pref="webhook"]')).to_have_count(0)
    await expect(panel.locator('[data-pref="email"]')).to_have_count(0)


async def data_cards_keep_reveal_prune_and_restore_confirms(page, base):
    server = await install_admin(page)
    await open_app(page, base)
    panel = await mount_admin(page, 'data')
    ntfy = panel.locator('.cn-mcp', has_text='ntfy topic')
    # Reveal is admin-only and audited by the server; a secret the app keeps for itself has no Reveal to press.
    await expect(ntfy.get_by_role('button', name='Reveal')).to_be_visible()
    groq = panel.locator('.cn-mcp', has_text='AI key · Groq')
    await expect(groq.get_by_role('button', name='Reveal')).to_have_count(0)
    await expect(groq.locator('.tag')).to_have_text('Model key')
    await ntfy.get_by_role('button', name='Reveal').click()
    await expect(page.locator('#modal textarea')).to_have_value('https://ntfy.example/topic')
    await page.locator('#modal').get_by_role('button', name='Done').click()
    # Retention reads in words, and Prune asks first.
    await expect(panel.locator('.rw', has_text=re.compile(r'^Finished tasks')).first).to_contain_text('30 days')
    await expect(panel.locator('.rw', has_text='Would be removed now')).to_contain_text('Finished tasks 4')
    await panel.get_by_role('button', name='Prune now').click()
    await expect(page.locator('#modal')).to_contain_text('Prune exhaust older than the retention policy?')
    await page.locator('#modal').get_by_role('button', name='Cancel').click()
    assert server.sent('POST', '/api/retention/prune') == []
    await panel.get_by_role('button', name='Prune now').click()
    await page.locator('#modal').get_by_role('button', name='Prune').click()
    await expect(page.locator('#toast')).to_contain_text('Pruned 0 event(s), 4 task(s), 1 run(s).')
    assert len(server.sent('POST', '/api/retention/prune')) == 1
    # Restore is for the owner, folded away, and asks before it replaces the workspace.
    await panel.locator('.ad-restore summary').click()
    await panel.locator('#restore-doc').fill('{"workspace": "x"}')
    await panel.get_by_role('button', name='Restore from pasted document').click()
    await expect(page.locator('#modal')).to_contain_text('Replace this workspace with the pasted backup?')
    await page.locator('#modal').get_by_role('button', name='Cancel').click()
    assert server.sent('POST', '/api/admin/restore') == []
    # Not the owner: no backup, only a line saying so.
    panel = await mount_admin(page, 'data', role='admin')
    await expect(panel.locator('#restore-doc')).to_have_count(0)
    await expect(panel).to_contain_text('Backup and restore are available to the workspace owner.')


async def demo_says_connectors_and_models_need_the_server(page, base):
    await open_app(page, base)
    await open_settings(page, 'conn')
    await expect(page.locator('#main .st-body')).to_contain_text('Connectors need the Node server')
    await goto_settings_section(page, 'models')
    await expect(page.locator('#main .st-body')).to_contain_text('Models and keys need the Node server')
    await expect(page.locator('#cli-provider-form')).to_have_count(0)


HELD_TEMPLATE = """
    const at = new Date().toISOString();
    s.connectors = [{id: 'google', kind: 'google', name: 'Google', account: 'me@example.org', status: 'ready', actions: []}];
    s.chats[WRITER] = [
      {id: 'u1', role: 'user', text: 'Email Bob that lunch is at noon', at},
      {id: 'c0', role: 'system', kind: 'connector', connectorId: 'google', text: 'Atlas used Google: gmail.search.', at},
      {id: 'c1', role: 'system', kind: 'connector', connectorId: 'google', activityId: 'act-1', undoUntil: new Date(Date.now() + 60000).toISOString(),
       text: 'Atlas is sending an email to bob@example.org. You can undo it until it goes out.', at},
      {id: 'c2', role: 'system', kind: 'connector-error', connectorId: 'google', text: 'Atlas could not use Google: drive.read. Google did not answer.', at},
    ];"""


held_state = lambda writer: HELD_TEMPLATE.replace('WRITER', repr(writer))
limit_state = lambda writer: LIMIT_TEMPLATE.replace('WRITER', repr(writer))


async def chat_connector_lines_and_undo(page, base):
    server = await install(page)
    writer = (await open_app(page, base, bots={'Writer': EXTRA_BOTS['Writer']}))['Writer']
    await patch_state(page, held_state(writer))
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    # What a connector read, and a call that failed without ending the run, are not shown: the bot's answer says it.
    await expect(page.locator('#cv-log .cv-held')).to_have_count(1)
    await expect(page.locator('#cv-log', has_text='used Google')).to_have_count(0)
    await expect(page.locator('#cv-log', has_text='could not use Google')).to_have_count(0)
    # The held send is a card with Undo while its window runs.
    held = page.locator('.cv-held')
    await expect(held).to_contain_text('sending an email to bob@example.org')
    await expect(held).to_contain_text('me@example.org')
    await held.get_by_role('button', name='Undo').click()
    await expect(page.locator('#toast')).to_contain_text('Undone')
    assert server.sent('POST', '/api/activity/act-1/undo') == [{}]
    # The server's own line says it was undone; that settles the card into one muted line.
    await patch_state(page, f"""
        s.chats[{writer!r}].push({{id: 'send-act-1', role: 'system', kind: 'connector', connectorId: 'google', text: 'You undid the email to bob@example.org. It was not sent.', at: new Date().toISOString()}});""")
    await expect(page.locator('.cv-held')).to_have_count(0)
    await expect(page.locator('.cv-conn', has_text='You undid')).to_be_visible()
    await expect(page.locator('.cv-conn', has_text='sending an email')).not_to_contain_text('You can undo')
    assert await page.locator('.cv-conn .btn, .cv-conn button').count() == 0


async def chat_held_send_closes_by_itself_and_late_undo_says_so(page, base):
    server = await install(page)
    writer = (await open_app(page, base, bots={'Writer': EXTRA_BOTS['Writer']}))['Writer']
    await patch_state(page, held_state(writer).replace('Date.now() + 60000', 'Date.now() + 2500'))
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    await expect(page.locator('.cv-held .btn')).to_have_text('Undo')
    # Nothing repaints the chat, yet the button goes when the window ends.
    await expect(page.locator('.cv-held')).to_have_count(0, timeout=6000)
    await expect(page.locator('.cv-conn', has_text='sending an email')).not_to_contain_text('You can undo')
    # Late: the server says it already went out, and the chat is not left in a false state.
    await patch_state(page, held_state(writer).replace("activityId: 'act-1'", "activityId: 'act-late'"))
    await expect(page.locator('.cv-held')).to_have_count(1)
    await page.locator('.cv-held').get_by_role('button', name='Undo').click()
    await expect(page.locator('#toast')).to_contain_text('already went out')


LIMIT_TEMPLATE = """
    const at = new Date().toISOString();
    s.ai = {providers: [{id: 'p1', label: 'My Claude', kind: 'local-cli', engine: 'claude'}, {id: 'p2', label: 'OpenAI', kind: 'api'}], defaultProviderId: 'p1', defaultModel: null, bots: {}};
    s.chats[WRITER] = [
      {id: 'u1', role: 'user', text: 'Summarise my week', at},
      {id: 'r1-model-limit', role: 'system', kind: 'model-limit', runId: 'r1', botId: WRITER, switchTo: 'p2',
       text: 'Atlas could not answer: My Claude has reached its usage limit. You can switch Atlas to OpenAI.', at},
    ];"""


async def chat_model_limit_switch(page, base):
    server = await install(page)
    writer = (await open_app(page, base, bots={'Writer': EXTRA_BOTS['Writer']}))['Writer']
    await patch_state(page, limit_state(writer))
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    card = page.locator('.cv-card', has_text='usage limit')
    await expect(card.get_by_role('button', name='Switch to OpenAI')).to_be_visible()
    await card.get_by_role('button', name='Switch to OpenAI').click()
    await expect(page.locator('#toast')).to_contain_text('Switched to OpenAI')
    assert server.sent('PATCH', f'/api/ai/bots/{writer}') == [{'providerId': 'p2', 'model': ''}]
    # Once the bot uses that provider the card is one muted line, with no button.
    await patch_state(page, f"s.ai.bots = {{{writer!r}: {{providerId: 'p2', model: null}}}};")
    await expect(page.locator('.cv-card', has_text='usage limit')).to_have_count(0)
    await expect(page.locator('.cv-conn', has_text='usage limit')).to_be_visible()
    # Nothing to switch to: no button, only the sentence.
    await patch_state(page, f"s.ai.bots = {{}}; delete s.chats[{writer!r}][1].switchTo; s.chats[{writer!r}][1].text = 'Atlas could not answer: My Claude has reached its usage limit. Connect another model in Settings to switch Atlas.';")
    await expect(page.locator('.cv-conn', has_text='Connect another model')).to_be_visible()
    await expect(page.locator('.cv-card .btn')).to_have_count(0)


async def phone_connectors_and_models_fit(page, base):
    await install(page, connectors=[connector('Notes')])
    writer = (await open_app(page, base, bots={'Writer': EXTRA_BOTS['Writer']}))['Writer']
    await page.locator('.ch-me').click()
    await page.locator('#main .st-phone .rw', has_text='Connectors').click()
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Connectors')
    await expect(page.locator('#main .cn-mcp')).to_have_count(1)
    await expect(page.locator('#ca-search')).to_be_visible()
    await page.locator('#main .cn-custom summary').click()
    await expect(page.locator('#connector-add-form')).to_be_visible()
    assert await overflow(page) <= 0, 'Connectors overflows the phone'
    await page.locator('#main [data-action="settings-back"]').click()
    await page.locator('#main .st-phone .rw', has_text='Models and keys').click()
    await expect(page.locator('#cli-provider-form')).to_be_visible()
    assert await overflow(page) <= 0, 'Models and keys overflows the phone'
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.evaluate(f"""localStorage.setItem({KEY!r}, JSON.stringify((s => {{ const at = new Date().toISOString();
        s.connectors = [{{id: 'google', kind: 'google', name: 'Google', account: 'me@example.org'}}];
        s.chats[{writer!r}] = [{{id: 'c1', role: 'system', kind: 'connector', connectorId: 'google', activityId: 'a', undoUntil: new Date(Date.now() + 60000).toISOString(), text: 'Atlas is sending an email to bob@example.org. You can undo it until it goes out.', at}}];
        return s; }})(JSON.parse(localStorage.getItem({KEY!r})))))""")
    await page.reload()
    await expect(page.locator('.cv-held .btn')).to_have_text('Undo')
    assert await overflow(page) <= 0, 'the held send overflows the phone'


async def main():
    shots = Path(tempfile.mkdtemp(prefix='usability-smoke-shots-'))
    site_dir = Path(tempfile.mkdtemp(prefix='usability-smoke-site-'))
    try:
        server = serve(build_site(site_dir))
        base = f'http://127.0.0.1:{server.server_address[1]}'
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
            h = Harness(browser, base, shots)
            print(f'Usability smoke against {base}')
            await h.scenario('bot: create from the New bot page and land in its chat', create_bot_from_page)
            await h.scenario('bot: edit renames it and a menu move puts it under a manager', edit_rename_and_move)
            await h.scenario('bot: delete asks first, and its reports go Solo', delete_bot_reports_go_solo)
            await h.scenario('bot: Atlas has no Delete or Hide; pin from the menu', atlas_has_no_delete)
            await h.scenario('pin: the menu pins, the menu key opens it, Alt+arrows reorder and it is saved', pin_by_menu_and_move_by_keyboard)
            await h.scenario('pin: drag a row to the pinned row, reorder faces, drag one out, reorder rows, Esc cancels', drag_to_pin_reorder_and_unpin)
            await h.scenario('pin: dropping on a manager moves the bot to its team', drag_onto_a_manager_moves_it_to_the_team)
            await h.scenario('asks: the card, Allow once, Always allow, Decline, and what is left', ask_cards_answer_and_collapse)
            await h.scenario('permissions: edit a rule in place, Deny shows, payments never Always allow, the activity chips', permissions_edit_in_place_and_deny)
            await h.scenario('pause: the banner says so on every screen and Resume lifts it', pause_banner_and_resume)
            await h.scenario('settings: opens from the avatar, Bots running pauses, Esc closes', settings_from_avatar_and_esc)
            await h.scenario('activity: four chips, bots made are logged, a profile counts its own', activity_page_and_counts)
            await h.scenario('out-of-job reply: three buttons, each does its thing', out_of_job_card)
            await h.scenario('checkpoint card and page ask: the waiting face sits above', checkpoint_and_ask_cards)
            await h.scenario('faces: hello hop, one hop per first reply, awake and asleep', faces_come_alive)
            await h.scenario('keyboard: Tab, Enter, Ctrl+K and Esc in the sidebar', keyboard_and_escape)
            await h.scenario('phone: create a bot from the + button', phone_create_bot, PHONE)
            await h.scenario('phone: bottom search opens on focus and closes on Esc or a tap', phone_search_and_escape, PHONE)
            await h.scenario('phone: Settings cards, a section, Back, Esc, and the menu sheet', phone_settings_cards, PHONE)
            await h.scenario('phone: ask card, permissions and the pause banner', phone_ask_card_permissions_and_pause, PHONE)
            await h.scenario('phone: long press opens the options sheet; hold and drag pins', phone_long_press_menu_and_drag, PHONE)
            await h.scenario('computer: the row says Browsing, the view shows a frame and the pages of the run', computer_row_frame_and_pages)
            await h.scenario('computer: Take over sends clicks, keys, the wheel and an address to the page', computer_take_over_drives_the_page)
            await h.scenario('computer: Hand back returns the browser to the bot', computer_hand_back)
            await h.scenario('computer: no device shows how to start the local agent, and notices', computer_no_device_empty_state)
            await h.scenario('computer: the demo has no browser, and Atlas has a Computer too', computer_demo_has_no_browser)
            await h.scenario('computer: the pill carries the site chip, opens the view and says You are driving', computer_site_chip_on_the_pill)
            await h.scenario('phone: the Computer view fits and its controls are thumb-sized', phone_computer_view, PHONE)
            await h.scenario('connectors: add an MCP server over HTTP and on the agent, refresh its tools, delete asks first, no secret is painted', connectors_add_and_delete_mcp)
            await h.scenario('connectors: the Google setup form, a plain Connect Google link, connected and reconnect states', google_setup_form_connect_and_reconnect)
            await h.scenario('connectors: ?google=connected toasts once, strips the address and opens Connectors; an error says why', google_return_toast_and_clean_address)
            await h.scenario('models: a subscription is a name and an engine with no key field, and its row says where it is signed in', subscription_provider_and_cli_status)
            await h.scenario('models: Add a model is one card with a choice, the dots hold Edit, Refresh and Delete, one model picker', models_api_provider_menu_and_one_model_picker)
            await h.scenario('models: a provider\'s list loads by itself into the dropdown, and Other… takes any id', model_list_loads_by_itself)
            await h.scenario('agents: one page with each computer online or not, claude and codex sign-in, a switch per permission, Revoke asks first', agents_page_status_signin_and_switches)
            await h.scenario('agents: the pairing form is switches, the code shows once with the command to run', agents_page_pairing_form_and_code)
            await h.scenario('team: roles are pills, the owner has none, sessions are not on this page', team_roles_are_pills_and_sessions_are_not_here)
            await h.scenario('notifications: switches that save at once; webhook and email show only when they can deliver', notifications_are_switches_and_unwired_channels_are_hidden)
            await h.scenario('notifications: no webhook switch without a saved address, no email without a mailbox', notifications_hide_webhook_without_a_saved_address)
            await h.scenario('data: Reveal not offered for app-kept secrets, Prune and Restore ask first, backup is owner only', data_cards_keep_reveal_prune_and_restore_confirms)
            await h.scenario('demo: Connectors and Models and keys say they need the server', demo_says_connectors_and_models_need_the_server)
            await h.scenario('chat: connector use is hidden, a held send has Undo and names the account, then collapses to a muted line', chat_connector_lines_and_undo)
            await h.scenario('chat: the Undo button goes when its window ends, and a late Undo says it already went out', chat_held_send_closes_by_itself_and_late_undo_says_so)
            await h.scenario('chat: a usage limit offers Switch to the provider named, then settles', chat_model_limit_switch)
            await h.scenario('chat: a run\'s hops fold into one line that updates and opens, at phone width', chat_hops_fold_into_one_line, {'width': 375, 'height': 812})
            await h.scenario('phone: Connectors, Models and keys and a held send fit and are usable', phone_connectors_and_models_fit, PHONE)
            await h.scenario('phone: Models and keys, with its dots, fits', phone_models_page_fits, PHONE)
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'USABILITY SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'USABILITY SMOKE PASS: {len(h.results)} scenarios; new bot, edit and move, delete, Atlas, pin and reorder, ask cards, permissions, pause banner, settings, out-of-job card, checkpoint card, faces, keyboard, phone, Computer view (row, frame, takeover input, hand back, no device, demo, site chip), Connectors (MCP add and delete, Google setup, return toast), subscription providers and CLI status, Undo and Switch lines in chat, no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
