import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand, validateProductState } from '../src/caddi/state/model.mjs';
import { createPrivateWorkspaceState } from '../src/caddi/desktop/private-state.mjs';

const code = expected => error => error?.code === expected;
const run = (state, ...commands) => commands.reduce(applyProductCommand, state);
const createFolder = (id, parentId = null, groupId = 'g1', workspaceId = 'w1') => ({ type: 'folder.create', id, parentId, groupId, workspaceId, name: id });
function fixture() {
  return run(createProductState(),
    { type: 'workspace.create', id: 'w1', identityId: 'i1', name: 'First', projectId: null, kind: 'personal' },
    { type: 'workspace.create', id: 'w2', identityId: 'i2', name: 'Second', projectId: null, kind: 'personal' },
    ...[['g1', 'w1'], ['foreign', 'w2'], ['g2', 'w1'], ['g3', 'w1']].map(([id, workspaceId]) => ({ type: 'group.create', id, workspaceId, name: id, color: '#123456' })),
    ...[['a', 'g1', 'w1'], ['x', 'foreign', 'w2'], ['b', 'g1', 'w1'], ['c', 'g1', 'w1'], ['d', 'g2', 'w1']].map(([id, groupId, workspaceId]) =>
      ({ type: 'tab.create', id, workspaceId, groupId, url: 'https://example.test/' + id, title: id, now: 1 })),
    createFolder('one'), createFolder('foreign-folder', null, 'foreign', 'w2'), createFolder('two'), createFolder('child', 'one'), createFolder('three'), createFolder('other-group', null, 'g2'));
}
const sorted = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));

test('ordinary tab ordering preserves entities, live selection, split and unrelated workspace order', () => {
  const before = run(fixture(), { type: 'tab.select', tabId: 'b', now: 3 },
    { type: 'layout.set', id: 'split', groupId: 'g1', tabIds: ['a', 'b'], orientation: 'horizontal', ratio: .4 });
  const original = structuredClone(before);
  const moved = applyProductCommand(before, { type: 'tab.reorder', tabId: 'c', beforeId: 'a' });
  assert.deepEqual(moved.tabs.filter(item => item.groupId === 'g1').map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(sorted(moved.tabs), sorted(before.tabs)); assert.deepEqual(moved.groups, before.groups);
  assert.deepEqual(moved.layouts, before.layouts); assert.deepEqual(moved.workspaces, before.workspaces);
  assert.deepEqual(before, original); assert.deepEqual(moved.tabs.filter(item => item.workspaceId === 'w2'), before.tabs.filter(item => item.workspaceId === 'w2'));
  const end = applyProductCommand(moved, { type: 'tab.reorder', tabId: 'c', beforeId: null });
  assert.deepEqual(end.tabs.filter(item => item.groupId === 'g1').map(item => item.id), ['a', 'b', 'c']);
  const self = applyProductCommand(end, { type: 'tab.reorder', tabId: 'a', beforeId: 'a' }); assert.deepEqual(self.tabs, end.tabs);
  assert.deepEqual(validateProductState(JSON.parse(JSON.stringify(end))), end);
});

test('favorites and pins can order across groups while retaining saved homes and dormant state', () => {
  for (const field of ['pinned', 'favorite']) {
    const state = run(fixture(), { type: field === 'pinned' ? 'tab.pin' : 'tab.favorite', tabId: 'a', [field]: true },
      { type: field === 'pinned' ? 'tab.pin' : 'tab.favorite', tabId: 'd', [field]: true }, { type: 'tab.close', tabId: 'a' });
    const result = applyProductCommand(state, { type: 'tab.reorder', tabId: 'd', beforeId: 'a' });
    assert.deepEqual(result.tabs.filter(item => item[field]).map(item => item.id), ['d', 'a']);
    assert.deepEqual(sorted(result.tabs), sorted(state.tabs)); assert.equal(result.tabs.find(item => item.id === 'a').dormant, true);
  }
});

test('folder and group reorder retain hierarchy, selection and independent entities', () => {
  const state = fixture(), result = run(state, { type: 'folder.reorder', folderId: 'three', beforeId: 'one' },
    { type: 'group.reorder', groupId: 'g3', beforeId: 'g1' });
  assert.deepEqual(result.folders.filter(item => item.groupId === 'g1' && item.parentId === null).map(item => item.id), ['three', 'one', 'two']);
  assert.deepEqual(result.groups.filter(item => item.workspaceId === 'w1').map(item => item.id), ['g3', 'g1', 'g2']);
  assert.deepEqual(sorted(result.groups), sorted(state.groups)); assert.deepEqual(sorted(result.folders), sorted(state.folders));
  assert.deepEqual(result.tabs, state.tabs); assert.deepEqual(result.workspaces, state.workspaces);
  const end = run(result, { type: 'folder.reorder', folderId: 'three', beforeId: null }, { type: 'group.reorder', groupId: 'g3', beforeId: null });
  assert.deepEqual(end.folders.filter(item => item.groupId === 'g1' && item.parentId === null).map(item => item.id), ['one', 'two', 'three']);
  assert.deepEqual(end.groups.filter(item => item.workspaceId === 'w1').map(item => item.id), ['g1', 'g2', 'g3']);
});

test('foreign workspace, parent, group, closed and saved-category targets fail atomically', () => {
  const state = run(fixture(), { type: 'tab.move', tabId: 'b', groupId: 'g1', folderId: 'one' }, { type: 'tab.pin', tabId: 'c', pinned: true });
  const before = structuredClone(state);
  for (const command of [
    { type: 'tab.reorder', tabId: 'a', beforeId: 'x' }, { type: 'tab.reorder', tabId: 'a', beforeId: 'b' },
    { type: 'tab.reorder', tabId: 'a', beforeId: 'd' }, { type: 'tab.reorder', tabId: 'a', beforeId: 'c' },
    { type: 'folder.reorder', folderId: 'one', beforeId: 'child' }, { type: 'folder.reorder', folderId: 'one', beforeId: 'foreign-folder' },
    { type: 'folder.reorder', folderId: 'one', beforeId: 'other-group' }, { type: 'group.reorder', groupId: 'g1', beforeId: 'foreign' },
  ]) assert.throws(() => applyProductCommand(state, command), code('ORDER_SCOPE_MISMATCH'));
  const closed = applyProductCommand(state, { type: 'tab.close', tabId: 'a' });
  assert.throws(() => applyProductCommand(closed, { type: 'tab.reorder', tabId: 'a', beforeId: null }), code('TAB_NOT_OPEN'));
  assert.throws(() => applyProductCommand(state, { type: 'tab.reorder', tabId: 'a', beforeId: 'missing' }), code('MISSING_REFERENCE'));
  assert.throws(() => applyProductCommand(state, { type: 'tab.reorder', tabId: 'a', beforeId: null, workspaceId: 'w2' }), code('INVALID_ARGUMENT'));
  assert.deepEqual(state, before);
});

test('private ordering remains in its own memory scope and rejects another scope anchor', async () => {
  const scope = createPrivateWorkspaceState(), other = createPrivateWorkspaceState();
  const act = command => scope.transact({ expectedRevision: scope.getState().revision, command });
  await act({ type: 'tab.create', id: 'second-private', workspaceId: scope.workspaceId, groupId: scope.groupId, url: 'about:blank', title: '', now: 2, activate: false });
  await act({ type: 'tab.reorder', tabId: 'second-private', beforeId: scope.tabId });
  assert.deepEqual(scope.getState().tabs.map(item => item.id), ['second-private', scope.tabId]);
  const before = scope.getState();
  await assert.rejects(act({ type: 'tab.reorder', tabId: 'second-private', beforeId: other.tabId }), code('MISSING_REFERENCE'));
  assert.deepEqual(scope.getState(), before); scope.dispose({ expectedGeneration: 1 }); other.dispose({ expectedGeneration: 1 });
});
