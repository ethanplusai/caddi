import { BrowserWindow, WebContentsView, session, ipcMain, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaddiError, assertKeys, assertId, assertInteger, cloneData } from '../contracts.mjs';
import { assertEngineTarget, validateEngineCapabilities, validateEngineOperation } from '../engine/contract.mjs';
import { createPopupGate, popupOrigin, safePopupURL } from './popups.mjs';
import { createPageResidency } from './page-residency.mjs';
import { createPrivateEngineLifetimes } from './private-engine-lifecycle.mjs';
import { createWorkspaceWindowOwnership } from './workspace-window-ownership.mjs';
import { createWorkspaceStorageMeter } from './storage-usage.mjs';
import { createWorkspaceStorageBoundary } from './workspace-storage-boundary.mjs';
import { createPreviewLifecycles } from './preview-lifecycle.mjs';
import { createPreviewPublisher } from './preview-publication.mjs';
import { createSystemPageCloseFence } from './system-page-close.mjs';
import { ANNOTATE_LIMITS, notesUpdateProblem } from './annotation-format.mjs';
import { keyChordEvents } from './agent-input.mjs';
import { validOfferReport } from './vault-offer.mjs';

const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page-preload.cjs');
const READ_ONLY_OPERATIONS = new Set(['page:observe', 'page:wait', 'page:screenshot', 'page:read', 'page:extract']);
// Actions where the agent cursor travels to the target before anything happens.
const CURSOR_FIRST = new Set(['page:click', 'page:fill', 'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag', 'page:scroll-by']);
const AGENT_SCREENSHOT_EDGE = 1568, AGENT_SCREENSHOT_BYTES = 720_000;
const channels = { ready: 'caddi-page:ready', authorize: 'caddi-page:authorize', reply: 'caddi-page:reply', viewport: 'caddi-page:viewport', selection: 'caddi-page:selection', selectionCancelled: 'caddi-page:selection-cancelled',
  annotateUpdate: 'caddi-page:annotate-update', annotateAction: 'caddi-page:annotate-action', livePointer: 'caddi-page:live-pointer',
  loginOffer: 'caddi-page:login-offer' };
// Page commands only the owner's trusted chrome sends: they pass the owner's fence, never an agent's capture checks.
const OWNER_COMMANDS = new Set(['login:owner-fill']);
// Page commands that are an agent acting. One in flight blocks the owner's save offer for that page.
const AGENT_COMMANDS = new Set(['page:click', 'page:fill', 'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag', 'page:scroll-by',
  'page:scroll-into-view', 'page:scroll', 'login:fill']);
const fail = (code, message = 'Page operation is unavailable') => { throw new CaddiError(code, message); };
const safeLabel = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256);
const zoomFactors = Object.freeze([0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
const FIND_TEXT_LIMIT = 512, FIND_DEADLINE_MS = 6000;
const pageURL = value => {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_URL');
  let u; try { u = new URL(value); } catch { fail('INVALID_URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('INVALID_URL');
  return u.href;
};
const syncFence = callback => {
  if (typeof callback !== 'function') fail('AUTHORIZATION_REQUIRED');
  const value = callback();
  if (value === false || (value && typeof value.then === 'function')) fail('AUTHORIZATION_REQUIRED');
};
const aborted = signal => { if (signal?.aborted) fail('CANCELLED'); };
const previewFence = callback => {
  if (typeof callback !== 'function') fail('AUTHORIZATION_REQUIRED');
  const value = callback();
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('AUTHORIZATION_REQUIRED');
};
const isPreviewPage = page => page?.purpose === 'preview' || page?.purpose === 'preview-promoting';
const denyPreviewTarget = page => { if (isPreviewPage(page)) fail('PREVIEW_ACCESS_DENIED'); return page; };

/**
 * Real-page development adapter, with isolated ephemeral or verified persistent sessions.
 * Development status explicitly excludes production isolation qualification.
 * Only main-frame DOM input is supported. No raw evaluation/CDP agent surface.
 */
export function createElectronEngine({ window, privacy, onChange = () => {}, onSelection = () => {}, onAnnotation = () => {}, onLivePointer = () => {}, onNotice = () => {}, onPopupBlocked = () => {},
  onPopupChange = () => {}, isPopupOpenerActive = () => false, onDownload = null, onPreviewLinkMenu = null,
  onOpenTab = null, onLeaveRequest = null, onContextMenu = null, profilePaths = null, sitePermissions = null, onLoginOffer = () => {} } = {}) {
  if (!window?.contentView || !privacy?.captureGuard) fail('INVALID_ARGUMENT');
  if (profilePaths !== null && typeof profilePaths?.forIdentity !== 'function') fail('INVALID_ARGUMENT');
  if (onPreviewLinkMenu !== null && typeof onPreviewLinkMenu !== 'function') fail('INVALID_ARGUMENT');
  if ((onOpenTab !== null && typeof onOpenTab !== 'function') || (onContextMenu !== null && typeof onContextMenu !== 'function') || (onLeaveRequest !== null && typeof onLeaveRequest !== 'function')) fail('INVALID_ARGUMENT');
  const capabilities = validateEngineCapabilities({
    implementation: 'development', isolation: 'storage-partition', isolationEvidence: 'unqualified',
    persistentStorage: !!profilePaths, input: 'target-scoped', capture: 'engine',
    extensions: false, passwordManagers: false, passkeys: false,
  });
  let runtimeIncarnation = 'electron-' + randomUUID(), accessIncarnation = null, sequence = 0, closed = false, engineClosing = false;
  const workspaces = new Map(), identities = new Map(), owners = new Map();
  // A closing page remains allocated until destroyRenderer/human-close acknowledgment
  // removes its map entry. Activity projections deliberately are not capacity truth.
  const residency = createPageResidency({ listAllocations: () => [...workspaces.values()].flatMap(workspace =>
    [...workspace.tabs.values()].map(page => ({ workspaceId: workspace.id, tabId: page.id }))) });
  const windowOwnership = createWorkspaceWindowOwnership({ initialWindow: window,
    workspaceFor: id => workspaces.get(id), listWorkspaces: () => [...workspaces.values()],
    pageCount: workspace => workspace.tabs.size, popupCount: workspace => workspace.popupWindows.size,
    beforePark(workspace) {
      privacy.revoke({ workspaceId: workspace.id, reason: 'WINDOW_PARKED' });
      sitePermissions?.invalidate({ workspaceId: workspace.id });
      popupGate.invalidate({ workspaceId: workspace.id });
      workspace.observer?.unregister(); workspace.observer = null;
      workspace.popupObserver?.unregister(); workspace.popupObserver = null;
    },
  });
  const storageMeter = createWorkspaceStorageMeter();
  const storageBoundary = createWorkspaceStorageBoundary({ workspaceFor: id => workspaces.get(id),
    getRuntimeIncarnation: () => runtimeIncarnation, getPrivacyState: workspaceId => privacy.getPrivacyState(workspaceId),
    assertOwner: workspace => windowOwnership.assertOwner(workspace), isClosed: () => closed || engineClosing, meter: storageMeter });
  const privateLifetimes = createPrivateEngineLifetimes({ engineIncarnation: 'private-engine-' + randomUUID(),
    workspaceFor: id => workspaces.get(id), pageCount: workspace => workspace.tabs.size,
    seal(workspace) {
      workspace.quarantined = true;
      sitePermissions?.invalidate({ workspaceId: workspace.id });
      popupGate.invalidate({ workspaceId: workspace.id });
    },
    cleanupSession: clearEphemeralSession,
    retireWorkspace(workspace) {
      workspace.observer?.unregister(); workspace.observer = null;
      workspace.popupObserver?.unregister(); workspace.popupObserver = null;
      workspace.session.removeListener('will-download', workspace.downloadListener);
      workspace.open = false; workspaces.delete(workspace.id); identities.delete(workspace.identityId);
    },
  });
  const mediaIdentity = page => ({ workspaceId: page.workspace.id, identityId: page.workspace.identityId, tabId: page.id,
    webContentsId: page.contentsId, nativeLifetimeId: page.lifetimeId, mediaDocumentId: page.mediaDocumentId });
  function mediaDocumentBinding(webContentsId) {
    const page = owners.get(webContentsId);
    if (!page || page.workspace.privateScope || isPreviewPage(page) || page.crashed || page.rendererGone || page.wc.isDestroyed() ||
        !page.workspace.open || page.workspace.quarantined || !windowOwnership.isRegistered(page.workspace.ownerWindow, 'normal')) return null;
    return { ...mediaIdentity(page), runtimeIncarnation, ownerWindowId: page.workspace.ownerWindow.id, ownerRevision: page.workspace.ownerRevision,
      documentGeneration: page.generation, nonce: page.nonce,
      privacyEpoch: privacy.getPrivacyState(page.workspace.id).capturePrivacyEpoch, url: page.wc.getURL() };
  }
  function permissionBinding(webContentsId) {
    const page = owners.get(webContentsId), binding = mediaDocumentBinding(webContentsId);
    return !binding || page.closed || !page.nonce || privacy.getPrivacyState(page.workspace.id).blocked ? null : binding;
  }
  function popupBinding(webContentsId) {
    const page = owners.get(webContentsId), binding = permissionBinding(webContentsId);
    if (!page || !binding || page.workspace.ownerWindow?.isDestroyed() || page.destroyTask) return null;
    const ownerWindowId = page.workspace.ownerWindow.id;
    return { ...binding, ownerWindowId, visible: page.view.getVisible() && page.workspace.ownerWindow.isVisible(),
      active: isPopupOpenerActive({ ...binding, ownerWindowId }) === true };
  }
  const popupGate = createPopupGate({ current: popupBinding, onChange: onPopupChange });
  const observation = () => 'observation-' + (++sequence);
  const selector = page => ({ workspaceId: page.workspace.id, tabId: page.id, frameId: 'main' });
  const publishPreviewPage = createPreviewPublisher({ workspaceFor: id => workspaces.get(id),
    isNormalOwner: owner => windowOwnership.isRegistered(owner, 'normal'), getRuntimeIncarnation: () => runtimeIncarnation,
    getPrivacyState: id => privacy.getPrivacyState(id), targetFor: page => current(page), navigationFor: page => pageNavigation(page),
    newObservation: observation, isClosed: () => closed || engineClosing });
  const previews = createPreviewLifecycles({ workspaceFor: id => workspaces.get(id),
    isNormalOwner: owner => !closed && !engineClosing && windowOwnership.isRegistered(owner, 'normal'),
    getRuntimeIncarnation: () => runtimeIncarnation, getPrivacyState: id => privacy.getPrivacyState(id),
    allocatePage: input => createNativePage({ workspaceId: input.workspaceId, tabId: input.tabId, url: input.url },
      { purpose: 'preview', previewId: input.previewId, onAllocated: input.onAllocated }),
    navigationFor: page => pageNavigation(page), targetFor: page => current(page),
    isPageReady: page => !!page.nonce && !page.wc.isDestroyed() && !page.wc.isLoading() && !page.crashed && !page.rendererGone,
    closePage: (page, options) => humanClosePage(page, options.decideClose, { previewClose: true, beforeClose: options.beforeClose }),
    publishPage: publishPreviewPage,
    onChange(item) {
      const page = workspaces.get(item.workspaceId)?.tabs.get(item.tabId);
      if (page && isPreviewPage(page)) { page.previewGeneration = item.generation; notify(page, 'preview-state'); }
    },
  });
  function resolve(query, { allowClosed = false } = {}) {
    assertKeys(query, ['workspaceId', 'tabId', 'frameId'], ['workspaceId', 'tabId']);
    assertId(query.workspaceId); assertId(query.tabId);
    if (query.frameId !== undefined && query.frameId !== 'main') fail('UNSUPPORTED_FRAME');
    const workspace = workspaces.get(query.workspaceId), page = workspace?.tabs.get(query.tabId);
    if (closed || !workspace?.open || !page || (page.closed && !allowClosed)) fail('TARGET_NOT_FOUND');
    return page;
  }
  function current(page) {
    return Object.freeze({ ...selector(page), runtimeIncarnation, documentGeneration: page.generation,
      observationId: page.observation, viewportRevision: page.viewportRevision,
      capturePrivacyEpoch: privacy.getPrivacyState(page.workspace.id).capturePrivacyEpoch });
  }
  function navigation(query) {
    return pageNavigation(denyPreviewTarget(resolve(query)));
  }
  function pageNavigation(page) {
    const wc = page.wc, alive = !wc.isDestroyed();
    return { url: alive ? wc.getURL() || page.url : page.url, title: alive ? safeLabel(wc.getTitle()) : page.title,
      loading: alive && wc.isLoading(), canGoBack: alive && wc.navigationHistory.canGoBack(),
      canGoForward: alive && wc.navigationHistory.canGoForward(), crashed: !alive || page.crashed,
      find: findStatus(page), zoomFactor: alive ? wc.getZoomFactor() : page.zoomFactor,
      muted: alive ? wc.isAudioMuted() : page.muted, audible: alive && !page.rendererGone && wc.isCurrentlyAudible(),
      loadError: page.loadError ? { code: page.loadError.code, name: page.loadError.name } : null };
  }
  function findStatus(page) {
    const search = page.find;
    if (!search || page.closed || page.rendererGone || page.wc.isDestroyed() || search.generation !== page.generation ||
        search.nonce !== page.nonce || search.privacyEpoch !== privacy.getPrivacyState(page.workspace.id).capturePrivacyEpoch) return null;
    return { requestId: search.requestId, matches: search.matches, activeMatchOrdinal: search.activeMatchOrdinal, finalUpdate: search.finalUpdate };
  }
  function clearFind(page) {
    const search = page.find; page.find = null;
    clearTimeout(search?.timer);
    if (search && !page.wc.isDestroyed() && !page.rendererGone) {
      try { page.wc.stopFindInPage('clearSelection'); } catch {}
    }
  }
  function requireHumanPage(query) {
    const page = denyPreviewTarget(resolve(query));
    if (page.crashed || page.rendererGone || page.destroyTask || page.wc.isDestroyed()) fail('PAGE_CLOSED');
    return page;
  }
  function find(raw) {
    const input = cloneData(raw, { maxBytes: 4096 });
    assertKeys(input, ['workspaceId', 'tabId', 'frameId', 'text', 'forward', 'findNext', 'matchCase'], ['workspaceId', 'tabId', 'text']);
    const { workspaceId, tabId, frameId, text, forward = true, findNext = false, matchCase = false } = input;
    if (typeof text !== 'string' || text.length > FIND_TEXT_LIMIT || /[\u0000-\u001f\u007f]/u.test(text) ||
        typeof forward !== 'boolean' || typeof findNext !== 'boolean' || typeof matchCase !== 'boolean') fail('INVALID_ARGUMENT');
    const page = requireHumanPage({ workspaceId, tabId, ...(frameId === undefined ? {} : { frameId }) });
    if (!text.trim()) return stopFind(selector(page));
    if (!page.nonce) fail('PAGE_NOT_READY');
    privacy.revoke({ workspaceId, reason: 'HUMAN_FIND' });
    const previous = page.find, privacyEpoch = privacy.getPrivacyState(workspaceId).capturePrivacyEpoch;
    const continuing = findNext && !!findStatus(page) && previous.text === text && previous.matchCase === matchCase;
    if (!continuing) clearFind(page);
    else { clearTimeout(previous.timer); page.find = null; }
    // A human search can scroll/select text. Fence existing agent targets before
    // native work and remove any outstanding page picker without exposing a bridge.
    invalidate(page, 'find');
    let requestId;
    try {
      // The host API uses findNext=true for next/previous. Electron's documented
      // flag instead selects a new finding session when true.
      requestId = page.wc.findInPage(text, { forward, findNext: !continuing, matchCase });
    } catch { fail('FIND_UNAVAILABLE'); }
    if (!Number.isSafeInteger(requestId) || requestId < 0) fail('FIND_UNAVAILABLE');
    const search = { requestId, generation: page.generation, nonce: page.nonce, privacyEpoch, text, matchCase,
      matches: continuing ? previous.matches : 0, activeMatchOrdinal: continuing ? previous.activeMatchOrdinal : 0, finalUpdate: false, timer: null };
    page.find = search;
    search.timer = setTimeout(() => {
      if (page.find !== search) return;
      clearFind(page); notify(page, 'find-stopped');
      try { onNotice({ workspaceId, tabId, message: 'Page search did not finish. Try a shorter search.' }); } catch {}
    }, FIND_DEADLINE_MS);
    search.timer.unref?.();
    notify(page, 'find-result');
    return findStatus(page);
  }
  function stopFind(query) {
    const page = denyPreviewTarget(resolve(query));
    clearFind(page); notify(page, 'find-stopped');
    return { stopped: true };
  }
  function setZoom(raw) {
    const input = cloneData(raw);
    assertKeys(input, ['workspaceId', 'tabId', 'frameId', 'factor'], ['workspaceId', 'tabId', 'factor']);
    const { workspaceId, tabId, frameId, factor } = input;
    if (!Number.isFinite(factor) || factor < 0.5 || factor > 2) fail('INVALID_ARGUMENT');
    const page = requireHumanPage({ workspaceId, tabId, ...(frameId === undefined ? {} : { frameId }) });
    privacy.revoke({ workspaceId, reason: 'HUMAN_ZOOM' });
    const before = page.wc.getZoomFactor();
    page.wc.setZoomFactor(factor); page.zoomFactor = page.wc.getZoomFactor();
    if (Math.abs(before - page.zoomFactor) > 0.0001) {
      page.viewportRevision++; invalidate(page, 'zoom');
    } else notify(page, 'zoom');
    return { zoomFactor: page.zoomFactor };
  }
  function setMuted(raw) {
    const input = cloneData(raw);
    assertKeys(input, ['workspaceId', 'tabId', 'frameId', 'muted'], ['workspaceId', 'tabId', 'muted']);
    const { workspaceId, tabId, frameId, muted } = input;
    if (typeof muted !== 'boolean') fail('INVALID_ARGUMENT');
    const page = requireHumanPage({ workspaceId, tabId, ...(frameId === undefined ? {} : { frameId }) });
    privacy.revoke({ workspaceId, reason: 'HUMAN_AUDIO' });
    page.wc.setAudioMuted(muted); page.muted = page.wc.isAudioMuted();
    notify(page, 'audio'); return { muted: page.muted };
  }
  function notify(page, reason) {
    if (closed || page.closed) return;
    // Snapshot the transient purpose now. A buffered preview event stays excluded
    // after promotion; consumers never infer its provenance from current page state.
    const preview = isPreviewPage(page) ? Object.freeze({ previewId: page.previewId,
      generation: page.previewGeneration, lifetimeId: page.lifetimeId }) : null;
    try { onChange({ workspaceId: page.workspace.id, tabId: page.id, reason, navigation: pageNavigation(page), target: current(page),
      ...(preview ? { preview } : {}) }); } catch {}
  }
  function getTarget(query) { return current(denyPreviewTarget(resolve(query))); }
  function getPageInfo(query) {
    const page = denyPreviewTarget(resolve(query)), target = current(page), url = pageNavigation(page).url;
    return { target, url, origin: url === 'about:blank' ? null : new URL(pageURL(url)).origin };
  }
  /** The visible page as a native image, for the owner's notes or an agent. Only a visible, current, non-private page. */
  async function capturePageImage(page, expectedTarget) {
    const owner = page.workspace.ownerWindow;
    if (page.workspace.privateScope) fail('PRIVATE_CAPTURE_UNAVAILABLE');
    if (!owner || owner.isDestroyed() || !owner.isVisible() || !page.view.getVisible() || page.closed || page.crashed || page.rendererGone || page.wc.isDestroyed()) fail('CAPTURE_UNAVAILABLE');
    assertCurrentTarget(expectedTarget); privacy.assertCapture(expectedTarget);
    const bounds = page.view.getBounds();
    if (bounds.width < 1 || bounds.height < 1 || bounds.width > 4096 || bounds.height > 4096 || bounds.width * bounds.height > 16_000_000) fail('CAPTURE_SIZE');
    let image;
    try { image = await page.wc.capturePage({ x: 0, y: 0, width: bounds.width, height: bounds.height }, { stayHidden: false }); }
    catch (error) { const unavailable = new CaddiError('CAPTURE_UNAVAILABLE', 'Native page screenshot capture is unavailable'); unavailable.cause = error; throw unavailable; }
    assertCurrentTarget(expectedTarget); privacy.assertCapture(expectedTarget);
    if (owner.isDestroyed() || !owner.isVisible() || !page.view.getVisible() || page.workspace.ownerWindow !== owner ||
        JSON.stringify(page.view.getBounds()) !== JSON.stringify(bounds)) fail('CAPTURE_CHANGED');
    if (!image || image.isEmpty()) fail('CAPTURE_UNAVAILABLE');
    return image;
  }
  async function capturePageScreenshot(query, expectedTarget) {
    const page = denyPreviewTarget(resolve(query));
    let bytes;
    try {
      let image = await capturePageImage(page, expectedTarget);
      const size = image.getSize();
      if (!size.width || !size.height) fail('CAPTURE_UNAVAILABLE');
      const scale = Math.min(1, 4096 / size.width, 4096 / size.height, Math.sqrt(16_000_000 / (size.width * size.height)));
      if (scale < 1) image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)), quality: 'best' });
      bytes = image.toPNG();
      if (bytes.length > 1024 * 1024) fail('CAPTURE_SIZE');
      assertCurrentTarget(expectedTarget); privacy.assertCapture(expectedTarget);
      return bytes;
    } catch (error) {
      bytes?.fill(0);
      if (error?.code) throw error;
      const unavailable = new CaddiError('CAPTURE_UNAVAILABLE', 'Native page screenshot capture is unavailable');
      unavailable.cause = error;
      throw unavailable;
    }
  }
  function assertCurrentTarget(raw) {
    const target = assertEngineTarget(raw), actual = getTarget({ workspaceId: target.workspaceId, tabId: target.tabId, frameId: target.frameId });
    for (const key of Object.keys(actual)) if (target[key] !== actual[key]) fail('STALE_TARGET');
    return true;
  }
  function createPreviewPage(input) {
    assertKeys(input, ['workspaceId', 'url', 'expectedOwnerWindow', 'sourceTarget', 'beforeCreate'],
      ['workspaceId', 'url', 'expectedOwnerWindow', 'beforeCreate']);
    if (closed || engineClosing) fail('CLOSED');
    const url = pageURL(input.url), sourceTarget = input.sourceTarget === undefined ? null : assertEngineTarget(cloneData(input.sourceTarget));
    if (sourceTarget && sourceTarget.workspaceId !== input.workspaceId) fail('WORKSPACE_MISMATCH');
    let revoked = false;
    const beforeCreate = () => {
      previewFence(input.beforeCreate);
      if (closed || engineClosing) fail('CLOSED');
      if (sourceTarget) {
        assertCurrentTarget(sourceTarget);
        const source = resolve({ workspaceId: sourceTarget.workspaceId, tabId: sourceTarget.tabId, frameId: sourceTarget.frameId });
        if (source.workspace.ownerWindow !== input.expectedOwnerWindow || !source.view.getVisible()) fail('PREVIEW_STALE');
      }
      if (!revoked) { revoked = true; privacy.revoke({ workspaceId: input.workspaceId, reason: 'HUMAN_PREVIEW' }); }
      return true;
    };
    return previews.create({ workspaceId: input.workspaceId, url, expectedOwnerWindow: input.expectedOwnerWindow,
      ...(sourceTarget ? { sourceTarget } : {}), beforeCreate });
  }
  function previewLinkMenu(page, params, collect = false) {
    if (!onPreviewLinkMenu || isPreviewPage(page) || page.workspace.privateScope || page.closed || page.crashed || page.rendererGone ||
        page.wc.isDestroyed() || !page.nonce || privacy.getPrivacyState(page.workspace.id).blocked) return;
    try {
      const frame = params?.frame, main = page.wc.mainFrame, url = pageURL(params?.linkURL);
      if (url === 'about:blank' || !frame || frame.detached || !main || main.detached ||
          frame.processId !== main.processId || frame.routingId !== main.routingId || !page.view.getVisible()) return;
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y) || params.x < 0 || params.y < 0 || params.x > 16384 || params.y > 16384) return;
      const sourceTarget = current(page), ownerWindow = page.workspace.ownerWindow, ownerRevision = page.workspace.ownerRevision, nonce = page.nonce;
      const assertCurrent = () => {
        denyPreviewTarget(page); assertCurrentTarget(sourceTarget);
        if (page.wc.isDestroyed() || page.crashed || page.rendererGone || page.nonce !== nonce || frame.detached ||
            page.workspace.ownerWindow !== ownerWindow || page.workspace.ownerRevision !== ownerRevision ||
            !windowOwnership.isRegistered(ownerWindow, 'normal') || !page.view.getVisible() || privacy.getPrivacyState(page.workspace.id).blocked)
          fail('PREVIEW_STALE');
        const actual = page.wc.mainFrame;
        if (!actual || actual.detached || actual.processId !== frame.processId || actual.routingId !== frame.routingId) fail('PREVIEW_STALE');
        return true;
      };
      assertCurrent();
      const info = { workspaceId: page.workspace.id, tabId: page.id, expectedOwnerWindow: ownerWindow,
        sourceTarget, url, point: { x: Math.round(params.x), y: Math.round(params.y) }, assertCurrent };
      if (collect) return info;
      const result = onPreviewLinkMenu(info);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {}
    return null;
  }
  /** The owner's right-click menu: link, image, field and selection items. Addresses are only http(s); nothing runs in the page. */
  function pageContextMenu(page, params) {
    if (!onContextMenu) return previewLinkMenu(page, params);
    if (page.closed || page.crashed || page.rendererGone || page.wc.isDestroyed() || isPreviewPage(page) || !page.view.getVisible()) return;
    const web = raw => { try { const value = pageURL(raw); return value === 'about:blank' ? null : value; } catch { return null; } };
    const flags = params?.editFlags ?? {};
    try {
      onContextMenu({ workspaceId: page.workspace.id, tabId: page.id, ownerWindow: page.workspace.ownerWindow, privateScope: page.workspace.privateScope,
        webContents: page.wc, link: web(params?.linkURL), image: params?.mediaType === 'image' ? web(params?.srcURL) : null,
        editable: params?.isEditable === true, selection: typeof params?.selectionText === 'string' && params.selectionText.trim().length > 0,
        editFlags: Object.fromEntries(['canUndo', 'canRedo', 'canCut', 'canCopy', 'canPaste', 'canSelectAll'].map(key => [key, flags[key] === true])),
        preview: params?.linkURL ? previewLinkMenu(page, params, true) : null });
    } catch {}
  }
  function setPreviewPresentation(binding, input) {
    assertKeys(input, ['bounds', 'visible', 'beforePresent'], ['visible', 'beforePresent']);
    if (typeof input.visible !== 'boolean') fail('INVALID_ARGUMENT');
    const page = previews.page(binding);
    previewFence(input.beforePresent);
    if (previews.page(binding) !== page) fail('PREVIEW_STALE');
    if (!input.visible) page.view.setVisible(false);
    else previews.assertCurrent(binding);
    if (input.bounds !== undefined) setPageBounds(page, input.bounds);
    previewFence(input.beforePresent);
    if (previews.page(binding) !== page) fail('PREVIEW_STALE');
    if (input.visible) { previews.assertCurrent(binding); page.view.setVisible(true); }
    return { visible: input.visible };
  }
  const sourcePage = (event, nonce, { channel = 'other', requireNonce = true } = {}) => {
    const page = owners.get(event.sender.id);
    if (!page) return null;
    let framesMatch = false, wrappersMatch = false, frameAvailable = false;
    try {
      const source = event.senderFrame, main = page.wc.mainFrame;
      frameAvailable = !!source && !!main && !source.detached && !main.detached;
      wrappersMatch = source === main;
      // WebFrameMain JS wrappers are not the authority. Bind the real current
      // main frame within this owned WebContents, then bind its document nonce.
      framesMatch = frameAvailable && Number.isSafeInteger(source.processId) && Number.isSafeInteger(source.routingId) &&
        source.processId === main.processId && source.routingId === main.routingId;
    } catch {}
    const documentMatches = !requireNonce || (typeof nonce === 'string' && nonce === page.nonce);
    page.lastSource = { mainFrame: framesMatch, wrappersMatch, frameAvailable, documentMatches };
    if (framesMatch && !wrappersMatch) page.wrapperDifferenceSeen = true;
    if (channel === 'reply') {
      page.replyCounts.arrivals++;
      page.lastReplySource = { ...page.lastSource };
      if (!framesMatch) page.replyCounts.frameRejected++;
      else if (!documentMatches) page.replyCounts.documentRejected++;
    }
    if (page.closed || event.sender.isDestroyed() || !framesMatch || !documentMatches) return null;
    return page;
  };
  function finish(page, request, error, result) {
    if (!page.pending.delete(request.id)) return;
    page.lastCommand = { type: request.type, stage: request.stage, entered: request.entered, cancelled: request.cancelled,
      code: error && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : null };
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    request.ack();
    if (error) request.reject(error); else request.resolve(result);
  }
  function revokePendingSelection(workspace, page = null) {
    const intent = workspace.pendingReviewIntent;
    if (!intent || (page && intent.page !== page)) return;
    intent.cancelled = true;
    workspace.pendingReviewIntent = null;
  }
  function invalidate(page, reason, committed = false, preservePending = null) {
    if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'privacy', 'page-crashed', 'page-closed', 'access-runtime'].includes(reason))
      page.humanClose?.cancel();
    if (!['resize', 'viewport'].includes(reason) && page.workspace.pendingReviewIntent?.page === page &&
        page.workspace.pendingReviewIntent !== preservePending) revokePendingSelection(page.workspace, page);
    page.observation = observation();
    page.selection = null;
    // On-page notes belong to one document. An in-page route change keeps them;
    // their markers report themselves detached if the elements go away.
    if (page.annotation && ['navigation-start', 'navigation-commit', 'privacy', 'page-crashed', 'page-closed', 'access-runtime'].includes(reason)) dropAnnotation(page);
    // Live pointing also belongs to one document. The desktop process decides whether the next document gets it again.
    if (page.live && ['navigation-start', 'navigation-commit', 'privacy', 'page-crashed', 'page-closed'].includes(reason)) dropLivePointer(page);
    if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'privacy', 'page-crashed', 'page-closed'].includes(reason)) clearFind(page);
    if (page.workspace.reviewPage === page.id) {
      page.workspace.reviewPage = null;
      // review-cancelled arrives after the isolated picker removed itself or
      // acknowledged a stop. A late cancel-picker IPC could erase a new pick.
      if (reason !== 'review-cancelled' && page.nonce && !page.wc.isDestroyed()) page.wc.send('caddi-page:cancel-picker', { nonce: page.nonce });
    }
    if (committed) {
      for (const request of [...page.pending.values()]) finish(page, request, new CaddiError(reason, 'Page context changed'));
    }
    notify(page, reason);
  }
  function dropAnnotation(page) {
    const annotation = page.annotation;
    if (!annotation) return false;
    page.annotation = null;
    // Fire-and-forget: the isolated layer removes itself. Privacy and navigation
    // teardown never wait on a page that may already be gone.
    try { if (page.nonce && !page.wc.isDestroyed() && !page.rendererGone) page.wc.send('caddi-page:annotate-cancel', { nonce: page.nonce }); } catch {}
    return true;
  }
  function dropLivePointer(page) {
    if (!page.live) return false;
    page.live = null;
    try { if (page.nonce && !page.wc.isDestroyed() && !page.rendererGone) page.wc.send('caddi-page:live-cancel', { nonce: page.nonce }); } catch {}
    return true;
  }
  async function destroyRenderer(page, reason) {
    const wc = page.wc;
    if (wc.isDestroyed()) return;
    if (isPreviewPage(page)) fail('PREVIEW_NATIVE_CLOSE_REQUIRED');
    if (!page.destroyTask) {
      // Retain the owned WebContents and one actual destruction acknowledgment.
      // WebContentsView.webContents can become undefined during destruction.
      page.destroyTask = new Promise((resolveStop, rejectStop) => {
        const timer = setTimeout(() => rejectStop(new CaddiError('STOP_NOT_ACKNOWLEDGED', 'Page shutdown was not acknowledged')), 1200);
        wc.once('destroyed', () => { clearTimeout(timer); resolveStop(); });
        try { wc.close({ waitForBeforeUnload: false }); } catch (error) { clearTimeout(timer); rejectStop(error); }
      });
      page.destroyTask.catch(() => {});
    }
    await page.destroyTask;
    page.crashed = true;
    try { onNotice({ workspaceId: page.workspace.id, tabId: page.id, message: reason }); } catch {}
  }
  function stopSelection(page, selection, preservePending = null) {
    if (selection.stopTask) return selection.stopTask;
    selection.stopTask = (async () => {
      try {
        if (!page.nonce || page.wc.isDestroyed() || page.rendererGone) throw new CaddiError('PAGE_NOT_READY', 'Page selection is no longer available');
        await send(page, 'stop', {}, { timeoutMs: 1500 });
      } catch (error) {
        try {
          if (!page.wc.isDestroyed()) await destroyRenderer(page, 'Page selection stopped.');
        } catch (stopError) {
          // Keep the review hold if neither the stop nor destruction is known.
          try { onNotice({ workspaceId: page.workspace.id, tabId: page.id, message: 'Page selection could not be stopped.' }); } catch {}
          throw stopError;
        }
        if (page.selection === selection) invalidate(page, 'page-crashed', true);
        return { stopped: true };
      }
      if (page.selection === selection) invalidate(page, 'review-cancelled', false, preservePending);
      return { stopped: true };
    })();
    return selection.stopTask;
  }
  function cancelPending(page) {
    for (const request of page.pending.values()) request.cancelled = true;
  }
  function send(page, type, payload = {}, { signal, beforeDispatch, target, timeoutMs = 3000 } = {}) {
    const wc = page.wc;
    if (isPreviewPage(page)) return Promise.reject(new CaddiError('PREVIEW_ACCESS_DENIED', 'Preview page operations require its human owner'));
    if (closed || page.closed || page.rendererGone || page.destroyTask || wc.isDestroyed() || !page.nonce) return Promise.reject(new CaddiError('PAGE_NOT_READY', 'Page is still loading'));
    aborted(signal);
    if (target) assertCurrentTarget(target);
    const id = randomUUID(), nonce = page.nonce;
    let ack;
    const acknowledged = new Promise(resolveAck => { ack = resolveAck; });
    return new Promise((resolveRequest, rejectRequest) => {
      const request = { id, nonce, type, payload, signal, beforeDispatch, target, resolve: resolveRequest, reject: rejectRequest,
        ack, acknowledged, cancelled: false, entered: false, timer: null, abort: null, stage: 'queued' };
      request.abort = () => {
        request.cancelled = true;
        // Queued renderer commands still have to reach a negative final fence or
        // acknowledge cancellation. A privacy barrier never equates rejection to stop.
        if (!wc.isDestroyed()) wc.send('caddi-page:cancel', { id, nonce });
      };
      request.timer = setTimeout(() => {
        request.cancelled = true;
        request.stage = 'deadline-' + request.stage;
        void destroyRenderer(page, 'An unresponsive page was stopped. Reload it to continue.').catch(() => {});
      }, timeoutMs);
      page.pending.set(id, request);
      signal?.addEventListener('abort', request.abort, { once: true });
      if (signal?.aborted) request.abort();
      try { wc.send('caddi-page:command', { id, nonce, type, payload }); }
      catch (error) { finish(page, request, error); }
    });
  }
  function ensureObserver(workspace) {
    if (workspace.observer) {
      try { workspace.observer.assertCurrent(); return; } catch { workspace.observer = null; }
    }
    workspace.observer = privacy.registerObserver({
      workspaceIds: [workspace.id], connectionId: 'desktop-' + workspace.id,
      async stop() {
        const observer = workspace.observer; workspace.observer = null;
        revokePendingSelection(workspace);
        const stops = [...workspace.tabs.values()].filter(page => !page.closed && !isPreviewPage(page)).map(async page => {
          page.selection = null; workspace.reviewPage = null; cancelPending(page);
          if (page.wc.isDestroyed() || page.rendererGone) return;
          // This command follows older main-process commands on the renderer IPC
          // stream. Its receipt proves the picker is removed and older handlers ended.
          page.lastStop = { stage: 'scheduled', hasDocument: !!page.nonce, pendingCount: page.pending.size, code: null };
          try {
            await send(page, 'stop', {}, { timeoutMs: 1500 });
            page.lastStop.stage = 'acknowledged';
          } catch (error) {
            page.lastStop.code = /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'STOP_FAILED';
            if (!page.wc.isDestroyed() && !page.rendererGone) await destroyRenderer(page, 'Page capture stopped for private takeover.');
            page.lastStop.stage = 'renderer-stopped';
          }
          await Promise.all([...page.pending.values()].map(request => request.acknowledged));
          invalidate(page, 'privacy');
        });
        await Promise.all(stops);
        for (const page of workspace.tabs.values()) if (!page.closed && isPreviewPage(page)) invalidate(page, 'privacy');
        observer?.unregister();
        return { stopped: true };
      },
    });
  }
  function createWorkspaceRecord(raw, privateScope = false) {
    if (closed || engineClosing) fail('CLOSED');
    const input = cloneData(raw); assertKeys(input, ['workspaceId', 'identityId', 'requiredIsolation'], ['workspaceId', 'identityId']);
    assertId(input.workspaceId); assertId(input.identityId);
    if (input.requiredIsolation && input.requiredIsolation !== 'storage-partition') fail('UNSUPPORTED_CAPABILITY');
    if (workspaces.has(input.workspaceId)) {
      const current = workspaces.get(input.workspaceId);
      if (privateScope || current.privateScope) fail('PRIVATE_IDENTITY_PROTECTED');
      if (current.identityId !== input.identityId || !current.open) fail('IDENTITY_MISMATCH');
      return current;
    }
    if (privateLifetimes.hasSeen(input)) fail('PRIVATE_IDENTITY_REUSED');
    if (identities.has(input.identityId) || workspaces.size >= 128) fail('IDENTITY_MISMATCH');
    const profile = privateScope ? null : profilePaths?.forIdentity(input.identityId) ?? null;
    const ses = profile ? session.fromPartition(profile.partition) : session.fromPartition((privateScope ? 'caddi-private-' : 'caddi-development-') + randomUUID(), { cache: false });
    if (profile && (!ses.isPersistent() || ses.storagePath !== profile.path)) fail('UNSAFE_PROFILE_PATH');
    if (!profile && (ses.isPersistent() || ses.storagePath !== null)) fail('UNSAFE_PROFILE_PATH');
    const sessionBinding = wc => wc && owners.get(wc.id)?.workspace === workspace ? permissionBinding(wc.id) : null;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      // A mailto:, tel: or app link asks to open another app. Caddi never does; say so instead of doing nothing.
      if (permission === 'openExternal') {
        callback(false);
        const page = wc && owners.get(wc.id), scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(String(details?.externalURL ?? ''))?.[1]?.toLowerCase();
        if (page?.workspace === workspace && scheme) try { onNotice({ workspaceId: workspace.id, tabId: page.id, message: 'This link opens another app (' + scheme + ':). Caddi does not open other apps from web pages.' }); } catch {}
        return;
      }
      return !privateScope && sitePermissions ? sitePermissions.request(sessionBinding(wc), permission, callback, details) : callback(false);
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
      !privateScope && !!sitePermissions && sitePermissions.check(sessionBinding(wc), permission, requestingOrigin, details));
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    const downloadListener = (event, item, webContents) => {
      if (privateScope) { event.preventDefault(); return; }
      const page = webContents && owners.get(webContents.id);
      let origin;
      try { origin = item.getInitiatorOrigin(); } catch {}
      let authorized = !!page && !isPreviewPage(page) && page.wc === webContents && page.workspace === workspace && !page.closed &&
        !page.rendererGone && !page.wc.isDestroyed() && typeof onDownload === 'function';
      try { const u = new URL(origin); authorized &&= ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
      catch { authorized = false; }
      if (!authorized) { event.preventDefault(); return; }
      try { onDownload({ item, workspaceId: workspace.id, tabId: page.id }); }
      catch {
        event.preventDefault();
        try { onNotice({ workspaceId: workspace.id, tabId: page.id, message: 'Download could not start.' }); } catch {}
      }
    };
    ses.on('will-download', downloadListener);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const scheme = new URL(details.url).protocol;
      callback({ cancel: !['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:'].includes(scheme) });
    });
    const workspace = { id: input.workspaceId, identityId: input.identityId, session: ses, tabs: new Map(), open: true, quarantined: false,
      storageMode: profile ? 'persistent' : 'ephemeral', profilePath: profile?.path ?? null, privateScope, downloadListener,
      ownerWindow: privateScope ? null : windowOwnership.defaultFor('normal'), ownerRevision: 0, popupWindows: new Set(),
      observer: null, popupObserver: null, reviewPage: null, pendingReviewIntent: null };
    identities.set(input.identityId, input.workspaceId); workspaces.set(input.workspaceId, workspace);
    return workspace;
  }
  function createWorkspace(raw) {
    const workspace = createWorkspaceRecord(raw);
    return { workspaceId: workspace.id, identityId: workspace.identityId, simulated: false };
  }
  function createPrivateWorkspace(raw) {
    const input = cloneData(raw); assertKeys(input, ['workspaceId', 'identityId'], ['workspaceId', 'identityId']);
    privateLifetimes.assertFresh(input);
    const workspace = createWorkspaceRecord(input, true);
    return privateLifetimes.register(workspace);
  }
  function createTab(raw, { reservation = null } = {}) {
    return current(createNativePage(raw, { reservation }));
  }
  function createNativePage(raw, { reservation = null, purpose = 'tab', previewId = null, onAllocated = () => {} } = {}) {
    if (closed || engineClosing) fail('CLOSED');
    const input = cloneData(raw); assertKeys(input, ['workspaceId', 'tabId', 'url'], ['workspaceId', 'tabId']);
    assertId(input.workspaceId); assertId(input.tabId);
    const workspace = workspaces.get(input.workspaceId), url = pageURL(input.url ?? 'about:blank');
    if (!workspace?.open || workspace.quarantined || workspace.tabs.has(input.tabId) || workspace.tabs.size >= 64) fail('TARGET_NOT_FOUND');
    windowOwnership.assertOwner(workspace);
    if ([...workspaces.values()].reduce((count, item) => count + item.tabs.size, 0) >= 32) fail('PAGE_CAPACITY');
    const target = { workspaceId: input.workspaceId, tabId: input.tabId };
    const ownReservation = reservation === null ? residency.reserve([target]) : null;
    residency.assertReserved(reservation ?? ownReservation, target);
    let view;
    try { view = new WebContentsView({ webPreferences: {
      session: workspace.session, preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, devTools: false, navigateOnDragDrop: false,
      backgroundThrottling: false, spellcheck: false,
    } }); } catch (error) { ownReservation?.release(); throw error; }
    const page = { id: input.tabId, workspace, view, wc: view.webContents, contentsId: view.webContents.id,
      purpose, previewId, previewGeneration: 1, lifetimeId: 'page-' + randomUUID(), purposeGeneration: 1,
      mediaDocumentId: 'document-' + randomUUID(),
      url, title: '', generation: 1, observation: observation(), viewportRevision: 0,
      viewport: { width: 960, height: 680, scrollX: 0, scrollY: 0 }, nonce: null, pending: new Map(), selection: null, annotation: null, live: null, agentInput: false, closed: false, crashed: false, rendererGone: false, destroyTask: null, lastStop: null, lastCommand: null, lastSource: null,
      wrapperDifferenceSeen: false, lastReplySource: null, replyCounts: { arrivals: 0, frameRejected: 0, documentRejected: 0, unknownRequest: 0 }, find: null, zoomFactor: 1, muted: false, humanClose: null,
      humanTouched: false, everNonBlank: url !== 'about:blank', activation: 0, loadError: null, leave: null };
    workspace.tabs.set(page.id, page); owners.set(view.webContents.id, page);
    ownReservation?.release();
    onAllocated(page);
    workspace.ownerWindow.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 960, height: 680 }); view.setVisible(false);
    const wc = view.webContents, contentsId = wc.id;
    // Electron 45 provides native per-WebContents zoom, avoiding same-origin
    // propagation to a sibling tab or another workspace.
    wc.setZoomMode('isolated');
    wc.on('found-in-page', (_event, result) => {
      const search = page.find;
      if (!search || !findStatus(page) || result?.requestId !== search.requestId ||
          !Number.isSafeInteger(result.matches) || result.matches < 0 ||
          !Number.isSafeInteger(result.activeMatchOrdinal) || result.activeMatchOrdinal < 0 ||
          result.activeMatchOrdinal > result.matches || typeof result.finalUpdate !== 'boolean') return;
      search.matches = result.matches; search.activeMatchOrdinal = result.activeMatchOrdinal; search.finalUpdate = result.finalUpdate;
      if (result.finalUpdate) clearTimeout(search.timer);
      notify(page, 'find-result');
    });
    wc.on('audio-state-changed', () => notify(page, 'audio'));
    wc.on('zoom-changed', (event, direction) => {
      if (page.closed || page.rendererGone || wc.isDestroyed() || !['in', 'out'].includes(direction)) return;
      event.preventDefault();
      const before = wc.getZoomFactor();
      const factor = direction === 'in' ? zoomFactors.find(value => value > before + 0.0001) ?? 2 : [...zoomFactors].reverse().find(value => value < before - 0.0001) ?? 0.5;
      try { setZoom({ ...selector(page), factor }); } catch {}
    });
    wc.setWindowOpenHandler(details => {
      if (workspace.privateScope || isPreviewPage(page)) return { action: 'deny' };
      // A link the owner just clicked with target=_blank, Command or the middle button opens as an ordinary tab with
      // no opener, like a typed address. One click opens at most one tab; script without a fresh click stays a pop-up.
      if (onOpenTab && ['foreground-tab', 'background-tab'].includes(details?.disposition) && !details?.postBody && !page.agentInput &&
          page.activation && Date.now() - page.activation < 5000 && !privacy.getPrivacyState(workspace.id).blocked) {
        let destination = null;
        try { destination = pageURL(details.url); } catch {}
        if (destination && destination !== 'about:blank') {
          page.activation = 0;
          try { onOpenTab({ workspaceId: workspace.id, tabId: page.id, url: destination, background: details.disposition === 'background-tab' }); } catch {}
          return { action: 'deny' };
        }
      }
      const decision = popupGate.consume(popupBinding(wc.id), details?.url, { postBody: !!details?.postBody });
      if (!decision.allowed) {
        try { onPopupBlocked({ workspaceId: workspace.id, tabId: page.id, reason: decision.reason }); } catch {}
        return { action: 'deny' };
      }
      const binding = decision.binding;
      return { action: 'allow', outlivesOpener: false,
        overrideBrowserWindowOptions: { width: 720, height: 560, minWidth: 400, minHeight: 300,
          frame: true, show: false, title: 'Caddi pop-up · ' + popupOrigin(decision.destination),
          webPreferences: { session: workspace.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
            nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
            allowRunningInsecureContent: false, webviewTag: false, devTools: false, navigateOnDragDrop: false,
            spellcheck: false } },
        createWindow(options) {
          let child;
          try {
            if (!popupGate.isLive(binding)) fail('POPUP_OPENER_UNAVAILABLE');
            // Electron supplies its pre-created native WebContents here. Preserve
            // that one object for opener/POST behavior; no renderer feature or
            // presentation option is copied into the owned native window.
            if (!options?.webContents || options.webContents.isDestroyed()) fail('POPUP_OPENER_UNAVAILABLE');
            child = new BrowserWindow({ webContents: options.webContents, width: 720, height: 560, minWidth: 400, minHeight: 300,
              maxWidth: 1200, maxHeight: 900, center: true, show: false,
              frame: true, titleBarStyle: 'default', transparent: false, movable: true, resizable: true, closable: true,
              fullscreen: false, fullscreenable: false, kiosk: false, alwaysOnTop: false, modal: false,
              title: 'Caddi pop-up · ' + popupOrigin(decision.destination), backgroundColor: '#f7f9f7',
              webPreferences: { session: workspace.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
                nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
                allowRunningInsecureContent: false, webviewTag: false, devTools: false, navigateOnDragDrop: false,
                spellcheck: false, preload: undefined } });
            // Track the actual native lifetime, including a child whose opener
            // binding was invalidated before its native closed acknowledgment.
            workspace.popupWindows.add(child);
            child.once('closed', () => workspace.popupWindows.delete(child));
            popupGate.register(binding, child, decision.destination);
            if (!workspace.popupObserver) workspace.popupObserver = privacy.registerObserver({
              workspaceIds: [workspace.id], connectionId: 'popup-' + workspace.id,
              stop() { popupGate.invalidate({ workspaceId: workspace.id }); const observer = workspace.popupObserver;
                workspace.popupObserver = null; observer?.unregister(); return { stopped: true }; },
            });
            const childWC = child.webContents;
            childWC.setWindowOpenHandler(() => ({ action: 'deny' }));
            childWC.on('will-attach-webview', event => event.preventDefault());
            const keepSafe = (event, legacyURL) => {
              const destination = typeof legacyURL === 'string' ? legacyURL : event.url;
              if (!popupGate.isLive(binding) || !safePopupURL(destination)) { event.preventDefault();
                if (!child.isDestroyed()) child.destroy(); }
            };
            childWC.on('will-frame-navigate', keepSafe);
            childWC.on('will-navigate', keepSafe);
            childWC.on('will-redirect', keepSafe);
            childWC.on('did-navigate', (_event, nextURL) => {
              const origin = popupOrigin(nextURL);
              if (!origin || !popupGate.isLive(binding)) { if (!child.isDestroyed()) child.destroy(); return; }
              try { popupGate.updateChildOrigin(binding, child, nextURL); }
              catch { if (!child.isDestroyed()) child.destroy(); return; }
              child.setTitle('Caddi pop-up · ' + origin);
            });
            childWC.on('page-title-updated', event => { event.preventDefault();
              child.setTitle('Caddi pop-up · ' + (popupOrigin(childWC.getURL()) ?? popupOrigin(decision.destination))); });
            childWC.on('render-process-gone', () => { if (!child.isDestroyed()) child.destroy(); });
            childWC.once('did-finish-load', () => { if (popupGate.isLive(binding) && !child.isDestroyed()) child.show();
              else if (!child.isDestroyed()) child.destroy(); });
            if (decision.destination === 'about:blank') queueMicrotask(() => {
              if (popupGate.isLive(binding) && !child.isDestroyed()) child.show();
              else if (!child.isDestroyed()) child.destroy();
            });
            return childWC;
          } catch (error) {
            if (child && !child.isDestroyed()) child.destroy();
            throw error;
          }
        } };
    });
    const guardNavigation = (event, legacyURL) => {
      const destination = typeof legacyURL === 'string' ? legacyURL : event.url;
      try { pageURL(destination); } catch { event.preventDefault(); }
    };
    wc.on('will-navigate', guardNavigation); wc.on('will-redirect', guardNavigation);
    wc.on('will-frame-navigate', event => {
      try { pageURL(event.url); return; } catch {}
      event.preventDefault();
      if (!event.isMainFrame) return;
      // The document stays: give it back the nonce the cancelled start took, so find, reading and notes keep working.
      if (!page.nonce && page.startedFrom?.generation === page.generation - 1 && wc.getURL() === page.startedFrom.url) page.nonce = page.startedFrom.nonce;
      // A mailto:, tel: or app link would otherwise do nothing at all. Say why; no other app is opened.
      const scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(String(event.url ?? ''))?.[1]?.toLowerCase();
      if (scheme && !['javascript', 'data', 'blob', 'file', 'about', 'chrome', 'devtools', 'chrome-extension'].includes(scheme))
        try { onNotice({ workspaceId: workspace.id, tabId: page.id, message: 'This link opens another app (' + scheme + ':). Caddi does not open other apps from web pages.' }); } catch {}
      notify(page, 'navigation-cancelled');
    });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('context-menu', (_event, params) => pageContextMenu(page, params));
    wc.on('before-input-event', (event, input) => {
      // Agent input is sent synchronously below and arrives here inside that call. It is not the owner taking over.
      if (page.agentInput || input.type !== 'keyDown') return;
      page.humanTouched = true; page.activation = Date.now();
      if (input.key === 'Escape' && page.selection && page.workspace.reviewPage === page.id) {
        // Native keyboard input belongs to this owned WebContents, even when
        // Chromium has not delivered DOM keydown to the isolated preload.
        // Keep the review hold until stop is acknowledged or the renderer is
        // destroyed, so an immediate new pick cannot race the old cleanup.
        event.preventDefault();
        void stopSelection(page, page.selection).catch(() => {});
        return;
      }
      notify(page, 'human-input');
    });
    wc.on('before-mouse-event', (_event, input) => { if (!page.agentInput && ['mouseDown', 'mouseWheel'].includes(input.type)) { page.humanTouched = true; if (input.type === 'mouseDown') page.activation = Date.now(); notify(page, 'human-input'); } });
    wc.on('did-start-navigation', (_event, nextURL, isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (nextURL !== 'about:blank') page.everNonBlank = true;
      popupGate.invalidate({ workspaceId: workspace.id, tabId: page.id });
      if (!isInPlace) { sitePermissions?.invalidate({ workspaceId: workspace.id, tabId: page.id }); page.startedFrom = { nonce: page.nonce, generation: page.generation, url: wc.getURL() }; page.generation++; page.nonce = null; page.activation = 0; page.loadError = null; cancelPending(page); }
      invalidate(page, 'navigation-start');
    });
    wc.on('did-navigate', (_event, nextURL) => {
      sitePermissions?.documentEnded?.(mediaIdentity(page));
      page.mediaDocumentId = 'document-' + randomUUID();
      page.url = nextURL; page.viewportRevision++; invalidate(page, 'navigation-commit', true);
    });
    wc.on('did-navigate-in-page', (_event, nextURL, isMainFrame) => {
      if (!isMainFrame) return;
      sitePermissions?.invalidate({ workspaceId: workspace.id, tabId: page.id });
      popupGate.invalidate({ workspaceId: workspace.id, tabId: page.id });
      page.url = nextURL; page.generation++; invalidate(page, 'navigation-in-page', true);
    });
    for (const eventName of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) wc.on(eventName, () => notify(page, eventName));
    // Chromium's own error pages are not part of Electron, so a failed load would leave a blank page. Write a short
    // explanation into the failed document instead; ERR_ABORTED is a cancelled load, not a failure.
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || page.closed || wc.isDestroyed() || !Number.isSafeInteger(errorCode)) return;
      page.loadError = { code: errorCode, name: /^[A-Z_]{1,64}$/.test(errorDescription) ? errorDescription : 'ERR_FAILED', url: safeLabel(validatedURL), generation: page.generation };
      notify(page, 'load-failed'); showLoadError(page);
    });
    wc.on('dom-ready', () => { if (page.loadError?.generation === page.generation) showLoadError(page); });
    // A page that asks to stay (beforeunload) while the owner navigates it: ask in Caddi, then repeat the navigation.
    wc.on('will-prevent-unload', event => {
      if (page.humanClose || page.closed || wc.isDestroyed()) return;
      if (page.leave?.allowed && Date.now() < page.leave.until) { page.leave = null; event.preventDefault(); return; }
      const intent = page.leave?.intent ?? null;
      if (!onLeaveRequest || page.leave?.deciding) return;
      const generation = page.generation;
      page.leave = { deciding: true, intent };
      void Promise.resolve().then(() => onLeaveRequest({ workspaceId: workspace.id, tabId: page.id })).then(leave => {
        if (page.closed || wc.isDestroyed() || page.generation !== generation || leave !== true) { page.leave = null; return; }
        page.leave = { allowed: true, until: Date.now() + 10_000 };
        if (!intent) { try { onNotice({ workspaceId: workspace.id, tabId: page.id, message: 'You can leave this page now. Try the link again.' }); } catch {} return; }
        setTimeout(() => { if (!page.closed && !wc.isDestroyed()) { try { runHumanIntent(page, intent); } catch {} } }, 50);
      }, () => { page.leave = null; });
    });
    wc.on('render-process-gone', () => { sitePermissions?.invalidate({ workspaceId: workspace.id, tabId: page.id }); sitePermissions?.documentEnded?.(mediaIdentity(page)); page.mediaDocumentId = 'document-' + randomUUID(); popupGate.invalidate({ workspaceId: workspace.id, tabId: page.id }); page.crashed = true; page.rendererGone = true; page.nonce = null; invalidate(page, 'page-crashed', true); });
    wc.on('destroyed', () => {
      sitePermissions?.invalidate({ workspaceId: workspace.id, tabId: page.id });
      sitePermissions?.documentEnded?.(mediaIdentity(page), { closed: true });
      popupGate.invalidate({ workspaceId: workspace.id, tabId: page.id });
      page.nonce = null; clearFind(page); owners.delete(contentsId);
      for (const request of [...page.pending.values()]) finish(page, request, new CaddiError('PAGE_CLOSED', 'Page closed'));
      notify(page, 'page-closed');
    });
    void wc.loadURL(url).catch(() => notify(page, 'load-failed'));
    return page;
  }
  const handlers = {
    ready(event, raw) {
      const page = sourcePage(event, undefined, { channel: 'ready', requireNonce: false });
      if (!page || typeof raw?.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(raw.nonce)) return;
      page.nonce = raw.nonce; page.crashed = false; page.rendererGone = false;
      page.observation = observation(); notify(page, 'ready');
    },
    authorize(event, raw) {
      // Assign returnValue exactly once: its setter sends the synchronous IPC
      // response immediately. An initial default assignment would deny even a
      // subsequently-authorized request.
      let answer = { ok: false, code: 'AUTHORIZATION_REQUIRED' };
      try {
        const page = sourcePage(event, raw?.nonce), request = page?.pending.get(raw?.id);
        if (!request || request.nonce !== raw.nonce) fail('AUTHORIZATION_REQUIRED');
        denyPreviewTarget(page);
        request.stage = 'authorizing';
        if (request.cancelled) fail('CANCELLED');
        aborted(request.signal);
        if (request.target) assertCurrentTarget(request.target);
        if (OWNER_COMMANDS.has(request.type)) {
          // The owner's own fill works while agents are paused: no capture authority is involved, only the owner's fence.
          syncFence(request.beforeDispatch);
          aborted(request.signal);
        } else if (request.type !== 'stop') {
          if ((page.workspace.reviewPage || previews.hasWorkspace(page.workspace.id)) && request.type.startsWith('page:')) fail('HUMAN_REVIEW_ACTIVE');
          privacy.assertCapture(current(page));
          syncFence(request.beforeDispatch);
          aborted(request.signal);
          if (request.target) assertCurrentTarget(request.target);
          denyPreviewTarget(page);
          if ((page.workspace.reviewPage || previews.hasWorkspace(page.workspace.id)) && request.type.startsWith('page:')) fail('HUMAN_REVIEW_ACTIVE');
          privacy.assertCapture(current(page));
        }
        request.entered = true; request.stage = 'authorized'; if (request.type === 'stop' && page.lastStop) page.lastStop.stage = 'authorized'; answer = { ok: true };
      } catch (error) {
        const codes = new Set(['AUTHORIZATION_REQUIRED', 'CANCELLED', 'STALE_TARGET', 'PRIVACY_BLOCKED', 'HUMAN_REVIEW_ACTIVE',
          'ACCESS_DENIED', 'LEASE_INVALID', 'LEASE_EXPIRED', 'DEADLINE', 'ACCESS_RUNTIME_MISMATCH', 'TARGET_NOT_FOUND']);
        answer = { ok: false, code: codes.has(error.code) ? error.code : 'AUTHORIZATION_REQUIRED' };
      }
      event.returnValue = answer;
    },
    reply(event, raw) {
      const page = sourcePage(event, raw?.nonce, { channel: 'reply' }), request = page?.pending.get(raw?.id);
      if (!request) { if (page) page.replyCounts.unknownRequest++; return; }
      request.stage = 'replied';
      if (request.type === 'stop' && page.lastStop) page.lastStop.stage = 'reply-received';
      try {
        const data = cloneData(raw, { maxBytes: 262_144 });
        if (request.cancelled || request.signal?.aborted) fail('CANCELLED');
        if (!data.ok) fail(/^[A-Z][A-Z_]{0,50}$/.test(data.code) ? data.code : 'PAGE_OPERATION_FAILED');
        if (!request.entered) fail('AUTHORIZATION_REQUIRED');
        if (request.type !== 'stop' && !OWNER_COMMANDS.has(request.type)) privacy.assertCapture(current(page));
        finish(page, request, null, data.result);
      } catch (error) { finish(page, request, error); }
    },
    viewport(event, raw) {
      const page = sourcePage(event, raw?.nonce); if (!page) return;
      try {
        const value = cloneData(raw, { maxBytes: 1024 });
        for (const key of ['width', 'height', 'scrollX', 'scrollY']) assertInteger(value[key], key, { min: key.startsWith('scroll') ? -10000000 : 1, max: 10000000 });
        if (Object.keys(page.viewport).some(key => page.viewport[key] !== value[key])) {
          page.viewport = { width: value.width, height: value.height, scrollX: value.scrollX, scrollY: value.scrollY };
          page.viewportRevision++; invalidate(page, 'viewport');
        }
      } catch {}
    },
    selection(event, raw) {
      const page = sourcePage(event, raw?.nonce), selection = page?.selection;
      if (!selection || raw?.captureId !== selection.captureId) return;
      try {
        privacy.assertCapture(selection.target); assertCurrentTarget(selection.target);
        const value = cloneData(raw, { maxBytes: 8192 });
        assertKeys(value, ['nonce', 'captureId', 'kind', 'label', 'bounds', 'elementId', 'coverage'], ['nonce', 'captureId', 'kind', 'label', 'bounds', 'coverage']);
        if (!['element', 'region'].includes(value.kind) || !['main-frame', 'region-only'].includes(value.coverage)) fail('INVALID_SELECTION');
        const bounds = value.bounds; assertKeys(bounds, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
        for (const key of Object.keys(bounds)) if (!Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 16384) fail('INVALID_SELECTION');
        if (bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > page.viewport.width + 1 || bounds.y + bounds.height > page.viewport.height + 1) fail('INVALID_SELECTION');
        if (value.elementId !== undefined) assertId(value.elementId);
        const { origin } = getPageInfo(selector(page));
        page.selection = null; page.workspace.reviewPage = null;
        onSelection({ target: { ...selection.target, origin }, captureId: selection.captureId, kind: value.kind,
          label: safeLabel(value.label), bounds, ...(value.elementId ? { elementId: value.elementId } : {}),
          sourceContext: null, coverage: value.coverage });
      } catch { page.selection = null; page.workspace.reviewPage = null; }
    },
    annotateUpdate(event, raw) {
      const page = sourcePage(event, raw?.nonce), annotation = page?.annotation;
      if (!annotation || raw?.sessionId !== annotation.sessionId) return;
      // Every update is answered. A refused one is never dropped silently: the
      // note layer tells its owner and holds Copy and Send until one is accepted.
      const seq = Number.isSafeInteger(raw?.seq) ? raw.seq : 0;
      const answer = (ok, code = null) => {
        try {
          if (page.annotation === annotation && page.nonce === annotation.nonce && !page.wc.isDestroyed() && !page.rendererGone)
            page.wc.send('caddi-page:annotate-update-result', { nonce: page.nonce, sessionId: annotation.sessionId, seq, ok, code });
        } catch {}
      };
      try { privacy.assertCapture(current(page)); } catch { return; } // Private takeover removes the layer itself.
      try {
        const problem = notesUpdateProblem(raw?.notes);
        if (problem) { answer(false, problem); return; }
        const value = cloneData(raw, { maxBytes: ANNOTATE_LIMITS.updateBytes + 1024 });
        assertKeys(value, ['nonce', 'sessionId', 'seq', 'notes'], ['nonce', 'sessionId', 'notes']);
        onAnnotation({ type: 'update', workspaceId: page.workspace.id, tabId: page.id, sessionId: annotation.sessionId, notes: value.notes });
        answer(true);
      } catch { answer(false, 'INVALID_ANNOTATION'); }
    },
    annotateAction(event, raw) {
      const page = sourcePage(event, raw?.nonce), annotation = page?.annotation;
      if (!annotation || raw?.sessionId !== annotation.sessionId) return;
      try {
        const value = cloneData(raw, { maxBytes: 1024 });
        assertKeys(value, ['nonce', 'sessionId', 'action', 'value'], ['nonce', 'sessionId', 'action']);
        if (!['copy', 'send', 'detail', 'done', 'ended'].includes(value.action)) fail('INVALID_ANNOTATION');
        if (value.value !== null && value.value !== undefined && (typeof value.value !== 'string' || value.value.length > 64)) fail('INVALID_ANNOTATION');
        if (value.action === 'ended') page.annotation = null;
        onAnnotation({ type: value.action, workspaceId: page.workspace.id, tabId: page.id, sessionId: annotation.sessionId, value: value.value ?? null });
      } catch {}
    },
    livePointer(event, raw) {
      const page = sourcePage(event, raw?.nonce), live = page?.live;
      if (!live || raw?.sessionId !== live.sessionId) return;
      try {
        privacy.assertCapture(current(page));
        const value = cloneData(raw, { maxBytes: 16384 });
        assertKeys(value, ['nonce', 'sessionId', 'event'], ['nonce', 'sessionId', 'event']);
        onLivePointer({ workspaceId: page.workspace.id, tabId: page.id, sessionId: live.sessionId, event: value.event });
      } catch {}
    },
    /**
     * The page layer saw the owner submit a sign-in form. It sends the site, the username and the password, as other
     * browsers do, because the page is usually gone a moment later. The facts that decide whether to offer are the browser
     * process's own: whether the owner's last key press or click came before the submit (agent input is excluded from
     * that), and whether an agent touched this page lately. The password Buffer is wiped here if the report goes nowhere.
     */
    loginOffer(event, raw) {
      const page = sourcePage(event, raw?.nonce);
      if (!page || page.closed || page.workspace.privateScope || isPreviewPage(page)) return;
      let report = null;
      try {
        report = validOfferReport(raw);
        onLoginOffer({ workspaceId: page.workspace.id, tabId: page.id, pageOrigin: getPageInfo(selector(page)).origin,
          report, humanActivationAt: page.activation ?? 0, lastAgentActivityAt: page.lastAgentAt ?? 0,
          agentRequestActive: page.agentInput === true || [...page.pending.values()].some(request => AGENT_COMMANDS.has(request.type)) });
      } catch { report?.password.fill(0); }
    },
    selectionCancelled(event, raw) {
      const page = sourcePage(event, raw?.nonce), selection = page?.selection;
      if (!selection || raw?.captureId !== selection.captureId || raw?.reason !== 'escape') return;
      invalidate(page, 'review-cancelled');
    },
  };
  for (const [key, callback] of Object.entries(handlers)) ipcMain.on(channels[key], callback);

  async function execute(raw, { signal, beforeDispatch, checkCurrent, actor } = {}) {
    const request = validateEngineOperation(raw); aborted(signal);
    // A wait is bound to the tab, its runtime and the privacy epoch: it may follow a navigation to load.
    if (request.operation === 'page:wait') assertWaitTarget(request.target); else assertCurrentTarget(request.target);
    const page = resolve({ workspaceId: request.target.workspaceId, tabId: request.target.tabId, frameId: request.target.frameId });
    if (page.workspace.privateScope) fail('PRIVATE_AGENT_ACCESS_DENIED');
    if (page.workspace.reviewPage || previews.hasWorkspace(page.workspace.id)) fail('HUMAN_REVIEW_ACTIVE');
    ensureObserver(page.workspace);
    // An agent that acts on the tab takes it over: the owner's note layer steps aside.
    if (page.annotation && !READ_ONLY_OPERATIONS.has(request.operation) && dropAnnotation(page)) notify(page, 'annotation-ended');
    // When an agent last acted on this page: the owner's save offer waits until the page has been quiet a while.
    if (!READ_ONLY_OPERATIONS.has(request.operation)) page.lastAgentAt = Date.now();
    let result = {};
    if (request.operation === 'page:navigate') {
      syncFence(beforeDispatch); aborted(signal); assertCurrentTarget(request.target);
      if (page.workspace.reviewPage || previews.hasWorkspace(page.workspace.id)) fail('HUMAN_REVIEW_ACTIVE');
      // Browser-process navigation starts immediately after the final fence.
      await navigate(page, request.payload.url, signal);
    } else if (request.operation === 'page:wait') {
      result = await agentWait(page, request, { signal, beforeDispatch });
    } else if (request.operation === 'page:screenshot') {
      result = await agentScreenshot(page, request, { signal, beforeDispatch });
    } else if (request.operation === 'page:observe' || request.operation === 'page:scroll') {
      result = await send(page, request.operation, request.payload, { signal, beforeDispatch, target: request.target });
    } else if (request.operation === 'page:read' || request.operation === 'page:extract') {
      // The page layer stops its own walk after about a second and replies with a truncated flag.
      result = await send(page, request.operation, request.payload, { signal, beforeDispatch, target: request.target, timeoutMs: 4000 });
    } else if (request.operation === 'page:fill-login') {
      result = await loginFill(page, request.payload, { signal, beforeDispatch, target: request.target, by: 'agent' });
    } else {
      result = await agentAct(page, request, { signal, beforeDispatch, checkCurrent, actor });
    }
    aborted(signal); privacy.assertCapture(request.target);
    page.observation = observation();
    return Object.freeze({ ok: true, simulated: false, operation: request.operation, target: current(page),
      result: cloneData(result ?? {}, { maxBytes: request.operation === 'page:screenshot' ? 1_048_576 : 262_144 }) });
  }
  function assertWaitTarget(raw) {
    const target = assertEngineTarget(raw), actual = getTarget({ workspaceId: target.workspaceId, tabId: target.tabId, frameId: target.frameId });
    for (const key of ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'capturePrivacyEpoch']) if (target[key] !== actual[key]) fail('STALE_TARGET');
    return true;
  }
  /** Native input for an agent, sent synchronously so the page's input listeners can tell it from the owner's. */
  function dispatchInput(page, events) {
    if (page.wc.isDestroyed() || page.rendererGone || page.closed) fail('PAGE_CLOSED');
    page.agentInput = true; page.lastAgentAt = Date.now();
    try { for (const event of events) page.wc.sendInputEvent(event); }
    finally { page.agentInput = false; page.lastAgentAt = Date.now(); }
  }
  const pause = (ms, signal) => new Promise(resolveDelay => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolveDelay(); }
    signal?.addEventListener('abort', done, { once: true });
  });
  function typedEvents(text) {
    const events = [];
    for (const char of text) {
      if (char === ' ') { events.push({ type: 'keyDown', keyCode: 'Space' }, { type: 'char', keyCode: ' ' }, { type: 'keyUp', keyCode: 'Space' }); continue; }
      // Letters and digits get real key presses; other characters arrive as typed characters only.
      if (/^[A-Za-z0-9]$/.test(char)) events.push({ type: 'keyDown', keyCode: char }, { type: 'char', keyCode: char }, { type: 'keyUp', keyCode: char });
      else events.push({ type: 'char', keyCode: char });
    }
    return events;
  }
  /**
   * Agent page actions. The cursor moves first under the non-entering check, so the owner sees where the
   * agent is about to act; then the page layer validates and acts after the final fence. Real input is armed
   * there first and verified there after.
   */
  async function agentAct(page, request, { signal, beforeDispatch, checkCurrent, actor }) {
    const { operation, payload, target } = request, name = typeof actor?.name === 'string' && actor.name.trim() ? actor.name : 'Agent';
    if (CURSOR_FIRST.has(operation) && typeof checkCurrent === 'function') {
      const spec = operation === 'page:drag' ? (payload.fromElementId !== undefined ? { elementId: payload.fromElementId } : { x: payload.fromX, y: payload.fromY })
        : operation === 'page:key' || operation === 'page:type' ? (payload.elementId !== undefined ? { elementId: payload.elementId } : { focus: true })
          : operation === 'page:scroll-by' ? (payload.elementId !== undefined ? { elementId: payload.elementId, reach: 'known' } : null)
            : payload.elementId !== undefined ? { elementId: payload.elementId } : { x: payload.x, y: payload.y };
      if (spec) await send(page, 'agent:cursor', { ...spec, name }, { signal, beforeDispatch: checkCurrent, target, timeoutMs: 3000 });
    }
    const prepared = await send(page, operation, payload, { signal, beforeDispatch, target });
    if (!prepared?.inject) return prepared;
    const generation = page.generation, nonce = page.nonce, zoom = page.wc.getZoomFactor();
    const at = point => ({ x: Math.max(0, Math.round(point.x * zoom)), y: Math.max(0, Math.round(point.y * zoom)) });
    if (prepared.inject === 'click') {
      const point = at(prepared);
      dispatchInput(page, [{ type: 'mouseMove', ...point }, { type: 'mouseDown', ...point, button: 'left', clickCount: 1 }, { type: 'mouseUp', ...point, button: 'left', clickCount: 1 }]);
    } else if (prepared.inject === 'hover') {
      const point = at(prepared);
      dispatchInput(page, [{ type: 'mouseEnter', ...point }, { type: 'mouseMove', ...point }]);
    } else if (prepared.inject === 'key') {
      const { keyCode, modifiers, char } = keyChordEvents(payload.key);
      dispatchInput(page, [{ type: 'keyDown', keyCode, modifiers }, ...(char ? [{ type: 'char', keyCode: char, modifiers }] : []), { type: 'keyUp', keyCode, modifiers }]);
    } else if (prepared.inject === 'type') {
      dispatchInput(page, typedEvents(payload.text));
    } else if (prepared.inject === 'drag') {
      const from = at(prepared.from), to = at(prepared.to);
      dispatchInput(page, [{ type: 'mouseMove', ...from }, { type: 'mouseDown', ...from, button: 'left', clickCount: 1 }]);
      let last = from;
      try {
        // A short glide, so pointer-based drag code sees movement. The owner taking over stops it at once.
        for (let step = 1; step <= 8; step++) {
          await pause(30, signal);
          if (signal?.aborted || page.wc.isDestroyed()) break;
          last = { x: Math.round(from.x + (to.x - from.x) * step / 8), y: Math.round(from.y + (to.y - from.y) * step / 8) };
          dispatchInput(page, [{ type: 'mouseMove', ...last, button: 'left', modifiers: ['leftButtonDown'] }]);
        }
      } finally {
        if (!page.wc.isDestroyed() && !page.rendererGone) dispatchInput(page, [{ type: 'mouseUp', ...last, button: 'left', clickCount: 1 }]);
      }
      aborted(signal);
    } else fail('UNSUPPORTED_OPERATION');
    let verified;
    try { verified = await send(page, 'agent:verify', {}, { beforeDispatch: () => true, timeoutMs: 3000 }); }
    catch (error) {
      // A click that started a navigation took the page layer with it. The input was sent; say so plainly.
      if (page.generation !== generation || page.nonce !== nonce) return { performed: true, verified: false, navigated: true };
      throw error;
    }
    if (!verified?.armed) fail('INPUT_NOT_VERIFIED');
    if (verified.blocked) fail('INPUT_BLOCKED');
    if (!verified.delivered) fail('INPUT_NOT_DELIVERED');
    // Select all is an editing command, not a key the page receives from synthetic input on macOS.
    if (payload.key === 'Meta+A' && !verified.prevented && verified.editable && page.nonce === nonce) page.wc.selectAll();
    const { armed: _armed, kind: _kind, delivered: _delivered, blocked: _blocked, editable: _editable, ...rest } = verified;
    return { performed: true, verified: true, ...rest };
  }
  /** Read-only wait: polls the page layer for the condition, under the same per-check fence as observation. */
  async function agentWait(page, request, { signal, beforeDispatch }) {
    const { until, text, role, timeoutMs = 5000 } = request.payload, started = Date.now(), deadline = started + timeoutMs;
    const probe = { until, ...(text === undefined ? {} : { text }), ...(role === undefined ? {} : { role }) };
    let met = false, readyState = null;
    while (true) {
      aborted(signal);
      if (!page.wc.isDestroyed() && !page.rendererGone && page.nonce && !page.wc.isLoading()) {
        try {
          const value = await send(page, 'page:wait-probe', probe, { signal, beforeDispatch, timeoutMs: 3000 });
          readyState = typeof value?.readyState === 'string' ? value.readyState.slice(0, 16) : null;
          if (value?.met === true) { met = true; break; }
        } catch (error) {
          // A document that is being replaced is not an answer yet; anything about authority is.
          if (!['PAGE_NOT_READY', 'navigation-start', 'navigation-commit', 'navigation-in-page'].includes(error.code)) throw error;
        }
      }
      if (Date.now() >= deadline) break;
      await pause(Math.min(150, Math.max(1, deadline - Date.now())), signal);
    }
    aborted(signal);
    return { met, until, waitedMs: Date.now() - started, ...(readyState ? { readyState } : {}) };
  }
  const MASK_PIXEL = [0x90, 0x8a, 0x7f, 0xff]; // #7F8A90 as BGRA, the same opaque grey Annotate masks with.
  /**
   * A viewport picture for an agent. The page layer reports every sensitive element and embedded frame in
   * the viewport (the Annotate masking rules) before and after capture; they must match, and are painted over
   * in the bitmap before encoding. The agent cursor is hidden for the capture.
   */
  async function agentScreenshot(page, request, { signal, beforeDispatch }) {
    const format = request.payload.format ?? 'jpeg', target = request.target;
    const before = await send(page, 'agent:screen-regions', { hide: true }, { signal, beforeDispatch, target, timeoutMs: 3000 });
    let image, after = null;
    try {
      image = await capturePageImage(page, target);
    } finally {
      try { after = await send(page, 'agent:screen-regions', { hide: false }, { signal, beforeDispatch, target, timeoutMs: 3000 }); } catch {}
    }
    aborted(signal);
    const same = (a, b) => a.length === b.length && a.every((item, index) => ['x', 'y', 'width', 'height'].every(key => Math.abs(item[key] - b[index][key]) <= 1));
    if (!before?.complete || !after?.complete || before.viewport.width !== after.viewport.width || before.viewport.height !== after.viewport.height ||
        before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y || !same(before.regions, after.regions)) fail('CAPTURE_CHANGED');
    const factors = typeof image.getScaleFactors === 'function' ? image.getScaleFactors() : [1];
    const deviceScale = Math.max(1, ...factors.filter(Number.isFinite));
    // One plain bitmap at device pixels, scaled so the long edge is at most 1568.
    let flat = nativeImage.createFromBuffer(image.toPNG({ scaleFactor: deviceScale }));
    const size = flat.getSize();
    if (!size.width || !size.height) fail('CAPTURE_UNAVAILABLE');
    const shrink = Math.min(1, AGENT_SCREENSHOT_EDGE / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * shrink)), height = Math.max(1, Math.round(size.height * shrink));
    if (shrink < 1) flat = flat.resize({ width, height, quality: 'best' });
    const actual = flat.getSize(), bitmap = flat.toBitmap();
    if (bitmap.length !== actual.width * actual.height * 4) fail('CAPTURE_UNAVAILABLE');
    const scale = actual.width / before.viewport.width;
    for (const region of before.regions) {
      const left = Math.max(0, Math.floor(region.x * scale)), top = Math.max(0, Math.floor(region.y * scale));
      const right = Math.min(actual.width, Math.ceil((region.x + region.width) * scale)), bottom = Math.min(actual.height, Math.ceil((region.y + region.height) * scale));
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) bitmap.set(MASK_PIXEL, (y * actual.width + x) * 4);
    }
    const masked = nativeImage.createFromBitmap(bitmap, { width: actual.width, height: actual.height });
    bitmap.fill(0);
    let bytes = null;
    for (const quality of format === 'png' ? [null] : [80, 65, 50]) {
      bytes = quality === null ? masked.toPNG() : masked.toJPEG(quality);
      if (bytes.length <= AGENT_SCREENSHOT_BYTES) break;
    }
    if (bytes.length > AGENT_SCREENSHOT_BYTES) { bytes.fill(0); fail('CAPTURE_SIZE'); }
    // The page must still be the one that was pictured.
    assertCurrentTarget(target); privacy.assertCapture(target);
    const data = bytes.toString('base64'); bytes.fill(0);
    return { image: data, mimeType: format === 'png' ? 'image/png' : 'image/jpeg', width: actual.width, height: actual.height,
      scale: Math.round(scale * 10000) / 10000, viewport: { ...before.viewport }, scroll: { ...before.scroll }, masked: before.regions.length };
  }
  /**
   * A saved login into the page's sign-in form, by the page layer: the visible username field and the one visible
   * password field of the top document only. Main checks the page's origin first; the page layer checks it again.
   * The values cross only to that page's isolated preload, and the result says only which fields were filled.
   */
  async function loginFill(page, { origin, username, password }, { signal, beforeDispatch, target = null, by }) {
    if (page.workspace.privateScope) fail('PRIVATE_LOGIN_UNAVAILABLE');
    if (getPageInfo(selector(page)).origin !== origin) fail('LOGIN_SITE_MISMATCH');
    const message = { origin, username, password };
    try {
      const value = await send(page, by === 'owner' ? 'login:owner-fill' : 'login:fill', message, { signal, beforeDispatch, target, timeoutMs: 3000 });
      return { filled: { username: value?.filled?.username === true, password: value?.filled?.password === true } };
    } finally { message.password = null; message.username = null; }
  }
  /** The owner's toolbar fill. Only from the trusted chrome action, never from a page or an agent. */
  function ownerFillLogin(query, secret, { beforeDispatch } = {}) {
    const page = denyPreviewTarget(resolve(query)), generation = page.generation;
    if (typeof beforeDispatch !== 'function') fail('INVALID_ARGUMENT');
    return loginFill(page, secret, { by: 'owner', beforeDispatch: () => {
      if (page.generation !== generation || page.closed) fail('STALE_TARGET');
      return beforeDispatch();
    } });
  }
  /**
   * The owner's "Copy page as Markdown": the tab's main content, read by the same page-layer extractor agents use,
   * so form values, sensitive fields and hidden text never come along. Only from the trusted chrome action.
   * Refused in private windows and, like any page capture, while agents are paused.
   */
  async function ownerReadPage(query) {
    const page = denyPreviewTarget(resolve(query)), generation = page.generation;
    if (page.workspace.privateScope) fail('PRIVATE_CAPTURE_UNAVAILABLE');
    if (page.closed || page.crashed || page.rendererGone || page.wc.isDestroyed() || !page.nonce) fail('PAGE_NOT_READY');
    const value = await send(page, 'owner:read-page', { mode: 'main' }, { timeoutMs: 4000,
      beforeDispatch: () => { if (page.generation !== generation || page.closed) fail('STALE_TARGET'); return true; } });
    if (page.generation !== generation) fail('STALE_TARGET');
    const chunks = Array.isArray(value?.chunks) ? value.chunks.filter(item => typeof item === 'string') : [];
    if (!chunks.length) fail('PAGE_OPERATION_FAILED');
    return { markdown: chunks.join(''), totalChars: Number.isSafeInteger(value.totalChars) ? value.totalChars : 0, truncated: value.truncated === true };
  }
  /** Geometry of the agent cursor, for the trusted desktop process and its tests. */
  function agentCursorProbe(query) {
    const page = denyPreviewTarget(resolve(query));
    return send(page, 'agent:cursor-probe', {}, { beforeDispatch: () => true, timeoutMs: 3000 });
  }
  function dropAgentCursors(workspaceId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) return;
    for (const page of workspace.tabs.values()) {
      try { if (page.nonce && !page.wc.isDestroyed() && !page.rendererGone) page.wc.send('caddi-page:agent-cursor-cancel', { nonce: page.nonce }); } catch {}
    }
  }
  // When control ends for any reason (release, expiry, revoke, Pause agents, the owner taking over), the cursor goes.
  const stopLeaseWatch = privacy.onLeaseChange?.(event => { if (!event.active) dropAgentCursors(event.workspaceId); }) ?? (() => {});
  async function navigate(page, rawURL, signal) {
    const url = pageURL(rawURL), wc = page.wc;
    if (wc.isDestroyed()) fail('PAGE_CLOSED');
    const cancel = () => { if (!wc.isDestroyed()) wc.stop(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 15_000);
    try { await wc.loadURL(url); page.url = wc.getURL() || url; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    aborted(signal);
  }
  const loadErrorText = code => code <= -200 && code > -300 ? ['This site’s certificate is not trusted', 'Caddi does not open sites whose security certificate is invalid, expired or self-signed.'] :
    [-105, -137].includes(code) ? ['This site can’t be found', 'The address could not be found. Check it for typos, or check your connection.'] :
    [-106, -21].includes(code) ? ['You are offline', 'Check your internet connection, then try again.'] :
    [-102, -100, -101, -104, -109, -118, -7, -324].includes(code) ? ['This site can’t be reached', 'The server did not respond or refused the connection.'] :
    ['This page could not load', 'Something went wrong while loading this page.'];
  function showLoadError(page) {
    const error = page.loadError, wc = page.wc;
    if (!error || page.closed || wc.isDestroyed() || page.rendererGone) return;
    const [title, detail] = loadErrorText(error.code);
    let host = ''; try { host = new URL(error.url).host; } catch {}
    const content = JSON.stringify({ title, detail, host, name: error.name });
    // Runs only in Chromium's own error document for the failed address. Text is set with textContent, never as markup.
    void wc.executeJavaScript(`(() => { if (location.protocol !== 'chrome-error:' || document.getElementById('caddi-load-error')) return;
      const value = ${content}, main = document.createElement('main'); main.id = 'caddi-load-error';
      main.style.cssText = 'font:15px -apple-system,system-ui,sans-serif;max-width:520px;margin:96px auto;padding:0 24px;color:CanvasText';
      const h = document.createElement('h1'); h.textContent = value.title; h.style.cssText = 'font-size:22px;font-weight:600;margin:0 0 12px';
      const p = document.createElement('p'); p.textContent = value.detail; p.style.cssText = 'line-height:1.5;margin:0 0 8px';
      const small = document.createElement('p'); small.textContent = [value.host, value.name].filter(Boolean).join(' · '); small.style.cssText = 'opacity:.6;font-size:13px;margin:0 0 20px';
      const button = document.createElement('button'); button.textContent = 'Try again'; button.onclick = () => location.reload();
      button.style.cssText = 'font:inherit;padding:6px 14px;border-radius:6px';
      document.title = value.title; document.documentElement.style.colorScheme = 'light dark';
      main.append(h, p, small, button); (document.body ?? document.documentElement).replaceChildren(main); })()`, false).catch(() => {});
  }
  function runHumanIntent(page, intent) {
    const wc = page.wc, history = wc.navigationHistory;
    page.leave = { ...(page.leave ?? {}), intent };
    if (intent.kind === 'url') void wc.loadURL(intent.url).catch(() => {});
    else if (intent.kind === 'reload') wc.reload();
    else if (intent.kind === 'back' && history.canGoBack()) history.goBack();
    else if (intent.kind === 'forward' && history.canGoForward()) history.goForward();
    // A navigation the page did not veto clears the remembered intent at its start.
    setTimeout(() => { if (page.leave?.intent === intent && !page.leave.deciding) page.leave = null; }, 1000);
  }
  /** Owner navigation starts the load and returns; failures are shown in the page, and nothing stops a slow page. */
  function startHumanNavigation(page, rawURL) {
    const url = pageURL(rawURL);
    if (page.wc.isDestroyed()) fail('PAGE_CLOSED');
    page.humanTouched = true; runHumanIntent(page, { kind: 'url', url });
    return { started: true };
  }
  function setBounds({ workspaceId, tabId, bounds }) {
    return setPageBounds(denyPreviewTarget(resolve({ workspaceId, tabId })), bounds);
  }
  function setPageBounds(page, bounds) {
    assertKeys(bounds, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
    for (const key of Object.keys(bounds)) assertInteger(bounds[key], key, { min: key === 'width' || key === 'height' ? 1 : 0, max: 16384 });
    const prior = page.view.getBounds();
    page.view.setBounds(bounds);
    // Publish only after the view owns the new dimensions. A compositor may
    // synchronously relayout in onChange; it must observe the updated bounds.
    if (prior.width !== bounds.width || prior.height !== bounds.height) { page.viewportRevision++; invalidate(page, 'resize'); }
  }
  async function beginSelection({ workspaceId, tabId, mode = 'element', captureId = randomUUID() }) {
    if (!['element', 'region'].includes(mode)) fail('INVALID_ARGUMENT');
    assertId(captureId);
    const page = denyPreviewTarget(resolve({ workspaceId, tabId })), workspace = page.workspace;
    if (workspace.privateScope) fail('PRIVATE_CAPTURE_UNAVAILABLE');
    ensureObserver(workspace);
    // Publish the exact intent before the first await. Cancel, navigation,
    // privacy, transfer and a newer start can revoke it while the viewport
    // settles, without leaving a late picker or a false stop acknowledgment.
    revokePendingSelection(workspace);
    const intent = { page, cancelled: false, generation: page.generation, nonce: page.nonce,
      runtimeIncarnation, ownerWindow: workspace.ownerWindow,
      privacyEpoch: privacy.getPrivacyState(workspaceId).capturePrivacyEpoch };
    workspace.pendingReviewIntent = intent;
    const assertIntent = () => {
      if (workspace.pendingReviewIntent !== intent || intent.cancelled || closed || !workspace.open ||
          workspace.quarantined || page.closed || page.rendererGone || page.wc.isDestroyed() ||
          page.generation !== intent.generation || page.nonce !== intent.nonce ||
          runtimeIncarnation !== intent.runtimeIncarnation || workspace.ownerWindow !== intent.ownerWindow ||
          intent.ownerWindow.isDestroyed() || privacy.getPrivacyState(workspaceId).blocked ||
          privacy.getPrivacyState(workspaceId).capturePrivacyEpoch !== intent.privacyEpoch) fail('CANCELLED');
    };
    let selection = null;
    try {
      if (workspace.reviewPage) {
        const oldPage = workspace.tabs.get(workspace.reviewPage), oldSelection = oldPage?.selection;
        if (oldSelection) await stopSelection(oldPage, oldSelection, intent);
      }
      assertIntent();
      // A chrome panel can synchronously resize the native view while its
      // isolated preload reports the new CSS viewport on a short timer.
      const deadline = Date.now() + 750;
      let settledRevision = null, settledSince = 0;
      while (true) {
        assertIntent();
        const bounds = page.view.getBounds(), zoom = page.wc.getZoomFactor();
        if (page.view.getVisible() && Math.abs(page.viewport.width - bounds.width / zoom) <= 2 &&
            Math.abs(page.viewport.height - bounds.height / zoom) <= 2) {
          if (settledRevision !== page.viewportRevision) { settledRevision = page.viewportRevision; settledSince = Date.now(); }
          if (Date.now() - settledSince >= 96) break;
        } else { settledRevision = null; settledSince = 0; }
        if (Date.now() >= deadline) fail('PAGE_NOT_READY');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      assertIntent();
      const target = current(page); privacy.assertCapture(target);
      privacy.revoke({ workspaceId, reason: 'HUMAN_REVIEW_ACTIVE' });
      assertIntent();
      workspace.reviewPage = page.id;
      selection = { target, captureId };
      page.selection = selection;
      await send(page, 'pick', { mode, captureId }, { target, beforeDispatch: () => { assertIntent(); privacy.assertCapture(target); } });
      assertIntent();
      if (page.selection !== selection) fail('CANCELLED');
      return { captureId, target };
    } catch (error) {
      if (selection && page.selection === selection) await stopSelection(page, selection,
        workspace.pendingReviewIntent !== intent ? workspace.pendingReviewIntent : null);
      throw error;
    } finally {
      if (workspace.pendingReviewIntent === intent) workspace.pendingReviewIntent = null;
    }
  }
  async function beginAnnotation({ workspaceId, tabId, sessionId = randomUUID(), detail = 'standard', agents = [], restore = [] }) {
    assertId(sessionId);
    const page = denyPreviewTarget(resolve({ workspaceId, tabId })), workspace = page.workspace;
    if (workspace.privateScope) fail('PRIVATE_CAPTURE_UNAVAILABLE');
    if (workspace.reviewPage || workspace.pendingReviewIntent || previews.hasWorkspace(workspace.id)) fail('HUMAN_REVIEW_ACTIVE');
    if (!page.view.getVisible() || page.closed || page.crashed || page.rendererGone || page.wc.isDestroyed() || !page.nonce) fail('PAGE_NOT_READY');
    // Registers the workspace stop observer, so private takeover removes the layer
    // through the same acknowledged `stop` command as the element picker.
    ensureObserver(workspace);
    const target = current(page); privacy.assertCapture(target);
    dropAnnotation(page);
    const annotation = { sessionId, nonce: page.nonce };
    page.annotation = annotation;
    try {
      await send(page, 'annotate:start', { sessionId, detail, agents, restore }, { beforeDispatch: () => { if (page.annotation !== annotation) fail('CANCELLED'); privacy.assertCapture(current(page)); }, timeoutMs: 8000 });
      if (page.annotation !== annotation) fail('CANCELLED');
      return { sessionId, target: current(page) };
    } catch (error) {
      if (page.annotation === annotation) dropAnnotation(page);
      throw error;
    }
  }
  function endAnnotation(query) {
    let page;
    try { page = resolve(query); } catch { return { stopped: true }; }
    dropAnnotation(page);
    return { stopped: true };
  }
  /** Live mode: the isolated preload reports which element the pointer is on, and draws a quiet highlight. It takes no input. */
  async function beginLivePointer({ workspaceId, tabId, sessionId }) {
    assertId(sessionId);
    const page = denyPreviewTarget(resolve({ workspaceId, tabId })), workspace = page.workspace;
    if (workspace.privateScope) fail('PRIVATE_CAPTURE_UNAVAILABLE');
    if (page.closed || page.crashed || page.rendererGone || page.wc.isDestroyed() || !page.nonce) fail('PAGE_NOT_READY');
    // The workspace stop observer removes the layer on a private takeover, like the picker and Annotate.
    ensureObserver(workspace);
    privacy.assertCapture(current(page));
    const live = { sessionId, nonce: page.nonce };
    page.live = live;
    try {
      await send(page, 'live:start', { sessionId }, { beforeDispatch: () => { if (page.live !== live) fail('CANCELLED'); privacy.assertCapture(current(page)); }, timeoutMs: 8000 });
      if (page.live !== live) fail('CANCELLED');
      return { sessionId, target: current(page) };
    } catch (error) { if (page.live === live) dropLivePointer(page); throw error; }
  }
  function endLivePointer(query) {
    let page;
    try { page = resolve(query); } catch { return { stopped: true }; }
    dropLivePointer(page);
    return { stopped: true };
  }
  /** The agent's reply during Live: outline the element it means (by the page layer's own key) with its name. */
  function liveMark(query, { key, label }) {
    if (typeof key !== 'string' || !/^p[0-9a-z]{1,12}$/.test(key)) fail('INVALID_ARGUMENT');
    const page = denyPreviewTarget(resolve(query)), live = page.live;
    if (!live) fail('LIVE_INACTIVE');
    return send(page, 'live:mark', { key, label: String(label ?? '').slice(0, 48) }, { beforeDispatch: () => { if (page.live !== live) fail('CANCELLED'); privacy.assertCapture(current(page)); }, timeoutMs: 3000 });
  }
  /** Geometry of the live highlight, for the trusted desktop process and its tests. */
  function livePointerProbe(query) {
    const page = denyPreviewTarget(resolve(query));
    return send(page, 'live:probe', {}, { beforeDispatch: () => true, timeoutMs: 3000 });
  }
  /** Trusted-process requests to the live note layer: config, clear, capture, probe. */
  async function annotationCommand(query, type, payload = {}) {
    if (!['config', 'clear', 'capture', 'probe'].includes(type)) fail('INVALID_ARGUMENT');
    const page = denyPreviewTarget(resolve(query)), annotation = page.annotation;
    if (!annotation && type !== 'probe') fail('ANNOTATE_INACTIVE');
    return send(page, 'annotate:' + type, payload, { beforeDispatch: () => { if (page.annotation !== annotation) fail('CANCELLED'); }, timeoutMs: 8000 });
  }
  async function cancelSelection(query) {
    const page = denyPreviewTarget(resolve(query)), selection = page.selection;
    revokePendingSelection(page.workspace, page);
    return selection ? stopSelection(page, selection) : { stopped: true };
  }
  async function closeTab(query) {
    const page = resolve(query);
    if (isPreviewPage(page)) fail('PREVIEW_NATIVE_CLOSE_REQUIRED');
    if (page.workspace.privateScope) fail('PRIVATE_NATIVE_CLOSE_REQUIRED');
    page.humanClose?.cancel(); revokePendingSelection(page.workspace, page); sitePermissions?.invalidate({ workspaceId: page.workspace.id, tabId: page.id }); popupGate.invalidate({ workspaceId: page.workspace.id, tabId: page.id }); clearFind(page); page.closed = true; page.selection = null;
    if (page.workspace.reviewPage === page.id) page.workspace.reviewPage = null;
    try { page.workspace.ownerWindow.contentView.removeChildView(page.view); } catch {}
    await destroyRenderer(page, 'Page closed');
    page.workspace.tabs.delete(page.id);
  }
  function humanCloseTab(query, decide, systemCleanup = null) {
    const page = denyPreviewTarget(resolve(query, { allowClosed: true }));
    if (systemCleanup !== null) {
      const workspace = page.workspace;
      const fence = createSystemPageCloseFence({ ...systemCleanup, inspect: () => ({
        workspaceId: workspace.id, identityId: workspace.identityId, tabId: page.id, lifetimeId: page.lifetimeId,
        documentGeneration: page.generation, nonce: page.nonce, runtimeIncarnation, ownerWindow: workspace.ownerWindow,
        ownerRevision: workspace.ownerRevision, privacyEpoch: privacy.getPrivacyState(workspace.id).capturePrivacyEpoch,
        kind: workspace.privateScope ? 'private' : 'normal', destroyed: page.wc.isDestroyed(),
        present: workspaces.get(workspace.id) === workspace && workspace.open && !workspace.quarantined &&
          windowOwnership.isRegistered(workspace.ownerWindow, 'normal') && workspace.tabs.get(page.id) === page,
        replacement: workspace.tabs.has(page.id) && workspace.tabs.get(page.id) !== page,
      }) });
      if (page.humanClose) return Promise.resolve({ closed: false });
      return humanClosePage(page, decide, { systemClose: true, beforeClose: fence.assertCurrent }).then(result =>
        result.closed ? Object.freeze({ closed: true, assertClosed: fence.assertClosed }) : result);
    }
    return humanClosePage(page, decide);
  }
  async function humanEndMediaPage(binding, { expectedOwnerWindow, beforeClose, decideClose } = {}) {
    previewFence(beforeClose);
    const page = binding && owners.get(binding.webContentsId), workspace = page?.workspace;
    const captured = binding && mediaDocumentBinding(binding.webContentsId);
    const keys = ['workspaceId', 'identityId', 'tabId', 'webContentsId', 'nativeLifetimeId', 'mediaDocumentId',
      'runtimeIncarnation', 'ownerWindowId', 'ownerRevision', 'documentGeneration', 'nonce', 'privacyEpoch', 'url'];
    if (!page || !captured || workspace.privateScope || isPreviewPage(page) || expectedOwnerWindow !== workspace.ownerWindow ||
        keys.some(key => binding[key] !== captured[key]) || typeof decideClose !== 'function') fail('MEDIA_REVIEW_STALE');
    if (page.humanClose) fail('MEDIA_END_PENDING');
    const assertCurrent = () => {
      previewFence(beforeClose);
      const next = mediaDocumentBinding(binding.webContentsId);
      if (!next || workspace.ownerWindow !== expectedOwnerWindow || keys.some(key => captured[key] !== next[key])) fail('MEDIA_REVIEW_STALE');
      return true;
    };
    const result = await humanClosePage(page, decideClose, { mediaClose: true, beforeClose: assertCurrent });
    if (!result.closed) return { closed: false };
    // Also acknowledge partial allocation cleanup where the usual native event
    // listener was not installed. This never substitutes for isDestroyed().
    if (!page.wc.isDestroyed() || workspace.tabs.get(page.id) === page) fail('MEDIA_STOP_UNCONFIRMED');
    sitePermissions?.documentEnded?.(mediaIdentity(page), { closed: true });
    const assertClosed = () => {
      if (closed || workspaces.get(workspace.id) !== workspace || !workspace.open || workspace.quarantined ||
          workspace.identityId !== captured.identityId || workspace.ownerWindow !== expectedOwnerWindow ||
          workspace.ownerRevision !== captured.ownerRevision || !windowOwnership.isRegistered(expectedOwnerWindow, 'normal') ||
          runtimeIncarnation !== captured.runtimeIncarnation || privacy.getPrivacyState(workspace.id).capturePrivacyEpoch !== captured.privacyEpoch ||
          !page.wc.isDestroyed() || workspace.tabs.has(page.id)) fail('MEDIA_REVIEW_STALE');
      return true;
    };
    return Object.freeze({ closed: true, assertClosed });
  }
  function humanClosePage(page, decide, { previewClose = false, mediaClose = false, systemClose = false, beforeClose = null } = {}) {
    const wc = page.wc, workspace = page.workspace;
    if (previewClose) { if (!isPreviewPage(page)) fail('PREVIEW_RETIRED'); previewFence(beforeClose); }
    else denyPreviewTarget(page);
    if (mediaClose) { if (workspace.privateScope) fail('PRIVATE_IDENTITY_PROTECTED'); previewFence(beforeClose); }
    if (systemClose) { if (workspace.privateScope) fail('PRIVATE_IDENTITY_PROTECTED'); previewFence(beforeClose); }
    if (typeof decide !== 'function') fail('INVALID_ARGUMENT');
    if (wc.isDestroyed()) {
      // A renderer/window crash can leave a retained allocation after the native
      // destroyed event. Reap only that acknowledged object; never force a close.
      page.closed = true; page.selection = null; clearFind(page); revokePendingSelection(workspace, page);
      if (workspace.reviewPage === page.id) workspace.reviewPage = null;
      sitePermissions?.invalidate({ workspaceId: workspace.id, tabId: page.id });
      sitePermissions?.documentEnded?.(mediaIdentity(page), { closed: true });
      popupGate.invalidate({ workspaceId: workspace.id, tabId: page.id });
      try { workspace.ownerWindow.contentView.removeChildView(page.view); } catch {}
      owners.delete(page.contentsId); workspace.tabs.delete(page.id); return Promise.resolve({ closed: true });
    }
    if (page.humanClose) return page.humanClose.task;
    // An existing pending destruction is not an acknowledged close. Callers may
    // retry after it settles; never issue a forceful replacement.
    if (page.closed || page.destroyTask) return Promise.resolve({ closed: false });
    windowOwnership.assertOwner(workspace);
    const binding = { workspaceId: workspace.id, tabId: page.id, runtimeIncarnation,
      documentGeneration: page.generation, nonce: page.nonce, ownerWindow: workspace.ownerWindow,
      ownerRevision: workspace.ownerRevision, purpose: page.purpose,
      ownerWindowKind: workspace.privateScope ? 'private' : 'normal',
      privacyEpoch: privacy.getPrivacyState(workspace.id).capturePrivacyEpoch };
    let settle, allowed = false, settled = false, retryTimer = null;
    const task = new Promise(resolve => { settle = resolve; });
    const sameContext = () => {
      try {
        if (previewClose || mediaClose || systemClose) previewFence(beforeClose);
        return !settled && !closed && !page.closed && !wc.isDestroyed() &&
          workspaces.get(workspace.id) === workspace && workspace.open && !workspace.quarantined && workspace.tabs.get(page.id) === page &&
          workspace.ownerWindow === binding.ownerWindow && workspace.ownerRevision === binding.ownerRevision &&
          windowOwnership.isRegistered(binding.ownerWindow, binding.ownerWindowKind) && page.purpose === binding.purpose &&
          page.generation === binding.documentGeneration && page.nonce === binding.nonce && runtimeIncarnation === binding.runtimeIncarnation &&
          privacy.getPrivacyState(workspace.id).capturePrivacyEpoch === binding.privacyEpoch &&
          (workspace.privateScope || (previewClose && isPreviewPage(page)) || mediaClose || systemClose || !privacy.getPrivacyState(workspace.id).blocked);
      } catch { return false; }
    };
    // A crashed renderer can leave its WebContents alive. A native close request
    // is still safe; any later unload approval requires the same live document.
    const same = () => sameContext() && !page.crashed && !page.rendererGone;
    const finish = closedPage => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(retryTimer); wc.removeListener('will-prevent-unload', onPrevent);
      wc.removeListener('destroyed', onDestroyed);
      if (page.humanClose === intent) page.humanClose = null;
      if (closedPage) {
        page.closed = true; page.selection = null; clearFind(page);
        revokePendingSelection(workspace, page);
        if (workspace.reviewPage === page.id) workspace.reviewPage = null;
        sitePermissions?.invalidate({ workspaceId: workspace.id, tabId: page.id });
        sitePermissions?.documentEnded?.(mediaIdentity(page), { closed: true });
        popupGate.invalidate({ workspaceId: workspace.id, tabId: page.id });
        try { binding.ownerWindow.contentView.removeChildView(page.view); } catch {}
        owners.delete(page.contentsId); workspace.tabs.delete(page.id);
      }
      settle({ closed: closedPage });
    };
    const onDestroyed = () => finish(true);
    const onPrevent = event => {
      if (!same()) { finish(false); return; }
      if (allowed) { event.preventDefault(); return; }
      if (intent.deciding) return;
      intent.deciding = true;
      void Promise.resolve().then(() => decide({ ...binding, ownerWindowId: binding.ownerWindow.id })).then(leave => {
        if (!same()) { finish(false); return; }
        if (leave !== true) { finish(false); return; }
        allowed = true;
        // Chromium may still be unwinding the first rejected close. A fresh
        // native request on the next task preserves beforeunload semantics.
        retryTimer = setTimeout(() => {
          if (!same()) { finish(false); return; }
          try { wc.close({ waitForBeforeUnload: true }); } catch { finish(false); }
        }, 50);
      }, () => finish(false));
    };
    const intent = { task, deciding: false, cancel: () => finish(false) };
    const timer = setTimeout(() => finish(false), 120_000);
    page.humanClose = intent;
    wc.on('will-prevent-unload', onPrevent); wc.once('destroyed', onDestroyed);
    if (!sameContext()) { finish(false); return task; }
    try { wc.close({ waitForBeforeUnload: true }); } catch { finish(false); }
    return task;
  }
  function cancelHumanClose({ workspaceId = null, tabId = null } = {}) {
    for (const workspace of workspaces.values()) {
      if (workspaceId && workspace.id !== workspaceId) continue;
      for (const page of workspace.tabs.values()) if (!tabId || page.id === tabId) page.humanClose?.cancel();
    }
  }
  function workspaceActivity(workspaceId) {
    const workspace = workspaces.get(assertId(workspaceId));
    if (!workspace?.open || closed) fail('WORKSPACE_NOT_FOUND');
    return { workspaceId, pages: [...workspace.tabs.values()].filter(page => !page.closed).map(page => {
      const alive = !page.wc.isDestroyed() && !page.crashed && !page.rendererGone && !page.destroyTask;
      const ready = !!alive && !!page.nonce && !page.wc.isLoading();
      return { tabId: page.id, ready, humanTouched: page.humanTouched,
        cleanBlank: !isPreviewPage(page) && ready && !page.everNonBlank && page.url === 'about:blank' && page.wc.getURL() === 'about:blank',
        busy: isPreviewPage(page) || !alive || page.pending.size > 0 || !!page.selection || !!page.humanClose || (alive && page.wc.isCurrentlyAudible()),
        ...(isPreviewPage(page) ? { preview: true } : {}),
        visible: alive ? page.view.getVisible() : true };
    }) };
  }
  function workspaceAllocations(workspaceId) {
    const workspace = workspaces.get(assertId(workspaceId));
    if (!workspace?.open || closed) fail('WORKSPACE_NOT_FOUND');
    return { workspaceId, pages: [...workspace.tabs.values()].map(page => ({ tabId: page.id,
      destroyed: page.wc.isDestroyed(), closing: !!page.closed || !!page.destroyTask || !!page.humanClose })) };
  }
  async function releaseWorkspacePages({ workspaceId, beforeRelease }) {
    assertId(workspaceId); syncFence(beforeRelease);
    if (previews.hasWorkspace(workspaceId)) return { pages: 'retained', reason: 'PREVIEW_ACTIVE' };
    const safe = () => workspaceActivity(workspaceId).pages.every(page => page.cleanBlank && !page.humanTouched && !page.busy && !page.visible);
    if (!safe()) return { pages: 'retained', reason: 'OWNER_REVIEW_REQUIRED' };
    const workspace = workspaces.get(workspaceId);
    for (const page of [...workspace.tabs.values()]) {
      syncFence(beforeRelease);
      if (!safe()) return { pages: 'retained', reason: 'OWNER_REVIEW_REQUIRED' };
      // Do not override a renderer's beforeunload veto, even on a blank page.
      let timer;
      const task = humanCloseTab(selector(page), () => false);
      timer = setTimeout(() => page.humanClose?.cancel(), 1000);
      const result = await task.finally(() => clearTimeout(timer));
      if (!result.closed) return { pages: 'retained', reason: 'OWNER_REVIEW_REQUIRED' };
    }
    // Keep the Session/profile and its storage intact. closeWorkspace is deliberately
    // not used: that teardown clears ephemeral sessions and is destructive.
    return { pages: 'released' };
  }
  async function closeWorkspace(workspaceId) {
    const workspace = workspaces.get(workspaceId); if (!workspace) return;
    if (workspace.privateScope) fail('PRIVATE_DISPOSAL_REQUIRED');
    if (previews.hasWorkspace(workspaceId)) fail('PREVIEW_NATIVE_CLOSE_REQUIRED');
    popupGate.invalidate({ workspaceId }); workspace.popupObserver?.unregister(); workspace.popupObserver = null;
    await Promise.all([...workspace.tabs.values()].map(page => closeTab(selector(page))));
    workspace.observer?.unregister(); workspace.observer = null; workspace.open = false;
    if (workspace.storageMode === 'persistent') {
      workspace.session.flushStorageData();
      await workspace.session.cookies.flushStore();
    } else {
      await clearEphemeralSession(workspace.session);
    }
  }
  async function clearEphemeralSession(ses) {
    if (ses.isPersistent() || ses.storagePath !== null) fail('PRIVATE_IDENTITY_MISMATCH');
    // Stop new traffic before clearing the exact, newly owned memory Session.
    // No profile paths or filesystem deletion are accepted by this boundary.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    await ses.closeAllConnections();
    await ses.clearData();
    await ses.clearStorageData();
    await ses.clearAuthCache();
    await ses.clearCache();
  }
  function registerWindow(nextWindow, options = {}) {
    if (closed || engineClosing) fail('WINDOW_UNAVAILABLE');
    return windowOwnership.register(nextWindow, options);
  }
  function transferWorkspace(workspaceId, nextWindow) {
    const workspace = workspaces.get(assertId(workspaceId));
    if (closed || engineClosing || !workspace?.open || workspace.quarantined) fail('WINDOW_UNAVAILABLE');
    const previousWindow = windowOwnership.assertTransfer(workspace, nextWindow);
    if (previousWindow === nextWindow) return { moved: false };
    if (previews.hasWorkspace(workspaceId)) fail('PREVIEW_BUSY');
    const revision = workspace.ownerRevision;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) fail('WORKSPACE_OWNER_CHANGED');
    for (const page of workspace.tabs.values()) page.humanClose?.cancel();
    revokePendingSelection(workspace);
    sitePermissions?.invalidate({ workspaceId });
    popupGate.invalidate({ workspaceId });
    privacy.revoke({ workspaceId, reason: 'WINDOW_TRANSFER' });
    if (workspaces.get(workspaceId) !== workspace || workspace.ownerWindow !== previousWindow || workspace.ownerRevision !== revision)
      fail('WORKSPACE_OWNER_CHANGED');
    const moved = [];
    try {
      for (const page of workspace.tabs.values()) {
        if (page.closed) continue;
        if (page.wc.isDestroyed()) {
          try { page.view.setVisible(false); } catch {}
          try { previousWindow.contentView.removeChildView(page.view); } catch {}
          continue;
        }
        clearFind(page);
        const visible = page.view.getVisible();
        page.view.setVisible(false);
        try { previousWindow.contentView.removeChildView(page.view); }
        catch (error) { page.view.setVisible(visible); throw error; }
        try { nextWindow.contentView.addChildView(page.view); moved.push({ page, visible }); }
        catch (error) {
          try { previousWindow.contentView.addChildView(page.view); page.view.setVisible(visible); }
          catch { workspace.quarantined = true; }
          throw error;
        }
      }
    } catch (error) {
      for (const { page, visible } of moved.reverse()) {
        try { nextWindow.contentView.removeChildView(page.view); previousWindow.contentView.addChildView(page.view); page.view.setVisible(visible); }
        catch { workspace.quarantined = true; }
      }
      fail('WINDOW_TRANSFER_FAILED');
    }
    workspace.ownerRevision = revision + 1; workspace.ownerWindow = nextWindow;
    for (const { page } of moved) {
      page.viewportRevision++;
      invalidate(page, 'window-transfer', true);
    }
    return { moved: true };
  }
  function unregisterWindow(oldWindow) {
    windowOwnership.unregister(oldWindow);
  }
  function parkWorkspace(input) {
    if (closed || engineClosing) fail('WINDOW_UNAVAILABLE');
    if (previews.hasWorkspace(input.workspaceId)) fail('PREVIEW_BUSY');
    return windowOwnership.park(input);
  }
  async function clearWorkspaceSiteData(workspaceId) {
    const workspace = workspaces.get(assertId(workspaceId));
    if (!workspace?.open || closed) fail('WORKSPACE_NOT_FOUND');
    if (workspace.privateScope) fail('PRIVATE_DISPOSAL_REQUIRED');
    if (previews.hasWorkspace(workspaceId)) fail('PREVIEW_NATIVE_CLOSE_REQUIRED');
    workspace.quarantined = true;
    try {
      await Promise.all([...workspace.tabs.values()].map(page => closeTab(selector(page))));
      await workspace.session.closeAllConnections();
      await workspace.session.clearData();
      await workspace.session.clearStorageData();
      await workspace.session.clearCache();
      await workspace.session.clearAuthCache();
      workspace.session.flushStorageData();
      await workspace.session.cookies.flushStore();
      workspace.quarantined = false;
      return true;
    } catch (error) { throw new CaddiError('SITE_DATA_CLEAR_FAILED', 'Workspace site data remains unavailable until clearing succeeds', { cause: error }); }
  }
  async function close() {
    if (closed) return;
    if (previews.count()) fail('PREVIEW_PAGES_OPEN');
    // Refuse before touching ordinary pages or reservations. The host must first
    // complete each private page's native human-close flow, including any veto.
    if ([...workspaces.values()].some(workspace => workspace.privateScope && workspace.tabs.size)) fail('PRIVATE_PAGES_OPEN');
    engineClosing = true;
    storageMeter.close();
    try {
      await Promise.all(privateLifetimes.bindings().map(binding => privateLifetimes.dispose({ ...binding, beforeDispose: () => true })));
      residency.close(); popupGate.close();
      await Promise.all([...workspaces.keys()].map(closeWorkspace)); closed = true;
      stopLeaseWatch();
      for (const [key, callback] of Object.entries(handlers)) ipcMain.off(channels[key], callback);
    } finally { if (!closed) engineClosing = false; }
  }
  return Object.freeze({
    capabilities, createWorkspace, createTab, getTarget, getPageInfo, assertCurrentTarget, capturePageScreenshot, execute, navigation, find, stopFind, setZoom, setMuted,
    createPrivateWorkspace, disposePrivateWorkspace: input => privateLifetimes.dispose(input),
    createPreviewPage, previewSnapshot: previews.snapshot, assertPreviewCurrent: previews.assertCurrent,
    preparePreviewPromotion: previews.prepare, promotePreviewPage: previews.promote, cancelPreviewPromotion: previews.cancelPreparation,
    humanClosePreview: previews.close, previewView: binding => previews.page(binding).view, setPreviewPresentation,
    get runtimeIncarnation() { return runtimeIncarnation; }, workspaceActivity, workspaceAllocations, releaseWorkspacePages,
    reservePages: targets => residency.reserve(targets), pageResidency: () => residency.snapshot(),
    markHumanTouched(query) { denyPreviewTarget(resolve(query)).humanTouched = true; },
    lifecycleDiagnostics() {
      return [...workspaces.values()].flatMap(workspace => [...workspace.tabs.values()].map(page => ({
        workspaceId: workspace.id, tabId: page.id, destroyed: page.wc.isDestroyed(), rendererGone: page.rendererGone,
        pending: [...page.pending.values()].map(request => ({ type: request.type, stage: request.stage, entered: request.entered, cancelled: request.cancelled })),
        lastCommand: page.lastCommand ? { ...page.lastCommand } : null, lastSource: page.lastSource ? { ...page.lastSource } : null,
        wrapperDifferenceSeen: page.wrapperDifferenceSeen, lastReplySource: page.lastReplySource ? { ...page.lastReplySource } : null,
        replyCounts: { ...page.replyCounts },
        lastStop: page.lastStop ? { ...page.lastStop } : null,
      })));
    },
    listTargets(workspaceId) {
      const workspace = workspaces.get(workspaceId); if (!workspace?.open) fail('TARGET_NOT_FOUND');
      return [...workspace.tabs.values()].filter(page => !isPreviewPage(page) && !page.closed && !page.crashed && !page.wc.isDestroyed()).map(current);
    },
    getView: query => denyPreviewTarget(resolve(query)).view, getOwnerWindow: query => denyPreviewTarget(resolve(query)).workspace.ownerWindow,
    getWorkspaceOwnerWindow(workspaceId) { return workspaces.get(assertId(workspaceId))?.ownerWindow ?? null; },
    registerWindow, transferWorkspace, unregisterWindow, parkWorkspace, permissionBinding, mediaDocumentBinding, humanEndMediaPage, setBounds,
    humanStorageUsage: storageBoundary.humanStorageUsage,
    allowPopupOnce({ workspaceId, tabId, ownerWindowId }) {
      const page = requireHumanPage({ workspaceId, tabId });
      if (page.workspace.privateScope) fail('PRIVATE_POPUP_UNAVAILABLE');
      privacy.revoke({ workspaceId, reason: 'HUMAN_POPUP_PERMISSION' });
      invalidate(page, 'popup-grant');
      const binding = popupBinding(page.wc.id);
      if (!binding || binding.ownerWindowId !== ownerWindowId) fail('POPUP_OPENER_UNAVAILABLE');
      return popupGate.grant(binding);
    },
    cancelPopupGrant({ workspaceId, tabId, ownerWindowId }) { return popupGate.cancel({ workspaceId, tabId, ownerWindowId }); },
    closePopup({ workspaceId, popupId, ownerWindowId }) { return popupGate.closeChild({ workspaceId, popupId, ownerWindowId }); },
    popupState(workspaceId, ownerWindowId) { return popupGate.list(workspaceId, ownerWindowId); },
    invalidatePopups(criteria) { popupGate.invalidate(criteria); },
    setVisible({ workspaceId, tabId, visible }) { if (typeof visible !== 'boolean') fail('INVALID_ARGUMENT'); denyPreviewTarget(resolve({ workspaceId, tabId })).view.setVisible(visible); },
    humanNavigate({ workspaceId, tabId, url }) { const page = denyPreviewTarget(resolve({ workspaceId, tabId })); page.humanTouched = true; return navigate(page, url); },
    startHumanNavigation({ workspaceId, tabId, url }) { return startHumanNavigation(denyPreviewTarget(resolve({ workspaceId, tabId })), url); },
    back(query) { const page = denyPreviewTarget(resolve(query)); page.humanTouched = true; runHumanIntent(page, { kind: 'back' }); },
    forward(query) { const page = denyPreviewTarget(resolve(query)); page.humanTouched = true; runHumanIntent(page, { kind: 'forward' }); },
    reload(query) { const page = denyPreviewTarget(resolve(query)); page.humanTouched = true; runHumanIntent(page, { kind: 'reload' }); },
    stop(query) { const page = denyPreviewTarget(resolve(query)); if (!page.wc.isDestroyed()) page.wc.stop(); },
    beginSelection, cancelSelection, beginAnnotation, endAnnotation, annotationCommand, beginLivePointer, endLivePointer, livePointerProbe, liveMark, agentCursorProbe, ownerFillLogin, ownerReadPage, closeTab, humanCloseTab, cancelHumanClose, closeWorkspace, clearWorkspaceSiteData, close,
    bindAccessRuntime(incarnation) {
      assertId(incarnation);
      if (accessIncarnation !== incarnation) {
        accessIncarnation = incarnation; runtimeIncarnation = 'electron-' + randomUUID();
        for (const workspace of workspaces.values()) {
          sitePermissions?.invalidate({ workspaceId: workspace.id });
          for (const page of workspace.tabs.values()) invalidate(page, 'access-runtime');
        }
      }
      return runtimeIncarnation;
    },
    assertAccessRuntime(incarnation) { if (incarnation !== accessIncarnation) fail('ACCESS_RUNTIME_MISMATCH'); return true; },
  });
}
