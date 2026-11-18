import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { createDesktopWorkspaceLifecycle } from '../src/caddi/desktop/workspace-host.mjs';
import { createPageResidency } from '../src/caddi/desktop/page-residency.mjs';
const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = n => ({ workspaceId: 'w-' + n, identityId: 'i-' + n, projectId: 'p-' + n, groupId: 'g-' + n,
  tabId: 't-' + n, logicalTaskId: 'task-' + n, name: 'Workspace ' + n, assertCurrent: () => true });
function fixture(t, options = {}) {
  let state = createProductState(), release = true, valid = true, nativeCreates = 0, nativeReleases = 0, preflights = 0;
  const pages = new Map(), identities = new Map(), storage = new Map();
  const residency = createPageResidency({ listAllocations: () => [...pages].flatMap(([workspaceId, list]) => list.map(page => ({ workspaceId, tabId: page.tabId }))) });
  const engine = {
    reservePages: residency.reserve,
    createWorkspace({ workspaceId, identityId }) {
      if (identities.has(workspaceId)) assert.equal(identities.get(workspaceId), identityId);
      else { identities.set(workspaceId, identityId); storage.set(identityId, { cookie: 'synthetic-' + identityId }); }
      if (!pages.has(workspaceId)) pages.set(workspaceId, []);
    },
    workspaceActivity(workspaceId) { return { workspaceId, pages: (pages.get(workspaceId) ?? []).map(item => ({ ...item })) }; },
    async releaseWorkspacePages({ workspaceId, beforeRelease }) {
      nativeReleases++; beforeRelease(); await options.beforeRelease?.();
      if (options.unloadVeto) return { pages: 'retained', reason: 'OWNER_REVIEW_REQUIRED' };
      beforeRelease(); pages.set(workspaceId, []); return { pages: 'released' };
    },
  };
  const host = createDesktopWorkspaceLifecycle({ getState: () => state, engine,
    async commit(command, fence) { await options.beforeCommit?.(command); fence(); state = applyProductCommand(state, command); return state; },
    ensureTab(tab, reservation) { residency.assertReserved(reservation, { workspaceId: tab.workspaceId, tabId: tab.id });
      nativeCreates++; pages.set(tab.workspaceId, [...(pages.get(tab.workspaceId) ?? []), { tabId: tab.id, ready: true, incarnation: nativeCreates }]); },
    canRelease: () => release, preflight: async () => { preflights++; await options.preflight?.(); }, isOpen: () => valid });
  t.after(() => host.close());
  return { host, engine, pages, storage, identities, get: () => structuredClone(state),
    command(command) { state = applyProductCommand(state, command); },
    capacity(count) { for (let i = 0; i < count; i++) { const id = 'capacity-' + i; state = applyProductCommand(state, { type: 'workspace.create', id, identityId: 'identity-' + i, name: id, projectId: null, kind: 'personal' }); pages.set(id, [{ tabId: 'page-' + i, ready: true }]); } },
    retained() { release = false; }, allowed() { release = true; }, revoke() { valid = false; },
    counts: () => ({ nativeCreates, nativeReleases, preflights }) };
}
const mutate = (created, assertCurrent = () => true) => ({ workspaceId: created.workspaceId, identityId: created.identityId, generation: created.generation, assertCurrent });

test('provision leaves selection untouched; clean retire/reopen keeps identity/storage and creates a fresh native page', async t => {
  const f = fixture(t), plan = input('a');
  const created = await f.host.provision(plan);
  assert.equal(f.get().activeWorkspaceId, null); assert.equal(created.initialTabId, plan.tabId);
  const cookie = f.storage.get(plan.identityId), originalPage = f.pages.get(plan.workspaceId)[0];
  const retired = await f.host.retire(mutate(created));
  assert.equal(retired.pages, 'released'); assert.equal(retired.state, 'archived'); assert.equal(retired.generation, 2);
  assert.equal(f.get().tabs.length, 1); assert.equal(f.storage.get(plan.identityId), cookie);
  const reopened = await f.host.reopen(mutate(retired));
  assert.equal(reopened.generation, 3); assert.equal(reopened.identityId, created.identityId);
  assert.notEqual(f.pages.get(plan.workspaceId)[0].incarnation, originalPage.incarnation);
  assert.equal(f.storage.get(plan.identityId), cookie); assert.equal(f.get().activeWorkspaceId, null);
  await assert.rejects(f.host.reopen(mutate(retired)), code('WORKSPACE_LIFECYCLE_STALE'));
});

test('protected pages and unload veto produce retained receipts, advance generation and never reopen agent scope', async t => {
  const f = fixture(t), created = await f.host.provision(input('a')); f.retained();
  const before = structuredClone(f.pages.get('w-a'));
  const result = await f.host.retire(mutate(created));
  assert.equal(result.state, 'retired'); assert.equal(result.pages, 'retained'); assert.equal(result.generation, 2);
  assert.deepEqual(f.pages.get('w-a'), before); assert.equal(f.counts().nativeReleases, 0);
  await assert.rejects(f.host.reopen(mutate(result)), code('WORKSPACE_LIFECYCLE_STALE'));
  f.allowed(); const retry = await f.host.retire(mutate(result));
  assert.equal(retry.state, 'archived'); assert.equal(retry.generation, 3);
  const vetoed = fixture(t, { unloadVeto: true }), active = await vetoed.host.provision(input('veto'));
  const retained = await vetoed.host.retire(mutate(active));
  assert.equal(retained.pages, 'retained'); assert.equal(vetoed.pages.get('w-veto').length, 1);
});

test('queued/revoked creation never publishes metadata or creates a native page', async t => {
  const entered = deferred(), leave = deferred();
  const f = fixture(t, { preflight: async () => { entered.resolve(); await leave.promise; } });
  const task = f.host.provision(input('a')); await entered.promise;
  assert.equal(f.host.isBusy('w-a'), true); f.revoke(); leave.resolve();
  await assert.rejects(task, code('WORKSPACE_LIFECYCLE_STALE'));
  assert.equal(f.get().workspaces.length, 0); assert.equal(f.counts().nativeCreates, 0); assert.equal(f.host.isBusy('w-a'), false);
});

test('reopen atomically binds a retained fallback when the original initial tab was closed', async t => {
  const f = fixture(t), created = await f.host.provision(input('a'));
  f.command({ type: 'tab.create', id: 'fallback', workspaceId: 'w-a', groupId: 'g-a', url: 'about:blank', title: '', now: 1, activate: false });
  f.command({ type: 'tab.close', tabId: 't-a' });
  const retired = await f.host.retire(mutate(created));
  const reopened = await f.host.reopen(mutate(retired));
  assert.equal(reopened.initialTabId, 'fallback');
  assert.equal(f.get().workspaces[0].lifecycle.initialTabId, reopened.initialTabId);
  assert.equal(f.get().tabs.find(tab => tab.id === 't-a').status, 'closed');
  assert.equal(f.get().activeWorkspaceId, null);
});

test('reopen with every tab closed adds one blank bootstrap without overwriting saved tab metadata', async t => {
  const f = fixture(t), created = await f.host.provision(input('a'));
  f.command({ type: 'tab.navigate', tabId: 't-a', url: 'https://example.test/saved', now: Date.now() });
  f.command({ type: 'tab.close', tabId: 't-a' });
  const closed = f.get().tabs[0], retired = await f.host.retire(mutate(created));
  const reopened = await f.host.reopen(mutate(retired));
  assert.notEqual(reopened.initialTabId, 't-a');
  assert.equal(f.get().workspaces[0].lifecycle.initialTabId, reopened.initialTabId);
  assert.deepEqual(f.get().tabs.find(tab => tab.id === 't-a'), closed);
  assert.equal(f.get().tabs.find(tab => tab.id === reopened.initialTabId).url, 'about:blank');
  assert.equal(f.get().groups[0].activeTabId, reopened.initialTabId);
  assert.equal(f.get().activeWorkspaceId, null);
});

test('publication rechecks authority after async staging; no partial project/task/workspace records', async t => {
  let allowed = true;
  const f = fixture(t, { beforeCommit: () => { allowed = false; } });
  await assert.rejects(f.host.provision({ ...input('a'), assertCurrent: () => allowed }), code('WORKSPACE_LIFECYCLE_STALE'));
  assert.equal(f.get().workspaces.length, 0); assert.equal(f.get().projects.length, 0); assert.equal(f.counts().nativeCreates, 0);
});

test('the 33rd resident is rejected before awaiting resources, allowing owner close to proceed', async t => {
  const f = fixture(t); f.capacity(31);
  const created = await f.host.provision(input('last')); assert.equal(created.generation, 1);
  // Keep workspace metadata below its independent32 bound while exercising native capacity.
  f.pages.get('capacity-0').push({ tabId: 'extra', ready: true });
  const current = f.get();
  // Reopen an archived metadata workspace while32 other native pages remain.
  f.command({ type: 'workspace.lifecycle', workspaceId: 'w-last', identityId: 'i-last', expectedGeneration: 1, status: 'archived' });
  f.pages.set('w-last', []);
  await assert.rejects(f.host.reopen({ workspaceId: 'w-last', identityId: 'i-last', generation: 2, assertCurrent: () => true }), code('PAGE_CAPACITY'));
  assert.equal(f.counts().preflights, 1); assert.equal(current.workspaces.length, 32);
});

test('256 open metadata bound leaves160-tab workload room and rejects new managed bootstrap before native work', async t => {
  const f = fixture(t), first = await f.host.provision(input('a'));
  for (let n = 1; n < 256; n++) f.command({ type: 'tab.create', id: 'metadata-' + n, workspaceId: 'w-a', groupId: 'g-a', url: 'about:blank', title: '', now: 1, activate: false });
  await assert.rejects(f.host.provision(input('b')), code('TAB_CAPACITY'));
  assert.equal(f.get().tabs.length, 256); assert.equal(f.get().groups[0].activeTabId, first.initialTabId);
  assert.equal(f.counts().nativeCreates, 1); assert.equal(f.counts().preflights, 1);
});
