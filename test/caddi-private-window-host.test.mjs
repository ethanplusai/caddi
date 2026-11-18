import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { createPrivateScopeRegistry } from '../src/caddi/desktop/private-scope-registry.mjs';
import { createPrivateWindowHost } from '../src/caddi/desktop/private-window-host.mjs';
import { createPageResidency } from '../src/caddi/desktop/page-residency.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failure = code => Object.assign(new Error(code), { code });
function harness({ maxOpenTabs = 256, residentLimit = 32 } = {}) {
  let durable = createProductState();
  for (const command of [
    { type: 'workspace.create', id: 'normal', identityId: 'normal-identity', projectId: null, kind: 'personal', name: 'Normal' },
    { type: 'group.create', id: 'normal-group', workspaceId: 'normal', name: 'Tabs', color: '#337765' },
    { type: 'tab.create', id: 'normal-tab', workspaceId: 'normal', groupId: 'normal-group', url: 'about:blank', title: 'New tab', now: 1 },
  ]) durable = applyProductCommand(durable, command);
  const registry = createPrivateScopeRegistry({ getDurableState: () => durable, maxOpenTabs });
  const workspaces = new Map(), contexts = new Set(), events = [], order = [], notices = [];
  let decision = true, cleanup = async () => {}, actionCurrent = true;
  const residency = createPageResidency({ limit: residentLimit, listAllocations: () => [...workspaces.values()].flatMap(workspace =>
    [...workspace.pages.keys()].map(tabId => ({ workspaceId: workspace.workspaceId, tabId }))) });
  const get = query => { const value = workspaces.get(query.workspaceId)?.pages.get(query.tabId); if (!value) throw failure('TARGET_NOT_FOUND'); return value; };
  const engine = {
    createPrivateWorkspace(input) { const capability = {}; workspaces.set(input.workspaceId, { ...input, pages: new Map(), capability }); return { ...input, engineIncarnation: 'engine-one', capability }; },
    transferWorkspace(id, window) { workspaces.get(id).window = window; },
    reservePages: residency.reserve,
    createTab(input, { reservation = null } = {}) {
      const own = reservation ? null : residency.reserve([{ workspaceId: input.workspaceId, tabId: input.tabId }]);
      residency.assertReserved(reservation ?? own, { workspaceId: input.workspaceId, tabId: input.tabId });
      const page = { url: input.url, title: 'Private fixture', generation: 1, destroyed: false, closing: false, visible: false, bounds: {} };
      page.view = { webContents: { isDestroyed: () => page.destroyed }, getVisible: () => page.visible, getBounds: () => page.bounds };
      workspaces.get(input.workspaceId).pages.set(input.tabId, page); own?.release();
    },
    getView: query => get(query).view,
    getOwnerWindow: query => workspaces.get(query.workspaceId).window,
    getTarget: query => ({ ...query, runtimeIncarnation: 'engine-one', documentGeneration: get(query).generation, capturePrivacyEpoch: 0 }),
    navigation: query => ({ url: get(query).url, title: get(query).title, crashed: get(query).destroyed }),
    workspaceActivity: id => ({ pages: [...workspaces.get(id).pages].filter(([, page]) => !page.closing).map(([tabId]) => ({ tabId })) }),
    workspaceAllocations: id => ({ workspaceId: id, pages: [...workspaces.get(id).pages].map(([tabId, page]) => ({ tabId, destroyed: page.destroyed, closing: page.closing })) }),
    async humanCloseTab(query, decide) {
      const page = get(query); order.push('native-close-request');
      if (page.closing && !page.destroyed) return { closed: false };
      if (!page.destroyed && !(await decide())) return { closed: false };
      page.destroyed = true; workspaces.get(query.workspaceId).pages.delete(query.tabId); order.push('native-close-ack'); return { closed: true };
    },
    async disposePrivateWorkspace(input) {
      input.beforeDispose(); const workspace = workspaces.get(input.workspaceId);
      assert.equal(input.capability, workspace.capability); assert.equal(workspace.pages.size, 0); order.push('session-cleanup-start');
      await cleanup(); input.beforeDispose(); order.push('session-cleanup-ack'); workspaces.delete(input.workspaceId);
    },
    markHumanTouched() {}, setBounds({ workspaceId, tabId, bounds }) { get({ workspaceId, tabId }).bounds = bounds; },
    setVisible({ workspaceId, tabId, visible }) { get({ workspaceId, tabId }).visible = visible; },
    stopFind() { events.push('find-stop'); }, find(input) { events.push(input); return { matches: 1 }; },
    setZoom(input) { return input.factor; }, setMuted(input) { return input.muted; },
    async humanNavigate(input) { const page = get(input); page.url = input.url; page.generation++; },
    startHumanNavigation(input) { const page = get(input); page.url = input.url; page.generation++; return { started: true }; },
    back() {}, forward() {}, reload() {}, stop() {},
  };
  const host = createPrivateWindowHost({ registry, engine, privacy: { async beginPrivacyBarrier() {} },
    isCurrent: context => contexts.has(context), isChromeReady: context => context.ready !== false,
    assertActionCurrent: () => { if (!actionCurrent) throw failure('CHROME_ACTION_STALE'); }, bindInput() {}, decideClose: async () => decision,
    onNotice: (_context, message) => notices.push(message), now: () => 1000 });
  function create() {
    const context = { id: contexts.size + 1, window: {}, workspaceId: null, ready: true, chromeOverlay: false,
      pageRect: { x: 250, y: 70, width: 800, height: 600 } }; contexts.add(context);
    const created = host.create(context); return { context, created, scope: registry.forContext(context) };
  }
  return { host, registry, engine, create, get, workspaces, durable, events, order, notices,
    decision(value) { decision = value; }, cleanup(value) { cleanup = value; }, actionCurrent(value) { actionCurrent = value; } };
}

test('private tabs and document events remain in the exact memory scope and never mutate normal state', async () => {
  const h = harness(), before = structuredClone(h.durable), a = h.create(), b = h.create();
  await h.host.display(a.context);
  const tabId = a.scope.tabId, query = { workspaceId: a.created.workspaceId, tabId };
  await h.host.act(a.context, { type: 'navigate', tabId, input: 'https://private.example/session?synthetic=private-only' });
  h.host.observe({ ...query, reason: 'navigation-commit', target: h.engine.getTarget(query), navigation: h.engine.navigation(query) });
  await h.host.flush();
  assert.match(a.scope.getState().tabs[0].url, /private-only/);
  assert.equal(JSON.stringify(b.scope.getState()).includes('private-only'), false); assert.deepEqual(h.durable, before);
  assert.equal(h.host.snapshot(a.context).privateBrowsing.ephemeral, true);
  await assert.rejects(h.host.act(a.context, { type: 'tab.select', tabId: b.scope.tabId }), { code: 'WORKSPACE_MISMATCH' });
  for (const type of ['history.list', 'agent.copy-config', 'review.open', 'page.print', 'external-links.review'])
    await assert.rejects(h.host.act(a.context, { type }), { code: 'PRIVATE_FEATURE_UNAVAILABLE' });
  await h.host.close(a.context); await h.host.close(b.context);
});

test('combined metadata reservations reject excess private tabs without changing selection or leaking capacity', async () => {
  const h = harness({ maxOpenTabs: 3 }), a = h.create(), selected = a.scope.getState().groups[0].activeTabId;
  const id = await h.host.act(a.context, { type: 'tab.create', workspaceId: a.created.workspaceId, input: 'about:blank', activate: false });
  assert.ok(id); assert.equal(a.scope.getState().groups[0].activeTabId, selected);
  await assert.rejects(h.host.act(a.context, { type: 'tab.create', workspaceId: a.created.workspaceId, input: '', activate: false }), { code: 'TAB_CAPACITY' });
  assert.equal(h.registry.inspect().openTabs, 3); assert.equal(h.registry.inspect().reservations, 0);
  await h.host.close(a.context);
});

test('private split selection reserves all missing panes before publishing group metadata', async () => {
  const h = harness({ residentLimit: 2 }), a = h.create(); await h.host.display(a.context);
  const original = a.scope.getState().groups[0].id;
  const groupId = await h.host.act(a.context, { type: 'group.create', workspaceId: a.created.workspaceId, name: 'Two unloaded tabs' });
  const one = await h.host.act(a.context, { type: 'tab.create', workspaceId: a.created.workspaceId, input: '', activate: false });
  await h.host.act(a.context, { type: 'tab.create', workspaceId: a.created.workspaceId, input: '', activate: false });
  await h.host.act(a.context, { type: 'group.select', groupId: original });
  await h.host.act(a.context, { type: 'split.toggle', tabId: one });
  const before = a.scope.getState();
  await assert.rejects(h.host.act(a.context, { type: 'group.select', groupId }), { code: 'PAGE_CAPACITY' });
  assert.deepEqual(a.scope.getState(), before); assert.equal(h.engine.workspaceAllocations(a.created.workspaceId).pages.length, 1);
  await h.host.close(a.context);
});

test('native veto retains private identity; cleanup must acknowledge before memory disposal and registry release', async () => {
  const h = harness(), a = h.create(); await h.host.display(a.context); h.decision(false);
  assert.deepEqual(await h.host.close(a.context), { closed: false }); assert.equal(a.context.closing, false);
  assert.equal(a.scope.inspect().status, 'active'); assert.equal(h.registry.inspect().activeScopes, 1);
  h.decision(true); const hold = deferred(); h.cleanup(() => hold.promise);
  const closing = h.host.close(a.context);
  while (!h.order.includes('session-cleanup-start')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.scope.inspect().status, 'active'); assert.equal(h.registry.forContext(a.context), a.scope);
  await assert.rejects(h.host.act(a.context, { type: 'tab.create', workspaceId: a.created.workspaceId, input: '', activate: false }), { code: 'PRIVATE_SCOPE_STALE' });
  hold.resolve(); assert.deepEqual(await closing, { closed: true, disposed: true });
  assert.equal(a.scope.inspect().status, 'disposed'); assert.equal(a.context.closing, true); assert.equal(a.context.privateScopeId, a.created.scopeId);
  assert.throws(() => h.registry.forContext(a.context), { code: 'PRIVATE_SCOPE_RETIRED' });
  assert.equal(h.registry.inspect().activeScopes, 0); assert.ok(h.order.indexOf('native-close-ack') < h.order.indexOf('session-cleanup-ack'));
});

test('failed private cleanup keeps the exact lifetime quarantined and supports a close-only retry', async () => {
  const h = harness(), a = h.create(); await h.host.display(a.context);
  h.cleanup(async () => { throw failure('PRIVATE_CLEANUP_UNCERTAIN'); });
  await assert.rejects(h.host.close(a.context), { code: 'PRIVATE_CLEANUP_UNCERTAIN' });
  assert.equal(h.host.snapshot(a.context).privateBrowsing.status, 'cleanup-pending');
  assert.equal(a.scope.inspect().status, 'active'); assert.equal(a.context.closing, true); assert.equal(h.registry.inspect().activeScopes, 1);
  h.cleanup(async () => {}); await h.host.close(a.context); assert.equal(h.registry.inspect().activeScopes, 0);
});

test('delayed private document events do not overwrite a new document or require an obsolete chrome action', async () => {
  const h = harness(), a = h.create(); await h.host.display(a.context);
  const query = { workspaceId: a.created.workspaceId, tabId: a.scope.tabId };
  await h.engine.humanNavigate({ ...query, url: 'https://private.example/old' });
  h.host.observe({ ...query, reason: 'navigation-commit', target: h.engine.getTarget(query), navigation: h.engine.navigation(query) });
  await h.engine.humanNavigate({ ...query, url: 'https://private.example/new' }); h.actionCurrent(false);
  await h.host.flush(); assert.equal(a.scope.getState().tabs[0].url, 'about:blank');
  h.host.observe({ ...query, reason: 'navigation-commit', target: h.engine.getTarget(query), navigation: h.engine.navigation(query) });
  await h.host.flush(); assert.equal(a.scope.getState().tabs[0].url, 'https://private.example/new');
  await h.host.close(a.context);
  assert.equal(h.host.observe({ ...query, reason: 'page-title-updated', target: {}, navigation: { url: 'https://private.example/late' } }), true);
});

test('actual private native allocations require close acknowledgment even after presentation bookkeeping lost them', async () => {
  const h = harness(), a = h.create(); await h.host.display(a.context);
  const query = { workspaceId: a.created.workspaceId, tabId: a.scope.tabId };
  h.host.observe({ ...query, reason: 'page-closed' }); h.get(query).closing = true;
  assert.deepEqual(await h.host.act(a.context, { type: 'tab.close', tabId: a.scope.tabId }), { closed: false });
  assert.equal(a.scope.getState().tabs[0].status, 'open');
  h.get(query).destroyed = true; await h.host.act(a.context, { type: 'tab.close', tabId: a.scope.tabId });
  assert.equal(a.scope.getState().tabs[0].status, 'closed'); await h.host.close(a.context);
});

test('find-next preserves the current native search instead of resetting it', async () => {
  const h = harness(), a = h.create(); await h.host.display(a.context);
  const query = { type: 'find', tabId: a.scope.tabId, text: 'draft', forward: true, findNext: false, matchCase: false };
  await h.host.act(a.context, query); await h.host.act(a.context, { ...query, findNext: true });
  assert.equal(h.events.filter(item => item === 'find-stop').length, 0); assert.equal(h.events.at(-1).findNext, true);
  await h.host.close(a.context);
});

test('private reordered intent binds the exact reviewed revision through queued publication', async () => {
  const h = harness(), a = h.create();
  const added = await h.host.act(a.context, { type: 'tab.create', workspaceId: a.created.workspaceId, input: '', activate: false });
  const revision = a.scope.getState().revision;
  const first = h.host.act(a.context, { type: 'tab.reorder', tabId: added, beforeId: a.scope.tabId, expectedRevision: revision });
  const stale = h.host.act(a.context, { type: 'tab.reorder', tabId: a.scope.tabId, beforeId: added, expectedRevision: revision });
  await first; await assert.rejects(stale, { code: 'ORDER_STALE' });
  const tabs = a.scope.getState().tabs.filter(tab => tab.status === 'open').sort((left, right) => left.order - right.order);
  assert.deepEqual(tabs.map(tab => tab.id), [added, a.scope.tabId]);
  assert.equal(h.engine.workspaceAllocations(a.created.workspaceId).pages.length, 0);
  await h.host.close(a.context);
});
