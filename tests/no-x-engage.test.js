/** X-engage (captured posts, drafts, evidence, the capture token, feed reads,
 * the demo samples) was removed in Phase Z. Nothing in the shipped code may
 * bring it back by name. The posting guard in shared/bot-browser.js and
 * agent/browser.mjs stays, and it does not use these words. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Anchored on X-engage's own names: plain words such as "candidate" are used
// by other code (Gemini's `candidates` field, an IME candidate, a memory rule).
const BANNED = /\b((add|score|process|fail|find|remove|begin)Candidates?|candidateInput|makeDraft|draftCard|draftAction|evidence\.js|captureToken|awaiting_feed|X_ENGAGE\w*|x-engage|DEMO_SAMPLES|seedDemo|resetDemo|homeFeed\w*)\b|\/api\/(candidates|drafts|evidence|schedules|demo)\b|state\.(candidates|drafts|evidence)\b/;
// The upgrade path has to name what it removes, once each.
const UPGRADE = [
  ['shared/workflow.js', "if (run?.status !== 'awaiting_feed') continue;"],
  ['shared/workflow.js', "'captureToken']) delete state[key];"],
];

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(path.join(root, dir), {withFileTypes: true})) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(rel));
    else if (/\.(m?js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('no X-engage code is left', async () => {
  const hits = [];
  for (const dir of ['shared', 'src', 'agent']) {
    for (const file of await sources(dir)) {
      const lines = (await readFile(path.join(root, file), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!BANNED.test(line) || UPGRADE.some(([f, text]) => f === file && line.includes(text))) return;
        hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
