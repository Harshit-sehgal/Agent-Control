/** The composer's files: the attach button, paste and drop, and the chips that
 * show what will go with the next message. A file is uploaded as soon as it is
 * picked (`POST /api/attachments`, or the demo's own copy in shared/local-api.js),
 * so Send only carries the references. A removed chip's upload is left for the
 * server's daily sweep. What may be attached is shared/attachments.js. */
import {ACCEPT, MAX_FILES, MAX_FILE_BYTES, DEMO_MAX_FILE_BYTES, pickProblem, isImage, sizeLabel} from './attachments.js?v=789d865101';
import {esc, icon} from './ui-kit.js?v=789d865101';
import {api, isStaticDemo} from './ui-store.js?v=789d865101';
import {toast} from './ui-dialogs.js?v=789d865101';

/** {key, name, type, size, preview, ref, failed} per picked file, for the open chat. */
let picked = [];

/** The attach button and the hidden picker, for the composer's box. */
export const attachButton = write => `<button type="button" class="cv-attach" id="cv-attach" aria-label="Attach files"${write ? '' : ' disabled'}>${icon('clip', 20)}</button><input type="file" id="cv-file" accept="${ACCEPT}" multiple hidden tabindex="-1" aria-hidden="true">`;
export const chipsSlot = '<div class="cv-chips" id="cv-chips" aria-live="polite" hidden></div>';

const readUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('That file could not be read.'));
  reader.readAsDataURL(file);
});

function paint() {
  const box = document.getElementById('cv-chips');
  if (!box) return;
  box.hidden = !picked.length;
  box.innerHTML = picked.map(p => {
    const look = isImage(p.type) && p.preview ? `<img src="${esc(p.preview)}" alt="">` : icon('file', 16);
    const state = p.failed ? ' failed' : p.ref ? '' : ' busy';
    return `<span class="cv-chip${state}" data-key="${esc(p.key)}">${look}<span class="cv-chip-name">${esc(p.name)}</span><small>${p.failed ? 'Not attached' : esc(sizeLabel(p.size))}</small><button type="button" class="cv-chip-x" data-key="${esc(p.key)}" aria-label="Remove ${esc(p.name)}">${icon('x', 14)}</button></span>`;
  }).join('');
  const text = document.querySelector('#chat-form textarea');
  // Files alone are a message: the box need not be typed in.
  if (text) text.required = !picked.some(p => p.ref);
}

async function add(files) {
  const max = isStaticDemo() ? DEMO_MAX_FILE_BYTES : MAX_FILE_BYTES;
  for (const file of files) {
    const problem = pickProblem({size: file.size, count: picked.length, max});
    if (problem) { toast(problem, true); if (picked.length >= MAX_FILES) break; continue; }
    const entry = {key: crypto.randomUUID(), name: file.name || 'pasted image', type: file.type, size: file.size, preview: '', ref: null, failed: false};
    picked.push(entry); paint();
    try {
      const data = await readUrl(file);
      if (isImage(file.type)) entry.preview = data;
      entry.ref = await api('/api/attachments', 'POST', {name: entry.name, data: data.replace(/^data:[^,]*,/, '')});
      entry.type = entry.ref.type;
    } catch (error) {
      entry.failed = true;
      toast(error?.message || 'That file could not be attached.', true);
    }
    if (picked.includes(entry)) paint();
  }
}

/** Start the open chat's composer with no files, and listen for picks, pastes and drops. */
export function wireAttach(form) {
  picked = [];
  if (!form) return;
  const input = form.querySelector('#cv-file');
  form.querySelector('#cv-attach')?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => { const files = [...input.files]; input.value = ''; void add(files); });
  form.querySelector('textarea')?.addEventListener('paste', ev => {
    const files = [...(ev.clipboardData?.files || [])];
    if (files.length) { ev.preventDefault(); void add(files); }
  });
  form.addEventListener('dragover', ev => { if (ev.dataTransfer?.types?.includes('Files')) { ev.preventDefault(); form.classList.add('drop'); } });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', ev => {
    form.classList.remove('drop');
    const files = [...(ev.dataTransfer?.files || [])];
    if (files.length) { ev.preventDefault(); void add(files); }
  });
  form.querySelector('#cv-chips')?.addEventListener('click', ev => {
    const x = ev.target.closest?.('.cv-chip-x');
    if (!x) return;
    picked = picked.filter(p => p.key !== x.dataset.key); paint();
  });
  paint();
}

/** True while a picked file is still uploading, so Send waits for it. */
export const attachBusy = () => picked.some(p => !p.ref && !p.failed);
/** The uploaded files for the message being sent, and an empty composer. */
export function takeAttachments() {
  const refs = picked.filter(p => p.ref).map(p => p.ref);
  picked = []; paint();
  return refs;
}
