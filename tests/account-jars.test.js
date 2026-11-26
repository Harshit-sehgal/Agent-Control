import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserAccountsDir, createJarStore, rekeyJars, rePairProof} from '../agent/account-jars.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const cookie = value => ({name: 'sid', value, domain: 'crm.example.com', path: '/', httpOnly: true});

async function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jars-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return path.join(dir, 'browser-accounts');
}

test('the folder is AGENT_BROWSER_ACCOUNTS, else browser-accounts beside the config', () => {
  assert.equal(browserAccountsDir({}, '/x/y/agent.config.json'), path.join('/x/y', 'browser-accounts'));
  assert.equal(browserAccountsDir({AGENT_BROWSER_ACCOUNTS: '/z/jars'}, '/x/y/agent.config.json'), '/z/jars');
  assert.equal(browserAccountsDir({AGENT_BROWSER_ACCOUNTS: ''}, '/x/y/agent.config.json'), path.join('/x/y', 'browser-accounts'));
});

test('a jar is encrypted, private to this user, and tied to its account', async t => {
  const dir = await tmp(t); fs.mkdirSync(dir, {mode: 0o755}); fs.chmodSync(dir, 0o755);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [{name: 'sid', value: 'MARKER-COOKIE', domain: 'crm.example.com', path: '/', httpOnly: true}]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'a looser folder is tightened');
  assert.equal(fs.statSync(path.join(dir, `${A}.jar`)).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'), /MARKER-COOKIE|sid/);
  assert.equal(jars.load(A)[0].value, 'MARKER-COOKIE');
  fs.copyFileSync(path.join(dir, `${A}.jar`), path.join(dir, `${B}.jar`));
  assert.equal(jars.load(B), null, 'a copied jar does not open as another account'); assert.equal(fs.existsSync(path.join(dir, `${B}.jar`)), false);
  assert.equal(createJarStore({dir, secret: 'other'}).load(A), null);
});

test('a new folder is made private, and a save leaves no temp file or loose mode behind', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [cookie('v1')]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  jars.save(A, [cookie('v2')]);
  assert.deepEqual(fs.readdirSync(dir), [`${A}.jar`]);
  assert.equal(fs.statSync(path.join(dir, `${A}.jar`)).mode & 0o777, 0o600);
  assert.equal(jars.load(A)[0].value, 'v2', 'a second save replaces the first');
});

test('a looser jar file is tightened on the next save, and a planted temp link is never followed', async t => {
  const dir = await tmp(t); fs.mkdirSync(dir, {mode: 0o700});
  const jars = createJarStore({dir, secret: 's1'});
  fs.writeFileSync(path.join(dir, `${A}.jar`), 'old', {mode: 0o644});
  const victim = path.join(path.dirname(dir), 'victim.txt'); fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(dir, `${A}.jar.tmp`));
  jars.save(A, [cookie('v')]);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(fs.statSync(path.join(dir, `${A}.jar`)).mode & 0o777, 0o600);
  assert.equal(jars.load(A)[0].value, 'v');
});

test('a missing jar is null; one that will not decrypt is removed and reads null', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  assert.equal(jars.load(A), null, 'no folder yet');
  jars.save(B, [cookie('v')]);
  assert.equal(jars.load(A), null);
  for (const junk of ['not json', '{"v":2}', JSON.stringify({v: 1, salt: 'AA==', iv: 'AA==', tag: 'AA==', data: 'AA=='}), '[]', 'null']) {
    fs.writeFileSync(path.join(dir, `${A}.jar`), junk, {mode: 0o600});
    assert.equal(jars.load(A), null, junk);
    assert.equal(fs.existsSync(path.join(dir, `${A}.jar`)), false, `${junk} is removed`);
  }
  // A flipped byte in the data fails the auth tag.
  jars.save(A, [cookie('v')]);
  const file = JSON.parse(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'));
  const raw = Buffer.from(file.data, 'base64'); raw[0] ^= 1; file.data = raw.toString('base64');
  fs.writeFileSync(path.join(dir, `${A}.jar`), JSON.stringify(file));
  assert.equal(jars.load(A), null);
  assert.equal(fs.existsSync(path.join(dir, `${A}.jar`)), false);
});

test('a jar with a shortened auth tag is refused and removed, never accepted at 32 bits', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  for (const len of [0, 1, 4, 8, 12, 15, 17]) {
    jars.save(A, [cookie('v')]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'));
    const tag = Buffer.from(file.tag, 'base64');
    file.tag = Buffer.concat([tag, Buffer.alloc(len)]).subarray(0, len).toString('base64');
    fs.writeFileSync(path.join(dir, `${A}.jar`), JSON.stringify(file));
    assert.equal(jars.load(A), null, `tag of ${len} bytes`);
    assert.equal(fs.existsSync(path.join(dir, `${A}.jar`)), false, `tag of ${len} bytes is removed`);
  }
});

test('the store has no way to write a path an id did not pass: staging is private', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  assert.deepEqual(Object.keys(jars).sort(), ['ids', 'load', 'retain', 'save', 'wipe']);
  assert.throws(() => jars.save('../x', []), /cannot use\.$/);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'x.jar.tmp')), false);
});

test('each save uses a fresh salt and iv, and only an array of cookies is saved', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [cookie('v')]); const one = JSON.parse(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'));
  jars.save(A, [cookie('v')]); const two = JSON.parse(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'));
  assert.equal(one.v, 1);
  assert.notEqual(one.salt, two.salt); assert.notEqual(one.iv, two.iv); assert.notEqual(one.data, two.data);
  assert.equal(Buffer.from(one.salt, 'base64').length, 16);
  for (const bad of [undefined, null, 'x', {}]) assert.throws(() => jars.save(A, bad), /cookies/);
  assert.equal(jars.load(A)[0].value, 'v', 'a refused save leaves the jar');
  assert.throws(() => createJarStore({dir, secret: ''}), /secret/);
});

test('ids are checked before any path is built', () => {
  for (const bad of ['../x', 'work-crm', `${A}/..`, '', `${A}\n`, null, undefined, 7, 'ABCDEF01-1111-4111-8111-111111111111']) {
    const jars = createJarStore({dir: '/nowhere', secret: 's'});
    for (const call of [() => jars.load(bad), () => jars.save(bad, []), () => jars.wipe(bad)]) assert.throws(call, /^Error: This task names a browser account this device cannot use\.$/);
  }
});

test('ids lists only valid *.jar files; wipe removes a jar and is quiet when it is gone', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  assert.deepEqual(jars.ids(), [], 'no folder yet');
  jars.save(A, [cookie('a')]); jars.save(B, [cookie('b')]);
  fs.writeFileSync(path.join(dir, 'notes.jar'), 'x'); fs.writeFileSync(path.join(dir, `${A}.jar.tmp`), 'x'); fs.writeFileSync(path.join(dir, `${A}.txt`), 'x');
  assert.deepEqual(jars.ids().sort(), [A, B]);
  jars.wipe(A); jars.wipe(A);
  assert.deepEqual(jars.ids(), [B]);
  assert.equal(fs.existsSync(path.join(dir, `${A}.jar.tmp`)), false, 'a wipe also removes a half-written copy');
  assert.equal(jars.load(A), null);
});

test('retain wipes only what an explicit list leaves out', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [cookie('a')]); jars.save(B, [cookie('b')]);
  for (const notAList of [undefined, null, 'x', {}, A]) assert.deepEqual(jars.retain(notAList), []);
  assert.deepEqual(jars.ids().sort(), [A, B]);
  assert.deepEqual(jars.retain([A, 'junk', 7]), [B]);
  assert.deepEqual(jars.ids(), [A]);
  assert.deepEqual(jars.retain([A]), []);
  assert.deepEqual(jars.retain([]), [A]);
  assert.deepEqual(jars.ids(), []);
});

test('a re-pair re-encrypts every jar under the new secret; one that will not open is wiped', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [cookie('MARKER')]);
  fs.writeFileSync(path.join(dir, `${B}.jar`), 'garbage', {mode: 0o600});
  assert.deepEqual(rekeyJars({dir, oldSecret: 's1', newSecret: 's2'}), {kept: [A], wiped: [B]});
  assert.equal(createJarStore({dir, secret: 's2'}).load(A)[0].value, 'MARKER');
  assert.equal(fs.existsSync(path.join(dir, `${B}.jar`)), false);
  assert.equal(fs.statSync(path.join(dir, `${A}.jar`)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [`${A}.jar`]);
  assert.equal(createJarStore({dir, secret: 's1'}).load(A), null);
  assert.deepEqual(rekeyJars({dir: path.join(dir, 'nope'), oldSecret: 's1', newSecret: 's2'}), {kept: [], wiped: []});
  assert.match(rePairProof('s1', 'CODE'), /^[0-9a-f]{64}$/);
});

test('a re-key that cannot write leaves every old jar readable under the old secret', async t => {
  const dir = await tmp(t);
  const jars = createJarStore({dir, secret: 's1'});
  jars.save(A, [cookie('a')]); jars.save(B, [cookie('b')]);
  // A directory where B's temp file must go makes the second staging fail.
  fs.mkdirSync(path.join(dir, `${B}.jar.tmp`));
  assert.throws(() => rekeyJars({dir, oldSecret: 's1', newSecret: 's2'}));
  assert.equal(jars.load(A)[0].value, 'a'); assert.equal(jars.load(B)[0].value, 'b');
  assert.equal(fs.existsSync(path.join(dir, `${A}.jar.tmp`)), false, 'a staged copy is removed');
});

test('the re-pair proof is the HMAC-SHA256 of "re-pair\\n<code>" under the secret', async () => {
  const {createHmac} = await import('node:crypto');
  assert.equal(rePairProof('s1', 'CODE'), createHmac('sha256', 's1').update('re-pair\nCODE').digest('hex'));
  assert.notEqual(rePairProof('s1', 'CODE'), rePairProof('s2', 'CODE'));
  assert.notEqual(rePairProof('s1', 'CODE'), rePairProof('s1', 'CODE2'));
});
