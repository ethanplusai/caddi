import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand, validateProductState } from '../src/caddi/state/model.mjs';
import { createFolderRemovalUndo } from '../src/caddi/desktop/organization-undo.mjs';

const code = expected => error => error?.code === expected;
const run = (state, ...commands) => commands.reduce(applyProductCommand, state);
const folder = (id, parentId = null) => ({ type: 'folder.create', id, workspaceId: 'work', groupId: 'group', name: id, parentId });
function fixture() {
  return run(createProductState(),
    { type: 'workspace.create', id: 'work', identityId: 'identity', projectId: null, kind: 'personal', name: 'Work' },
    { type: 'workspace.create', id: 'other', identityId: 'other-identity', projectId: null, kind: 'personal', name: 'Other' },
    { type: 'group.create', id: 'group', workspaceId: 'work', name: 'Tabs', color: '#123456' },
    { type: 'group.create', id: 'another-group', workspaceId: 'work', name: 'Elsewhere', color: '#654321' },
    folder('before'), folder('parent'), folder('child', 'parent'), folder('after'),
    { type: 'folder.collapse', folderId: 'parent', collapsed: true },
    { type: 'tab.create', id: 'tab', workspaceId: 'work', groupId: 'group', url: 'https://example.test/initial', title: 'Initial', now: 1 },
    { type: 'tab.move', tabId: 'tab', groupId: 'group', folderId: 'child' },
    { type: 'tab.pin', tabId: 'tab', pinned: true });
}
function removal(undo, before = fixture(), folderId = 'parent') {
  const after = applyProductCommand(before, { type: 'folder.remove', folderId });
  return { before, after, receipt: undo.record(before, after, folderId) };
}

test('folder undo restores nested organization and insertion order without rolling back current page data or selection', () => {
  const undo = createFolderRemovalUndo(), { before, after, receipt } = removal(undo);
  const current = run(after, folder('new-folder'),
    { type: 'tab.update', tabId: 'tab', url: 'https://example.test/current', title: 'Current document' },
    { type: 'tab.rename', tabId: 'tab', label: 'New label' },
    { type: 'workspace.select', workspaceId: 'other' });
  const restored = applyProductCommand(current, undo.prepare(current, 'work', receipt.id));
  assert.deepEqual(restored.folders.map(item => item.id), ['before', 'parent', 'child', 'after', 'new-folder']);
  assert.deepEqual(restored.folders.filter(item => ['parent', 'child'].includes(item.id)), before.folders.filter(item => ['parent', 'child'].includes(item.id)));
  assert.deepEqual(restored.tabs, current.tabs.map(item => ({ ...item, folderId: 'child' })));
  assert.equal(restored.tabs[0].url, 'https://example.test/current');
  assert.equal(restored.activeWorkspaceId, 'other'); assert.deepEqual(restored.identities, current.identities);
  undo.complete(receipt.id); assert.deepEqual(undo.snapshot(restored, 'work'), { available: false });
});

test('intervening tab organization refuses the entire undo rather than overriding a newer placement', () => {
  const undo = createFolderRemovalUndo(), { after, receipt } = removal(undo);
  const moved = applyProductCommand(after, { type: 'tab.move', tabId: 'tab', groupId: 'another-group', folderId: null });
  const pristine = structuredClone(moved);
  assert.throws(() => undo.prepare(moved, 'work', receipt.id), code('UNDO_CONFLICT'));
  assert.deepEqual(moved, pristine); assert.equal(moved.folders.some(item => item.id === 'parent'), false);
  assert.deepEqual(undo.snapshot(moved, 'work'), { available: false });
});

test('undo cannot cross workspaces or a replaced identity and rejects a restored identifier collision', () => {
  const undo = createFolderRemovalUndo(), { after, receipt } = removal(undo);
  assert.throws(() => undo.prepare(after, 'other', receipt.id), code('UNDO_STALE'));
  const replaced = structuredClone(after); replaced.workspaces[0].identityId = 'replacement'; replaced.identities[0].id = 'replacement';
  assert.throws(() => undo.prepare(validateProductState(replaced), 'work', receipt.id), code('UNDO_STALE'));
  const collision = applyProductCommand(after, folder('child'));
  assert.throws(() => undo.prepare(collision, 'work', receipt.id), code('UNDO_CONFLICT'));
  assert.equal(collision.folders.find(item => item.id === 'child').parentId, null);
});

test('undo restores closed saved tab membership without reopening it and handles an absent unrelated order anchor', () => {
  const undo = createFolderRemovalUndo(), { after, receipt } = removal(undo);
  const closed = run(after, { type: 'tab.close', tabId: 'tab' }, { type: 'folder.remove', folderId: 'after' }, folder('later'));
  const result = applyProductCommand(closed, undo.prepare(closed, 'work', receipt.id));
  assert.deepEqual(result.tabs, closed.tabs.map(item => ({ ...item, folderId: 'child' })));
  assert.equal(result.tabs[0].dormant, true);
  assert.equal(result.folders.some(item => item.id === 'after'), false);
  assert.equal(result.folders.some(item => item.id === 'later'), true);
});

test('managed archive/reopen invalidates earlier folder undo even when the identity is retained', () => {
  let state = applyProductCommand(createProductState(), { type: 'workspace.provision', workspaceId: 'managed', identityId: 'managed-identity',
    projectId: 'project', groupId: 'managed-group', tabId: 'initial', logicalTaskId: 'task', name: 'Project', now: 1 });
  state = applyProductCommand(state, { type: 'folder.create', id: 'managed-folder', workspaceId: 'managed', groupId: 'managed-group', name: 'Notes', parentId: null });
  const undo = createFolderRemovalUndo(), before = state;
  state = applyProductCommand(state, { type: 'folder.remove', folderId: 'managed-folder' });
  const receipt = undo.record(before, state, 'managed-folder');
  state = applyProductCommand(state, { type: 'workspace.lifecycle', workspaceId: 'managed', identityId: 'managed-identity', expectedGeneration: 1, status: 'archived' });
  assert.throws(() => undo.prepare(state, 'managed', receipt.id), code('UNDO_STALE'));
  state = applyProductCommand(state, { type: 'workspace.reopen', workspaceId: 'managed', identityId: 'managed-identity', expectedGeneration: 2, initialTabId: 'initial', now: 2 });
  assert.throws(() => undo.prepare(state, 'managed', receipt.id), code('UNDO_STALE'));
});

test('core restoration validates every nested payload and all tab placements atomically', () => {
  const undo = createFolderRemovalUndo(), { after, receipt } = removal(undo);
  const command = undo.prepare(after, 'work', receipt.id), pristine = structuredClone(after);
  const foreign = structuredClone(command); foreign.folders[0].folder.workspaceId = 'other';
  assert.throws(() => applyProductCommand(after, foreign), code('WORKSPACE_MISMATCH'));
  const extra = structuredClone(command); extra.folders[0].folder.url = 'https://example.test/private';
  assert.throws(() => applyProductCommand(after, extra), code('INVALID_ARGUMENT'));
  const duplicate = structuredClone(command); duplicate.tabFolders.push(duplicate.tabFolders[0]);
  assert.throws(() => applyProductCommand(after, duplicate), code('UNDO_CONFLICT'));
  const badParent = structuredClone(command); badParent.folders[0].folder.parentId = 'child';
  assert.throws(() => applyProductCommand(after, badParent), code('FOLDER_CYCLE'));
  assert.deepEqual(after, pristine);
});

test('prepare does not consume on a failed save, while an already-published restore cannot be replayed', () => {
  const undo = createFolderRemovalUndo(), { after, receipt } = removal(undo);
  const first = undo.prepare(after, 'work', receipt.id);
  assert.deepEqual(undo.prepare(after, 'work', receipt.id), first);
  const result = applyProductCommand(after, first);
  assert.throws(() => undo.prepare(result, 'work', receipt.id), code('UNDO_CONFLICT'));
  undo.complete(receipt.id); assert.throws(() => undo.prepare(after, 'work', receipt.id), code('UNDO_STALE'));
});

test('undo retention is bounded, scoped and expires; forget/close retain no receipts', () => {
  let time = 100; const undo = createFolderRemovalUndo({ now: () => time, maximumEntries: 1, lifetimeMs: 100 });
  const a = removal(undo), b = removal(undo, a.after, 'before');
  assert.throws(() => undo.prepare(a.after, 'work', a.receipt.id), code('UNDO_STALE'));
  assert.equal(undo.snapshot(b.after, 'work').id, b.receipt.id);
  assert.deepEqual(undo.snapshot(b.after, 'other'), { available: false });
  time = 200; assert.deepEqual(undo.snapshot(b.after, 'work'), { available: false });
  const c = removal(undo); undo.forgetWorkspace('work'); assert.throws(() => undo.prepare(c.after, 'work', c.receipt.id), code('UNDO_STALE'));
  const d = removal(undo); undo.close(); assert.deepEqual(undo.snapshot(d.after, 'work'), { available: false });
  assert.throws(() => undo.prepare(d.after, 'work', d.receipt.id), code('CLOSED'));
});

test('oversized removal remains completed but is honestly unavailable for session undo', () => {
  const before = fixture();
  for (let i = 0; i < 1000; i++) before.folders.push({ id: 'bulk-' + i, workspaceId: 'work', groupId: 'group', name: 'Long folder '.padEnd(120, 'x'), parentId: 'parent', collapsed: false });
  const undo = createFolderRemovalUndo(), { after, receipt } = removal(undo, validateProductState(before));
  assert.deepEqual(receipt, { available: false, reason: 'UNDO_CAPACITY' });
  assert.equal(after.folders.some(item => item.id === 'parent'), false); assert.equal(after.tabs.length, 1);
  assert.deepEqual(undo.snapshot(after, 'work'), { available: false });
});
