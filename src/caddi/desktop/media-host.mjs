import { CaddiError } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'The reviewed media document is unavailable'); };
const sync = callback => {
  const value = callback(); if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('MEDIA_REVIEW_STALE'); return true;
};

/** Main-only document receipts. Renderer requests carry a reviewed permission ID,
 * never the native document or a substitute tab ID. */
export function createMediaHost({ permissions, captureOwner, closeNative, closeMetadata, onChange = () => {} } = {}) {
  if (!permissions?.list || ![captureOwner, closeNative, closeMetadata, onChange].every(value => typeof value === 'function')) fail('INVALID_ARGUMENT');
  const changed = () => { try { onChange(); } catch {} };
  function binding(owner, input, pending = false) {
    const rows = permissions.list(input.workspaceId)[pending ? 'pending' : 'media'];
    const row = rows.find(item => item.id === (pending ? input.requestId : input.mediaRecordId));
    if (!row || row.workspaceId !== input.workspaceId) fail(pending ? 'PERMISSION_REQUEST_STALE' : 'MEDIA_REVIEW_STALE');
    const capability = captureOwner(owner, { workspaceId: row.workspaceId, tabId: row.tabId, cleanup: !pending });
    if (!capability || typeof capability.assertCurrent !== 'function') {
      if (capability instanceof Promise) void capability.catch(() => {}); fail('MEDIA_REVIEW_STALE');
    }
    sync(capability.assertCurrent); return { row, capability };
  }
  return Object.freeze({
    respond(owner, input) {
      const { capability } = binding(owner, input, true);
      const result = permissions.respond(input, { beforeRespond: capability.assertCurrent }); changed(); return result;
    },
    revoke(owner, input) {
      const { capability } = binding(owner, input);
      const result = permissions.revokeMedia(input, { beforeRevoke: capability.assertCurrent }); changed(); return result;
    },
    async end(owner, input) {
      const { row, capability } = binding(owner, input);
      const result = await permissions.endMedia(input, { beforeEnd: capability.assertCurrent,
        closePage: request => closeNative(owner, request) });
      if (result?.closed !== true && result?.closed !== false) fail('MEDIA_STOP_UNCONFIRMED');
      const receipt = { closed: result.closed, ended: result.ended === true, tabId: row.tabId, mediaRecordId: row.id };
      if (!result.closed) { changed(); return receipt; }
      // Actual native destruction cannot be undone by a stale chrome or a failed
      // metadata write. Return that completed effect honestly and never retry the
      // close against a replacement page.
      try {
        if (!result.ended || result.tabId !== row.tabId || result.workspaceId !== row.workspaceId ||
            result.mediaRecordId !== row.id || typeof result.assertClosed !== 'function') fail('MEDIA_STOP_UNCONFIRMED');
        const assertClosed = () => { sync(capability.assertCurrent); sync(result.assertClosed); return true; };
        assertClosed();
        const metadata = await closeMetadata(owner, { workspaceId: row.workspaceId, tabId: row.tabId, assertClosed });
        changed(); return { ...receipt, ...(metadata?.display === 'unavailable' ? { presentationPending: true } : {}) };
      } catch { changed(); return { ...receipt, metadataPending: true, presentationPending: true }; }
    },
  });
}
