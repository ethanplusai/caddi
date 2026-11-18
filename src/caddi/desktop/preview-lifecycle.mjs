import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertKeys, cloneData } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Live preview is unavailable'); };
const sync = callback => {
  if (typeof callback !== 'function') fail('AUTHORIZATION_REQUIRED');
  const value = callback();
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('AUTHORIZATION_REQUIRED');
};
const sameTarget = (left, right) => Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every(key => left[key] === right[key]);
const safeReason = error => typeof error?.code === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(error.code) ? error.code : 'PREVIEW_STALE';

/** Main-process capabilities for one transient native page per ordinary owner.
 * No durable metadata, agent authority, filesystem, or browser evaluation lives here.
 * Native callbacks receive the exact retained page object, never a caller target.
 */
export function createPreviewLifecycles({ workspaceFor, isNormalOwner, getRuntimeIncarnation, getPrivacyState,
  allocatePage, navigationFor, targetFor, isPageReady, closePage, publishPage, onChange = () => {} } = {}) {
  for (const callback of [workspaceFor, isNormalOwner, getRuntimeIncarnation, getPrivacyState, allocatePage,
    navigationFor, targetFor, isPageReady, closePage, publishPage, onChange]) if (typeof callback !== 'function') fail('INVALID_ARGUMENT');
  const records = new WeakMap(), tickets = new WeakMap(), byOwner = new Map();
  function notify(record) {
    try { onChange({ previewId: record.previewId, workspaceId: record.workspaceId, tabId: record.tabId,
      generation: record.generation, phase: record.phase }); } catch {}
  }
  function transition(record, phase, { emit = true } = {}) {
    if (!Number.isSafeInteger(record.generation) || record.generation >= Number.MAX_SAFE_INTEGER) fail('PREVIEW_STALE');
    record.generation++; record.phase = phase;
    if (emit) notify(record);
  }
  function recordFor(binding) {
    const record = binding && typeof binding === 'object' && records.get(binding);
    if (!record) fail('PREVIEW_CAPABILITY_INVALID');
    return record;
  }
  function owned(record, { page = true } = {}) {
    if (['closed', 'promoted'].includes(record.phase)) fail('PREVIEW_RETIRED');
    const workspace = record.workspace;
    if (!workspace || workspaceFor(record.workspaceId) !== workspace || workspace.id !== record.workspaceId ||
        workspace.identityId !== record.identityId || workspace.session !== record.session || !workspace.open ||
        workspace.quarantined || workspace.privateScope || workspace.ownerWindow !== record.ownerWindow ||
        workspace.ownerRevision !== record.ownerRevision || isNormalOwner(record.ownerWindow) !== true) fail('PREVIEW_STALE');
    if (page && (!record.page || workspace.tabs.get(record.tabId) !== record.page || record.page.workspace !== workspace ||
        record.page.id !== record.tabId || record.page.previewId !== record.previewId ||
        !['preview', 'preview-promoting'].includes(record.page.purpose))) fail('PREVIEW_STALE');
    return workspace;
  }
  function current(record, { ready = false } = {}) {
    owned(record);
    const privacy = getPrivacyState(record.workspaceId);
    if (privacy.blocked) fail('PREVIEW_BLOCKED');
    if (privacy.capturePrivacyEpoch !== record.privacyEpoch || getRuntimeIncarnation() !== record.runtimeIncarnation) fail('PREVIEW_STALE');
    if (record.page.closed || record.page.destroyTask || record.page.wc.isDestroyed() || record.page.crashed || record.page.rendererGone)
      fail('PREVIEW_NOT_READY');
    if (ready && isPageReady(record.page) !== true) fail('PREVIEW_NOT_READY');
    return true;
  }
  function navigation(record) {
    if (record.page) {
      try {
        const value = navigationFor(record.page);
        record.lastNavigation = cloneData({ url: value.url, title: value.title, loading: value.loading, crashed: value.crashed }, { maxBytes: 16_384 });
      } catch { return { ...record.lastNavigation, loading: false, crashed: true }; }
    }
    return { ...record.lastNavigation };
  }
  function snapshotRecord(record) {
    let canKeep = record.phase === 'active', reason = record.reason, readable = !['closed', 'promoted'].includes(record.phase);
    if (readable) try { owned(record); } catch (error) { readable = false; canKeep = false; reason ??= safeReason(error); }
    if (canKeep) try { current(record, { ready: true }); } catch (error) { canKeep = false; reason ??= safeReason(error); }
    // A retired/stale capability may report its last owner-visible state, but it
    // must never follow a native tab that has since moved to another owner.
    const nav = readable ? navigation(record) : { ...record.lastNavigation };
    if (nav.crashed) { canKeep = false; reason ??= 'PREVIEW_NOT_READY'; }
    return { previewId: record.previewId, generation: record.generation, workspaceId: record.workspaceId,
      identityId: record.identityId, tabId: record.tabId, sourceTabId: record.sourceTabId, phase: record.phase,
      navigation: nav, canKeep, reason: reason ?? null };
  }
  function create(input) {
    assertKeys(input, ['workspaceId', 'url', 'expectedOwnerWindow', 'sourceTarget', 'beforeCreate'],
      ['workspaceId', 'url', 'expectedOwnerWindow', 'beforeCreate']);
    assertId(input.workspaceId);
    const workspace = workspaceFor(input.workspaceId), ownerWindow = input.expectedOwnerWindow;
    if (!workspace?.open || workspace.quarantined || workspace.privateScope || workspace.ownerWindow !== ownerWindow ||
        isNormalOwner(ownerWindow) !== true) fail('PREVIEW_UNAVAILABLE');
    if (byOwner.has(ownerWindow)) fail('PREVIEW_BUSY');
    if (byOwner.size >= 8) fail('PREVIEW_CAPACITY');
    const privacy = getPrivacyState(workspace.id);
    if (privacy.blocked) fail('PREVIEW_BLOCKED');
    const record = { previewId: 'preview-' + randomUUID(), tabId: 'tab-' + randomUUID(), generation: 1,
      workspaceId: workspace.id, identityId: workspace.identityId, workspace, session: workspace.session,
      ownerWindow, ownerRevision: workspace.ownerRevision, runtimeIncarnation: getRuntimeIncarnation(),
      privacyEpoch: privacy.capturePrivacyEpoch, sourceTabId: input.sourceTarget?.tabId ?? null,
      page: null, phase: 'opening', reason: null, ticket: null, pendingClose: null,
      lastNavigation: { url: input.url, title: '', loading: true, crashed: false } };
    owned(record, { page: false }); sync(input.beforeCreate); owned(record, { page: false });
    if (getPrivacyState(workspace.id).blocked || getPrivacyState(workspace.id).capturePrivacyEpoch !== record.privacyEpoch ||
        getRuntimeIncarnation() !== record.runtimeIncarnation) fail('PREVIEW_STALE');
    const binding = Object.freeze({ previewId: record.previewId, workspaceId: record.workspaceId, identityId: record.identityId,
      tabId: record.tabId, generation: record.generation });
    records.set(binding, record); byOwner.set(ownerWindow, record);
    try {
      allocatePage({ workspaceId: record.workspaceId, tabId: record.tabId, url: input.url, previewId: record.previewId,
        onAllocated(page) {
          if (record.page || !page) fail('PREVIEW_OPEN_INCOMPLETE');
          record.page = page; owned(record);
        } });
      current(record); sync(input.beforeCreate); current(record);
      transition(record, 'active');
    } catch (error) {
      if (!record.page) { byOwner.delete(ownerWindow); record.phase = 'closed'; throw error; }
      // Keep the actual allocation reachable for acknowledged human cleanup.
      // Never turn a failed native attachment into a lost page or forceful close.
      record.reason = 'PREVIEW_OPEN_INCOMPLETE'; transition(record, 'close-pending');
    }
    return binding;
  }
  function assertCurrent(binding, { beforeCheck } = {}) {
    const record = recordFor(binding); current(record);
    if (beforeCheck !== undefined) { sync(beforeCheck); current(record); }
    return true;
  }
  function assertTicket(ticket) {
    const entry = ticket && typeof ticket === 'object' && tickets.get(ticket), record = entry?.record;
    if (!entry || record.ticket !== ticket || record.phase !== 'keeping') fail('PREVIEW_PROMOTION_STALE');
    current(record, { ready: true }); sync(entry.beforePrepare); current(record, { ready: true });
    if (!sameTarget(entry.target, targetFor(record.page))) fail('PREVIEW_PROMOTION_STALE');
    return entry;
  }
  function prepare(binding, { beforePrepare } = {}) {
    const record = recordFor(binding);
    if (record.phase !== 'active') fail('PREVIEW_BUSY');
    current(record, { ready: true }); sync(beforePrepare); current(record, { ready: true });
    const target = Object.freeze(cloneData(targetFor(record.page), { maxBytes: 4096 }));
    transition(record, 'keeping', { emit: false });
    const snapshot = snapshotRecord(record); Object.freeze(snapshot.navigation); Object.freeze(snapshot);
    let ticket;
    ticket = Object.freeze({ snapshot, assertCurrent() { assertTicket(ticket); return true; } });
    tickets.set(ticket, { record, target, beforePrepare }); record.ticket = ticket;
    notify(record); return ticket;
  }
  function cancelPreparation(ticket) {
    const entry = ticket && typeof ticket === 'object' && tickets.get(ticket), record = entry?.record;
    if (!entry || record.ticket !== ticket || record.phase !== 'keeping') fail('PREVIEW_PROMOTION_STALE');
    record.ticket = null; transition(record, 'active'); return { cancelled: true };
  }
  function promote(ticket, { beforePromote, adoptDocument } = {}) {
    const entry = assertTicket(ticket), record = entry.record;
    if (typeof adoptDocument !== 'function') fail('AUTHORIZATION_REQUIRED');
    sync(beforePromote); assertTicket(ticket);
    try {
      const receipt = publishPage(record.page, { previewId: record.previewId, generation: record.generation + 1,
        identityId: record.identityId, expectedTarget: entry.target, adoptDocument,
        beforePublish: () => { assertTicket(ticket); sync(beforePromote); assertTicket(ticket); return true; },
        afterAdopt: () => {
          if (record.ticket !== ticket || record.phase !== 'keeping') fail('PREVIEW_PROMOTION_STALE');
          current(record, { ready: true }); sync(beforePromote); current(record, { ready: true }); return true;
        } });
      if (record.page.purpose !== 'tab' || record.workspace.tabs.get(record.tabId) !== record.page || !receipt ||
          typeof receipt.assertCurrent !== 'function' || typeof receipt.assertPublished !== 'function') fail('PREVIEW_PROMOTION_UNCONFIRMED');
      record.lastNavigation = navigation(record); record.ticket = null;
      transition(record, 'promoted', { emit: false }); byOwner.delete(record.ownerWindow);
      return receipt;
    } catch (error) {
      // Even an unexpected adapter error after staging must not expose the page.
      // The purpose gate rejects queued/guessed targets independently of tokens.
      record.page.purpose = 'preview'; record.page.observation = 'observation-' + randomUUID();
      record.ticket = null; record.reason = 'PREVIEW_PROMOTION_UNCONFIRMED'; transition(record, 'close-pending');
      throw new CaddiError('PREVIEW_PROMOTION_UNCONFIRMED', 'The saved tab could not finish becoming a live tab. Close its retained preview before reopening it.');
    }
  }
  function actuallyClosed(record) {
    return !!record.page && record.page.wc.isDestroyed() && record.workspace.tabs.get(record.tabId) !== record.page;
  }
  function finishClosed(record) {
    byOwner.delete(record.ownerWindow); record.ticket = null; record.reason = null;
    transition(record, 'closed'); record.page = null; record.workspace = null; record.session = null; record.ownerWindow = null;
    return { closed: true };
  }
  function close(binding, { beforeClose, decideClose } = {}) {
    try {
      const record = recordFor(binding);
      if (record.phase === 'closed') return Promise.resolve({ closed: true });
      if (record.phase === 'promoted') fail('PREVIEW_RETIRED');
      if (typeof decideClose !== 'function') fail('AUTHORIZATION_REQUIRED');
      owned(record); sync(beforeClose); owned(record);
      if (record.pendingClose) return record.pendingClose;
      const previous = record.phase, wasUncertain = previous === 'keeping' || previous === 'close-pending';
      record.lastNavigation = navigation(record); record.ticket = null; transition(record, 'closing');
      const guard = () => { owned(record); sync(beforeClose); owned(record); return true; };
      record.pendingClose = Promise.resolve().then(() => closePage(record.page, { beforeClose: guard, decideClose })).then(result => {
        if (actuallyClosed(record)) return finishClosed(record);
        if (result?.closed !== false) fail('PREVIEW_CLOSE_UNCONFIRMED');
        transition(record, wasUncertain ? 'close-pending' : 'active'); return { closed: false };
      }).catch(error => {
        if (actuallyClosed(record)) return finishClosed(record);
        record.reason = 'PREVIEW_CLOSE_UNCONFIRMED'; transition(record, 'close-pending');
        throw new CaddiError('PREVIEW_CLOSE_UNCONFIRMED', 'The preview has not acknowledged closing. Its native page remains retained.');
      }).finally(() => { record.pendingClose = null; });
      return record.pendingClose;
    } catch (error) { return Promise.reject(error); }
  }
  return Object.freeze({ create, assertCurrent, prepare, promote, cancelPreparation, close,
    snapshot: binding => snapshotRecord(recordFor(binding)),
    page(binding) { const record = recordFor(binding); owned(record); return record.page; },
    hasOwner: ownerWindow => byOwner.has(ownerWindow),
    hasWorkspace: workspaceId => [...byOwner.values()].some(record => record.workspaceId === workspaceId),
    count: () => byOwner.size,
  });
}
