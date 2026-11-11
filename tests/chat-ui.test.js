import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
const html=await readFile(new URL('../shared/index.html',import.meta.url),'utf8');
// The UI is app.js plus the ui-*.js modules; assertions match across all of them.
const sharedDir=new URL('../shared/',import.meta.url);
const uiFiles=['app.js',...(await readdir(sharedDir)).filter(f=>/^ui-.+\.js$/.test(f)).sort()];
const app=(await Promise.all(uiFiles.map(f=>readFile(new URL(f,sharedDir),'utf8')))).join('\n');
const css=await readFile(new URL('../shared/app.css',import.meta.url),'utf8');
test('Pages build has safe relative assets, modal and accessible chat structure',()=>{
  assert.match(html,/\.\/app\.js/);assert.match(html,/\.\/app\.css/);assert.match(html,/\.\/local-api\.js/);
  assert.match(html,/Data is saved only in this browser/);assert.match(html,/id="chrome"/);assert.match(html,/\.\/shell\.css/);
  assert.match(app,/id="chat-form"/);assert.match(app,/id="new-bot-form"/);
  assert.match(app,/id="new-group-form"/);
  assert.match(css,/@media\(max-width:850px\)/);
});
test('custom bots run through the Node provider only on the server build',()=>{
  // The README promises custom bots run when a key is configured; the UI used
  // to answer every custom bot with the offline command demo instead.
  // The group-run path is the same on both builds, and now for every chat: a bot
  // chat posts to the company group with the bot as directBotId, a thread to its
  // own group, then the run is followed through its routes. There is no separate
  // 1:1 path any more, so no plain `/api/bots/run` call either.
  assert.match(app,/return runOnServer\(group, message, isTeam \? null : bot\.id, id\)/);
  assert.match(app,/\/api\/groups\/\$\{group\.id\}\/chat`, 'POST', \{message, directBotId: directBotId \|\| null, chatKey: key/);
  assert.doesNotMatch(app,/\/api\/bots\/run', 'POST', \{botId: bot\.id/);
  assert.match(app,/export const isLive = \(\) => !isStaticDemo\(\) && Boolean\(store\.state\?\.aiEnabled\)/);
  // Built-in bots use the same provider. A missing key is an error, not the demo.
  assert.match(app,/Answers come from your AI provider/);
  assert.match(app,/this chat cannot answer/);
  // A retry watches a queued run the same way as the first send.
  assert.match(app,/if \(await watchQueuedRun\(b\.dataset\.id, key, run\)\) return/);
  // The watch loop now lives in shared/run-follow.js over injected pieces, and
  // tests/run-follow.test.js drives it with fake snapshots instead of matching
  // its text; this only checks that the chat module still hands it the run.
  assert.match(app,/await pollRun\(\{/);
  assert.match(app,/const key = run\?\.chatKey \|\| chatId\(\) \|\| teamKey\(b\.dataset\.id\)/);
  // A run decision goes to its route in both builds: continue, plan, cancel.
  assert.match(app,/runs\/\$\{b\.dataset\.run\}\/continue`, 'POST'/);
  assert.match(app,/runs\/\$\{b\.dataset\.run\}\/plan`, 'POST', \{approve: true\}/);
  assert.match(app,/runs\/\$\{b\.dataset\.run\}\/plan`, 'POST', \{approve: false\}/);
  assert.match(app,/runs\/\$\{b\.dataset\.run\}\/cancel`, 'POST'/);
  assert.match(app,/runWithTyping\(\{key, setTyping, sync, concurrent: true,/);
  assert.match(app,/runButtons\(\{status, live\}\)/);
  assert.match(app,/flags\.checkpoint \? btn\('Approve next step', 'continue-run'/);
  // The chat header and the info panel read the same "waiting on you" answer.
  assert.match(app,/const waiting = totalWaitingOnYou\(waitingOnYou\(state, conv\.id\)\) > 0/);
  assert.match(app,/const waiting = waitingOnYou\(state, conv\.id, runs\)/);
  assert.match(app,/paused \? `\$\{paused\} paused`/);
  assert.match(app,/Waiting on a page/);
  assert.match(app,/Viewers cannot send messages/);
  assert.match(app,/A member can change group settings/);
  assert.match(app,/flags\.checkpoint && btn\('Approve next step', 'continue-run'/);
  assert.match(app,/Viewers can read chats\. A member can send\./);
  // A plan's Start and Cancel are now routed like every other decision, not
  // patched into a browser-side run log.
  assert.match(app,/runs\/\$\{b\.dataset\.run\}\/plan`, 'POST', \{approve: false\}/);
  assert.match(app,/'delete-account'/);
  assert.match(app,/\/api\/account', 'DELETE'/);
  assert.match(app,/'toggle-user-disabled'/);
  assert.match(app,/Temporary password \(min 8 chars\)/);
  assert.match(app,/EMAIL_RELAY_URL/);
  assert.match(app,/request.status === 'dispatched' \? `<div class="acts">\$\{decline\}/);
  assert.match(app,/<form id="login-form"[\s\S]*?name="email"/);
  assert.match(app,/id="password-form"/);
  assert.match(app,/\/api\/auth\/password/);
  assert.match(app,/'deny-browser': async b => \{[\s\S]*?streamGroupRun\(request\.groupId/);
  assert.match(app,/'retry-bot-task'/);
  assert.match(app,/\['failed', 'interrupted', 'awaiting_plan', 'awaiting_checkpoint', 'awaiting_limit', 'completed', 'cancelled'\]\.includes\(run\?\.status\)/);
  // When a provider is connected, the actual model id is surfaced if known.
  assert.match(app,/Connected · \$\{esc\(model\)\}/);
  assert.match(app,/state\?\.aiModel/);
  // A run that is still working can be stopped from its card, in the same build
  // that shows the thread's Stop button: the card used to offer nothing at all.
  // Both buttons now come from the one `runButtons` rule in the view model.
  assert.match(app,/flags\.stop \? btn\('Cancel', 'cancel-run'/);
  assert.match(app,/flags\.retry \? btn\('Retry', 'retry-run'/);
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
