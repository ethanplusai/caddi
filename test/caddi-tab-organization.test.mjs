import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductState, applyProductCommand, validateProductState, PRODUCT_SCHEMA_VERSION } from '../src/caddi/state/model.mjs';
import { createProductStore } from '../src/caddi/state/store.mjs';

const code = expected => error => error?.code === expected;
const run = (state, ...commands) => commands.reduce(applyProductCommand, state);
const tab = (state, id) => state.tabs.find(item => item.id === id);
const group = (state, id) => state.groups.find(item => item.id === id);
const folder = (state, id) => state.folders.find(item => item.id === id);
const createFolder = (id, parentId = null, groupId = 'g-a', workspaceId = 'w-a') => ({ type: 'folder.create', id, workspaceId, groupId, name: id, parentId });
function fixture() {
  return run(createProductState(),
    { type: 'workspace.create', id: 'w-a', identityId: 'i-a', name: 'A', projectId: null, kind: 'personal' },
    { type: 'workspace.create', id: 'w-b', identityId: 'i-b', name: 'B', projectId: null, kind: 'personal' },
    { type: 'group.create', id: 'g-a', workspaceId: 'w-a', name: 'Main', color: '#123456' },
    { type: 'group.create', id: 'g-other', workspaceId: 'w-a', name: 'Other', color: '#654321' },
    { type: 'group.create', id: 'g-b', workspaceId: 'w-b', name: 'B', color: '#abcdef' },
    ...[['a', 'w-a', 'g-a'], ['b', 'w-a', 'g-a'], ['c', 'w-a', 'g-other'], ['x', 'w-b', 'g-b']].map(([id, workspaceId, groupId]) =>
      ({ type: 'tab.create', id, workspaceId, groupId, url: 'https://example.test/' + id, title: id, now: 100 })));
}

test('nested folder metadata remains schema-compatible and renames/collapse do not mutate input', () => {
  const initial = fixture(), before = structuredClone(initial);
  const result = run(initial, createFolder('parent'), createFolder('child', 'parent'),
    { type: 'group.rename', groupId: 'g-a', name: 'Client work', color: '#337765' },
    { type: 'folder.rename', folderId: 'child', name: 'References' },
    { type: 'folder.collapse', folderId: 'parent', collapsed: true },
    { type: 'tab.move', tabId: 'a', groupId: 'g-a', folderId: 'child' });
  assert.equal(PRODUCT_SCHEMA_VERSION, 2);
  assert.deepEqual(initial, before);
  assert.equal(group(result, 'g-a').name, 'Client work');
  assert.equal(group(result, 'g-a').color, '#337765');
  assert.equal(folder(result, 'parent').collapsed, true);
  assert.equal(folder(result, 'child').name, 'References');
  assert.equal(folder(result, 'child').parentId, 'parent');
  assert.equal(tab(result, 'a').folderId, 'child');
  assert.deepEqual(validateProductState(JSON.parse(JSON.stringify(result))), result);
});

test('folder reparenting rejects cycles and foreign ownership without partial changes', () => {
  const state = run(fixture(), createFolder('parent'), createFolder('child', 'parent'), createFolder('grandchild', 'child'),
    createFolder('same-workspace-other-group', null, 'g-other'), createFolder('foreign', null, 'g-b', 'w-b'));
  const before = structuredClone(state);
  for (const parentId of ['parent', 'child', 'grandchild']) assert.throws(() =>
    applyProductCommand(state, { type: 'folder.move', folderId: 'parent', parentId }), code('FOLDER_CYCLE'));
  assert.throws(() => applyProductCommand(state, { type: 'folder.move', folderId: 'child', parentId: 'foreign' }), code('WORKSPACE_MISMATCH'));
  assert.throws(() => applyProductCommand(state, { type: 'folder.move', folderId: 'child', parentId: 'same-workspace-other-group' }), code('GROUP_MISMATCH'));
  assert.throws(() => applyProductCommand(state, createFolder('bad', null, 'g-b')), code('WORKSPACE_MISMATCH'));
  assert.deepEqual(state, before);
  const moved = applyProductCommand(state, { type: 'folder.move', folderId: 'child', parentId: null });
  assert.equal(folder(moved, 'child').parentId, null);
  assert.equal(folder(moved, 'grandchild').parentId, 'child');
});

test('removing a nested folder ungroups all descendants without deleting tabs or saved homes', () => {
  const state = run(fixture(), createFolder('parent'), createFolder('child', 'parent'), createFolder('unrelated'),
    { type: 'tab.move', tabId: 'a', groupId: 'g-a', folderId: 'parent' },
    { type: 'tab.move', tabId: 'b', groupId: 'g-a', folderId: 'child' },
    { type: 'tab.pin', tabId: 'b', pinned: true },
    { type: 'tab.close', tabId: 'b' });
  const result = applyProductCommand(state, { type: 'folder.remove', folderId: 'parent' });
  assert.deepEqual(result.folders.map(item => item.id), ['unrelated']);
  assert.equal(result.tabs.length, state.tabs.length);
  assert.deepEqual(result.tabs, state.tabs.map(item => ['a', 'b'].includes(item.id) ? { ...item, folderId: null } : item));
  assert.deepEqual(result.identities, state.identities);
  assert.equal(tab(result, 'b').homeUrl, 'https://example.test/b');
  assert.equal(tab(result, 'b').dormant, true);
});

test('moving an active ordinary tab repairs old splits without switching workspace or destination selection', () => {
  const state = run(fixture(), createFolder('destination', null, 'g-other'),
    { type: 'tab.select', tabId: 'a', now: 101 },
    { type: 'layout.set', id: 'split', groupId: 'g-a', tabIds: ['a', 'b'], orientation: 'horizontal', ratio: 0.5 });
  const result = applyProductCommand(state, { type: 'tab.move', tabId: 'a', groupId: 'g-other', folderId: 'destination' });
  assert.equal(tab(result, 'a').workspaceId, 'w-a');
  assert.equal(tab(result, 'a').groupId, 'g-other');
  assert.equal(tab(result, 'a').folderId, 'destination');
  assert.deepEqual(result.identities, state.identities);
  assert.equal(result.activeWorkspaceId, 'w-a');
  assert.equal(result.workspaces[0].activeGroupId, 'g-a');
  assert.equal(group(result, 'g-a').activeTabId, 'b');
  assert.equal(group(result, 'g-other').activeTabId, 'c');
  assert.equal(group(result, 'g-a').activeLayoutId, null);
  assert.deepEqual(result.layouts, []);
});

test('moving within one group retains split layout and foreign moves cannot change identity', () => {
  const state = run(fixture(), createFolder('local'), createFolder('other', null, 'g-other'), createFolder('foreign', null, 'g-b', 'w-b'),
    { type: 'layout.set', id: 'split', groupId: 'g-a', tabIds: ['a', 'b'], orientation: 'vertical', ratio: 0.4 });
  const result = applyProductCommand(state, { type: 'tab.move', tabId: 'a', groupId: 'g-a', folderId: 'local' });
  assert.deepEqual(result.layouts, state.layouts);
  assert.throws(() => applyProductCommand(state, { type: 'tab.move', tabId: 'a', groupId: 'g-b', folderId: null }), code('WORKSPACE_MISMATCH'));
  assert.throws(() => applyProductCommand(state, { type: 'tab.move', tabId: 'a', groupId: 'g-a', folderId: 'foreign' }), code('WORKSPACE_MISMATCH'));
  assert.throws(() => applyProductCommand(state, { type: 'tab.move', tabId: 'a', groupId: 'g-a', folderId: 'other' }), code('GROUP_MISMATCH'));
});

test('a favorite can remain active across groups, and removing favorite repairs only now-invalid references', () => {
  let state = run(fixture(),
    { type: 'tab.favorite', tabId: 'a', favorite: true },
    { type: 'tab.select', tabId: 'a', now: 101 },
    { type: 'layout.set', id: 'home-split', groupId: 'g-a', tabIds: ['a', 'b'], orientation: 'horizontal', ratio: 0.5 },
    { type: 'layout.set', id: 'other-split', groupId: 'g-other', tabIds: ['a', 'c'], orientation: 'horizontal', ratio: 0.5 });
  group(state, 'g-other').activeTabId = 'a';
  state = applyProductCommand(state, { type: 'tab.move', tabId: 'a', groupId: 'g-other', folderId: null });
  assert.equal(group(state, 'g-a').activeTabId, 'a');
  assert.equal(state.layouts.length, 2);
  const result = applyProductCommand(state, { type: 'tab.favorite', tabId: 'a', favorite: false });
  assert.equal(group(result, 'g-a').activeTabId, 'b');
  assert.equal(group(result, 'g-a').activeLayoutId, null);
  assert.equal(group(result, 'g-other').activeTabId, 'a');
  assert.equal(group(result, 'g-other').activeLayoutId, 'other-split');
  assert.deepEqual(result.layouts.map(item => item.id), ['other-split']);
  assert.equal(tab(result, 'a').homeUrl, null);
  validateProductState(result);
});

test('duplicate copies the current destination and organization, never saved flags or runtime authority', () => {
  const state = run(fixture(), createFolder('notes'),
    { type: 'tab.move', tabId: 'a', groupId: 'g-a', folderId: 'notes' },
    { type: 'tab.favorite', tabId: 'a', favorite: true },
    { type: 'tab.pin', tabId: 'a', pinned: true },
    { type: 'tab.rename', tabId: 'a', label: 'Design brief' },
    { type: 'tab.update', tabId: 'a', url: 'https://example.test/current', title: 'Current page' });
  const result = applyProductCommand(state, { type: 'tab.duplicate', sourceTabId: 'a', id: 'duplicate', now: 200 });
  assert.deepEqual(tab(result, 'duplicate'), { id: 'duplicate', workspaceId: 'w-a', groupId: 'g-a', folderId: 'notes',
    url: 'https://example.test/current', title: 'Current page', label: 'Design brief', pinned: false, favorite: false,
    homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: 200, lastActiveAt: 200, archivedAt: null, legacyGroupId: null });
  assert.deepEqual(tab(result, 'a'), tab(state, 'a'));
  assert.deepEqual(result.sessions, state.sessions);
  assert.deepEqual(result.identities, state.identities);
  assert.equal(group(result, 'g-a').activeTabId, 'duplicate');
  assert.throws(() => applyProductCommand(state, { type: 'tab.duplicate', sourceTabId: 'a', id: 'b', now: 200 }), code('DUPLICATE_ID'));
});

test('closed and dormant sources cannot be duplicated, and command shapes reject authority or invalid metadata', () => {
  const state = run(fixture(), { type: 'tab.pin', tabId: 'a', pinned: true },
    { type: 'tab.close', tabId: 'a' }, { type: 'tab.close', tabId: 'b' }, createFolder('folder'));
  for (const sourceTabId of ['a', 'b']) assert.throws(() =>
    applyProductCommand(state, { type: 'tab.duplicate', sourceTabId, id: 'copy', now: 200 }), code('TAB_NOT_OPEN'));
  assert.throws(() => applyProductCommand(state, { ...createFolder('extra'), identityId: 'i-b' }), code('INVALID_ARGUMENT'));
  assert.throws(() => applyProductCommand(state, { type: 'tab.move', tabId: 'c', groupId: 'g-a', folderId: null, workspaceId: 'w-b' }), code('INVALID_ARGUMENT'));
  assert.throws(() => applyProductCommand(state, { type: 'folder.collapse', folderId: 'folder', collapsed: 'false' }), code('INVALID_STATE'));
  assert.throws(() => applyProductCommand(state, { type: 'group.rename', groupId: 'g-a', name: 'Valid', color: 'invalid' }), code('INVALID_STATE'));
});

test('organization commands persist through the existing atomic store without a schema migration', async t => {
  const base = fileURLToPath(new URL('../.test-artifacts/', import.meta.url));
  await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'caddi-organization-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'metadata'), store = createProductStore({ directory });
  let state = await store.load();
  for (const command of [
    { type: 'workspace.create', id: 'w', identityId: 'i', name: 'Project', projectId: null, kind: 'personal' },
    { type: 'group.create', id: 'g', workspaceId: 'w', name: 'Tabs', color: '#337765' },
    createFolder('folder', null, 'g', 'w'),
    { type: 'tab.create', id: 'tab', workspaceId: 'w', groupId: 'g', url: 'https://example.test/', title: 'Example', now: 100 },
    { type: 'tab.move', tabId: 'tab', groupId: 'g', folderId: 'folder' },
    { type: 'folder.collapse', folderId: 'folder', collapsed: true },
    { type: 'tab.duplicate', sourceTabId: 'tab', id: 'copy', now: 101 },
  ]) state = (await store.transact({ expectedRevision: state.revision, command })).state;
  const restored = await createProductStore({ directory }).load();
  assert.deepEqual(restored, state);
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.folders[0].collapsed, true);
  assert.equal(tab(restored, 'copy').folderId, 'folder');
});
