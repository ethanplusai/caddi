import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger } from '../contracts.mjs';
import { applyProductCommand, createProductState } from '../state/model.mjs';
import { createPrivateWorkspaceState } from './private-state.mjs';
import { createFolderRemovalUndo } from './organization-undo.mjs';
import { affectedVisiblePages, commitVisiblePages, commitClosedPage } from './page-residency.mjs';
import { visibleTabIds, navigationInput, cleanPageTitle } from './presentation.mjs';
import { capturePageBackdrop } from './page-backdrop.mjs';

const fail = code => { throw new CaddiError(code, 'Private browsing action is unavailable'); };
const target = tab => ({ workspaceId: tab.workspaceId, tabId: tab.id });
const unavailable = Object.freeze(['agents', 'services', 'history', 'feedback', 'downloads', 'permissions', 'popups', 'print', 'external-links']);
const visibleCommands = new Set(['group.select', 'tab.select', 'tab.reopen', 'tab.create', 'tab.duplicate', 'tab.move', 'tab.pin', 'tab.favorite', 'layout.set', 'layout.clear']);
export const privateOpenAdditions = (before, after, scopeId) => after.tabs.filter(tab => tab.status === 'open' &&
  !before.tabs.some(prior => prior.id === tab.id && prior.workspaceId === tab.workspaceId && prior.status === 'open'))
  .map(tab => ({ scopeId, workspaceId: tab.workspaceId, tabId: tab.id }));

/** Main-only private composition. Never receives a durable store, history or agent interface. */
export function createPrivateWindowHost({ registry, engine, privacy, isCurrent, isChromeReady,
  assertActionCurrent = () => true, isSystemReady = () => true, bindInput = () => {}, decideClose = async () => false,
  onChange = () => {}, onNotice = () => {}, runBackground = work => work(), now = Date.now } = {}) {
  if (!registry || !engine || !privacy || ![isCurrent, isChromeReady, assertActionCurrent, isSystemReady, bindInput, decideClose, onChange, onNotice, runBackground, now].every(fn => typeof fn === 'function')) fail('INVALID_ARGUMENT');
  const records = new WeakMap(), byWorkspace = new Map(), usedWorkspaces = new Set();
  function recordFor(context, { disposed = false } = {}) {
    const record = records.get(context);
    if (disposed && record?.status === 'disposed' && context.privateScopeId === record.scope.scopeId) return record;
    if (!record || context.privateScopeId !== record.scope.scopeId || registry.forContext(context) !== record.scope) fail('PRIVATE_SCOPE_RETIRED');
    return record;
  }
  function current(record, { closing = false, action = false } = {}) {
    const info = record.scope.inspect();
    if (!isCurrent(record.context) || record.context.privateScopeId !== record.scope.scopeId ||
        registry.forContext(record.context) !== record.scope || info.status !== 'active' || info.generation !== record.generation ||
        record.context.workspaceId !== record.scope.workspaceId || (!closing && (record.status !== 'active' || record.context.closing))) fail('PRIVATE_SCOPE_STALE');
    if (action) { assertActionCurrent(); if (!isChromeReady(record.context)) fail('CHROME_RECOVERY_REQUIRED'); }
    return true;
  }
  function tabFor(record, id) {
    const tab = record.scope.getState().tabs.find(item => item.id === assertId(id));
    if (!tab) fail('WORKSPACE_MISMATCH'); return tab;
  }
  function stopFind(record) {
    const query = record.context.finding; record.context.finding = null;
    if (query) try { engine.stopFind(query); } catch {}
  }
  function serial(record, work) {
    if (record.pending >= 64) fail('PRIVATE_QUEUE_CAPACITY');
    record.pending++;
    const result = record.tail.then(work);
    record.tail = result.catch(() => {}).finally(() => { record.pending--; });
    return result;
  }
  async function ensure(record, tab, reservation = null) {
    if (!isSystemReady()) fail('SYSTEM_PAUSED');
    current(record, { action: true });
    if (tab.status !== 'open' || tab.dormant) return;
    let existing;
    try { existing = engine.getView(target(tab)); } catch {}
    if (existing && !existing.webContents.isDestroyed() && !engine.navigation(target(tab)).crashed) { record.loaded.add(tab.id); return; }
    if (existing || engine.workspaceAllocations(record.scope.workspaceId).pages.some(item => item.tabId === tab.id)) {
      const closed = await engine.humanCloseTab(target(tab), () => decideClose(record.context));
      if (!closed.closed) fail('PRIVATE_CLOSE_CANCELLED');
      record.loaded.delete(tab.id); current(record, { action: true });
    }
    engine.createTab({ ...target(tab), url: tab.url }, { reservation }); record.loaded.add(tab.id);
    bindInput(engine.getView(target(tab)).webContents, record.context);
  }
  function layout(context) {
    const record = recordFor(context, { disposed: true });
    if (record.status === 'disposed' || context.layingOut) return;
    context.layingOut = true;
    try {
    const state = record.scope.getState(), ids = visibleTabIds(state);
    const group = state.groups.find(item => item.id === state.workspaces[0].activeGroupId);
    const split = state.layouts.find(item => item.id === group?.activeLayoutId);
    const allowed = isSystemReady() && record.status === 'active' && !context.closing && isChromeReady(context) && !context.chromeOverlay;
    for (const tab of state.tabs) if (record.loaded.has(tab.id)) {
      try {
        const index = ids.indexOf(tab.id), visible = allowed && index >= 0 && context.pageRect.width > 1 && context.pageRect.height > 1 && engine.navigation(target(tab)).url !== 'about:blank';
        if (engine.getOwnerWindow(target(tab)) !== context.window) fail('PRIVATE_SCOPE_STALE');
        if (visible) {
          const bounds = { ...context.pageRect };
          if (ids.length === 2) {
            const horizontal = split?.orientation !== 'vertical', dimension = horizontal ? 'width' : 'height', axis = horizontal ? 'x' : 'y';
            const first = Math.floor((bounds[dimension] - 8) * (split?.ratio ?? 0.5));
            if (!index) bounds[dimension] = first; else { bounds[axis] += first + 8; bounds[dimension] -= first + 8; }
          }
          engine.setBounds({ ...target(tab), bounds });
        }
        engine.setVisible({ ...target(tab), visible });
      } catch {}
    }
    } finally { context.layingOut = false; }
  }
  async function display(context, held = null) {
    if (!isSystemReady()) fail('SYSTEM_PAUSED');
    const record = recordFor(context); current(record, { action: true });
    const state = record.scope.getState(), tabs = visibleTabIds(state).map(id => tabFor(record, id));
    const reservation = held ?? engine.reservePages(tabs.map(target));
    try {
      reservation.assertCurrent();
      for (const tab of tabs) { await ensure(record, tab, reservation); engine.markHumanTouched(target(tab)); }
      layout(context); onChange();
    } finally { if (!held) reservation.release(); }
  }
  function transact(record, command, { acknowledgedClose = false, beforeCommit = null, background = false } = {}) {
    return serial(record, async () => {
      const fence = () => { current(record, { closing: acknowledgedClose, action: !acknowledgedClose && !background }); return beforeCommit ? beforeCommit() : true; };
      fence();
      const before = record.scope.getState(), after = applyProductCommand(before, command);
      const additions = privateOpenAdditions(before, after, record.scope.scopeId);
      const metadata = additions.length ? registry.reserveTabs(additions) : null;
      const finalFence = () => { fence(); metadata?.assertReserved(privateOpenAdditions(record.scope.getState(), after, record.scope.scopeId)); return true; };
      const commit = async nativeFence => (await record.scope.transact({ expectedRevision: before.revision, command }, { beforeCommit: nativeFence })).state;
      try {
        let result;
        if (!background && visibleCommands.has(command.type) && !(command.type === 'tab.create' && command.activate === false)) {
          const targets = affectedVisiblePages({ before, after, command, contexts: [record.context] });
          result = await commitVisiblePages({ reserve: engine.reservePages, targets, commit, beforeCommit: finalFence,
            load: (query, reservation) => ensure(record, tabFor(record, query.tabId), reservation) });
        } else result = await commit(finalFence);
        onChange(); return result;
      } finally { metadata?.release(); }
    });
  }
  function create(context, settings) {
    if (!isCurrent(context) || records.has(context) || context.privateScopeId) fail('PRIVATE_SCOPE_BINDING');
    const scope = createPrivateWorkspaceState({ settings, now });
    Object.defineProperty(context, 'privateScopeId', { value: scope.scopeId, enumerable: true, writable: false, configurable: false });
    context.workspaceId = scope.workspaceId;
    registry.attach(context, scope);
    const record = { context, scope, generation: scope.generation, binding: null, status: 'active', loaded: new Set(),
      tail: Promise.resolve(), pending: 0, changes: new Map(), timer: null, recent: [], undo: createFolderRemovalUndo(), closeTask: null };
    records.set(context, record); byWorkspace.set(scope.workspaceId, record); usedWorkspaces.add(scope.workspaceId);
    try {
      record.binding = engine.createPrivateWorkspace({ workspaceId: scope.workspaceId, identityId: scope.identityId });
      engine.transferWorkspace(scope.workspaceId, context.window);
    } catch (error) { record.status = 'cleanup-pending'; context.closing = true; throw error; }
    return { scopeId: scope.scopeId, workspaceId: scope.workspaceId, identityId: scope.identityId, generation: record.generation };
  }
  function snapshot(context) {
    const record = recordFor(context, { disposed: true }), info = record.scope.inspect();
    const state = info.status === 'active' ? record.scope.getState() : createProductState(), pages = {};
    for (const tab of state.tabs) if (record.loaded.has(tab.id)) try { pages[tab.id] = { ...engine.navigation(target(tab)) }; } catch {}
    return { metadata: state, pages, privateBrowsing: { scopeId: record.scope.scopeId, generation: record.generation,
      status: record.status === 'disposed' ? 'closing' : record.status, ephemeral: true, unavailable: [...unavailable] },
      organizationUndo: info.status === 'active' ? record.undo.snapshot(state, record.scope.workspaceId) : { available: false } };
  }
  async function flushEvents(record) {
    clearTimeout(record.timer); record.timer = null;
    const changes = [...record.changes.values()]; record.changes.clear();
    for (const change of changes) {
      try {
        await transact(record, { type: 'tab.update', tabId: change.tabId, url: change.url, title: change.title }, { background: true, beforeCommit: () => {
          const actual = engine.getTarget({ workspaceId: record.scope.workspaceId, tabId: change.tabId });
          if (['workspaceId', 'tabId', 'runtimeIncarnation', 'documentGeneration', 'capturePrivacyEpoch'].some(key => actual[key] !== change.target[key]) ||
              engine.navigation({ workspaceId: record.scope.workspaceId, tabId: change.tabId }).url !== change.url || tabFor(record, change.tabId).status !== 'open') fail('PRIVATE_DOCUMENT_STALE');
          return true;
        } });
      } catch (error) { if (!['PRIVATE_SCOPE_STALE', 'PRIVATE_SCOPE_RETIRED', 'PRIVATE_DOCUMENT_STALE', 'TARGET_NOT_FOUND', 'PAGE_CLOSED'].includes(error.code)) onNotice(record.context, 'Private page details could not update. They were not saved to normal browsing data.'); }
    }
  }
  function observe(event) {
    if (!usedWorkspaces.has(event.workspaceId)) return false;
    if (!isSystemReady()) return true;
    const record = byWorkspace.get(event.workspaceId);
    if (!record || record.status !== 'active' || record.scope.inspect().status !== 'active') return true;
    if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'page-crashed', 'page-closed', 'privacy'].includes(event.reason)) stopFind(record);
    if (event.reason === 'page-closed') { record.loaded.delete(event.tabId); record.changes.delete(event.tabId); }
    if (event.target && ['navigation-commit', 'navigation-in-page', 'page-title-updated', 'ready', 'did-stop-loading'].includes(event.reason)) {
      try {
        current(record);
        const tab = tabFor(record, event.tabId); if (tab.status !== 'open' || event.target.workspaceId !== record.scope.workspaceId) return true;
        const url = navigationInput(event.navigation.url), title = url === 'about:blank' ? 'New tab' : cleanPageTitle(event.navigation.title);
        record.changes.set(tab.id, { tabId: tab.id, url, title, target: { ...event.target } });
        if (!record.timer) record.timer = setTimeout(() => void runBackground(() => flushEvents(record)).catch(() => {}), 100);
      } catch {}
    }
    layout(record.context); onChange(); return true;
  }
  async function act(context, input) {
    const record = recordFor(context); current(record, { action: true });
    const { type, ...args } = input, state = record.scope.getState(), workspace = state.workspaces[0];
    if (args.workspaceId && args.workspaceId !== workspace.id) fail('WORKSPACE_MISMATCH');
    if (args.tabId) tabFor(record, args.tabId);
    if (args.groupId && !state.groups.some(group => group.id === args.groupId)) fail('WORKSPACE_MISMATCH');
    if (args.folderId && !state.folders.some(folder => folder.id === args.folderId)) fail('WORKSPACE_MISMATCH');
    switch (type) {
      case 'overlay.set': {
        if (typeof args.open !== 'boolean') fail('INVALID_ARGUMENT');
        const backdrop = args.open && !context.chromeOverlay ? await capturePageBackdrop(state.tabs.filter(tab => record.loaded.has(tab.id)).flatMap(tab => {
          try { return [engine.getView(target(tab))]; } catch { return []; }
        }), context.pageRect) : [];
        context.chromeOverlay = args.open; layout(context); onChange(); return { backdrop };
      }
      case 'workspace.rename': case 'group.rename': case 'folder.rename': case 'folder.collapse': case 'folder.move': case 'tab.rename': await transact(record, input); return true;
      case 'group.reorder': case 'folder.reorder': case 'tab.reorder': {
        const { expectedRevision, ...command } = input; assertInteger(expectedRevision, 'reviewed order revision');
        if (state.revision !== expectedRevision) fail('ORDER_STALE');
        await transact(record, command, { beforeCommit: () => { if (record.scope.getState().revision !== expectedRevision) fail('ORDER_STALE'); return true; } }); return true;
      }
      case 'workspace.select': return { focusedExisting: false };
      case 'group.create': {
        const id = 'private-group-' + randomUUID(); stopFind(record);
        await transact(record, { type, id, workspaceId: workspace.id, name: args.name, color: '#7d6aa6' });
        await transact(record, { type: 'group.select', groupId: id }); await display(context); return id;
      }
      case 'folder.create': {
        const id = 'private-folder-' + randomUUID(); await transact(record, { type, id, workspaceId: workspace.id, ...args }); return id;
      }
      case 'folder.remove': {
        const before = record.scope.getState(), after = await transact(record, input);
        let undoAvailable = false; try { undoAvailable = record.undo.record(before, after, args.folderId).available === true; } catch {}
        onChange(); return { removed: true, undoAvailable };
      }
      case 'folder.undo': {
        const command = record.undo.prepare(state, workspace.id, args.undoId);
        await transact(record, command, { beforeCommit: () => { record.undo.prepare(record.scope.getState(), workspace.id, args.undoId); return true; } });
        record.undo.complete(args.undoId); onChange(); return { restored: true };
      }
      case 'group.select': case 'tab.move': case 'tab.pin': case 'tab.favorite': stopFind(record); await transact(record, input); await display(context); return true;
      case 'tab.create': {
        if (typeof args.activate !== 'boolean') fail('INVALID_ARGUMENT');
        const id = 'private-tab-' + randomUUID(); if (args.activate) stopFind(record);
        await transact(record, { type, id, workspaceId: workspace.id, groupId: workspace.activeGroupId, url: navigationInput(args.input), title: 'New tab', now: now(), activate: args.activate });
        if (args.activate) await display(context); return id;
      }
      case 'tab.duplicate': {
        const id = 'private-tab-' + randomUUID(); stopFind(record);
        await transact(record, { type, id, sourceTabId: args.tabId, now: now() }); await display(context); return id;
      }
      case 'tab.select': case 'tab.reopen': stopFind(record); await transact(record, { ...input, now: now() }); await display(context); return true;
      case 'tab.reopen-last': {
        const tab = [...record.recent].reverse().map(id => state.tabs.find(tab => tab.id === id && tab.status === 'closed')).find(Boolean) ?? state.tabs.filter(tab => tab.status === 'closed').at(-1);
        if (!tab) fail('NO_CLOSED_TAB'); return act(context, { type: 'tab.reopen', tabId: tab.id });
      }
      case 'tab.close': {
        const tab = tabFor(record, args.tabId);
        if (engine.workspaceAllocations(record.scope.workspaceId).pages.some(page => page.tabId === tab.id)) {
          const result = await engine.humanCloseTab(target(tab), () => decideClose(context));
          if (!result.closed) return { closed: false };
          record.loaded.delete(tab.id);
        }
        record.changes.delete(tab.id); stopFind(record);
        return commitClosedPage({ commit: () => transact(record, input, { acknowledgedClose: true }), display: async () => {
          record.recent.push(tab.id); if (record.recent.length > 128) record.recent.shift(); await display(context);
        }, onDisplayUnavailable: () => { layout(context); onChange(); onNotice(context, 'Tab closed. Select a tab to display it when page capacity is available.'); } });
      }
      case 'stop': { const tab = tabFor(record, args.tabId); if (record.loaded.has(tab.id)) engine.stop(target(tab)); onChange(); return true; }
      case 'navigate': case 'back': case 'forward': case 'reload': {
        const tab = tabFor(record, args.tabId); stopFind(record); await ensure(record, tab); current(record, { action: true });
        // Start the load only; awaiting it would hold this window's later actions until the page finished.
        if (type === 'navigate') engine.startHumanNavigation({ ...target(tab), url: navigationInput(args.input) });
        else await engine[type](target(tab)); layout(context); onChange(); return true;
      }
      case 'find': case 'find.stop': case 'zoom.set': case 'mute.set': {
        const tab = tabFor(record, args.tabId); if (!visibleTabIds(record.scope.getState()).includes(tab.id)) fail('TAB_NOT_ACTIVE');
        await ensure(record, tab); current(record, { action: true });
        if (type === 'find') { if (context.finding && context.finding.tabId !== tab.id) stopFind(record);
          const result = engine.find({ ...target(tab), text: args.text, forward: args.forward, findNext: args.findNext, matchCase: args.matchCase }); context.finding = target(tab); return result; }
        if (type === 'find.stop') { stopFind(record); engine.stopFind(target(tab)); return true; }
        return type === 'zoom.set' ? engine.setZoom({ ...target(tab), factor: args.factor }) : engine.setMuted({ ...target(tab), muted: args.muted });
      }
      case 'split.toggle': {
        const tab = tabFor(record, args.tabId), group = state.groups.find(group => group.id === tab.groupId); stopFind(record);
        if (group.activeLayoutId) await transact(record, { type: 'layout.clear', groupId: group.id });
        else {
          const other = state.tabs.find(item => item.id !== tab.id && item.groupId === group.id && item.status === 'open' && !item.dormant);
          if (!other) fail('SECOND_TAB_REQUIRED');
          await transact(record, { type: 'layout.set', id: 'private-layout-' + randomUUID(), groupId: group.id, tabIds: [tab.id, other.id], orientation: 'horizontal', ratio: 0.5 });
        }
        await display(context); return true;
      }
      default: fail('PRIVATE_FEATURE_UNAVAILABLE');
    }
  }
  function close(context) {
    const record = recordFor(context, { disposed: true });
    if (record.status === 'disposed') return Promise.resolve({ closed: true, disposed: true });
    if (record.closeTask) return record.closeTask;
    context.closing = true; record.status = 'closing'; stopFind(record); clearTimeout(record.timer); record.changes.clear(); onChange();
    const work = async () => {
      await record.tail; current(record, { closing: true });
      if (record.binding) {
        for (const page of engine.workspaceAllocations(record.scope.workspaceId).pages) {
          current(record, { closing: true });
          const result = await engine.humanCloseTab({ workspaceId: record.scope.workspaceId, tabId: page.tabId }, () => decideClose(context));
          if (!result.closed) { record.status = 'active'; context.closing = false; layout(context); onChange(); return { closed: false }; }
          record.loaded.delete(page.tabId); record.changes.delete(page.tabId);
          const tab = record.scope.getState().tabs.find(item => item.id === page.tabId);
          if (tab?.status === 'open') await transact(record, { type: 'tab.close', tabId: tab.id }, { acknowledgedClose: true });
        }
        current(record, { closing: true });
        await engine.disposePrivateWorkspace({ ...record.binding, beforeDispose: () => current(record, { closing: true }) });
      }
      current(record, { closing: true });
      record.scope.dispose({ expectedGeneration: record.generation }); await record.scope.flush();
      registry.release(context, { expectedScopeId: record.scope.scopeId, expectedGeneration: record.generation });
      record.undo.close(); record.recent.length = 0; record.loaded.clear(); record.binding = null; record.status = 'disposed';
      byWorkspace.delete(record.scope.workspaceId);
      return { closed: true, disposed: true };
    };
    record.closeTask = work().catch(error => { record.status = 'cleanup-pending'; onChange(); throw error; }).finally(() => { record.closeTask = null; });
    return record.closeTask;
  }
  return Object.freeze({ create, act, snapshot, layout, display, observe, close,
    ownsWorkspace: workspaceId => usedWorkspaces.has(workspaceId),
    async flush() { for (const record of byWorkspace.values()) { await runBackground(() => flushEvents(record)); await record.tail; } },
    async protect(context) { const record = recordFor(context); stopFind(record); clearTimeout(record.timer); record.changes.clear();
      await privacy.beginPrivacyBarrier({ workspaceId: record.scope.workspaceId, timeoutMs: 5000 }); layout(context); },
  });
}
