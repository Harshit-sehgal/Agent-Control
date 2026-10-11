import test from 'node:test';
import assert from 'node:assert/strict';
import {migrate,addCandidate,beginProcessing,finishProcessing,draftAction,editDraft} from '../shared/workflow.js';
import * as evidence from '../shared/evidence.js';
import {scoreCandidate} from '../shared/core.js';

const store = () => {
  const s = {settings: {topics: ['AI'], style: '', opinions: '', minDelay: 0, maxDelay: 0}, candidates: [], drafts: [], evidence: [], events: [], groups: []};
  migrate(s);
  return s;
};
const draftFor = (state, url = 'https://x.com/a/status/1', text = 'A post long enough to become a candidate.') => {
  const {candidate} = addCandidate(state, {url, text, author: 'Tester', topic: 'AI'});
  const ctx = beginProcessing(state, candidate.id);
  return finishProcessing(state, candidate.id, scoreCandidate(ctx.candidate, ctx.settings.topics), {text: 'A short draft.', mode: 'template', note: 'template'});
};

test('captured posts arrive as unverified link evidence, honestly labeled', () => {
  const s = store();
  const draft = draftFor(s);
  const items = evidence.evidenceForDraft(s, draft.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'link');
  assert.equal(items[0].verification, 'unverified');
  assert.equal(items[0].reuse, 'internal');
  assert.equal(items[0].link, 'https://x.com/a/status/1');
  assert.equal(items[0].confidence, 0.5);
  assert.equal(draft.evidence.level, 'claimed');
});

test('evidence validation rejects bad links, confidence, verification and reuse', () => {
  const s = store();
  assert.throws(() => evidence.addEvidence(s, {draftId: 'x', kind: 'nope', claim: 'c', confidence: 0.5}), /link, quote or claim/);
  assert.throws(() => evidence.addEvidence(s, {draftId: 'x', kind: 'link', claim: 'c', confidence: 0.5, link: 'javascript:alert(1)'}), /valid public http/);
  assert.throws(() => evidence.addEvidence(s, {draftId: 'x', kind: 'link', claim: 'c', confidence: 0.5}), /needs the URL/);
  assert.throws(() => evidence.addEvidence(s, {draftId: 'x', kind: 'link', link: 'https://e.com/a', claim: 'c', confidence: 1.5}), /0 and 1/);
  assert.throws(() => evidence.addEvidence(s, {draftId: 'x', kind: 'link', link: 'https://e.com/a', claim: 'c', confidence: 1, verification: 'probably'}), /Verification must be/);
  assert.throws(() => evidence.addEvidence(s, {draftId: 'x', kind: 'link', link: 'https://e.com/a', claim: 'c', confidence: 1, reuse: 'whatever'}), /Reuse must be/);
  assert.throws(() => evidence.addEvidence(s, {draftId: 'missing', kind: 'claim', claim: 'c', confidence: 0}), /Draft not found/);
  assert.throws(() => evidence.addEvidence(s, {kind: 'claim', claim: 'c', confidence: 0}), /Attach evidence/);
});

test('verification is a human decision that moves the draft summary', () => {
  const s = store();
  const draft = draftFor(s);
  const item = evidence.evidenceForDraft(s, draft.id)[0];
  let summary = evidence.evidenceSummary(evidence.evidenceForDraft(s, draft.id));
  assert.equal(summary.level, 'claimed');
  evidence.verifyEvidence(s, item.id, 'user_verified');
  summary = evidence.evidenceSummary(evidence.evidenceForDraft(s, draft.id));
  assert.equal(summary.level, 'supported');
  assert.equal(s.drafts.find(d => d.id === draft.id).evidence.level, 'supported', 'The cached summary must follow the evidence rows.');
  evidence.verifyEvidence(s, item.id, 'disputed');
  summary = evidence.evidenceSummary(evidence.evidenceForDraft(s, draft.id));
  assert.equal(summary.level, 'blocked');
  assert.equal(summary.approved, false);
  // Verification can never be set by anything other than the allowed statuses.
  assert.throws(() => evidence.verifyEvidence(s, item.id, 'trust_me'), /Unknown verification status/);
  // Removing the disputed item clears the block.
  evidence.dropEvidence(s, item.id);
  assert.equal(evidence.evidenceSummary(evidence.evidenceForDraft(s, draft.id)).level, 'none');
});

test('disputed evidence blocks approval and the approval snapshot is frozen', () => {
  const s = store();
  const draft = draftFor(s);
  const item = evidence.evidenceForDraft(s, draft.id)[0];
  evidence.verifyEvidence(s, item.id, 'disputed');
  assert.throws(() => draftAction(s, draft.id, 'approve', {minDelay: 0, maxDelay: 0}), /disputed evidence/);
  evidence.verifyEvidence(s, item.id, 'user_verified');
  const approved = draftAction(s, draft.id, 'approve', {minDelay: 0, maxDelay: 0});
  assert.equal(approved.status, 'scheduled');
  assert.equal(approved.approvedEvidence.length, 1);
  assert.equal(approved.approvedEvidence[0].verification, 'user_verified');
  // Later changes to the evidence cannot rewrite what was approved.
  evidence.verifyEvidence(s, item.id, 'disputed');
  assert.equal(s.drafts.find(d => d.id === draft.id).approvedEvidence[0].verification, 'user_verified');
  // An edit invalidates the frozen snapshot along with the approval itself.
  const edited = editDraft(s, draft.id, 'A revised draft that is a bit longer.');
  assert.equal(edited.approvedEvidence, undefined);
  assert.equal(edited.status, 'pending');
});

test('evidence items are separate from conversation text and never quoted as verified facts', () => {
  const s = store();
  const draft = draftFor(s);
  evidence.addEvidence(s, {draftId: draft.id, kind: 'quote', claim: 'The author says benchmarks do not capture production behavior.', confidence: 0.3, reuse: 'quote'});
  const reuse = evidence.evidenceForDraft(s, draft.id).filter(e => e.reuse === 'quote');
  assert.equal(reuse.length, 1);
  // A "none" reuse policy still records the material but marks it off-limits.
  evidence.addEvidence(s, {draftId: draft.id, kind: 'link', link: 'https://example.com/paywalled', claim: 'Paywalled report behind a login.', confidence: 0.9, reuse: 'none'});
  assert.equal(evidence.evidenceSummary(evidence.evidenceForDraft(s, draft.id)).reuseBlocked, 1);
  assert.equal(evidence.evidenceForDraft(s, draft.id).find(e => e.reuse === 'none').verification, 'unverified', 'High confidence never means verified.');
});
