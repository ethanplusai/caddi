import { CaddiError, assertId, assertInteger } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Page preview is unavailable'); };
const sync = callback => {
  const value = callback();
  if (value !== true && value !== undefined) {
    if (value instanceof Promise) void value.catch(() => {});
    fail('PREVIEW_STALE');
  }
};
export function previewURL(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 8192 || /[\u0000-\u001f\u007f]/u.test(raw)) fail('PREVIEW_URL_INVALID');
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value) || /[\\\s]/u.test(value)) fail('PREVIEW_URL_INVALID');
  let url; try { url = new URL(value); } catch { fail('PREVIEW_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) fail('PREVIEW_URL_INVALID');
  return url.href;
}

/** Main-only owner capabilities. A preview is never a metadata tab until Keep;
 * native publication happens only after that exact reviewed metadata commit. */
export function createPreviewHost({ engine, getState, captureOwner, assertOwner, commit, adoptDocument, discardAdoption,
  didPromote = () => {}, bindInput = () => {}, decideClose, onChange = () => {}, now = Date.now } = {}) {
  if (![getState, captureOwner, assertOwner, commit, adoptDocument, discardAdoption, didPromote, bindInput, decideClose, onChange, now]
    .every(value => typeof value === 'function')) fail('INTEGRATION_REQUIRED');
  const owners = new Map(), byId = new Map();
  function native(record) { return engine.previewSnapshot(record.binding); }
  function ownerCurrent(record, allowClosing = false) {
    if (owners.get(record.owner) !== record) fail('PREVIEW_STALE');
    sync(() => assertOwner(record.owner, record.intent, { allowClosing }));
    const workspace = getState().workspaces.find(item => item.id === record.intent.workspaceId);
    if (!workspace || workspace.identityId !== record.intent.identityId) fail('PREVIEW_STALE');
    return true;
  }
  function sameLifecycle(record) {
    const workspace = getState().workspaces.find(item => item.id === record.intent.workspaceId);
    return workspace?.identityId === record.intent.identityId && workspace.lifecycle?.status !== 'archived' &&
      (workspace.lifecycle?.generation ?? 0) === record.intent.workspaceGeneration;
  }
  function publicCurrent(record) {
    ownerCurrent(record);
    if (!sameLifecycle(record)) fail('PREVIEW_STALE');
    if (record.invalidated) fail('PREVIEW_PRIVACY_BLOCKED');
    sync(record.intent.assertCurrent); return true;
  }
  function locate(owner, input, allowClosing = false) {
    assertId(input.previewId); assertInteger(input.generation, 'preview generation', { min: 1 });
    const record = owners.get(owner); if (!record || !record.binding) fail('PREVIEW_STALE');
    ownerCurrent(record, allowClosing);
    const value = native(record);
    if (value.previewId !== input.previewId || value.generation !== input.generation) fail('PREVIEW_STALE');
    return record;
  }
  const notify = record => { try { onChange(record.owner); } catch {} };
  function forget(record) { owners.delete(record.owner); byId.delete(record.id); notify(record); }
  function snapshot(owner) {
    const record = owners.get(owner); if (!record?.binding) return null;
    const value = native(record), nav = value.navigation;
    const status = record.status ?? (!sameLifecycle(record) ? 'paused' : ({ keeping: 'promoting', opening: 'active' }[value.phase] ?? value.phase));
    return { id: value.previewId, generation: value.generation, workspaceId: value.workspaceId,
      sourceTabId: value.sourceTabId ?? record.intent.sourceTabId, status,
      url: nav.url, title: nav.title || 'Page preview', loading: nav.loading === true,
      canPromote: status === 'active' && !record.invalidated && record.metadataOutcome === 'none' && value.canKeep === true,
      source: record.source, errorCode: record.errorCode ?? value.reason ?? null, metadataCommitted: record.metadataCommitted,
      metadataOutcome: record.metadataOutcome, ...(record.metadataOutcome !== 'none' ? { savedTabId: record.tabId } : {}) };
  }
  function open(owner, { input, sourceTarget = null, sourceAssertCurrent = () => true } = {}) {
    if (owners.has(owner)) fail('PREVIEW_BUSY');
    if (owners.size >= 8) fail('PREVIEW_BUSY');
    const url = previewURL(input), intent = captureOwner(owner);
    if (!intent || typeof intent.assertCurrent !== 'function') { if (intent instanceof Promise) void intent.catch(() => {}); fail('INTEGRATION_REQUIRED'); }
    sync(intent.assertCurrent); sync(sourceAssertCurrent);
    const record = { owner, intent, source: sourceTarget ? 'link' : 'address', binding: null, id: null, status: null,
      errorCode: null, invalidated: false, metadataCommitted: false, metadataOutcome: 'none', tabId: null, task: null };
    owners.set(owner, record);
    try {
      record.binding = engine.createPreviewPage({ workspaceId: intent.workspaceId, url, expectedOwnerWindow: owner.window,
        ...(sourceTarget ? { sourceTarget } : {}), beforeCreate: () => { publicCurrent(record); sync(sourceAssertCurrent); return true; } });
      const value = native(record); record.id = value.previewId; record.tabId = value.tabId; byId.set(record.id, record);
      bindInput(engine.previewView(record.binding).webContents, owner);
      if (value.phase === 'close-pending') { record.status = 'close-pending'; record.errorCode = value.reason; }
      notify(record); return snapshot(owner);
    } catch (error) {
      // The engine returns a binding for partial native creation. Only failures
      // before allocation throw, so there is no unidentified page to discard.
      if (!record.binding) forget(record);
      else { record.status = 'close-pending'; record.errorCode = error.code ?? 'PREVIEW_OPEN_INCOMPLETE'; notify(record); }
      throw error;
    }
  }
  async function promote(owner, input) {
    const record = locate(owner, input); publicCurrent(record);
    assertInteger(input.expectedRevision, 'reviewed metadata revision', { min: 0 });
    if (getState().revision !== input.expectedRevision) fail('PREVIEW_REVISION_STALE');
    if (record.task || record.metadataOutcome !== 'none' || snapshot(owner).status !== 'active') fail('PREVIEW_BUSY');
    previewURL(native(record).navigation.url);
    let ticket, value, url, title;
    try {
      ticket = engine.preparePreviewPromotion(record.binding, { beforePrepare: () => publicCurrent(record) });
      value = ticket.snapshot; url = previewURL(value.navigation.url); title = String(value.navigation.title || 'Page preview').slice(0, 512);
    } catch (error) {
      if (ticket) {
        try { engine.cancelPreviewPromotion(ticket); }
        catch { record.status = 'close-pending'; record.errorCode = 'PREVIEW_STOP_PENDING'; }
        notify(record);
      }
      throw error;
    }
    let published = false;
    const fence = () => {
      publicCurrent(record); sync(ticket.assertCurrent);
      const state = getState(), workspace = state.workspaces.find(item => item.id === value.workspaceId);
      if (state.revision !== input.expectedRevision || workspace?.activeGroupId !== record.intent.groupId) fail('PREVIEW_REVISION_STALE');
      return true;
    };
    record.status = 'promoting'; notify(record);
    const work = (async () => {
      try {
        fence();
        await commit({ type: 'tab.create', id: value.tabId, workspaceId: value.workspaceId, groupId: record.intent.groupId,
          url, title, now: now(), activate: true }, fence, () => { published = true; record.metadataCommitted = true; record.metadataOutcome = 'committed'; });
        published = true; record.metadataCommitted = true; record.metadataOutcome = 'committed';
        const receipt = engine.promotePreviewPage(ticket, { beforePromote: () => {
          publicCurrent(record);
          const state = getState(), tab = state.tabs.find(item => item.id === value.tabId), workspace = state.workspaces.find(item => item.id === value.workspaceId);
          if (state.revision !== input.expectedRevision + 1 || !tab || tab.workspaceId !== value.workspaceId || tab.groupId !== record.intent.groupId ||
              tab.status !== 'open' || tab.url !== url || workspace?.activeGroupId !== record.intent.groupId ||
              state.groups.find(group => group.id === record.intent.groupId)?.activeTabId !== value.tabId) fail('PREVIEW_STALE');
          return true;
        }, adoptDocument: receipt => sync(() => adoptDocument(receipt)) });
        forget(record);
        // Publication is complete. A presentation callback cannot turn a saved,
        // public native tab into an uncertain preview or authorize another Keep.
        let presentationPending = false;
        try { didPromote(owner, receipt); } catch { presentationPending = true; }
        return { promoted: true, tabId: receipt.tabId, presentationPending };
      } catch (error) {
        discardAdoption(value.tabId);
        if (published || error.code === 'COMMIT_OUTCOME_UNKNOWN') {
          record.metadataCommitted = published; record.metadataOutcome = published ? 'committed' : 'unknown';
          record.status = 'uncertain'; record.errorCode = 'PREVIEW_OUTCOME_UNKNOWN';
          notify(record); fail('PREVIEW_OUTCOME_UNKNOWN');
        }
        try { engine.cancelPreviewPromotion(ticket); }
        catch { record.status = 'close-pending'; record.errorCode = 'PREVIEW_STOP_PENDING'; notify(record); throw error; }
        record.status = record.invalidated ? 'paused' : null; record.errorCode = record.invalidated ? 'PREVIEW_PRIVACY_BLOCKED' : null;
        notify(record); throw error;
      }
    })();
    record.task = work;
    try { return await work; } finally { if (record.task === work) record.task = null; }
  }
  async function close(owner, input, { allowClosing = false } = {}) {
    const record = locate(owner, input, allowClosing);
    if (record.task) fail('PREVIEW_BUSY');
    record.status = 'closing'; notify(record);
    const work = (async () => {
      try {
        const result = await engine.humanClosePreview(record.binding, {
          beforeClose: () => ownerCurrent(record, allowClosing), decideClose: () => decideClose(owner) });
        if (!result.closed) { record.status = record.metadataOutcome !== 'none' ? 'uncertain' : record.invalidated ? 'paused' : null; notify(record); return { closed: false }; }
        discardAdoption(record.tabId); forget(record); return { closed: true, metadataCommitted: record.metadataCommitted, metadataOutcome: record.metadataOutcome };
      } catch (error) {
        record.status = 'close-pending'; record.errorCode = error.code ?? 'PREVIEW_STOP_PENDING'; notify(record); throw error;
      }
    })();
    record.task = work;
    try { return await work; } finally { if (record.task === work) record.task = null; }
  }
  function invalidate(owner, reason = 'PREVIEW_PRIVACY_BLOCKED') {
    const record = owners.get(owner); if (!record) return;
    record.invalidated = true; record.errorCode = reason;
    if (!record.task) record.status = record.metadataOutcome !== 'none' ? 'uncertain' : 'paused';
    notify(record);
  }
  return Object.freeze({ open, promote, close, snapshot,
    has: owner => owners.has(owner), hasWorkspace: workspaceId => [...owners.values()].some(record => record.intent.workspaceId === workspaceId),
    invalidate, invalidateWorkspace(workspaceId, reason) { for (const record of owners.values()) if (record.intent.workspaceId === workspaceId) invalidate(record.owner, reason); },
    consume(event) {
      if (!event?.preview) return false;
      const record = byId.get(event.preview.previewId);
      if (record) { if (['privacy', 'page-crashed'].includes(event.reason)) invalidate(record.owner); else notify(record); }
      // Delayed preview-stamped events remain excluded even after Keep or close.
      return true;
    },
    present(owner, { bounds, visible }) {
      const record = owners.get(owner); if (!record?.binding) return false;
      const show = visible === true && sameLifecycle(record) && !record.invalidated && !['closing', 'close-pending'].includes(record.status);
      engine.setPreviewPresentation(record.binding, { bounds, visible: show, beforePresent: () => ownerCurrent(record, !show) });
      return true;
    },
    closeOwner(owner) { const value = snapshot(owner); return value ? close(owner, { previewId: value.id, generation: value.generation }, { allowClosing: true }) : Promise.resolve({ closed: true }); },
  });
}
