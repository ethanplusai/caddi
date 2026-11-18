import { CaddiError, assertId } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Pop-up permission is unavailable'); };
const MAX_CHILDREN = 8, MAX_PER_WORKSPACE = 2, MAX_GRANTS = 16, TTL_MS = 30_000;
const fields = ['workspaceId', 'tabId', 'webContentsId', 'documentGeneration', 'nonce', 'url', 'privacyEpoch', 'ownerWindowId'];
const same = (left, right) => !!left && !!right && fields.every(key => left[key] === right[key]);
export function safePopupURL(raw) {
  if (raw === 'about:blank') return raw;
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
    return url.href;
  } catch { return null; }
}
export function popupOrigin(raw) {
  const safe = safePopupURL(raw);
  return safe === 'about:blank' ? 'about:blank' : safe ? new URL(safe).origin : null;
}
function openerOrigin(raw) {
  if (raw === 'about:blank') return raw;
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** Volatile one-shot human grant and auxiliary-window registry. No page IDs are accepted from the page. */
export function createPopupGate({ current, now = Date.now, onChange = () => {} } = {}) {
  if (typeof current !== 'function' || typeof now !== 'function') fail('INVALID_ARGUMENT');
  const grants = new Map(), children = new Map();
  let closed = false;
  const publish = () => { try { onChange(); } catch {} };
  const live = binding => {
    if (closed || !binding) return false;
    try {
      const value = current(binding.webContentsId);
      return same(binding, value) && value.active === true && value.visible === true;
    } catch { return false; }
  };
  function dropGrant(webContentsId) {
    const value = grants.get(webContentsId);
    if (!value) return false;
    clearTimeout(value.timer); grants.delete(webContentsId); publish(); return true;
  }
  function grant(binding) {
    if (!live(binding) || !binding.nonce || !openerOrigin(binding.url)) fail('POPUP_OPENER_UNAVAILABLE');
    if (!grants.has(binding.webContentsId) && grants.size >= MAX_GRANTS) fail('POPUP_CAPACITY');
    dropGrant(binding.webContentsId);
    const expiresAt = now() + TTL_MS;
    const item = { binding: { ...binding }, expiresAt, timer: null };
    item.timer = setTimeout(() => dropGrant(binding.webContentsId), TTL_MS);
    item.timer.unref?.(); grants.set(binding.webContentsId, item); publish();
    return { workspaceId: binding.workspaceId, tabId: binding.tabId, origin: openerOrigin(binding.url), expiresAt };
  }
  function consume(binding, destination, { postBody = false } = {}) {
    const item = binding && grants.get(binding.webContentsId);
    if (!item) return { allowed: false, reason: postBody ?
      'A new-window form was blocked. Allow one pop-up in Site permissions, then submit it again; the form was not replayed.' :
      'A pop-up was blocked. Allow one pop-up in Site permissions, then retry on the page.' };
    dropGrant(binding.webContentsId); // Every attempt consumes the one-shot grant.
    if (item.expiresAt <= now() || !same(item.binding, binding) || !live(item.binding))
      return { allowed: false, reason: 'The one-time pop-up permission expired or the page changed. Allow it again and retry.' };
    const safe = safePopupURL(destination);
    if (!safe) return { allowed: false, reason: 'The pop-up destination is not supported. Only HTTPS, about:blank and local test HTTP are allowed.' };
    if (children.size >= MAX_CHILDREN || [...children.values()].filter(value => value.binding.workspaceId === binding.workspaceId).length >= MAX_PER_WORKSPACE)
      return { allowed: false, reason: 'Too many pop-ups are open in this workspace. Close one and retry.' };
    return { allowed: true, binding: item.binding, destination: safe };
  }
  function register(binding, nativeWindow, destination) {
    if (!live(binding) || closed || !nativeWindow || nativeWindow.isDestroyed?.()) fail('POPUP_OPENER_UNAVAILABLE');
    const id = assertId('popup-' + nativeWindow.id);
    if (children.has(id) || children.size >= MAX_CHILDREN ||
        [...children.values()].filter(value => value.binding.workspaceId === binding.workspaceId).length >= MAX_PER_WORKSPACE) fail('POPUP_CAPACITY');
    children.set(id, { id, binding: { ...binding }, nativeWindow, origin: popupOrigin(destination) });
    nativeWindow.once('closed', () => { children.delete(id); publish(); });
    publish(); return id;
  }
  function updateChildOrigin(binding, nativeWindow, destination) {
    const id = assertId('popup-' + nativeWindow.id), item = children.get(id), origin = popupOrigin(destination);
    if (!item || item.nativeWindow !== nativeWindow || !same(item.binding, binding) || !live(binding) || !origin) fail('POPUP_OPENER_UNAVAILABLE');
    item.origin = origin; publish(); return origin;
  }
  function invalidate({ workspaceId, tabId = null, ownerWindowId = null } = {}) {
    for (const [id, item] of [...grants]) if ((workspaceId === undefined || item.binding.workspaceId === workspaceId) &&
      (tabId === null || item.binding.tabId === tabId) && (ownerWindowId === null || item.binding.ownerWindowId === ownerWindowId)) dropGrant(id);
    for (const item of [...children.values()]) if ((workspaceId === undefined || item.binding.workspaceId === workspaceId) &&
      (tabId === null || item.binding.tabId === tabId) && (ownerWindowId === null || item.binding.ownerWindowId === ownerWindowId)) {
      children.delete(item.id);
      if (!item.nativeWindow.isDestroyed()) item.nativeWindow.destroy();
    }
    publish();
  }
  function cancel({ workspaceId, tabId, ownerWindowId }) {
    const item = [...grants.values()].find(value => value.binding.workspaceId === workspaceId && value.binding.tabId === tabId &&
      value.binding.ownerWindowId === ownerWindowId);
    if (!item) fail('POPUP_GRANT_STALE');
    dropGrant(item.binding.webContentsId); return true;
  }
  function closeChild({ workspaceId, popupId, ownerWindowId }) {
    const item = children.get(assertId(popupId));
    if (!item || item.binding.workspaceId !== workspaceId || item.binding.ownerWindowId !== ownerWindowId) fail('POPUP_NOT_FOUND');
    children.delete(item.id); if (!item.nativeWindow.isDestroyed()) item.nativeWindow.destroy(); publish(); return true;
  }
  function list(workspaceId, ownerWindowId) {
    const stillBound = item => { try { return same(item.binding, current(item.binding.webContentsId)); } catch { return false; } };
    return { grants: [...grants.values()].filter(item => item.binding.workspaceId === workspaceId && item.binding.ownerWindowId === ownerWindowId &&
      item.expiresAt > now() && stillBound(item)).map(item => ({ tabId: item.binding.tabId,
        origin: openerOrigin(item.binding.url), expiresAt: item.expiresAt })),
    children: [...children.values()].filter(item => item.binding.workspaceId === workspaceId && item.binding.ownerWindowId === ownerWindowId &&
      !item.nativeWindow.isDestroyed()).map(item => ({ popupId: item.id, tabId: item.binding.tabId, origin: item.origin })) };
  }
  function close() { invalidate(); closed = true; }
  return Object.freeze({ grant, consume, register, updateChildOrigin, invalidate, cancel, closeChild, list, isLive: live, close });
}
