"""Interactive browser checks for the chats shell: new bots, the cards that wait on you, faces and keyboard.

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
    return 'frame-ancestors' in msg.text or 'favicon' in url


class Harness:
    def __init__(self, browser, base, shots):
        self.browser, self.base, self.shots = browser, base, shots
        self.results = []

    async def scenario(self, name, fn, viewport=DESKTOP):
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


SCREEN = '#main .cv, #main .hv, #main .rail-none, #main .nv, #main .pg, #main .page-body'


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

async def create_bot_from_page(page, base):
    await open_app(page, base)
    await page.locator('#sidebar [data-action="new-bot"]').click()
    assert await hash_(page) == '#new-bot'
    form = page.locator('#new-bot-lite-form')
    await expect(form).to_be_visible()
    await expect(form.locator('input[name=name]')).to_be_focused()
    await form.locator('input[name=name]').fill('Publishing assistant')
    await form.locator('textarea[name=instructions]').fill('Check drafts for unsupported facts.')
    await form.locator('button[type=submit]').click()
    # Lands in the new bot's own chat, which says what the bot is for.
    await expect(page.locator('#main h1')).to_have_text('Publishing assistant')
    assert (await hash_(page)).startswith('#bot/'), await hash_(page)
    await expect(page.locator('#cv-log .cv-empty')).to_contain_text('Check drafts for unsupported facts')
    await expect(page.locator('#toast')).to_contain_text('Publishing assistant is ready')
    await expect(page.locator('#sidebar .crow', has_text='Publishing assistant')).to_have_count(1)
    await expect(page.locator('#sidebar .crow.on')).to_contain_text('Publishing assistant')
    # A bot answers in its own chat, and says when it is the offline demo.
    await page.locator('#chat-form textarea').fill('hello')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.cv-bot .cv-body').last).to_contain_text('Pages demo', timeout=10000)
    await page.reload()
    await expect(page.locator('#main h1')).to_have_text('Publishing assistant')


async def phone_create_bot(page, base):
    await open_app(page, base)
    await page.locator('.ch-new').click()
    await page.locator('#new-bot-lite-form input[name=name]').fill('Market scanner')
    await page.locator('#new-bot-lite-form textarea[name=instructions]').fill('Watch the market and report moves.')
    await page.locator('#new-bot-lite-form button[type=submit]').click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'chat')
    await expect(page.locator('#main h1')).to_have_text('Market scanner')
    assert await overflow(page) <= 0
    await page.locator('#main .cv-head .rbtn').first.click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    await expect(page.locator('#main .crow', has_text='Market scanner')).to_have_count(1)


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
    await expect(page.locator('#new-bot-lite-form textarea[name=instructions]')).to_have_value('Book me a table for Friday')
    await page.go_back()
    # Ask Atlas starts a thread with the request; the owner's line is written once.
    await page.locator('.cv-card').get_by_role('button', name='Ask Atlas').click()
    await expect(page.locator('#cv-line')).to_have_text('Atlas runs this thread', timeout=10000)
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
            await h.scenario('out-of-job reply: three buttons, each does its thing', out_of_job_card)
            await h.scenario('checkpoint card and page ask: the waiting face sits above', checkpoint_and_ask_cards)
            await h.scenario('faces: hello hop, one hop per first reply, awake and asleep', faces_come_alive)
            await h.scenario('keyboard: Tab, Enter, Ctrl+K and Esc in the sidebar', keyboard_and_escape)
            await h.scenario('phone: create a bot from the + button', phone_create_bot, PHONE)
            await h.scenario('phone: bottom search opens on focus and closes on Esc or a tap', phone_search_and_escape, PHONE)
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'USABILITY SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'USABILITY SMOKE PASS: {len(h.results)} scenarios; new bot, out-of-job card, checkpoint card, faces, keyboard, phone search, no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
