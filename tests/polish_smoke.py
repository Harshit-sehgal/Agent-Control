"""Browser smoke test for the chats shell: layout, navigation and responsiveness.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/polish_smoke.py   (screenshots of failures land in a temp dir)
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


# ---------------------------------------------------------------- scenarios

async def first_run(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    # A laptop opens on the primary bot's chat, with Atlas pinned as a large face.
    assert await hash_(page) == '#bot/atlas', await hash_(page)
    await expect(page.locator('#main h1')).to_have_text('Atlas')
    await expect(page.locator('#cv-line')).to_have_text('Hands work to any bot')
    await expect(page.locator('#sidebar .pin')).to_have_count(1)
    await expect(page.locator('#sidebar .pin')).to_contain_text('Atlas')
    await expect(page.locator('#sidebar .rail-status')).to_contain_text('Atlas on watch')
    await expect(page.locator('#sidebar .rail-demo')).to_contain_text('Browser-only')
    names = await page.locator('#sidebar .crow b').all_inner_texts()
    assert names == ['Researcher', 'Writer', 'Reviewer'], names
    await expect(page.locator('#sidebar .badge')).to_have_count(0)
    await expect(page.locator('#cv-log .cv-empty')).to_contain_text('offline demo')
    # Search narrows by name or job and says so when nothing matches.
    await page.locator('#rail-q').fill('wri')
    await expect(page.locator('#sidebar .crow')).to_have_count(1)
    await expect(page.locator('#sidebar .crow')).to_contain_text('Writer')
    await page.locator('#rail-q').fill('unsupported claims')
    await expect(page.locator('#sidebar .crow')).to_contain_text('Reviewer')
    await page.locator('#rail-q').fill('zzzz-nothing')
    await expect(page.locator('#sidebar .hv-empty')).to_contain_text('No match')
    await page.locator('#rail-q').fill('')
    await expect(page.locator('#sidebar .crow')).to_have_count(3)


async def bot_chat_flow(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    before = await page.locator('#sidebar .crow').evaluate_all('rows => rows.map(r => r.dataset.id)')
    await page.locator(f'#sidebar .crow[data-id="{ids["Writer"]}"]').click()
    assert await hash_(page) == f'#bot/{ids["Writer"]}'
    await expect(page.locator('#main h1')).to_have_text('Writer')
    await expect(page.locator('#cv-line')).to_have_text('One continuous chat')
    box = page.locator('#chat-form textarea[name=message]')
    # Shift+Enter is a newline, not a send.
    await box.fill('line one')
    await box.press('Shift+Enter')
    await box.type('line two')
    assert await box.input_value() == 'line one\nline two'
    await expect(page.locator('.cv-me')).to_have_count(0)
    await box.fill('Draft a reply')
    await box.press('Enter')
    # The owner's mint bubble, then the bot's own reply with its face and name.
    await expect(page.locator('.cv-me').first).to_have_text('Draft a reply')
    await expect(page.locator('.cv-bot .cv-name').last).to_contain_text('Writer', timeout=10000)
    assert await box.input_value() == ''
    # A bot that answered by itself leaves no "helped" pill and no routing chatter.
    await expect(page.locator('.cv-done')).to_have_count(0)
    # The sidebar keeps its order: messaging a bot never moves it up.
    after = await page.locator('#sidebar .crow').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert after == before, (before, after)
    await expect(page.locator(f'#sidebar .crow[data-id="{ids["Writer"]}"] .crow-prev')).to_contain_text('Draft a reply')
    # The conversation survives a reload, on the same hash.
    await page.reload()
    await expect(page.locator('.cv-me').first).to_have_text('Draft a reply')


async def thread_run(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator('#sidebar .rail-new').click()
    assert await hash_(page) == '#new-thread'
    await expect(page.locator('#main h2')).to_have_text('What should the company get done?')
    box = page.locator('#new-thread-form textarea')
    await box.fill('Ask @Researcher to find papers and @Writer to summarise them')
    await box.press('Enter')
    # A thread is a new chat run by Atlas, never a bot's own chat.
    await expect(page.locator('#cv-line')).to_have_text('Atlas runs this thread', timeout=10000)
    assert (await hash_(page)).startswith('#thread/'), await hash_(page)
    await expect(page.locator('.cv-me')).to_have_count(1)  # the owner's first line is written once
    await expect(page.locator('#main .cv-who')).to_have_count(0)  # no face: Atlas runs every thread
    # While it works one pill updates; when it is done a quiet pill names who helped.
    await expect(page.locator('.cv-done summary')).to_contain_text('helped', timeout=10000)
    await expect(page.locator('.cv-done summary')).to_contain_text('Researcher')
    await page.locator('.cv-done summary').click()
    await expect(page.locator('.cv-plog li').first).to_be_visible()
    assert await page.locator('.cv-plog li').count() >= 2
    # The thread is listed under Threads, selected.
    await expect(page.locator('#sidebar .trow.on')).to_contain_text('Ask @Researcher')
    # A follow-up goes to Atlas again, even with an @mention.
    followup = page.locator('#chat-form textarea')
    await followup.fill('thanks, now ask @Reviewer to check it')
    await followup.press('Enter')
    await expect(page.locator('.cv-me')).to_have_count(2)
    await expect(page.locator('.cv-bot .cv-name').last).to_contain_text('Atlas', timeout=10000)
    # An open thread turns the sidebar's switch to Threads; Bots brings the bot rows back.
    await expect(page.locator('#rail-seg')).to_have_attribute('data-on', 'threads')
    await expect(page.locator('#sidebar .crow')).to_have_count(0)
    await page.locator('#rail-seg [data-section="bots"]').click()
    await expect(page.locator('#rail-seg [data-section="bots"]')).to_have_attribute('aria-selected', 'true')
    await expect(page.locator('#sidebar .trow')).to_have_count(0)
    # Back on the home, the thread stays out of the bot rows.
    await page.locator(f'#sidebar .crow[data-id="{ids["Writer"]}"]').click()
    await expect(page.locator('#cv-log .cv-me')).to_have_count(0)


async def search_shortcuts(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    rail = page.locator('#rail-q')
    await page.locator('#main').click(position={'x': 10, 'y': 300})
    await page.keyboard.press('/')
    await expect(rail).to_be_focused()
    assert await rail.input_value() == ''  # the key focuses the box and is not typed into it
    await page.keyboard.type('revi')
    await expect(page.locator('#sidebar .crow')).to_have_count(1)
    await page.keyboard.press('Escape')
    await expect(rail).not_to_be_focused()
    assert await rail.input_value() == ''
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    await page.keyboard.press('Control+k')
    await expect(rail).to_be_focused()
    await page.keyboard.press('Escape')
    await page.keyboard.press('t')
    await expect(rail).to_be_focused()
    # Typing in the message box is never hijacked.
    await page.locator('#chat-form textarea').fill('')
    await page.locator('#chat-form textarea').focus()
    await page.keyboard.type('t/')
    assert await page.locator('#chat-form textarea').input_value() == 't/'


async def history_routes(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator(f'#sidebar .crow[data-id="{ids["Writer"]}"]').click()
    assert await hash_(page) == f'#bot/{ids["Writer"]}'
    await page.locator('#sidebar .pin').click()
    assert await hash_(page) == '#bot/atlas'
    await page.go_back()
    assert await hash_(page) == f'#bot/{ids["Writer"]}'
    await expect(page.locator('#main h1')).to_have_text('Writer')
    await page.go_back()
    assert await hash_(page) == '#bot/atlas'
    await expect(page.locator('#main h1')).to_have_text('Atlas')
    await page.go_forward()
    await expect(page.locator('#main h1')).to_have_text('Writer')
    # Deep links work cold, in a fresh load; unknown targets fall back to the list.
    await page.goto(f'{base}/index.html#chat/{PRIMARY}/info/edit')  # an old hash lands on the bot's Edit page
    await page.reload()
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Edit')
    await expect(page.locator('#edit-bot-form input[name=name]')).to_have_value('Atlas')
    await page.goto(f'{base}/index.html#new-bot')
    await page.reload()
    await expect(page.locator('#new-bot-form')).to_be_visible()
    await page.goto(f'{base}/index.html#you/about')
    await page.reload()
    await expect(page.locator('#main .st-head h2')).to_have_text('About this build')
    await page.goto(f'{base}/index.html#thread/does-not-exist')
    await page.reload()
    await expect(page.locator('#main .rail-none')).to_contain_text('Select a chat')
    await page.goto(f'{base}/index.html#team')  # an admin page is refused without a server session
    await page.reload()
    await expect(page.locator('#main .st-head h2')).to_have_text('General')
    await page.goto(f'{base}/index.html#bot/does-not-exist')
    await page.reload()
    await expect(page.locator('#main .rail-none')).to_contain_text('Select a chat')


async def you_pages(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .rail-me').click()
    assert await hash_(page) == '#settings'
    await expect(page.locator('#main .st-head h2')).to_have_text('General')
    await expect(page.locator('#main')).to_contain_text('Browser-only demo')
    await page.locator('#main [data-action="settings-open"][data-section="about"]').click()
    assert await hash_(page) == '#settings/about', await hash_(page)
    await expect(page.locator('#main .st-head h2')).to_have_text('About this build')
    await page.locator('#main .st-nav [data-section="look"]').click()
    await expect(page.locator('#main .st-head h2')).to_have_text('Appearance')


async def phone_flow(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    body = page.locator('body')
    await expect(body).to_have_attribute('data-view', 'home')
    await expect(page.locator('#sidebar')).to_be_hidden()
    await expect(page.locator('#chrome')).to_be_visible()
    await expect(page.locator('#ch-ind')).to_have_attribute('data-on', 'bots')
    await expect(page.locator('#main .shelf .pin')).to_have_count(1)  # Atlas, pinned, in a row of large faces
    await expect(page.locator('#main .crow')).to_have_count(3)
    assert await overflow(page) <= 0
    # Swipe left reaches Threads, swipe right comes back. A swipe on the pinned row does not.
    async def swipe(start, end, y=500):
        await page.mouse.move(start, y)
        await page.mouse.down()
        await page.mouse.move((start + end) / 2, y, steps=4)
        await page.mouse.move(end, y, steps=4)
        await page.mouse.up()
    box = await page.locator('#main .shelf').bounding_box()
    await swipe(300, 60, y=box['y'] + box['height'] / 2)
    await expect(page.locator('#ch-ind')).to_have_attribute('data-on', 'bots')
    await swipe(300, 60)
    await expect(page.locator('#ch-ind')).to_have_attribute('data-on', 'threads')
    await expect(page.locator('#main .hv')).to_have_attribute('data-section', 'threads')
    await expect(page.locator('#main .hv-empty')).to_contain_text('No threads yet')
    await swipe(60, 300)
    await expect(page.locator('#ch-ind')).to_have_attribute('data-on', 'bots')
    # A bot chat hides the chrome; back goes home, to the same section.
    await page.locator(f'#main .crow[data-id="{ids["Writer"]}"]').click()
    await expect(body).to_have_attribute('data-view', 'chat')
    await expect(page.locator('#chrome')).to_be_hidden()
    await expect(page.locator('#chat-form')).to_be_visible()
    await expect(page.locator('#main .cv-head .rbtn').first).to_have_attribute('aria-label', 'Back to Bots')
    assert await overflow(page) <= 0
    await page.locator('#main .cv-head .rbtn').first.click()
    await expect(body).to_have_attribute('data-view', 'home')
    # Hardware back does the same walk.
    await page.locator('#main .pin').click()
    await expect(body).to_have_attribute('data-view', 'chat')
    await page.go_back()
    await expect(body).to_have_attribute('data-view', 'home')
    # New thread: a page with one box; sending opens the thread and Back lands on Threads' home.
    await page.locator('.ch-thread').click()
    await expect(page.locator('#new-thread-form')).to_be_visible()
    assert await overflow(page) <= 0
    await page.locator('#new-thread-form textarea').fill('Ask @Writer for a draft')
    await page.locator('#new-thread-form textarea').press('Enter')
    await expect(page.locator('#cv-line')).to_have_text('Atlas runs this thread', timeout=10000)
    await page.locator('#main .cv-head .rbtn').first.click()
    await expect(body).to_have_attribute('data-view', 'home')
    await swipe(300, 60)
    await expect(page.locator('#main .trow')).to_have_count(1)
    # The bottom search lists threads when focused and bots when typed into.
    await page.locator('#sq').focus()
    await expect(page.locator('#ch-res')).to_be_visible()
    await expect(page.locator('#ch-res .trow')).to_have_count(1)
    await page.locator('#sq').fill('revi')
    await expect(page.locator('#ch-res .res-bots button')).to_have_count(1)
    await page.locator('#ch-res .res-bots button').click()
    await expect(page.locator('#main h1')).to_have_text('Reviewer')
    assert await overflow(page) <= 0


async def no_overflow(page, base):
    """No horizontal scroll at the extremes, on every kind of screen."""
    routes = ['#chats', '#bot/atlas', '#new-thread', '#new-bot', '#profile/atlas', '#settings', '#settings/about', '#company', '#activity']
    for width in (390, 1360):
        await page.set_viewport_size({'width': width, 'height': 860})
        for route in routes:
            await page.goto(f'{base}/index.html{route}')
            await page.reload()
            await page.locator(SCREEN).first.wait_for(state='attached')
            await page.wait_for_timeout(300)
            extra = await overflow(page)
            assert extra <= 0, f'{route} at {width}px overflows by {extra}px'
        # A long message must wrap instead of widening the page.
        await page.goto(f'{base}/index.html#bot/atlas')
        await page.reload()
        long_word = 'x' * 400
        sent = await page.locator('.cv-me').count()
        await page.locator('#chat-form textarea').fill(f'{long_word} ' + 'word ' * 80)
        await page.locator('#chat-form textarea').press('Enter')
        await expect(page.locator('.cv-me')).to_have_count(sent + 1)
        await page.wait_for_timeout(300)
        extra = await overflow(page)
        assert extra <= 0, f'long message at {width}px overflows by {extra}px'


async def layout_split(page, base):
    """Desktop is a 292px sidebar and the chat beside it; the phone chrome stays out of the way."""
    await open_app(page, base)
    side, main = await page.locator('#sidebar').bounding_box(), await page.locator('#main').bounding_box()
    assert side['x'] == 0 and abs(side['width'] - 292) <= 1, side
    assert main['x'] >= side['x'] + side['width'] - 1, (side, main)
    await expect(page.locator('#chrome')).to_be_hidden()
    # The owner row opens Settings; New thread sits beside it.
    await expect(page.locator('#sidebar .rail-foot .rail-me')).to_be_visible()
    await expect(page.locator('#sidebar .rail-foot .rail-new')).to_be_visible()
    # Crossing below 1024px swaps the sidebar for the phone home.
    await page.set_viewport_size({'width': 800, 'height': 860})
    await expect(page.locator('#sidebar')).to_be_hidden()
    await expect(page.locator('#chat-form')).to_be_visible()
    await page.set_viewport_size({'width': 1360, 'height': 860})
    await expect(page.locator('#sidebar')).to_be_visible()


async def reduced_motion(browser, base):
    context = await browser.new_context(viewport=DESKTOP, reduced_motion='reduce')
    page = await context.new_page()
    problems = []
    page.on('pageerror', lambda e: problems.append(str(e)))
    try:
        await open_app(page, base, bots=EXTRA_BOTS)
        # Faces, rows and view changes all stop: no animation and no transition anywhere that matters.
        names = await page.evaluate('''() => [...document.querySelectorAll('.face, .face--sway, .face-eye')].map(n => getComputedStyle(n).animationName)''')
        assert names and all(n == 'none' for n in names), set(names)
        await page.locator('#sidebar .crow').first.click()
        durations = await page.evaluate('''() => [...document.querySelectorAll('.crow, .rbtn, .cv-send, #main')].map(n => getComputedStyle(n).transitionDuration + '|' + getComputedStyle(n).animationName)''')
        assert all(d.startswith('0s') and d.endswith('|none') for d in durations), durations
        assert not problems, problems
    finally:
        await context.close()


async def main():
    shots = Path(tempfile.mkdtemp(prefix='polish-smoke-shots-'))
    site_dir = Path(tempfile.mkdtemp(prefix='polish-smoke-site-'))
    try:
        server = serve(build_site(site_dir))
        base = f'http://127.0.0.1:{server.server_address[1]}'
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
            h = Harness(browser, base, shots)
            print(f'Polish smoke against {base}')
            await h.scenario('first run: Atlas pinned, sidebar, search', first_run)
            await h.scenario('bot chat: send, reply, order kept, reload', bot_chat_flow)
            await h.scenario('thread: run by Atlas, handoff pill, follow-up', thread_run)
            await h.scenario('search shortcuts: / T Ctrl+K Esc', search_shortcuts)
            await h.scenario('Back/Forward walk the hash routes', history_routes)
            await h.scenario('Settings opens its sections', you_pages)
            await h.scenario('desktop sidebar layout, and the 1024px switch', layout_split)
            await h.scenario('phone: Bots | Threads, chat, thread, search', phone_flow, PHONE)
            await h.scenario('no horizontal overflow at 390px and 1360px', no_overflow, PHONE)
            try:
                await reduced_motion(browser, base)
                print('  ok   reduced motion stops faces and transitions')
                h.results.append(('reduced motion', None))
            except Exception as error:  # noqa: BLE001
                print(f'  FAIL reduced motion: {error}')
                h.results.append(('reduced motion', error))
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'POLISH SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'POLISH SMOKE PASS: {len(h.results)} scenarios; first run, bot chats, thread handoffs, search, history, phone sections, reduced motion, no overflow, no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
