import { randomUUID } from 'node:crypto';
import { CaddiError } from '../contracts.mjs';
import { assertMediaFence, validateMediaTypes } from './site-media-access.mjs';

const MAX_PENDING = 4, MAX_RECENT = 12, MAX_MEDIA_DOCUMENTS = 32, DEADLINE_MS = 30_000;
const fail = code => { throw new CaddiError(code, 'Site permission request is unavailable'); };
const PAGE_KEYS = ['workspaceId', 'tabId', 'webContentsId', 'documentGeneration', 'nonce', 'privacyEpoch', 'url'];
const MEDIA_KEYS = [...PAGE_KEYS, 'identityId', 'nativeLifetimeId', 'mediaDocumentId', 'runtimeIncarnation', 'ownerWindowId', 'ownerRevision', 'chromeGeneration'];
const DOCUMENT_KEYS = ['workspaceId', 'identityId', 'tabId', 'webContentsId', 'nativeLifetimeId', 'mediaDocumentId'];
const CLEANUP_KEYS = [...DOCUMENT_KEYS, 'runtimeIncarnation', 'ownerWindowId', 'ownerRevision', 'privacyEpoch'];
const equal = (a, b, keys = PAGE_KEYS) => !!a && !!b && keys.every(key => a[key] === b[key]);
const documentKey = binding => JSON.stringify([binding.webContentsId, binding.nativeLifetimeId, binding.mediaDocumentId]);
const ordered = values => ['audio', 'video'].filter(type => values.has(type));
function safeOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
    return url.origin;
  } catch { return null; }
}
function validMediaBinding(binding) {
  return !!binding && binding.mediaEligible === true &&
    ['workspaceId', 'identityId', 'tabId', 'nativeLifetimeId', 'mediaDocumentId', 'runtimeIncarnation', 'nonce'].every(key => typeof binding[key] === 'string' && binding[key].length > 0) &&
    ['webContentsId', 'documentGeneration', 'privacyEpoch', 'ownerWindowId', 'ownerRevision', 'chromeGeneration']
      .every(key => Number.isSafeInteger(binding[key]) && binding[key] >= 0);
}

/** Volatile owner review. Media grants permit future requests; issued records
 * intentionally survive revocation because an existing stream may continue. */
export function createSitePermissions({ current, onChange = () => {}, now = () => Date.now(), mediaAccess = null,
  currentMediaDocument = null, deadlineMs = DEADLINE_MS } = {}) {
  if (typeof current !== 'function' || typeof onChange !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS ||
      (mediaAccess !== null && typeof mediaAccess?.authorize !== 'function') ||
      (currentMediaDocument !== null && typeof currentMediaDocument !== 'function')) fail('INVALID_ARGUMENT');
  const pending = new Map(), grants = new Map(), recent = [], media = new Map(), mediaByDocument = new Map();
  let closed = false;
  const publish = () => { try { onChange(); } catch {} };
  function record(binding, permission, reason) {
    if (!binding?.workspaceId) return;
    recent.unshift({ workspaceId: binding.workspaceId, tabId: binding.tabId, origin: safeOrigin(binding.url),
      permission: permission === 'notifications' ? 'notifications' : permission === 'media' ? 'camera or microphone' : 'other', reason, at: now() });
    recent.length = Math.min(recent.length, MAX_RECENT); publish();
  }
  function observed(binding) {
    if (closed || !binding) return null;
    try {
      const value = current(binding.webContentsId);
      if (value instanceof Promise) void value.catch(() => {});
      return equal(binding, value) ? value : null;
    } catch { return null; }
  }
  function live(binding, permission = 'notifications') {
    const value = observed(binding);
    return permission === 'media' ? validMediaBinding(value) && equal(binding, value, MEDIA_KEYS) : !!value;
  }
  function nativeDocument(binding) {
    if (closed || !currentMediaDocument) return null;
    try {
      const value = currentMediaDocument(binding.webContentsId);
      if (value instanceof Promise) void value.catch(() => {});
      return equal(binding, value, DOCUMENT_KEYS) ? value : null;
    } catch { return null; }
  }
  function mediaRecord(binding, types) {
    const key = documentKey(binding);
    let item = media.get(mediaByDocument.get(key));
    if (item?.end) fail('MEDIA_END_PENDING');
    if (!item) {
      if (media.size >= MAX_MEDIA_DOCUMENTS) fail('MEDIA_CAPACITY');
      item = { id: randomUUID(), revision: 0, binding: { ...binding }, origin: safeOrigin(binding.url),
        issued: new Set(), granted: new Set(), state: 'allowed', createdAt: now(), updatedAt: now(), end: null };
      media.set(item.id, item); mediaByDocument.set(key, item.id);
    }
    item.binding = { ...binding };
    for (const type of types) { item.issued.add(type); item.granted.add(type); }
    item.revision++; item.updatedAt = now(); item.state = 'allowed';
    return item;
  }
  function finish(item, allowed, reason) {
    if (pending.get(item.id) !== item) return false;
    pending.delete(item.id); clearTimeout(item.timer);
    let authorized = allowed === true && live(item.binding, item.permission), issued = null;
    if (allowed === true && !authorized) reason = 'The page changed before review finished.';
    try {
      if (authorized && item.reviewFence) assertMediaFence(item.reviewFence);
      if (authorized && item.permission === 'media') issued = mediaRecord(item.binding, item.mediaTypes);
      else if (authorized) grants.set(item.binding.webContentsId, { binding: item.binding, origin: item.origin });
    } catch { authorized = false; reason = 'The page changed or the bounded permission capacity is unavailable.'; }
    try { item.callback(authorized); }
    catch {
      if (authorized && issued) {
        // A callback exception is not proof that native capture never started.
        issued.granted.clear(); issued.revision++; issued.state = 'close-pending'; issued.updatedAt = now();
      } else if (authorized) grants.delete(item.binding.webContentsId);
      authorized = false;
      reason = issued ? 'Native approval could not be confirmed. Existing media may continue until this page ends.' : 'The native permission response could not be confirmed.';
    }
    record(item.binding, item.permission, authorized ? (item.permission === 'media' ?
      'Allowed for this page. Existing media may continue until the page ends.' : 'Allowed for this page until it changes or closes.') : reason);
    publish(); return authorized;
  }
  function request(binding, permission, callback, details = {}) {
    if (typeof callback !== 'function') fail('INVALID_ARGUMENT');
    const deny = reason => { try { callback(false); } catch {} record(binding, permission, reason); return null; };
    const captured = observed(binding);
    if (!captured || !captured.nonce) return deny('The page changed before review.');
    if (permission !== 'notifications' && permission !== 'media') return deny('This site capability is not supported in this development build.');
    let mediaTypes = null;
    if (permission === 'media') {
      if (!mediaAccess || !currentMediaDocument) return deny('Page camera and microphone access is not supported in this development build.');
      if (!validMediaBinding(captured)) return deny('Camera and microphone are available only in an eligible Personal workspace.');
      try { mediaTypes = validateMediaTypes(details?.mediaTypes); } catch { return deny('The requested camera or microphone types could not be verified.'); }
      if (media.get(mediaByDocument.get(documentKey(captured)))?.end) return deny('This page is ending its activity.');
    }
    const origin = safeOrigin(captured.url), requesting = safeOrigin(details?.requestingUrl);
    if (!origin || !requesting || origin !== requesting || details?.requestingUrl !== captured.url || details?.isMainFrame !== true ||
        (permission === 'media' && details.securityOrigin !== undefined && safeOrigin(details.securityOrigin) !== origin))
      return deny('The requesting document or origin could not be verified.');
    if (pending.size >= MAX_PENDING) return deny('Too many permission requests are waiting for review.');
    const item = { id: randomUUID(), revision: 1, binding: { ...captured }, origin, permission, mediaTypes,
      callback, createdAt: now(), phase: 'review', timer: null, reviewFence: null };
    item.timer = setTimeout(() => finish(item, false, 'The review timed out.'), deadlineMs);
    item.timer.unref?.(); pending.set(item.id, item); publish(); return item.id;
  }
  function check(binding, permission, requestingOrigin, details = {}) {
    if (!['notifications', 'media'].includes(permission) || !binding || details?.isMainFrame !== true || details?.requestingUrl !== binding.url) return false;
    const value = observed(binding);
    if (!value) return false;
    const origin = safeOrigin(requestingOrigin);
    if (!origin || origin !== safeOrigin(value.url)) return false;
    if (permission === 'media') {
      if (!validMediaBinding(value) || !['audio', 'video'].includes(details?.mediaType) ||
          (details.securityOrigin !== undefined && safeOrigin(details.securityOrigin) !== origin)) return false;
      const item = media.get(mediaByDocument.get(documentKey(value)));
      return !!item && !item.end && equal(item.binding, value, MEDIA_KEYS) && item.origin === origin && item.granted.has(details.mediaType);
    }
    const grant = grants.get(binding.webContentsId);
    return !!grant && equal(grant.binding, value) && grant.origin === origin;
  }
  function respond({ requestId, allow, workspaceId, expectedRevision }, { beforeRespond = () => true } = {}) {
    if (typeof requestId !== 'string' || typeof allow !== 'boolean' || typeof workspaceId !== 'string') fail('INVALID_ARGUMENT');
    const item = pending.get(requestId);
    if (!item || item.binding.workspaceId !== workspaceId || (item.permission === 'media' && expectedRevision !== item.revision)) fail('PERMISSION_REQUEST_STALE');
    assertMediaFence(beforeRespond);
    if (!live(item.binding, item.permission)) { finish(item, false, 'The page changed before review.'); fail('PERMISSION_REQUEST_STALE'); }
    if (!allow) return { allowed: finish(item, false, 'You denied this request.') };
    if (item.phase !== 'review') fail('PERMISSION_REQUEST_STALE');
    item.reviewFence = beforeRespond;
    if (item.permission !== 'media') return { allowed: finish(item, true, '') };
    item.phase = 'waiting-for-system'; item.revision++; publish();
    const assertCurrent = () => {
      if (pending.get(item.id) !== item || item.phase !== 'waiting-for-system' || !live(item.binding, 'media')) fail('PERMISSION_REQUEST_STALE');
      assertMediaFence(beforeRespond); return true;
    };
    // The action returns immediately; an OS prompt cannot block unrelated owner
    // work or prevent Deny/close/privacy actions from invalidating this request.
    void Promise.resolve().then(() => {
      assertCurrent(); return mediaAccess.authorize(item.mediaTypes, { assertCurrent });
    }).then(result => {
      if (result?.allowed !== true && result?.allowed !== false) fail('MEDIA_SYSTEM_RESULT_INVALID');
      finish(item, result.allowed, 'System camera or microphone permission was not granted.');
    }).catch(error => finish(item, false, error.code === 'MEDIA_SYSTEM_BUSY' ?
      'Another system permission request is still pending.' : 'The page changed or system permission was unavailable.'));
    return { allowed: false, pending: true };
  }
  function selectMedia({ workspaceId, mediaRecordId, expectedRevision }) {
    const item = media.get(mediaRecordId);
    if (!item || item.binding.workspaceId !== workspaceId || !Number.isSafeInteger(expectedRevision) || item.revision !== expectedRevision)
      fail('MEDIA_REVIEW_STALE');
    if (item.end) fail('MEDIA_END_PENDING');
    if (!nativeDocument(item.binding)) fail('MEDIA_REVIEW_STALE');
    return item;
  }
  function revokeMedia(input, { beforeRevoke = () => true } = {}) {
    assertMediaFence(beforeRevoke);
    const item = selectMedia(input), types = input.mediaTypes === undefined ? ordered(item.issued) : validateMediaTypes(input.mediaTypes);
    if (types.some(type => !item.issued.has(type))) fail('MEDIA_TYPES_INVALID');
    assertMediaFence(beforeRevoke);
    for (const request of [...pending.values()]) if (request.permission === 'media' && equal(request.binding, item.binding, DOCUMENT_KEYS) &&
        request.mediaTypes.some(type => types.includes(type))) finish(request, false, 'You blocked new requests for this page.');
    for (const type of types) item.granted.delete(type);
    item.revision++; item.updatedAt = now(); item.state = item.granted.size ? 'allowed' : 'revoked';
    record(item.binding, 'media', 'New requests were blocked. An existing stream may continue until this page ends.');
    return { revoked: true, mayBeUsing: true, revision: item.revision };
  }
  async function endMedia(input, { beforeEnd, closePage } = {}) {
    assertMediaFence(beforeEnd);
    if (typeof closePage !== 'function') fail('INVALID_ARGUMENT');
    const item = selectMedia(input), binding = { ...nativeDocument(item.binding) };
    if (!equal(binding, item.binding, DOCUMENT_KEYS)) fail('MEDIA_REVIEW_STALE');
    for (const request of [...pending.values()]) if (request.permission === 'media' && equal(request.binding, item.binding, DOCUMENT_KEYS))
      finish(request, false, 'This page is ending its activity.');
    item.granted.clear(); item.revision++; item.updatedAt = now(); item.state = 'ending';
    const end = { revision: item.revision, acknowledged: false, nativeClosed: false };
    item.end = end; publish();
    const assertCurrent = () => {
      assertMediaFence(beforeEnd);
      if (closed || media.get(item.id) !== item || item.end !== end || item.revision !== end.revision ||
          !equal(binding, nativeDocument(item.binding), CLEANUP_KEYS)) fail('MEDIA_REVIEW_STALE');
      return true;
    };
    try {
      assertCurrent();
      const result = await closePage({ binding: Object.freeze(binding), assertCurrent });
      if (result?.closed !== true && result?.closed !== false) fail('MEDIA_STOP_UNCONFIRMED');
      if (result.closed && (!end.acknowledged || typeof result.assertClosed !== 'function')) fail('MEDIA_STOP_UNCONFIRMED');
      if (result.closed) {
        // Renderer loss can acknowledge document end before the later native
        // destroyed event. The exact engine receipt must still prove closure.
        assertMediaFence(result.assertClosed);
        const assertClosed = () => { assertMediaFence(beforeEnd); assertMediaFence(result.assertClosed); return true; };
        return { closed: true, ended: true, workspaceId: binding.workspaceId, tabId: binding.tabId, mediaRecordId: item.id, assertClosed };
      }
      if (media.get(item.id) === item) { item.end = null; item.revision++; item.state = 'revoked'; item.updatedAt = now(); publish(); }
      return { closed: false, ended: end.acknowledged, workspaceId: binding.workspaceId, tabId: binding.tabId, mediaRecordId: item.id };
    } catch (error) {
      if (media.get(item.id) === item) { item.end = null; item.revision++; item.state = 'close-pending'; item.updatedAt = now(); publish(); }
      throw error;
    }
  }
  function invalidate({ workspaceId, tabId = null }) {
    for (const item of [...pending.values()]) if (item.binding.workspaceId === workspaceId &&
        (tabId === null || item.binding.tabId === tabId)) finish(item, false, 'The page or workspace changed before review.');
    for (const [id, grant] of grants) if (grant.binding.workspaceId === workspaceId && (tabId === null || grant.binding.tabId === tabId)) grants.delete(id);
    for (const item of media.values()) if (item.binding.workspaceId === workspaceId && (tabId === null || item.binding.tabId === tabId)) {
      if (item.granted.size) { item.granted.clear(); item.revision++; item.updatedAt = now(); }
      if (!item.end) item.state = 'revoked';
    }
    publish();
  }
  function documentEnded(binding, { closed: nativeClosed = false } = {}) {
    // Only the main-process engine reports committed replacement, renderer loss,
    // or destruction. Navigation-start, hash changes and revocation are not ACKs.
    const key = documentKey(binding ?? {}), item = media.get(mediaByDocument.get(key));
    for (const request of [...pending.values()]) if (request.permission === 'media' && equal(request.binding, binding, DOCUMENT_KEYS))
      finish(request, false, 'The requesting document ended.');
    if (item && equal(item.binding, binding, DOCUMENT_KEYS)) {
      if (item.end) { item.end.acknowledged = true; item.end.nativeClosed = nativeClosed === true; }
      media.delete(item.id); mediaByDocument.delete(key); publish();
    }
  }
  function list(workspaceId) {
    return { pending: [...pending.values()].filter(item => item.binding.workspaceId === workspaceId && live(item.binding, item.permission))
      .map(item => ({ id: item.id, revision: item.revision, workspaceId, tabId: item.binding.tabId, origin: item.origin,
        permission: item.permission, createdAt: item.createdAt, phase: item.phase,
        ...(item.mediaTypes ? { mediaTypes: [...item.mediaTypes] } : {}) })),
    recent: recent.filter(item => item.workspaceId === workspaceId).map(item => ({ ...item })),
    media: [...media.values()].filter(item => item.binding.workspaceId === workspaceId).map(item => ({
      id: item.id, revision: item.revision, workspaceId, tabId: item.binding.tabId, origin: item.origin,
      mediaTypes: ordered(item.issued), grantedMediaTypes: ordered(item.granted), state: item.state,
      mayBeUsing: true, createdAt: item.createdAt, updatedAt: item.updatedAt })),
    };
  }
  function close() {
    for (const item of [...pending.values()]) finish(item, false, 'The browser closed before review.');
    grants.clear(); for (const item of media.values()) item.granted.clear(); closed = true;
    mediaAccess?.close?.(); publish();
  }
  return Object.freeze({ request, check, respond, revokeMedia, endMedia, documentEnded, invalidate, list, close });
}
