import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {classifyMessage, botSuggestions, statusSummary} from '../shared/chat-engine.js';
const html=await readFile(new URL('../shared/index.html',import.meta.url),'utf8');
const app=await readFile(new URL('../shared/app.js',import.meta.url),'utf8');
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
