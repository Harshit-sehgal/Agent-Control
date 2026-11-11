"""Interactive browser checks for the chat-first UI: bots, groups, sheets and keyboard.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/usability_smoke.py   (screenshots of failures land in a temp dir)
No network, no credentials, nothing is ever posted to X.
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
from datetime import datetime, timedelta
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = {'width': 1360, 'height': 860}
PHONE = {'width': 390, 'height': 844}
TEAM = 'team-x-engage'
BOT_IDS = ['scout', 'ranker', 'researcher', 'writer', 'reviewer', 'handoff']
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


async def open_app(page, base, hash_=''):
    await page.goto(f'{base}/index.html{hash_}')
    await page.locator('.chat-row').first.wait_for()


async def overflow(page):
    return await page.evaluate('() => document.documentElement.scrollWidth - innerWidth')


async def hash_(page):
    return await page.evaluate('location.hash')


# ---------------------------------------------------------------- helpers



async def open_info_section(page, section):
    await page.locator('.thread-title').click()
    await page.locator(f'#inspector [data-action="open-section"][data-section="{section}"]').click()


async def toast_text(page):
    return await page.locator('#toast').inner_text()


# ---------------------------------------------------------------- scenarios













async def create_bot_from_template(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .new-chat').click()
    await page.locator('#modal [data-action="new-bot"]').click()
    form = page.locator('#new-bot-form')
    await expect(form).to_be_visible()
    await expect(form.locator('input[name=name]')).to_be_focused()
    await expect(form.locator('select[name=group]')).to_have_value('x-engage')
    # A template fills both fields; the user then renames it.
    await page.get_by_label('Bot template').select_option('writer')
    await expect(form.locator('input[name=name]')).to_have_value('Writer')
    assert (await form.locator('textarea[name=instructions]').input_value()).startswith('Write clear, concise drafts')
    await page.get_by_label('Bot template').select_option('blank')
    await expect(form.locator('input[name=name]')).to_have_value('')
    await page.get_by_label('Bot template').select_option('review')
    await expect(form.locator('input[name=name]')).to_have_value('Reviewer')
    await form.locator('input[name=name]').fill('Publishing assistant')
    await form.locator('button.tint[data-index="3"]').click()
    await expect(form.locator('button.tint[data-index="3"]')).to_have_attribute('aria-pressed', 'true')
    await form.locator('button[type=submit]').click()
    # Lands in the new bot's own chat.
    await expect(page.locator('#modal')).to_be_hidden()
    await expect(page.locator('.thread-title strong')).to_have_text('Publishing assistant')
    assert (await hash_(page)).startswith('#chat/') and TEAM not in await hash_(page), await hash_(page)
    await expect(page.locator('#chat-space .welcome')).to_contain_text('Check drafts for unsupported facts')
    await expect(page.locator('#toast')).to_contain_text('Publishing assistant is ready')
    await expect(page.locator('.chat-row', has_text='Publishing assistant')).to_have_count(1)
    await expect(page.locator('.chat-row.current')).to_contain_text('Publishing assistant')
    # A custom bot answers with the offline command set and says so.
    await page.locator('#chat-form textarea').fill('hello')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.msg.them .text').last).to_contain_text('offline demo')
    # Survives a reload.
    await page.reload()
    await expect(page.locator('.thread-title strong')).to_have_text('Publishing assistant')


async def create_group(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .new-chat').click()
    await page.locator('#modal [data-action="new-group"]').click()
    form = page.locator('#new-group-form')
    await form.locator('input[name=name]').fill('Product research')
    await form.locator('textarea[name=description]').fill('Reads docs and summarises them.')
    await form.locator('button[type=submit]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Product research')
    await expect(page.locator('#inspector .hero h2')).to_have_text('Product research')  # lands on its info panel
    await expect(page.locator('#toast')).to_contain_text('Group created')
    await expect(page.locator('.chat-row', has_text='Product research')).to_have_count(1)
    # Add a bot straight from the empty group's info panel.
    await page.locator('#inspector [data-action="add-bot-to-group"]').click()
    selected = await page.locator('#new-bot-form select[name=group] option:checked').inner_text()
    assert selected == 'Product research', selected
    await page.locator('#new-bot-form input[name=name]').fill('Reader')
    await page.locator('#new-bot-form textarea[name=instructions]').fill('Read the docs and report key points.')
    await page.locator('#new-bot-form button[type=submit]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Reader')
    await expect(page.locator('.thread-title')).to_contain_text('Product research')


async def edit_profile_persists(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="writer"]').click()
    await page.locator('.thread-title').click()
    await expect(page.locator('#inspector .hero h2')).to_have_text('Writer')
    await page.locator('#inspector [data-action="open-section"][data-section="edit"]').click()
    form = page.locator('#edit-bot-form')
    await expect(form.locator('input[name=name]')).to_have_value('Writer')
    await form.locator('input[name=name]').fill('Lead Writer')
    await form.locator('textarea[name=instructions]').fill('Draft concise replies, then hand to Reviewer.')
    await form.locator('button[type=submit]').click()
    await expect(page.locator('#toast')).to_contain_text('Profile saved')
    await expect(page.locator('.thread-title strong')).to_have_text('Lead Writer')
    await expect(page.locator('#inspector')).to_contain_text('Draft concise replies, then hand to Reviewer.')
    await expect(page.locator('.chat-row[data-id="writer"] .chat-row-name')).to_have_text('Lead Writer')

    async def profile_is_in_store():
        stored = await page.evaluate("() => JSON.parse(localStorage.getItem('agent-control-ghpages-v1'))")
        bot = next(b for g in stored['groups'] for b in g['bots'] if b['id'] == 'writer')
        assert bot['name'] == 'Lead Writer' and bot['instructions'].startswith('Draft concise replies'), bot
        # The cosmetic record must not mirror name/instructions, or it would shadow the store.
        profiles = await page.evaluate("() => JSON.parse(localStorage.getItem('agent-control-bot-profiles-v2') || '{}')")
        assert not any('name' in v or 'instructions' in v for v in profiles.values()), profiles
    await profile_is_in_store()
    # Same context, real reload: the edit is still there.
    await page.reload()
    await expect(page.locator('.chat-row[data-id="writer"] .chat-row-name')).to_have_text('Lead Writer')
    await expect(page.locator('.thread-title strong')).to_have_text('Lead Writer')
    await expect(page.locator('#inspector')).to_contain_text('Draft concise replies, then hand to Reviewer.')
    await profile_is_in_store()
    # Validation: a blank name is refused by the form and nothing changes.
    await page.locator('#inspector [data-action="open-section"][data-section="edit"]').click()
    await page.locator('#edit-bot-form input[name=name]').fill('')
    await page.locator('#edit-bot-form button[type=submit]').click()
    await expect(page.locator('#edit-bot-form')).to_be_visible()
    await expect(page.locator('.thread-title strong')).to_have_text('Lead Writer')


async def pin_bot(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="reviewer"]').click()
    await page.locator('.thread-title').click()
    await page.locator('#inspector [data-action="pin-bot"]').click()
    await expect(page.locator('#toast')).to_contain_text('Pinned to the top')
    await expect(page.locator('#inspector [data-action="pin-bot"]')).to_contain_text('Unpin from top')
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids[0] == 'reviewer', ids
    await expect(page.locator('.chat-row[data-id="reviewer"] svg').first).to_be_visible()
    # Pins are remembered.
    await page.reload()
    await page.locator('.chat-row').first.wait_for()
    first = await page.locator('.chat-row').first.get_attribute('data-id')
    assert first == 'reviewer', first
    # Unpin puts it back in its natural place.
    await page.locator('#inspector [data-action="pin-bot"]').click()
    await expect(page.locator('#toast')).to_contain_text('Unpinned')
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids == [TEAM] + BOT_IDS, ids


async def duplicate_bot(page, base):
    await open_app(page, base, '#chat/scout/info')
    await page.locator('#inspector [data-action="duplicate-bot"]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Scout copy')
    await expect(page.locator('#chat-space .welcome')).to_contain_text('home-feed page they approved')
    await expect(page.locator('.chat-row', has_text='Scout copy')).to_have_count(1)


async def clear_conversation(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="scout"]').click()
    await page.locator('.thread-title').click()
    # Empty: nothing to clear, and no sheet.
    await page.locator('#inspector [data-action="clear-chat"]').click()
    await expect(page.locator('#toast')).to_contain_text('already empty')
    await expect(page.locator('#modal')).to_be_hidden()
    await page.locator('#chat-form textarea').fill('What can you do?')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.msg.them .text').last).to_contain_text('My job')
    await expect(page.locator('.msg.me')).to_have_count(1)
    clear = page.locator('#inspector [data-action="clear-chat"]')
    await clear.click()
    sheet = page.get_by_role('dialog', name='Clear this conversation?')
    await expect(sheet).to_be_visible()
    await expect(sheet.locator('[data-action="sheet-confirm"]')).to_have_class(re.compile('danger'))
    # Cancel keeps the messages.
    await sheet.locator('[data-action="close-sheet"]').last.click()
    await expect(sheet).to_be_hidden()
    await expect(page.locator('.msg.me')).to_have_count(1)
    await clear.click()
    await page.locator('[data-action="sheet-confirm"]').click()
    await expect(sheet).to_be_hidden()
    await expect(page.locator('#toast')).to_contain_text('Conversation cleared')
    await expect(page.locator('.msg.me')).to_have_count(0)
    await expect(page.locator('#chat-space .welcome')).to_be_visible()
    await expect(page.locator('.chat-row[data-id="scout"] .chat-row-preview')).to_contain_text('home-feed page')
    # Clearing is local to that conversation and survives a reload.
    await page.reload()
    await expect(page.locator('.msg.me')).to_have_count(0)






async def runs_log(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await page.locator('#chat-form textarea').fill('Research the launch plan')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('#chat-space .event').last).to_contain_text('Done in', timeout=10000)
    await open_info_section(page, 'runs')
    card = page.locator('#inspector .run-card')
    await expect(card).to_have_count(1)
    await expect(card).to_contain_text('Research the launch plan')


async def sheet_keyboard(page, base):
    await open_app(page, base)
    # A sheet takes focus as it opens, before any animation frame. A deferred
    # focus used to land after the user had moved to the next field.
    inside = await page.evaluate('''async () => {
        document.querySelector('#sidebar .new-chat').click();
        for (let i = 0; i < 4; i++) await Promise.resolve();
        return Boolean(document.activeElement?.closest('#modal'));
    }''')
    assert inside, 'the sheet must hold focus as soon as it opens'
    await page.keyboard.press('Escape')
    await expect(page.locator('#modal')).to_be_hidden()
    trigger = page.locator('#sidebar .new-chat')
    await trigger.focus()
    await page.keyboard.press('Enter')
    sheet = page.locator('#modal .sheet')
    await expect(sheet).to_be_visible()
    await page.locator('#modal [data-action="new-bot"]').click()
    await expect(page.locator('#new-bot-form')).to_be_visible()
    inside = "() => document.getElementById('modal').contains(document.activeElement)"
    seen = set()
    # Tab forwards and backwards past both ends: focus never leaves the sheet.
    for _ in range(18):
        await page.keyboard.press('Tab')
        assert await page.evaluate(inside), 'Tab escaped the sheet'
        seen.add(await page.evaluate('document.activeElement.outerHTML.slice(0, 60)'))
    assert len(seen) >= 5, seen
    for _ in range(18):
        await page.keyboard.press('Shift+Tab')
        assert await page.evaluate(inside), 'Shift+Tab escaped the sheet'
    # Clicking the backdrop closes it; so does Escape; focus goes back to the opener.
    await page.keyboard.press('Escape')
    await expect(sheet).to_be_hidden()
    await expect(trigger).to_be_focused()
    await trigger.click()
    await page.locator('#modal').click(position={'x': 5, 'y': 5})
    await expect(page.locator('#modal')).to_be_hidden()
    # The command palette traps Tab as well.
    await page.keyboard.press('Control+k')
    await expect(page.locator('#command-input')).to_be_focused()
    for _ in range(6):
        await page.keyboard.press('Tab')
        assert await page.evaluate("() => document.getElementById('command').contains(document.activeElement)"), 'Tab escaped the palette'
    await page.keyboard.press('Escape')
    # Sheets declare themselves as modal dialogs.
    await trigger.click()
    await expect(page.locator('#modal [role=dialog][aria-modal=true]')).to_have_count(1)


async def group_settings_and_behaviour(page, base):
    await open_app(page, base, f'#chat/{TEAM}/info/group-settings')
    form = page.locator('#group-settings-form')
    await expect(form.locator('input[name=routing]')).to_have_count(3)
    rows = form.locator('#pipeline-rows .pipe-row')
    await expect(rows.first).to_contain_text('1.')
    first = (await rows.first.locator('.check-row').inner_text()).split('.', 1)[1].strip()
    await rows.first.get_by_role('button', name=re.compile('down', re.I)).click()
    await expect(rows.nth(1).locator('.check-row')).to_contain_text(f'2. {first}')
    await expect(rows.first.get_by_role('button', name=re.compile('up', re.I))).to_be_disabled()
    await expect(page.locator('#inspector [data-action="delete-group"]')).to_have_count(1)  # the demo may delete any group
    # The bot profile carries the Behaviour fields.
    await open_app(page, base, '#chat/writer/info/edit')
    edit = page.locator('#edit-bot-form')
    for name in ['enabled', 'replyLength', 'temperature', 'style', 'contextMessages', 'summonable', 'canHandoff']:
        await expect(edit.locator(f'[name={name}]')).to_have_count(1)
    # Typing @ in the composer offers names; picking one completes it.
    await open_app(page, base, f'#chat/{TEAM}')
    box = page.locator('#chat-form textarea')
    await box.fill('ask @wri')
    await box.dispatch_event('input')
    await page.locator('#mention-strip [data-action="mention-pick"]', has_text='Writer').click()
    await expect(box).to_have_value('ask @Writer ')


async def tracked_plan_can_start(page, base):
    """Show-the-plan-first used to stop with no Start button on the demo."""
    await open_app(page, base, '#chat/team-x-engage/info/group-settings')
    form = page.locator('#group-settings-form')
    await form.locator('input[name=confirmPlan]').check()
    await form.locator('button[type=submit]').click()
    await expect(page.locator('#toast')).to_contain_text('Group settings saved')
    await open_app(page, base, '#chat/handoff')
    box = page.locator('#chat-form textarea')
    await box.fill('draft a reply')
    await box.press('Enter')
    start = page.locator('#chat-space [data-action="approve-plan"]')
    cancel = page.locator('#chat-space [data-action="cancel-plan"]')
    await expect(start).to_be_visible()
    await cancel.click()
    await expect(page.locator('#chat-space')).to_contain_text('Plan cancelled')
    await expect(start).to_have_count(0)
    await box.fill('draft a reply')
    await box.press('Enter')
    await start.click()
    await expect(page.locator('#chat-space .msg.them').first).to_be_visible(timeout=15000)


async def phone_create_bot(page, base):
    await open_app(page, base)
    await page.locator('.fab').click()
    await page.locator('#modal [data-action="new-bot"]').click()
    await page.get_by_label('Bot template').select_option('research')
    await expect(page.locator('#new-bot-form input[name=name]')).to_have_value('Researcher')
    await page.locator('#new-bot-form input[name=name]').fill('Market scanner')
    await page.locator('#new-bot-form button[type=submit]').click()
    await expect(page.locator('body')).to_have_attribute('data-pane', 'main')
    await expect(page.locator('.thread-title strong')).to_have_text('Market scanner')
    assert await overflow(page) <= 0
    await page.locator('#thread-head .back').click()
    await expect(page.locator('body')).to_have_attribute('data-pane', 'list')
    await expect(page.locator('.chat-row', has_text='Market scanner')).to_have_count(1)


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
            await h.scenario('bot: create from template and land in its chat', create_bot_from_template)
            await h.scenario('group: create and add a bot', create_group)
            await h.scenario('bot: edit profile survives reload', edit_profile_persists)
            await h.scenario('bot: pin sorts to top and persists', pin_bot)
            await h.scenario('bot: duplicate', duplicate_bot)
            await h.scenario('conversation: clear via confirm sheet', clear_conversation)
            await h.scenario('runs log shows the handoff trace', runs_log)
            await h.scenario('keyboard: Tab trapped in sheets and palette, Esc restores focus', sheet_keyboard)
            await h.scenario('group settings reorder, behaviour fields, @mention help', group_settings_and_behaviour)
            await h.scenario('tracked plan can be started or cancelled', tracked_plan_can_start)
            await h.scenario('phone: create a bot from the + button', phone_create_bot, PHONE)
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'USABILITY SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'USABILITY SMOKE PASS: {len(h.results)} scenarios; bots, pins, clear, sheets, keyboard, no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
