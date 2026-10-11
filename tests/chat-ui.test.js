import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {classifyMessage, botSuggestions, statusSummary} from '../shared/chat-engine.js';
const html=await readFile(new URL('../shared/index.html',import.meta.url),'utf8');
// The UI is app.js plus the ui-*.js modules; assertions match across all of them.
const sharedDir=new URL('../shared/',import.meta.url);
const uiFiles=['app.js',...(await readdir(sharedDir)).filter(f=>/^ui-.+\.js$/.test(f)).sort()];
const app=(await Promise.all(uiFiles.map(f=>readFile(new URL(f,sharedDir),'utf8')))).join('\n');
const css=await readFile(new URL('../shared/app.css',import.meta.url),'utf8');
test('Pages build has safe relative assets, modal and accessible chat structure',()=>{
  assert.match(html,/\.\/app\.js/);assert.match(html,/\.\/app\.css/);assert.match(html,/\.\/local-api\.js/);
  assert.match(html,/Data is saved only in this browser/);assert.match(html,/id="inspector"/);
  assert.match(app,/id="chat-form"/);assert.match(app,/id="new-bot-form"/);
  assert.match(app,/id="candidate-form"/);assert.match(app,/id="new-group-form"/);
  assert.match(app,/Manual posting handoff|Manual final posting|manual Post click/);
  assert.match(css,/@media\(max-width:850px\)/);
});
test('Offline chat command classifier covers common workflows without inventing AI',()=>{
  assert.equal(classifyMessage('show pending approvals').intent,'approvals');
  assert.equal(classifyMessage('draft a reply').intent,'draft');
  assert.equal(classifyMessage('scan candidates').intent,'discover');
  assert.equal(classifyMessage('show status').intent,'status');
  assert.equal(classifyMessage('set reminder').intent,'schedules');
  assert.equal(classifyMessage('create bot named Analyst').name,'Analyst');
  assert.equal(classifyMessage('').intent,'empty');
  assert.equal(classifyMessage('Create a new bot').name,null);
});
test('Status reflects current draft states',()=>{
  const summary=statusSummary({candidates:[{},{}],drafts:[{status:'pending'},{status:'ready'},{status:'posted'}]});
  assert.match(summary,/2 candidates/);assert.match(summary,/1 awaiting approval/);assert.match(summary,/1 ready/);
});
test('Specialist suggestions remain relevant',()=>{
  assert.ok(botSuggestions('Scout').some(x=>/candidate/i.test(x)));
  assert.ok(botSuggestions('Writer').some(x=>/Draft/i.test(x)));
});

test('custom bots run through the Node provider only on the server build',()=>{
  // The README promises custom bots run when a key is configured; the UI used
  // to answer every custom bot with the offline command demo instead.
  assert.match(app,/isLive\(\) && bot\.type === 'custom'/);
  assert.match(app,/export const isLive = \(\) => !isStaticDemo\(\) && Boolean\(store\.state\?\.aiEnabled\)/);
  assert.match(app,/\/api\/bots\/run/);
  // And the chat/inspector must stop claiming the bot is offline in that case.
  assert.match(app,/This bot runs its instructions through the server AI provider/);
  // When a provider is connected, the actual model id is surfaced if known.
  assert.match(app,/Connected · \$\{esc\(model\)\}/);
  assert.match(app,/state\?\.aiModel/);
});
test('bot profiles never mirror name/instructions into browser-local UI state',()=>{
  // `profile()` spreads the cosmetic UI record over the bot, so a name/instructions
  // copy there would shadow the server value permanently and edits made on another
  // device could never appear.
  assert.match(app,/delete store\.profiles\[id\]\.name; delete store\.profiles\[id\]\.instructions/);
  // Nothing may write name/instructions into the local profile record.
  for (const call of app.match(/setProfile\([^;]*\);/g)||[]) assert.doesNotMatch(call,/\b(name|instructions)\b/,`setProfile must stay cosmetic: ${call}`);
  // Saving a profile must round-trip through the API, not only localStorage.
  assert.match(app,/api\(`\/api\/groups\/\$\{groupOfBot\(b\.id\)\.id\}\/bots\/\$\{b\.id\}`, 'PATCH'/);
  // A duplicate must take its instructions from the group record, not the mirror.
  assert.match(app,/instructions: base\.instructions/);
});
test('the old browser dialogs are gone: confirmation and prompts are in-app sheets',()=>{
  assert.doesNotMatch(app,/window\.(confirm|prompt|alert)\(/);
  assert.doesNotMatch(app,/(^|[^.\w])(confirm|prompt|alert)\(/m);
  assert.match(app,/function confirmSheet\(/);
  assert.match(app,/function askSheet\(/);
});
