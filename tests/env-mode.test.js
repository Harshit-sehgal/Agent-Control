import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {envModeWarning} from '../src/env-mode.js';

test('a secrets file readable by others is flagged; an owner-only one is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-envmode-'));
  try {
    const open = path.join(dir, 'open.env'), closed = path.join(dir, 'closed.env');
    fs.writeFileSync(open, 'A=1\n', {mode: 0o644}); fs.chmodSync(open, 0o644);
    fs.writeFileSync(closed, 'A=1\n', {mode: 0o600}); fs.chmodSync(closed, 0o600);
    assert.match(envModeWarning(open), /readable by other users \(mode 644\)/);
    assert.equal(envModeWarning(closed), null);
    assert.equal(envModeWarning(path.join(dir, 'missing.env')), null);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
