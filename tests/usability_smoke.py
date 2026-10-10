"""Interactive browser checks for Agent Control's v0.5 usability controls."""
import asyncio
import re
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]


def strip_imports(text):
 x=re.sub(r"import\s*\{[^}]*\}\s*from\s*'[^']*';",'',text,flags=re.S)
 return re.sub(r"import\s+[^\n]*?from\s*'[^']*';",'',x)

def page_html():
 s=(ROOT/'shared/index.html').read_text()
 c='\n'.join((ROOT/'shared'/f).read_text() for f in ['app.css','polish.css','usability.css'])
 for name in ('app.css','polish.css','usability.css'):
  s=s.replace(f'<link rel="stylesheet" href="./{name}">','')
 s=s.replace('</head>','<style>'+c+'</style></head>')
 for tag in ['<script type="module" src="./local-api.js"></script>','<script defer src="./transport.js"></script>','<script type="module" src="./app.js"></script>']:
  s=s.replace(tag,'')
 # This harness injects the bundle as an inline script, which the page CSP
 # would block. Drop the CSP meta here only; the deployed page keeps it.
 s=re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>','',s)
 # Mirror the real Pages build: the browser-local demo is marked "static", so
 # the app auto-seeds its sample posts. With the source marker ("server") the
 # app would (correctly) treat the API as a real, empty backend.
 s=s.replace('content="server"','content="static"')
 return s

MODULES=['core.js','workflow.js','usability.js','coordination.js','group-simulator.js','chat-engine.js','local-api.js','app.js']

async def boot(page,seed=None):
 """Load the bundle. `seed` pre-populates the fake localStorage so a caller can
 simulate a reload that preserved data (set_content and reload both wipe the
 in-memory store the harness installs). """
 await page.goto('about:blank')
 await page.set_content(page_html(),wait_until='domcontentloaded')
 await page.evaluate("""s => {const store=Object.assign({},s);Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v},removeItem:k=>{delete store[k]},key:i=>Object.keys(store)[i]??null,get length(){return Object.keys(store).length}}});crypto.randomUUID=()=>String(Date.now())+'-'+Math.random().toString(16).slice(2);} """,seed or {})
 scripts=[]
 for f in MODULES:
  x=strip_imports((ROOT/'shared'/f).read_text())
  x=x.replace('export const ','const ').replace('export function ','function ').replace('export async function ','async function ')
  scripts.append(x)
  if f=='local-api.js': scripts.append('window.AGENT_API=window.AGENT_LOCAL_API;')
 await page.add_script_tag(content='\n'.join(scripts))
 await page.get_by_role('button',name='Create new bot').first.wait_for()

async def bot_profile_edit(page,errors):
 """Editing a lasting bot profile must persist through the shared workflow rules.

 The store is the source of truth: the edit has to survive a reload and must not
 be shadowed by the cosmetic localStorage profile record.
 """
 await boot(page)
 # Target the sidebar entry by bot id: its accessible name carries the avatar
 # glyph (e.g. "⌘Writer"), so a plain name match is fragile.
 await page.locator('#sidebar button[data-action="open-chat"][data-id="writer"]').click()
 await page.get_by_role('button',name='Profile').click()
 await page.locator('#edit-bot-form input[name="name"]').fill('Lead Writer')
 await page.locator('#edit-bot-form textarea[name="instructions"]').fill('Draft concise replies, then hand to Reviewer.')
 await page.locator('#edit-bot-form button:has-text("Save profile")').click()
 await page.get_by_role('heading',name='Lead Writer',exact=True).wait_for()
 # The group record must hold the new instructions, not just the rendered copy.
 stored=await page.evaluate("()=>JSON.parse(localStorage.getItem('agent-control-ghpages-v1'))")
 bot=next(b for g in stored['groups'] for b in g['bots'] if b['id']=='writer')
 assert bot['name']=='Lead Writer',bot
 assert bot['instructions'].startswith('Draft concise replies'),bot
 # The cosmetic record must not carry a stale name/instructions mirror, which
 # would shadow the store forever via profile().
 profiles=await page.evaluate("()=>JSON.parse(localStorage.getItem('agent-control-bot-profiles-v2')||'{}')")
 assert not any('name' in v or 'instructions' in v for v in profiles.values()),profiles
 # And it must survive a reload: re-boot with the persisted data only.
 storage=await page.evaluate("()=>{const o={};for(let i=0;i<window.localStorage.length;i++){const k=window.localStorage.key(i);o[k]=window.localStorage.getItem(k);}return o;}")
 await boot(page,storage)
 await page.locator('#sidebar button[data-action="open-chat"][data-id="writer"]').click()
 await page.get_by_role('heading',name='Lead Writer',exact=True).wait_for()
 panel=page.locator('#inspector .inspector-card').first
 assert 'Draft concise replies' in await panel.inner_text(),await panel.inner_text()
 assert not errors,errors

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,args=['--no-sandbox'])
  desktop=await browser.new_page(viewport={'width':1440,'height':900})
  desktop.set_default_timeout(7000)
  errors=[]
  desktop.on('pageerror',lambda e:errors.append(str(e)))
  await desktop.context.grant_permissions(['clipboard-read','clipboard-write'])
  desktop.on('dialog',lambda d:asyncio.create_task(d.accept()))
  await boot(desktop)
  # dropdown menus on groups
  await desktop.locator('summary[aria-label="X-engage options"]').click()
  assert await desktop.get_by_role('button',name='Add a specialist').is_visible()
  await desktop.get_by_role('button',name='Add a specialist').click()
  await desktop.get_by_label('Bot template').select_option('writer')
  assert await desktop.locator('#new-bot-form input[name="name"]').input_value()=='Writer'
  await desktop.locator('#new-bot-form input[name="name"]').fill('My publishing assistant')
  await desktop.locator('#new-bot-form button[type="submit"]').click()
  await desktop.get_by_role('heading',name='My publishing assistant',exact=True).wait_for()
  # dropdown on individual chat
  await desktop.locator('summary[aria-label="Conversation actions"]').click()
  await desktop.get_by_role('button',name='Pin bot').click()
  await desktop.locator('summary[aria-label="Conversation actions"]').click()
  await desktop.get_by_role('button',name='Duplicate bot').click()
  await desktop.get_by_role('heading',name='My publishing assistant copy',exact=True).wait_for()
  await desktop.locator('summary[aria-label="Conversation actions"]').click()
  await desktop.get_by_role('button',name='Copy conversation').wait_for()
  await desktop.locator('summary[aria-label="Conversation actions"]').click()
  await desktop.keyboard.press('Escape')
  assert await desktop.locator('details.action-menu[open]').count()==0
  # candidates discovery sort and query persists without losing input focus
  await desktop.get_by_role('button',name='X-engage').first.click()
  await desktop.get_by_role('tab',name='Discovery').click()
  await desktop.locator('#candidate-search').fill('robotics')
  assert await desktop.locator('#candidate-results .list-row').count()==1
  await desktop.locator('#candidate-sort').select_option('oldest')
  await desktop.locator('#candidate-status').select_option('drafted')
  assert await desktop.locator('#candidate-results .list-row').count()==0
  await desktop.get_by_role('button',name='Clear filters').click()
  assert await desktop.locator('#candidate-results .list-row').count()==3
  # approvals after drafting / filter state
  await desktop.locator('#candidate-results .list-row').first.get_by_role('button',name='Draft reply').click()
  await desktop.get_by_role('tab',name='Approvals').click()
  assert await desktop.locator('#approval-results .draft-card').count()==1
  await desktop.locator('#draft-status').select_option('posted')
  assert await desktop.locator('#approval-results .draft-card').count()==0
  await desktop.locator('#draft-status').select_option('pending')
  assert await desktop.locator('#approval-results .draft-card').count()==1
  # scheduling disabled field based on mode
  await desktop.get_by_role('tab',name='Schedules').click()
  assert not await desktop.locator('#schedule-form [name=intervalMinutes]').is_disabled()
  assert await desktop.locator('#schedule-form [name=nextAt]').is_disabled()
  await desktop.locator('#schedule-form [name=kind]').select_option('once')
  assert await desktop.locator('#schedule-form [name=intervalMinutes]').is_disabled()
  assert not await desktop.locator('#schedule-form [name=nextAt]').is_disabled()
  await desktop.screenshot(path=str(ROOT/'ui-v05-desktop.png'),full_page=True)
  # mobile native section dropdown works
  phone=await browser.new_page(viewport={'width':390,'height':844})
  phone.on('pageerror',lambda e:errors.append(str(e)))
  await boot(phone)
  await phone.get_by_role('button',name='Open menu').click()
  await phone.get_by_role('button',name='X-engage').first.click()
  await phone.get_by_label('Workspace section').select_option('approvals')
  assert await phone.get_by_role('heading',name='Approval inbox').count()==1
  await phone.wait_for_timeout(350)
  await phone.screenshot(path=str(ROOT/'ui-v05-mobile.png'),full_page=True)
  # A lasting bot profile edit must persist to the store and survive a reload.
  await bot_profile_edit(desktop,errors)
  assert not errors,errors
  print('USABILITY SMOKE PASS: contextual menus, templates, pinned/duplicated bot, filters, schedules, mobile selector, persisted bot profile, no JS errors')
  await browser.close()
asyncio.run(main())
