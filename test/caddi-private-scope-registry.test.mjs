import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateScopeRegistry } from '../src/caddi/desktop/private-scope-registry.mjs';
import { createPrivateWorkspaceState } from '../src/caddi/desktop/private-state.mjs';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';

const code = expected => error => error?.code === expected;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function durableState() {
  let state = createProductState();
  for (const command of [
    { type: 'workspace.create', id: 'ordinary', identityId: 'ordinary-identity', name: 'Ordinary', kind: 'personal', projectId: null },
    { type: 'group.create', id: 'ordinary-group', workspaceId: 'ordinary', name: 'Tabs', color: '#123456' },
    { type: 'tab.create', id: 'ordinary-tab', workspaceId: 'ordinary', groupId: 'ordinary-group', url: 'https://synthetic.test/', title: 'Ordinary tab', now: 1 },
  ]) state = applyProductCommand(state, command);
  return state;
}
const privateTarget = (scope, tabId = scope.tabId) => ({ scopeId: scope.scopeId, workspaceId: scope.workspaceId, tabId });
const ordinaryTarget = tabId => ({ scopeId: 'durable', workspaceId: 'ordinary', tabId });
function fixture(maxOpenTabs = 256) {
  let durable = durableState();
  const registry = createPrivateScopeRegistry({ getDurableState: () => durable, maxOpenTabs });
  const scope = createPrivateWorkspaceState({ now: () => 1 }), owner = { id: 1 };
  return { registry, scope, owner, get durable() { return durable; }, set durable(value) { durable = value; } };
}
const dispose = (registry, owner, scope) => {
  const expectedGeneration = scope.generation; scope.dispose({ expectedGeneration });
  registry.release(owner, { expectedScopeId: scope.scopeId, expectedGeneration });
};

test('exact owner scopes stay separate from durable metadata and cannot transfer to another context', () => {
  const f = fixture(), before = structuredClone(f.durable);
  f.registry.attach(f.owner, f.scope);
  assert.equal(f.registry.forContext(f.owner), f.scope);
  assert.equal(f.registry.forContext({ id: 1 }), null);
  assert.equal(f.registry.forWorkspace(f.scope.workspaceId), f.scope);
  assert.equal(f.registry.forWorkspace('ordinary'), null);
  assert.throws(() => f.registry.attach({ id: 2 }, f.scope), code('PRIVATE_SCOPE_REUSED'));
  assert.throws(() => f.registry.attach(f.owner, createPrivateWorkspaceState()), code('PRIVATE_SCOPE_BINDING'));
  assert.deepEqual(f.durable, before);
  assert.doesNotMatch(JSON.stringify(f.registry.inspect()), /private-work-|https?:|synthetic/);
});

test('open normal, private and in-flight tabs share a single bounded admission count', () => {
  const f = fixture(4); f.registry.attach(f.owner, f.scope);
  const normal = f.registry.reserveTabs([ordinaryTarget('next-ordinary')]);
  const privateTab = f.registry.reserveTabs([privateTarget(f.scope, 'next-private')]);
  assert.equal(f.registry.inspect().committedAndReservedTabs, 4);
  assert.throws(() => f.registry.reserveTabs([ordinaryTarget('overflow')]), code('TAB_CAPACITY'));
  assert.throws(() => f.registry.attach({ id: 2 }, createPrivateWorkspaceState()), code('TAB_CAPACITY'));
  normal.release(); assert.equal(privateTab.assertCurrent(), true);
  const replacement = f.registry.reserveTabs([ordinaryTarget('after-cancel')]); replacement.release(); privateTab.release();
  assert.equal(f.registry.inspect().committedAndReservedTabs, 2);
});

test('existing tabs and duplicate reservations count once, and a committed new tab keeps its reserved slot', async () => {
  const f = fixture(3); f.registry.attach(f.owner, f.scope);
  const existing = f.registry.reserveTabs([ordinaryTarget('ordinary-tab'), privateTarget(f.scope)]);
  assert.equal(f.registry.inspect().committedAndReservedTabs, 2);
  assert.throws(() => existing.assertReserved([privateTarget(f.scope, 'unreserved-create')]), code('TAB_NOT_RESERVED'));
  const planned = privateTarget(f.scope, 'private-added'), a = f.registry.reserveTabs([planned]), b = f.registry.reserveTabs([planned]);
  assert.equal(a.assertReserved([planned]), true);
  assert.equal(f.registry.inspect().committedAndReservedTabs, 3);
  await f.scope.transact({ expectedRevision: f.scope.getState().revision, command: { type: 'tab.create', id: planned.tabId,
    workspaceId: f.scope.workspaceId, groupId: f.scope.groupId, url: 'about:blank', title: '', now: 2 } }, { beforeCommit: a.assertCurrent });
  assert.equal(b.assertCurrent(), true); a.release(); b.release(); existing.release();
  assert.equal(f.registry.inspect().committedAndReservedTabs, 3);
  assert.throws(() => f.registry.reserveTabs([ordinaryTarget('too-many')]), code('TAB_CAPACITY'));
});

test('disposal requires the exact owner and completed memory teardown and invalidates every held reservation', () => {
  const f = fixture(); f.registry.attach(f.owner, f.scope);
  const token = f.registry.reserveTabs([privateTarget(f.scope, 'pending-private')]);
  const release = { expectedScopeId: f.scope.scopeId, expectedGeneration: f.scope.generation };
  assert.throws(() => f.registry.release({ id: 1 }, release), code('PRIVATE_SCOPE_STALE'));
  assert.throws(() => f.registry.release(f.owner, release), code('PRIVATE_SCOPE_DISPOSAL_REQUIRED'));
  assert.throws(() => f.registry.close(), code('PRIVATE_SCOPES_OPEN'));
  const beforeGeneration = f.scope.generation;
  f.scope.dispose({ expectedGeneration: beforeGeneration });
  assert.equal(f.registry.forContext(f.owner), f.scope, 'disposed private context never falls through to durable routing');
  assert.throws(token.assertCurrent, code('PRIVATE_SCOPE_STALE'));
  f.registry.release(f.owner, release);
  assert.throws(token.assertCurrent, code('TAB_RESERVATION_STALE')); assert.throws(() => f.registry.forContext(f.owner), code('PRIVATE_SCOPE_RETIRED'));
  assert.throws(() => f.registry.release(f.owner, release), code('PRIVATE_SCOPE_STALE'));
  assert.throws(() => f.registry.attach(f.owner, createPrivateWorkspaceState()), code('PRIVATE_SCOPE_BINDING'));
  assert.equal(f.registry.inspect().reservations, 0); f.registry.close();
  assert.throws(() => f.registry.reserveTabs([ordinaryTarget('later')]), code('PRIVATE_REGISTRY_CLOSED'));
});

test('durable identity changes, archive and overflow fence held publication rather than relying on initial counts', () => {
  const f = fixture(2), token = f.registry.reserveTabs([ordinaryTarget('later')]);
  const original = f.durable;
  f.durable = { ...original, workspaces: original.workspaces.map(item => ({ ...item, identityId: 'replacement' })) };
  assert.throws(token.assertCurrent, code('TAB_RESERVATION_STALE'));
  f.durable = { ...original, workspaces: original.workspaces.map(item => ({ ...item, lifecycle: { status: 'archived', generation: 2 } })) };
  assert.throws(token.assertCurrent, code('WORKSPACE_CHANGED'));
  f.durable = applyProductCommand(original, { type: 'tab.create', id: 'unrelated-added', workspaceId: 'ordinary',
    groupId: 'ordinary-group', title: '', url: 'about:blank', now: 2 });
  assert.throws(token.assertCurrent, code('TAB_CAPACITY')); token.release();
});

test('scope and reservation bounds reject unknown or asynchronous state without widening access', () => {
  assert.throws(() => createPrivateScopeRegistry({ getDurableState: durableState, maxOpenTabs: 257 }), code('INVALID_ARGUMENT'));
  const f = fixture();
  assert.throws(() => f.registry.reserveTabs([privateTarget(f.scope)]), code('PRIVATE_SCOPE_STALE'));
  assert.throws(() => f.registry.reserveTabs([ordinaryTarget('same'), ordinaryTarget('same')]), code('INVALID_ARGUMENT'));
  const contexts = [], scopes = [];
  for (let i = 0; i < 8; i++) { const context = { id: i }, scope = createPrivateWorkspaceState(); contexts.push(context); scopes.push(scope); f.registry.attach(context, scope); }
  assert.throws(() => f.registry.attach({}, createPrivateWorkspaceState()), code('PRIVATE_SCOPE_CAPACITY'));
  for (let i = 0; i < scopes.length; i++) dispose(f.registry, contexts[i], scopes[i]);
  assert.equal(f.registry.inspect().activeScopes, 0);
  const asyncRegistry = createPrivateScopeRegistry({ getDurableState: async () => durableState() });
  assert.throws(() => asyncRegistry.reserveTabs([ordinaryTarget('normal')]), code('PRIVATE_ASYNC_SCOPE'));
});

const provision = suffix => ({ type: 'workspace.provision', workspaceId: 'managed-' + suffix, identityId: 'managed-identity-' + suffix,
  projectId: 'project-' + suffix, groupId: 'managed-group-' + suffix, tabId: 'managed-tab-' + suffix,
  logicalTaskId: 'managed-task-' + suffix, name: 'Managed fixture', now: 2 });

test('an exact trusted projection admits atomic provisioning before its identity exists and only its exact publication afterward', () => {
  const f = fixture(3); f.registry.attach(f.owner, f.scope);
  const command = provision('new'), next = applyProductCommand(f.durable, command);
  const target = { scopeId: 'durable', workspaceId: command.workspaceId, tabId: command.tabId };
  assert.throws(() => f.registry.reserveTabs([target]), code('WORKSPACE_CHANGED'));
  const token = f.registry.reserveTabs([target], { projectedDurableState: next });
  assert.equal(token.assertReserved([target]), true);
  assert.equal(f.registry.inspect().committedAndReservedTabs, 3);
  assert.throws(() => f.registry.reserveTabs([ordinaryTarget('one-too-many')]), code('TAB_CAPACITY'));
  // The durable store canonicalizes object-key order when it reads the previous
  // snapshot. That formatting difference must not invalidate the same state.
  const expected = canonical(next); next.tabs[0].title = 'caller mutation';
  f.durable = expected; assert.equal(token.assertCurrent(), true);
  f.durable = applyProductCommand(expected, { type: 'workspace.rename', workspaceId: command.workspaceId, name: 'Later state' });
  assert.throws(token.assertCurrent, code('TAB_RESERVATION_STALE')); token.release();
});

test('projected reopen binds the archived generation and requires every actual new tab to be reserved', () => {
  const f = fixture(3), command = provision('reopen');
  f.durable = applyProductCommand(f.durable, command);
  f.durable = applyProductCommand(f.durable, { type: 'tab.close', tabId: command.tabId });
  f.durable = applyProductCommand(f.durable, { type: 'workspace.lifecycle', workspaceId: command.workspaceId,
    identityId: command.identityId, expectedGeneration: 1, status: 'archived' });
  const next = applyProductCommand(f.durable, { type: 'workspace.reopen', workspaceId: command.workspaceId,
    identityId: command.identityId, expectedGeneration: 2, initialTabId: 'fresh-reopened-tab', now: 3 });
  const target = { scopeId: 'durable', workspaceId: command.workspaceId, tabId: 'fresh-reopened-tab' };
  assert.throws(() => f.registry.reserveTabs([ordinaryTarget('ordinary-tab')], { projectedDurableState: next }), code('TAB_NOT_RESERVED'));
  assert.throws(() => f.registry.reserveTabs([{ ...target, tabId: 'not-in-the-projection' }], { projectedDurableState: next }), code('TAB_NOT_RESERVED'));
  const token = f.registry.reserveTabs([target], { projectedDurableState: next });
  assert.equal(token.assertCurrent(), true);
  const before = f.durable; f.durable = structuredClone(next); f.durable.tabs[0].title = 'different same-revision publication';
  assert.throws(token.assertCurrent, code('TAB_RESERVATION_STALE'));
  f.durable = before; assert.equal(token.assertCurrent(), true);
  f.durable = next; assert.equal(token.assertCurrent(), true); token.release();
});

test('private attachment cannot overtake a reserved future durable workspace at the shared identity ceiling', () => {
  const f = fixture();
  for (let i = 0; i < 125; i++) f.durable = applyProductCommand(f.durable, { type: 'workspace.create',
    id: 'normal-' + i, identityId: 'identity-' + i, name: 'Normal', projectId: null, kind: 'personal' });
  f.registry.attach(f.owner, f.scope); assert.equal(f.registry.inspect().committedAndReservedWorkspaces, 127);
  const command = provision('last'), next = applyProductCommand(f.durable, command);
  const token = f.registry.reserveTabs([{ scopeId: 'durable', workspaceId: command.workspaceId, tabId: command.tabId }], { projectedDurableState: next });
  assert.equal(f.registry.inspect().committedAndReservedWorkspaces, 128);
  assert.throws(() => f.registry.attach({}, createPrivateWorkspaceState()), code('WORKSPACE_CAPACITY'));
  f.durable = next; assert.equal(token.assertCurrent(), true); token.release();
  const extra = provision('overflow'), overflow = applyProductCommand(f.durable, extra);
  assert.throws(() => f.registry.reserveTabs([{ scopeId: 'durable', workspaceId: extra.workspaceId, tabId: extra.tabId }],
    { projectedDurableState: overflow }), code('WORKSPACE_CAPACITY'));
});

test('empty imported workspace identity occupies a reserved slot before and after its exact publication', () => {
  const f = fixture();
  const next = applyProductCommand(f.durable, { type: 'workspace.create', id: 'empty-import', identityId: 'empty-import-identity',
    name: 'Empty imported workspace', kind: 'personal', projectId: null });
  assert.throws(() => f.registry.reserveTabs([]), code('TAB_CAPACITY'));
  const token = f.registry.reserveTabs([], { projectedDurableState: next });
  assert.equal(token.assertReserved([]), true);
  assert.equal(f.registry.inspect().committedAndReservedDurableWorkspaces, 2);
  assert.equal(f.registry.inspect().committedAndReservedTabs, 1);
  const before = f.durable; f.durable = { ...next, workspaces: next.workspaces.map(workspace => ({ ...workspace, name: 'unreviewed' })) };
  assert.throws(token.assertCurrent, code('TAB_RESERVATION_STALE'));
  f.durable = before; assert.equal(token.assertCurrent(), true);
  f.durable = next; assert.equal(token.assertCurrent(), true);
  assert.equal(f.registry.inspect().committedAndReservedDurableWorkspaces, 2); token.release();
  assert.equal(f.registry.inspect().committedAndReservedDurableWorkspaces, 2);
});

test('empty workspace reservations prevent concurrent private attachment from overtaking the shared identity ceiling', () => {
  const f = fixture();
  for (let index = 0; index < 125; index++) f.durable = applyProductCommand(f.durable, { type: 'workspace.create',
    id: 'existing-' + index, identityId: 'existing-identity-' + index, name: 'Existing', kind: 'personal', projectId: null });
  f.registry.attach(f.owner, f.scope);
  const next = applyProductCommand(f.durable, { type: 'workspace.create', id: 'empty-last', identityId: 'empty-last-identity',
    name: 'Last empty workspace', kind: 'personal', projectId: null });
  const token = f.registry.reserveTabs([], { projectedDurableState: next });
  assert.equal(f.registry.inspect().committedAndReservedWorkspaces, 128);
  assert.throws(() => f.registry.attach({}, createPrivateWorkspaceState()), code('WORKSPACE_CAPACITY'));
  token.release(); const owner = {}, scope = createPrivateWorkspaceState(); f.registry.attach(owner, scope);
  assert.equal(f.registry.inspect().committedAndReservedWorkspaces, 128);
});
