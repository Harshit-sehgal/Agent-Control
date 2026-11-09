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
  assert.match(app,/if \(!isStaticDemo\(\)\) return runOnServer/);
  assert.match(app,/\/api\/bots\/run', 'POST', \{botId: bot\.id/);
  assert.match(app,/export const isLive = \(\) => !isStaticDemo\(\) && Boolean\(store\.state\?\.aiEnabled\)/);
  assert.match(app,/\/api\/bots\/run/);
  // Built-in bots use the same provider. A missing key is an error, not the demo.
  assert.match(app,/This bot answers with your AI provider/);
  assert.match(app,/will not answer with the demo/);
  // Retry of a feed read must wait or keep watching, the same as the first send.
  assert.match(app,/if \(await watchQueuedRun\(b\.dataset\.id, key, run\)\) return/);
  assert.match(app,/await sync\(\)\.catch\(\(\) => \{\}\);\n    for \(const m of store\.messages\[key\] \|\| \[\]\) seen\.add\(m\.id\);/);
  assert.match(app,/await sync\(\)\.catch\(\(\) => \{\}\);\n    const request = \(store\.state\.browserRequests \|\| \[\]\)\.find\(r => r\.runId === last\.id/);
  assert.match(app,/await streamGroupRun\(groupId, key, run\.runId\);\n    return true;/);
  assert.match(app,/const key = run\?\.chatKey \|\| chatId\(\) \|\| teamKey\(b\.dataset\.id\)/);
  assert.match(app,/continueDemoPlan\(group, run\.input, key, \{runId: run\.id\}\)/);
  assert.match(app,/BUSY_STATUSES\.includes\(r\.status\)/);
  assert.match(app,/groupInFlight\(group\) > 1/);
  assert.match(app,/continueDemoPlan\(group, message, key, \{runId, resume\} = \{\}\)/);
  assert.match(app,/A group run is already active\. Wait or retry later/);
  assert.match(app,/const lease = await claimLocalRun\(started/);
  assert.match(app,/const heartbeat = setInterval\(\(\) => \{ void renewLocalRun\(lease\)\.catch\(\(\) => \{\}\); \}, 30_000\);/);
  assert.match(app,/shouldStop: \(\) => localRunCancelled\(lease\.id\)/);
  assert.match(app,/const finished = await finishLocalRun\(lease, run\);/);
  assert.match(app,/'continue-run': async b => \{[\s\S]*?isStaticDemo\(\)[\s\S]*?resume: run/);
  assert.match(app,/status === 'awaiting_checkpoint' \? btn\('Approve next step', 'continue-run'/);
  assert.match(app,/drafts \? `<button type="button" class="needs-pill" data-action="open-section" data-section="drafts"/);
  assert.match(app,/paused \? `\$\{paused\} paused`/);
  assert.match(app,/Waiting on a page/);
  assert.match(app,/An admin sets voice and timing for this workspace/);
  assert.match(app,/if \(!isAdmin\(\) && !isStaticDemo\(\)\) throw new Error\('An admin sets voice and timing\.'\)/);
  assert.match(app,/Viewers cannot send messages/);
  assert.match(app,/A member can change group settings/);
  assert.match(app,/write \? iconBtn\('plus', 'Share a post'/);
  assert.match(app,/write && flags\.checkpoint \? btn\('Approve next step'/);
  assert.match(app,/Viewers can read chats\. A member can send\./);
  assert.match(app,/patchLocalRun\(run\.id, \{status: 'awaiting_plan'\}\)/);
  assert.doesNotMatch(app,/if \(error\.status !== 409\) patchLocalRun/);
  assert.match(app,/'delete-account'/);
  assert.match(app,/\/api\/account', 'DELETE'/);
  assert.match(app,/'toggle-user-disabled'/);
  assert.match(app,/Temporary password \(min 8 chars\)/);
  assert.match(app,/EMAIL_RELAY_URL/);
  assert.match(app,/const waiting = last && skip.has\(last.status\)/);
  assert.match(app,/request.status === 'dispatched' \? `<div class="card-actions">\$\{decline\}/);
  assert.match(app,/<form id="login-form"[\s\S]*?name="email"/);
  assert.match(app,/id="password-form"/);
  assert.match(app,/\/api\/auth\/password/);
  assert.match(app,/'deny-browser': async b => \{[\s\S]*?streamGroupRun\(request\.groupId/);
  assert.match(app,/'retry-bot-task'/);
  assert.match(app,/\['failed', 'interrupted', 'awaiting_plan', 'awaiting_checkpoint', 'completed', 'cancelled'\]\.includes\(run\?\.status\)/);
  assert.match(app,/Grant browser access/);
  assert.match(app,/'grant-browser': async b => \{[\s\S]*?patchBot\([\s\S]*?browser\.use/);
  // When a provider is connected, the actual model id is surfaced if known.
  assert.match(app,/Connected · \$\{esc\(model\)\}/);
  assert.match(app,/state\?\.aiModel/);
  // A run that is still working can be stopped from its card, in the same build
  // that shows the thread's Stop button: the card used to offer nothing at all.
  assert.match(app,/BUSY_STATUSES\.includes\(status\) && status !== 'awaiting_checkpoint' \? btn\('Cancel', 'cancel-run'/);
});
test('bot profiles never mirror name/instructions into browser-local UI state',()=>{
  // `profile()` spreads the cosmetic UI record over the bot, so a name/instructions
  // copy there would shadow the server value permanently and edits made on another
  // device could never appear. The strip is behaviourally covered by
  // tests/usability.test.js ('legacy profile fields cannot shadow the server value').
  assert.match(app,/for \(const legacy of \['name', 'instructions'\]\)[\s\S]*?delete entry\[legacy\]/);
  // And it must land on disk, or the same stale fields return on every load.
  assert.match(app,/if \(cleanProfiles\(store\.profiles\)\) saveLocal\(META_KEY, store\.profiles\)/);
  // Nothing may write name/instructions into the local profile record.
  for (const call of app.match(/setProfile\([^;]*\);/g)||[]) assert.doesNotMatch(call,/\b(name|instructions)\b/,`setProfile must stay cosmetic: ${call}`);
  // Saving a profile must round-trip through the API, not only localStorage.
  assert.match(app,/api\(`\/api\/groups\/\$\{groupOfBot\(b\.id\)\.id\}\/bots\/\$\{b\.id\}`, 'PATCH'/);
  // A duplicate must take its instructions from the group record, not the mirror.
  assert.match(app,/instructions: base\.instructions/);
  assert.match(app,/settings: \{\.\.\.botSettings\(base\), lead: false\}/);
});
test('the old browser dialogs are gone: confirmation and prompts are in-app sheets',()=>{
  assert.doesNotMatch(app,/window\.(confirm|prompt|alert)\(/);
  assert.doesNotMatch(app,/(^|[^.\w])(confirm|prompt|alert)\(/m);
  assert.match(app,/function confirmSheet\(/);
  assert.match(app,/function askSheet\(/);
});
