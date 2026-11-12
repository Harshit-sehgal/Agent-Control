/** Attachments: what may be attached (typed from the bytes), how big, who can
 * read a stored file back, and how a bot turn hands images to each wire shape. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {sniffType, attachmentRefs, pickProblem, cleanFileName, MAX_FILES, MAX_FILE_BYTES, MODEL_IMAGE_BYTES, MODEL_IMAGES_TOTAL, fencedFile} from '../shared/attachments.js';
import {addChatMessages} from '../shared/chats.js';
import {threadContext} from '../shared/bot-settings.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {createApp} from '../src/app.js';
import {saveAttachment, readAttachment, pruneAttachments, turnFiles} from '../src/attachments.js';
import {executeCustomBot, userContent} from '../src/ai.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('the type comes from the bytes, not the name', () => {
  assert.equal(sniffType(PNG, 'a.png'), 'image/png');
  assert.equal(sniffType(PNG, 'notes.txt'), 'image/png', 'a PNG is a PNG whatever it is called');
  assert.equal(sniffType(JPEG, 'x'), 'image/jpeg');
  assert.equal(sniffType(GIF, 'x'), 'image/gif');
  assert.equal(sniffType(WEBP, 'x'), 'image/webp');
  assert.equal(sniffType(Buffer.from('hello'), 'a.txt'), 'text/plain');
  assert.equal(sniffType(Buffer.from('# Hi'), 'a.MD'), 'text/markdown');
  assert.equal(sniffType(Buffer.from('a,b\n1,2'), 'a.csv'), 'text/csv');
  assert.equal(sniffType(Buffer.from('{"a":1}'), 'a.json'), 'application/json');
  assert.equal(sniffType(Buffer.from('{nope'), 'a.json'), '', 'a .json that does not parse is refused');
  assert.equal(sniffType(Buffer.from('<svg/>'), 'a.svg'), '', 'svg can carry script and is not accepted');
  assert.equal(sniffType(Buffer.from([0x4d, 0x5a, 0, 1]), 'a.txt'), '', 'a binary with a text name is refused');
  assert.equal(sniffType(Buffer.from([0xc3, 0x28]), 'a.txt'), '', 'invalid UTF-8 is not text');
  assert.equal(sniffType(Buffer.from('hello'), 'a.png'), '', 'text named .png is neither');
  assert.equal(sniffType(Buffer.alloc(0), 'a.txt'), '');
});

test('names, references and the size and count caps', () => {
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('C:\\x\\<b>"q".png'), 'bq.png');
  assert.equal(cleanFileName(''), 'file');
  const refs = attachmentRefs([
    ...Array.from({length: 12}, (_, i) => ({id: `aaaaaa${String(i).padStart(2, '0')}`, name: `f${i}.png`, type: 'image/png', size: 3})),
  ]);
  assert.equal(refs.length, MAX_FILES);
  assert.deepEqual(attachmentRefs([{id: '../x', type: 'image/png'}, {id: 'abcdefgh', type: 'text/html'}]), []);
  assert.equal(MAX_FILES, 10);
  assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.match(pickProblem({size: MAX_FILE_BYTES + 1}), /10 MB or smaller/);
  assert.equal(pickProblem({size: MAX_FILE_BYTES, count: 9}), '');
  assert.match(pickProblem({size: 10, count: MAX_FILES}), /at most 10/);
  assert.equal(pickProblem({size: 10, count: 0}), '');
  assert.match(fencedFile('a.txt', 'x'.repeat(20), 10), /first 10 characters/);
});

test('a chat line keeps its files only on the owner\'s own lines, and a line of files alone is named by them', () => {
  const state = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas'}]}], chats: {}};
  const file = {id: 'abcdefgh-1', name: 'shot.png', type: 'image/png', size: 9};
  addChatMessages(state, 'atlas', [{role: 'user', text: '', attachments: [file]}, {role: 'system', text: 'x', attachments: [file]}]);
  const [mine, note] = state.chats.atlas;
  assert.deepEqual(mine.attachments, [file]);
  assert.equal(mine.text, 'shot.png');
  assert.equal(note.attachments, undefined);
  assert.deepEqual(threadContext(state.chats.atlas)[0].files, [{id: file.id, name: 'shot.png', type: 'image/png'}]);
});

/* ---------- the routes, over two real workspaces ---------- */

async function workspaces() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attach-'));
  const a = await new SqliteStore(path.join(dir, 'a.db'), path.join(dir, 'a.json')).init();
  const b = await new SqliteStore(path.join(dir, 'b.db'), path.join(dir, 'b.json')).init();
  const sessions = {member: {userId: 'u1', role: 'member', workspaceId: 'a'}, viewer: {userId: 'u2', role: 'viewer', workspaceId: 'a'}, other: {userId: 'u3', role: 'owner', workspaceId: 'b'}};
  const app = createApp({store: a, auth: {session: id => sessions[id] || null}, workspaces: {get: id => ({a, b})[id] || null}, push: {}, version: 't'});
  const call = async (method, url, {who = '', body} = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {method, url, headers: {host: '127.0.0.1', ...(who ? {cookie: `agent_session=${who}`} : {})}});
    const res = {status: 0, headers: {}, body: null, writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = b ?? null; }};
    res.req = req;
    await app.handler(req, res);
    return res;
  };
  return {a, b, call, async done() { a.db.close(); b.db.close(); await fs.rm(dir, {recursive: true, force: true}); }};
}
const upload = (name, bytes) => ({name, data: Buffer.from(bytes).toString('base64')});

test('a member uploads a file; only sessions of the same workspace can read it back', async () => {
  const t = await workspaces();
  try {
    const made = await t.call('POST', '/api/attachments', {who: 'member', body: upload('shot.png', PNG)});
    assert.equal(made.status, 201);
    const ref = JSON.parse(made.body);
    assert.equal(ref.type, 'image/png');
    assert.equal(ref.size, PNG.length);
    assert.match(ref.id, /^[a-f0-9-]{36}$/, 'the server picks the id');

    const got = await t.call('GET', `/api/attachments/${ref.id}`, {who: 'viewer'});
    assert.equal(got.status, 200);
    assert.ok(Buffer.from(got.body).equals(PNG));
    assert.equal(got.headers['Content-Type'], 'image/png');
    assert.equal(got.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(got.headers['Content-Disposition'], /^inline/);
    assert.match(got.headers['Content-Security-Policy'], /sandbox/);

    assert.equal((await t.call('GET', `/api/attachments/${ref.id}`, {who: 'other'})).status, 404, 'another workspace cannot read it');
    assert.equal((await t.call('GET', `/api/attachments/${ref.id}`)).status, 401, 'nor can someone signed out');
    assert.equal((await t.call('POST', '/api/attachments', {who: 'viewer', body: upload('a.png', PNG)})).status, 403, 'a viewer cannot upload');
  } finally { await t.done(); }
});

test('a text file downloads as an attachment; a disguised or oversized file is refused', async () => {
  const t = await workspaces();
  try {
    const ref = JSON.parse((await t.call('POST', '/api/attachments', {who: 'member', body: upload('notes.md', Buffer.from('# Plan'))})).body);
    const got = await t.call('GET', `/api/attachments/${ref.id}`, {who: 'member'});
    assert.equal(got.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.match(got.headers['Content-Disposition'], /^attachment; filename\*=UTF-8''notes\.md$/);
    assert.equal((await t.call('POST', '/api/attachments', {who: 'member', body: upload('evil.png', Buffer.from('<script>x</script>'))})).status, 415);
    assert.equal((await t.call('POST', '/api/attachments', {who: 'member', body: {name: 'a.txt', data: 'not base64!'}})).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_BYTES)]);
    assert.equal((await t.call('POST', '/api/attachments', {who: 'member', body: upload('big.png', big)})).status, 413);
  } finally { await t.done(); }
});

test('a file no message points at is swept after a day; one a message uses stays', async () => {
  const t = await workspaces();
  try {
    const old = '2020-01-01T00:00:00.000Z';
    const used = saveAttachment(t.a, upload('a.png', PNG), {at: old});
    const loose = saveAttachment(t.a, upload('b.png', PNG), {at: old});
    const fresh = saveAttachment(t.a, upload('c.png', PNG));
    await t.a.update(s => addChatMessages(s, s.groups[0].bots[0].id, [{role: 'user', text: 'look', attachments: [used]}]));
    assert.equal(pruneAttachments(t.a), 1);
    assert.ok(readAttachment(t.a, used.id));
    assert.equal(readAttachment(t.a, loose.id), null);
    assert.ok(readAttachment(t.a, fresh.id), 'an upload not sent yet is kept for a day');
  } finally { await t.done(); }
});

/* ---------- the model side ---------- */

const IMG = {type: 'image/png', data: PNG.toString('base64')};

test('each wire shape spells an image part its own way', () => {
  assert.equal(userContent('openai-chat', 'hi', []), 'hi', 'no images: the text as before');
  assert.deepEqual(userContent('openai-chat', 'hi', [IMG]), [{type: 'text', text: 'hi'}, {type: 'image_url', image_url: {url: `data:image/png;base64,${IMG.data}`}}]);
  assert.deepEqual(userContent('azure-openai', 'hi', [IMG])[1].type, 'image_url');
  assert.deepEqual(userContent('openai-responses', 'hi', [IMG]), [{role: 'user', content: [{type: 'input_text', text: 'hi'}, {type: 'input_image', image_url: `data:image/png;base64,${IMG.data}`}]}]);
  assert.deepEqual(userContent('anthropic', 'hi', [IMG]), [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: IMG.data}}, {type: 'text', text: 'hi'}]);
  assert.deepEqual(userContent('gemini', 'hi', [IMG]), [{text: 'hi'}, {inline_data: {mime_type: 'image/png', data: IMG.data}}]);
});

test('a turn reads the files on the owner\'s newest lines only, and fences text files', () => {
  const files = {i1aaaaaa: {type: 'image/png', name: 'a.png', data: PNG}, t1aaaaaa: {type: 'text/plain', name: 'n.txt', data: Buffer.from('hello')}};
  const env = thread => JSON.stringify({message: 'm', thread});
  const read = id => files[id] || null;
  const out = turnFiles(env([{from: 'user', text: 'old', files: [{id: 'i1aaaaaa', name: 'a.png', type: 'image/png'}]}, {from: 'Atlas', text: 'ok'}, {from: 'user', text: 'new', files: [{id: 't1aaaaaa', name: 'n.txt', type: 'text/plain'}, {id: 'i1aaaaaa', name: 'a.png', type: 'image/png'}]}]), read);
  assert.equal(out.images.length, 1);
  assert.match(out.text, /Attached file n\.txt:\n```\nhello\n```/);
  assert.equal(turnFiles(env([{from: 'user', text: 'x', files: [{id: 'i1aaaaaa', name: 'a.png', type: 'image/png'}]}, {from: 'Atlas', text: 'seen'}]), read), null, 'an answered image is not sent again');
});

test('an image too big for one model request is named in the text instead of sent', () => {
  const big = n => Buffer.concat([PNG, Buffer.alloc(n)]);
  const files = {
    b1aaaaaa: {type: 'image/png', name: 'huge.png', data: big(6 * 1024 * 1024)},
    ...Object.fromEntries(Array.from({length: 4}, (_, i) => [`m${i}aaaaaa`, {type: 'image/png', name: `m${i}.png`, data: big(4 * 1024 * 1024)}])),
  };
  const refs = Object.entries(files).map(([id, f]) => ({id, name: f.name, type: f.type}));
  const out = turnFiles(JSON.stringify({message: 'm', thread: [{from: 'user', text: 'look', files: refs}]}), id => files[id] || null);
  assert.ok(out.images.every(image => Buffer.from(image.data, 'base64').length <= MODEL_IMAGE_BYTES), 'no single image is over the per-image limit');
  assert.ok(out.images.reduce((n, image) => n + Buffer.from(image.data, 'base64').length, 0) <= MODEL_IMAGES_TOTAL, 'the images fit one request');
  assert.ok(out.images.length >= 1, 'the ones that fit are still sent');
  assert.match(out.text, /huge\.png/);
  assert.match(out.text, /too large/);
});

async function provider(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(reply.status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}
const withImage = JSON.stringify({message: 'what is this?', thread: [{from: 'user', text: 'what is this?', files: [{id: 'i1aaaaaa', name: 'a.png', type: 'image/png'}]}]});
const readPng = () => ({type: 'image/png', name: 'a.png', data: PNG});

test('a bot turn with an image sends it as an image part (Anthropic)', async () => {
  const p = await provider([{status: 200, json: {content: [{type: 'text', text: 'A logo.'}]}}]);
  try {
    const out = await executeCustomBot({instructions: 'Help.'}, withImage, {baseUrl: `http://127.0.0.1:${p.port}/v1`, apiKey: 'k', model: 'claude-x', protocol: 'anthropic'}, {readFile: readPng});
    assert.equal(out, 'A logo.');
  } finally { p.close(); }
  const content = p.requests[0].messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content.at(-1).type, 'text');
});

test('a model that refuses images gets the turn once more, as text with a note', async () => {
  const p = await provider([{status: 400, json: {error: {message: 'This model does not support image input.'}}}, {status: 200, json: {choices: [{message: {content: 'Text only.'}}]}}]);
  try {
    const out = await executeCustomBot({instructions: 'Help.'}, withImage, {baseUrl: `http://127.0.0.1:${p.port}/v1`, apiKey: 'k', model: 'm', protocol: 'openai-chat'}, {readFile: readPng});
    assert.equal(out, 'Text only.');
  } finally { p.close(); }
  assert.equal(p.requests.length, 2);
  assert.ok(Array.isArray(p.requests[0].messages[1].content), 'first try carried the image');
  const retry = p.requests[1].messages[1].content;
  assert.equal(typeof retry, 'string');
  assert.match(retry, /cannot see images/);
});

test('a 400 about something else is not retried without the image', async () => {
  const p = await provider([{status: 400, json: {error: {message: 'Bad key format.'}}}]);
  try {
    await assert.rejects(executeCustomBot({instructions: 'Help.'}, withImage, {baseUrl: `http://127.0.0.1:${p.port}/v1`, apiKey: 'k', model: 'm', protocol: 'openai-chat'}, {readFile: readPng}), /400/);
  } finally { p.close(); }
  assert.equal(p.requests.length, 1);
});

test('a subscription CLI is handed the note instead of the image', async () => {
  let said = '';
  await executeCustomBot({instructions: 'Help.'}, withImage, {kind: 'local-cli', engine: 'claude', run: async ({input}) => { said = input; return 'ok'; }}, {readFile: readPng});
  assert.match(said, /cannot see images/);
});

test('the feed shows a thumbnail per image and a chip per file, with names escaped and only safe links', async () => {
  const {fileStrip} = await import('../shared/ui-feed.js');
  const html = fileStrip([{id: 'abcdefgh', name: '<img src=x onerror=1>.png', type: 'image/png', size: 3}, {id: 'abcdefgi', name: 'n.txt', type: 'text/plain', size: 2048}], ref => `/api/attachments/${ref.id}`);
  assert.match(html, /<img src="\/api\/attachments\/abcdefgh" alt="img src=x onerror=1\.png"|alt="&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /class="cv-file" href="\/api\/attachments\/abcdefgi" download="n\.txt"/);
  assert.match(html, /2 KB/);
  const hostile = fileStrip([{id: 'abcdefgh', name: 'a.png', type: 'image/png', size: 3}], () => 'javascript:alert(1)');
  assert.doesNotMatch(hostile, /javascript:/);
  assert.match(hostile, /cv-file gone/);
  assert.equal(fileStrip(undefined), '');
});

test('every model call of a bot turn can read the workspace\'s files', async () => {
  const {runBotTurn} = await import('../src/bot-turn.js');
  const t = await workspaces();
  try {
    const ref = saveAttachment(t.a, upload('a.png', PNG));
    let seen = null;
    await runBotTurn(t.a, {bot: {id: 'b1', name: 'B', instructions: ''}, envelope: {message: 'hi'}, config: {}, executor: async (bot, input, cfg, extra) => { seen = extra?.readFile?.(ref.id); return 'done'; }});
    assert.equal(seen?.type, 'image/png');
  } finally { await t.done(); }
});
