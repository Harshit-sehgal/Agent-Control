/** Source evidence model.
 *
 * A draft used to carry only the source URL and an unverified text blob, with
 * the Researcher bot unable to check anything. This module gives every claim a
 * real record: what links support it, how confident we are, whether a human
 * verified it, and what may be done with the material. Verification is a human
 * decision recorded here, never something a bot asserts about itself.
 *
 * Pure transitions over the state object, like workflow.js and tasks.js.
 */
import {activity, cleanText, validHttpUrl} from './core.js?v=85a553776b';

export const VERIFICATION_STATUSES = ['unverified', 'user_verified', 'disputed', 'unverifiable'];
export const REUSE_POLICIES = ['internal', 'quote', 'summarize', 'none'];
export const EVIDENCE_KINDS = ['link', 'quote', 'claim'];

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

export function buildEvidence(body = {}) {
  const kind = EVIDENCE_KINDS.includes(body.kind) ? body.kind : fail('Evidence kind must be link, quote or claim.');
  const claim = cleanText(body.claim, 600);
  if (!claim) fail('Describe the claim this evidence supports.', 400);
  if (body.link !== undefined && body.link !== null && String(body.link).trim() !== '' && !validHttpUrl(String(body.link))) fail('Evidence link must be a valid public http(s) URL.', 400);
  if (kind === 'link' && !body.link) fail('Link evidence needs the URL it points at.', 400);
  const confidence = Number(body.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail('Confidence must be a number between 0 and 1.', 400);
  const verification = body.verification === undefined ? 'unverified' : body.verification;
  if (!VERIFICATION_STATUSES.includes(verification)) fail(`Verification must be one of: ${VERIFICATION_STATUSES.join(', ')}.`, 400);
  const reuse = body.reuse === undefined ? 'internal' : body.reuse;
  if (!REUSE_POLICIES.includes(reuse)) fail(`Reuse must be one of: ${REUSE_POLICIES.join(', ')}.`, 400);
  return {
    id: crypto.randomUUID(), kind,
    link: body.link ? validHttpUrl(String(body.link)) : null,
    claim, confidence: Math.round(confidence * 100) / 100, verification, reuse,
    note: cleanText(body.note, 300), draftId: body.draftId || null, candidateId: body.candidateId || null,
    createdBy: body.createdBy || null, createdAt: new Date().toISOString(),
  };
}

/** The evidence a draft is allowed to rely on: its own items plus the evidence
 * attached to the candidate it replies to. */
export function evidenceForDraft(state, draftId) {
  const draft = state.drafts.find(d => d.id === draftId);
  if (!draft) fail('Draft not found.', 404);
  return state.evidence.filter(e => e.draftId === draftId || (draft.candidateId && e.candidateId === draft.candidateId));
}

/** Summary the UI and the approval gate read: whether anything disputed or
 * unverified stands between this draft and publication. */
export function evidenceSummary(items) {
  const disputed = items.filter(e => e.verification === 'disputed').length;
  const verified = items.filter(e => e.verification === 'user_verified').length;
  const unverified = items.filter(e => e.verification === 'unverified').length;
  const reuseBlocked = items.filter(e => e.reuse === 'none').length;
  return {
    total: items.length, disputed, verified, unverified, reuseBlocked,
    approved: disputed === 0,
    level: items.length === 0 ? 'none' : disputed > 0 ? 'blocked' : verified > 0 ? 'supported' : 'claimed',
  };
}

/** A human sets verification. High confidence never implies verification: the
 * whole point is that a model's certainty is not a fact-check. */
export function setVerification(state, id, status, {actor = null} = {}) {
  if (!VERIFICATION_STATUSES.includes(status)) fail('Unknown verification status.', 400);
  const item = state.evidence.find(e => e.id === id);
  if (!item) fail('Evidence not found.', 404);
  item.verification = status;
  activity(state, 'evidence', `Marked evidence for "${item.claim.slice(0, 60)}" as ${status}.`, {evidenceId: item.id});
  return item;
}

export function removeEvidence(state, id) {
  const i = state.evidence.findIndex(e => e.id === id);
  if (i < 0) fail('Evidence not found.', 404);
  const [item] = state.evidence.splice(i, 1);
  activity(state, 'evidence', `Removed evidence for "${item.claim.slice(0, 60)}".`, {evidenceId: item.id});
  return {ok: true};
}

/** Keep the summary cached on affected drafts in sync. The UI renders the
 * cached summary, so it must never lag the evidence rows it summarizes. */
function refreshSummaries(state, changed) {
  const affected = new Set();
  for (const draft of state.drafts) {
    const items = state.evidence.filter(e => e.draftId === draft.id || e.candidateId === draft.candidateId);
    const summary = evidenceSummary(items);
    draft.evidence = summary;
    if (changed && (changed.draftId === draft.id || (changed.candidateId && changed.candidateId === draft.candidateId))) affected.add(draft.id);
  }
  return affected;
}

export function addEvidence(state, body = {}) {
  const item = buildEvidence(body);
  if (item.draftId && !state.drafts.some(d => d.id === item.draftId)) fail('Draft not found.', 404);
  if (item.candidateId && !state.candidates.some(c => c.id === item.candidateId)) fail('Candidate not found.', 404);
  if (!item.draftId && !item.candidateId) fail('Attach evidence to a draft or a candidate.', 400);
  state.evidence.unshift(item);
  refreshSummaries(state, item);
  activity(state, 'evidence', `Added evidence for "${item.claim.slice(0, 60)}".`, {evidenceId: item.id});
  return item;
}

export function verifyEvidence(state, id, status, {actor = null} = {}) {
  const item = setVerification(state, id, status, {actor});
  refreshSummaries(state, item);
  return item;
}

export function dropEvidence(state, id) {
  const item = state.evidence.find(e => e.id === id);
  removeEvidence(state, id);
  refreshSummaries(state, item);
  return {ok: true};
}

/** Seed the default, honestly-labeled record for a captured candidate: the
 * text is a user-selected source, not verified reporting. */
export function seedCandidateEvidence(state, candidate) {
  if (state.evidence.some(e => e.candidateId === candidate.id)) return;
  state.evidence.unshift(buildEvidence({
    draftId: null, candidateId: candidate.id, kind: 'link',
    link: candidate.url, claim: `Source post by ${candidate.author}: ${candidate.text.slice(0, 200)}`,
    confidence: 0.5, verification: 'unverified', reuse: 'internal',
    note: 'Captured by the user. Claims in the post are not checked.',
  }));
}
