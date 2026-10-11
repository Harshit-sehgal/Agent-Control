/** Groups, bots and conversations over HTTP: creating them, running a group
 * through the server orchestrator, and the chat history each conversation
 * keeps. Model workers get no publication, browser or filesystem tools. */
import {activity, cleanText, uuid} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as chats from '../shared/chats.js';
import {executeCustomBot} from './ai.js';
import {queueGroupRun, resumeGroupRun, coordinationState} from './coordination.js';
import {fail} from './http.js';
import {reply} from './router.js';

export function groupRoutes(router) {
  router.add('POST', '/api/groups', 'member', async c => { const b = await c.body(); return reply(201, await c.store.update(s => wf.addGroup(s, b))); });
  router.add('POST', '/api/groups/:group/bots', 'member', async c => { const b = await c.body(); return reply(201, await c.store.update(s => wf.addBot(s, c.params.group, b))); });
  // Lasting bot profile edits go to the store so they survive a reload and are
  // shared by every device, instead of living only in browser localStorage.
  router.add('PATCH', '/api/groups/:group/bots/:bot', 'member', async c => { const b = await c.body(); return c.store.update(s => wf.updateBot(s, c.params.group, c.params.bot, b)); });

  // Durable text-only bot coordination. Humans approve every external action separately.
  router.add('GET', '/api/groups/:group/chat', 'viewer', c => {
    const s = c.store.read(); coordinationState(s);
    return {messages: (s.groupMessages[c.params.group] || []).slice(-300), runs: s.groupRuns.filter(r => r.groupId === c.params.group).slice(0, 50)};
  });
  router.add('POST', '/api/groups/:group/chat', 'member', async c => {
    const b = await c.body();
    return reply(202, await queueGroupRun(c.store, {groupId: c.params.group, message: b.message, directBotId: b.directBotId || null, checkpoints: b.checkpoints === true, chatKey: typeof b.chatKey === 'string' ? b.chatKey : null}));
  });
  // Approve the next handoff of a run paused at a human checkpoint.
  router.add('POST', '/api/groups/:group/runs/:run/continue', 'member', async c => reply(202, await resumeGroupRun(c.store, c.params.run)));

  router.add('POST', '/api/bots/run', 'member', async c => {
    const b = await c.body(), input = cleanText(b.input, 4000);
    const bot = c.store.read().groups.flatMap(g => g.bots).find(x => x.id === b.botId);
    if (!bot || bot.type !== 'custom') fail('Select a custom bot.', 404);
    if (!input) fail('Provide task input.');
    const output = await executeCustomBot(bot, input);
    return reply(201, await c.store.update(s => {
      const run = {id: uuid(), botId: bot.id, botName: bot.name, input, output, at: new Date().toISOString()};
      s.runs.unshift(run); s.runs = s.runs.slice(0, 100);
      // Written here, not by the browser, so the chat can show it as model output.
      chats.addChatMessages(s, bot.id, [{id: run.id, role: 'bot', text: output, mode: 'ai', at: run.at}], {trusted: true});
      activity(s, 'run', `Completed ${bot.name} task.`, {runId: run.id}); return run;
    }));
  });

  // Conversation history. It is part of the state snapshot, so there is no
  // separate read route; these two keep it current.
  router.add('POST', '/api/chats/:key/messages', 'member', async c => {
    const b = await c.body();
    return c.store.update(s => chats.addChatMessages(s, c.params.key, Array.isArray(b.messages) ? b.messages : [b]));
  });
  router.add('DELETE', '/api/chats/:key', 'member', c => c.store.update(s => chats.clearChat(s, c.params.key)));
}
