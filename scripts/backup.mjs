#!/usr/bin/env node
/** Backup CLI.
 *
 *   node scripts/backup.mjs export [out.json]      # writes to stdout by default
 *   node scripts/backup.mjs import file.json        # validates, then restores
 *   node scripts/backup.mjs import file.json --force # replace an existing store
 *
 * Uses the same open/backup code the HTTP admin endpoints use, so a CLI backup
 * and a dashboard backup are byte-compatible. Credentials and live sessions are
 * never included: re-enter secrets after a restore, and sign in again.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../src/sqlite-store.js';
import {exportBackup, importBackup, validateBackup} from '../src/backup.js';
import {loadMasterKey} from '../src/vault.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = process.env.DATA_FILE || path.join(ROOT, 'data', 'state.json');
const [command, target, flag] = process.argv.slice(2);

if (!['export', 'import'].includes(command)) {
  console.log('Usage: node scripts/backup.mjs export [out.json] | import file.json [--force]');
  process.exit(1);
}

// A CLI run needs the same vault key the server used, or credential rows would
// be undecryptable after a restore. This never prints the key.
loadMasterKey(dataFile);

const store = await openStore(dataFile);
try {
  if (command === 'export') {
    const document = exportBackup(store);
    const json = JSON.stringify(document, null, 2);
    if (target) {
      fs.writeFileSync(path.resolve(target), json, {mode: 0o600});
      console.log(`Backup written to ${path.resolve(target)} (credentials and sessions excluded).`);
    } else {
      console.log(json);
    }
  } else {
    if (!target) { console.error('Provide the backup JSON file to import.'); process.exit(1); }
    const document = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
    // Validate first so a bad file fails before anything is written.
    validateBackup(document);
    const result = importBackup(store, document, {force: flag === '--force'});
    console.log(`Restored ${result.restored} rows. Sign in again; re-enter any credentials.`);
  }
} finally {
  store.db.close?.();
}
