/** Attachments over HTTP. A member uploads one file per request; any member of
 * the same workspace (viewer and up) can read it back. Both work on `c.store`,
 * the session's own workspace, so an id from another workspace is a 404. */
import {MAX_FILE_BYTES} from '../shared/attachments.js';
import {saveAttachment, readAttachment, attachmentHeaders} from './attachments.js';
import {fail} from './http.js';
import {reply} from './router.js';

// base64 is 4/3 of the bytes, plus the JSON around it.
const BODY_LIMIT = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64 * 1024;

export function fileRoutes(router) {
  router.add('POST', '/api/attachments', 'member', async c => {
    const b = await c.body(BODY_LIMIT);
    return reply(201, saveAttachment(c.store, b, {by: c.actor?.userId || null}));
  });
  router.add('GET', '/api/attachments/:id', 'viewer', c => {
    const file = readAttachment(c.store, c.params.id);
    if (!file) fail('File not found.', 404);
    return reply(200, file.data, attachmentHeaders(file));
  });
}
