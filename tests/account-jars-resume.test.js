import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJarStore, rekeyJars, wipeAllJars} from '../agent/account-jars.mjs';

/* A re-pair may stop halfway: the new config holds both secrets until the jars are re-keyed, so running the re-key again
 * must finish it whatever state the folder is in, and never delete a jar the new secret already opens. */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const cookie = value => ({name: 'sid', value, domain: 'crm.example.com', path: '/', httpOnly: true});
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jars-resume-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return path.join(d, 'browser-accounts'); };

test('a re-key run again over a half-done folder keeps the jars already under the new secret', t => {
  const dir = tmp(t);
  createJarStore({dir, secret: 'old'}).save(A, [cookie('a')]);   // not yet re-keyed
  createJarStore({dir, secret: 'new'}).save(B, [cookie('b')]);   // already re-keyed
  fs.writeFileSync(path.join(dir, `${C}.jar`), 'garbage', {mode: 0o600});
  const done = rekeyJars({dir, oldSecret: 'old', newSecret: 'new'});
  assert.deepEqual([done.kept.sort(), done.wiped], [[A, B], [C]]);
  const jars = createJarStore({dir, secret: 'new'});
  assert.equal(jars.load(A)[0].value, 'a');
  assert.equal(jars.load(B)[0].value, 'b');
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${A}.jar`, `${B}.jar`]);
  assert.deepEqual(rekeyJars({dir, oldSecret: 'old', newSecret: 'new'}).kept.sort(), [A, B], 'and a third run changes nothing');
});

test('wipeAllJars removes every jar and half-written copy, and is quiet for a folder that is not there', t => {
  const dir = tmp(t);
  createJarStore({dir, secret: 'old'}).save(A, [cookie('a')]);
  fs.writeFileSync(path.join(dir, `${B}.jar.tmp`), 'x', {mode: 0o600});
  assert.deepEqual(wipeAllJars(dir), [A]);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(wipeAllJars(path.join(dir, 'nope')), []);
});
