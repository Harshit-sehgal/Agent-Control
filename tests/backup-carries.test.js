/** A backup carries what a restore needs: attached files, saved templates, token usage and the owner's
 * permission switches and limits. A backup file is untrusted input, so each of those is checked again on the
 * way in with the rules the live upload and settings routes use, and a backup written before they travelled
 * still restores. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/sqlite-store.js';
import * as backup from '../src/backup.js';
import {saveAttachment, readAttachment} from '../src/attachments.js';
import {addTemplate} from '../shared/templates.js';
import {setLimits} from '../shared/limits.js';
import {recordDay} from '../shared/usage.js';
import {setGrant, grantFor} from '../shared/asks.js';

const seal = doc => ({...doc, checksum: crypto.createHash('sha256').update(JSON.stringify(doc.tables)).digest('hex')});
const copy = doc => JSON.parse(JSON.stringify(doc));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const upload = (name, bytes) => ({name, data: Buffer.from(bytes).toString('base64')});
const inHours = h => new Date(Date.now() + h * 3600000).toISOString();

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-carries-'));
  const store = await openStore(path.join(dir, 'state.json'));
  return {store, async done() { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }};
}

async function filled() {
  const t = await sandbox();
  const png = saveAttachment(t.store, upload('cat.png', PNG), {at: '2026-01-01T00:00:00.000Z'});
  const notes = saveAttachment(t.store, upload('notes.md', Buffer.from('# hi\n')), {at: '2026-01-02T00:00:00.000Z'});
  await t.store.update(s => {
    addTemplate(s, {text: 'Summarise the news for me.'});
    setLimits(s, {pages: 3, steps: 12, askCheckpoints: true});
    recordDay(s, {botId: 'atlas', input: 100, output: 20, cost: 0.5}, new Date().toISOString());
    s.askBasics = true;
    s.handsOff = true;
    setGrant(s, 'atlas', 'post', 'https://x.example', 'always', undefined, {log: false, until: inHours(5)});
    setGrant(s, 'atlas', 'send', 'https://mail.example', 'always', undefined, {log: false});
  });
  return {...t, png, notes};
}

test('a backup round-trips attachment bytes, templates, usage, limits, switches and a grant end', async () => {
  const t = await filled();
  const other = await sandbox();
  try {
    const document = copy(backup.exportBackup(t.store));
    assert.equal(document.tables.attachments.length, 2);
    assert.deepEqual(document.attachmentsLeftOut, []);
    const result = backup.importBackup(other.store, document, {force: true});
    assert.deepEqual(result.attachmentsLeftOut, []);
    const file = readAttachment(other.store, t.png.id);
    assert.ok(file, 'the attached image is back');
    assert.deepEqual([...file.data], [...PNG], 'byte for byte');
    assert.equal(file.type, 'image/png');
    assert.equal(readAttachment(other.store, t.notes.id).data.toString(), '# hi\n');
    const s = other.store.read();
    assert.deepEqual(s.templates.map(x => x.text), ['Summarise the news for me.']);
    assert.equal(s.templates[0].id, t.store.read().templates[0].id, 'a template keeps its id');
    assert.deepEqual(s.limits, {pages: 3, rounds: null, steps: 12, askCheckpoints: true});
    assert.equal(s.askBasics, true);
    assert.equal(s.handsOff, true);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(s.usage.days[today].atlas.input, 100);
    assert.equal(s.usage.days[today].atlas.cost, 0.5);
    const grant = s.grants.find(g => g.action === 'post');
    assert.ok(grant.until, 'the grant keeps its end');
    assert.equal(grantFor(s, 'atlas', 'post', 'https://x.example'), 'always');
    // And it survives a reopen of the restored store, so it was written to the file, not only the cache.
    await other.store.update(st => { st.settings.touched = 1; });
    assert.equal(other.store.kvGet('hands_off'), '1');
  } finally { await t.done(); await other.done(); }
});

test('an expired grant end and an every-site payment Always allow do not come back', async () => {
  const t = await filled();
  const other = await sandbox();
  try {
    const document = copy(backup.exportBackup(t.store));
    const post = document.tables.grants.find(g => g.action === 'post');
    post.until = '2020-01-01T00:00:00.000Z';
    backup.importBackup(other.store, seal(document), {force: true});
    assert.equal(other.store.read().grants.some(g => g.action === 'post'), false, 'an ended grant is swept');
    assert.equal(grantFor(other.store.read(), 'atlas', 'send', 'https://mail.example'), 'always');
    const smuggled = copy(document);
    smuggled.tables.grants.push({bot_id: 'atlas', action: 'spend', scope: '', choice: 'always', at: post.at});
    assert.throws(() => backup.validateBackup(seal(smuggled)), e => e.status === 400 && /payment/i.test(e.message));
  } finally { await t.done(); await other.done(); }
});

test('past the attachment cap the newest files are kept and the rest are named, never dropped silently', async () => {
  const t = await filled();
  const other = await sandbox();
  try {
    const document = copy(backup.exportBackup(t.store, {attachmentBytes: 10}));
    assert.deepEqual(document.tables.attachments.map(a => a.id), [t.notes.id], 'the newest file fits');
    assert.deepEqual(document.attachmentsLeftOut.map(a => a.id), [t.png.id]);
    assert.equal(document.attachmentsLeftOut[0].name, 'cat.png');
    const result = backup.importBackup(other.store, document, {force: true});
    assert.deepEqual(result.attachmentsLeftOut.map(a => a.id), [t.png.id]);
    assert.match(result.notes.join(' '), /1 attached file.*left out/i);
  } finally { await t.done(); await other.done(); }
});

test('a hostile backup is refused before anything is written', async () => {
  const t = await filled();
  try {
    const document = copy(backup.exportBackup(t.store));
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const cases = {
      'HTML bytes named .png': a => Object.assign(a, {name: 'x.png', type: 'image/png', data: html, size: 38}),
      'a type that does not match the bytes': a => Object.assign(a, {type: 'image/gif'}),
      'oversized': a => Object.assign(a, {size: 11 * 1024 * 1024}),
      'a bad id': a => Object.assign(a, {id: 'NOT VALID!'}),
      'a path-like id': a => Object.assign(a, {id: '../../etc/passwd'}),
      'data that is not base64': a => Object.assign(a, {data: '***'}),
    };
    for (const [label, spoil] of Object.entries(cases)) {
      const bad = copy(document);
      spoil(bad.tables.attachments.find(a => a.id === t.png.id));
      assert.throws(() => backup.validateBackup(seal(bad)), e => e.status === 400 && /attach/i.test(e.message), label);
    }
    const settings = {
      'limits past the backstop': rows => { rows.find(r => r.key === 'limits').value = JSON.stringify({pages: 9999}); },
      'an unknown limit': rows => { rows.find(r => r.key === 'limits').value = JSON.stringify({sneaky: 1}); },
      'a switch that is not 0 or 1': rows => { rows.find(r => r.key === 'hands_off').value = 'yes'; },
      'too many templates': rows => { rows.find(r => r.key === 'templates').value = JSON.stringify(Array.from({length: 31}, (_, i) => ({id: `t-${i}`, title: 'x', text: `t ${i}`}))); },
      'a key that is not an owner setting': rows => { rows.push({key: 'vapid_keys', value: '{}'}); },
      'usage with a prototype key': rows => { rows.find(r => r.key === 'usage').value = '{"days":{"2026-01-01":{"__proto__":{"input":1}}}}'; },
    };
    for (const [label, spoil] of Object.entries(settings)) {
      const bad = copy(document);
      spoil(bad.tables.owner_settings);
      assert.throws(() => backup.validateBackup(seal(bad)), e => e.status === 400, label);
    }
  } finally { await t.done(); }
});

test('a backup written before files and settings travelled still restores, and leaves them as they were', async () => {
  const t = await filled();
  const other = await sandbox();
  try {
    const old = copy(backup.exportBackup(t.store));
    delete old.tables.attachments;
    delete old.tables.owner_settings;
    delete old.attachmentsLeftOut;
    for (const g of old.tables.grants) delete g.until;
    await other.store.update(s => { s.limits = {pages: 2}; });
    const result = backup.importBackup(other.store, seal(old), {force: true});
    assert.ok(result.restored > 0);
    assert.deepEqual(result.attachmentsLeftOut, []);
    assert.equal(other.store.read().limits.pages, 2, 'no settings in the file: the live ones stay');
    assert.equal(grantFor(other.store.read(), 'atlas', 'post', 'https://x.example'), 'always');
  } finally { await t.done(); await other.done(); }
});
