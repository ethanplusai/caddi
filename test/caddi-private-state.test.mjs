import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateWorkspaceState, PRIVATE_STATE_LIMITS } from '../src/caddi/desktop/private-state.mjs';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';

const code = value => error => error?.code === value;
const act = (scope, command, options) => scope.transact({ expectedRevision: scope.getState().revision, command }, options);

test('private scopes have fresh isolated human-only identities and cannot mutate ordinary metadata', async () => {
  const normal = applyProductCommand(createProductState(), { type: 'workspace.create', id: 'ordinary', identityId: 'ordinary-id', projectId: null, kind: 'personal', name: 'Ordinary' });
  const pristine = structuredClone(normal), a = createPrivateWorkspaceState({ settings: normal.settings }), b = createPrivateWorkspaceState();
  assert.notEqual(a.workspaceId, b.workspaceId); assert.notEqual(a.identityId, b.identityId); assert.notEqual(a.scopeId, b.scopeId);
  await act(a, { type: 'tab.update', tabId: a.tabId, url: 'https://example.test/PRIVATE_SENTINEL_NOT_SECRET', title: 'Private title' });
  assert.deepEqual(normal, pristine); assert.equal(b.getState().tabs[0].url, 'about:blank');
  assert.equal(a.getState().workspaces[0].agentPolicy, 'human-only');
  const copy = a.getState(); copy.tabs[0].title = 'Changed outside'; assert.equal(a.getState().tabs[0].title, 'Private title');
  assert.equal(a.inspect().ephemeral, true); assert.equal('files' in a, false); assert.equal('commit' in a, false);
});

test('private scope rejects project, agent, migration, foreign workspace and cross-scope tab mutations', async () => {
  const a = createPrivateWorkspaceState(), b = createPrivateWorkspaceState(), before = a.getState();
  for (const type of ['workspace.create', 'workspace.provision', 'workspace.lifecycle', 'workspace.reopen', 'project.create', 'worktree.bind', 'logicalTask.create', 'session.register', 'state.import', 'metadata.export']) {
    assert.throws(() => act(a, { type }), code('PRIVATE_COMMAND_DENIED'));
  }
  await assert.rejects(act(a, { type: 'workspace.select', workspaceId: b.workspaceId }), code('MISSING_REFERENCE'));
  await assert.rejects(act(a, { type: 'tab.update', tabId: b.tabId, url: 'https://example.test/foreign', title: 'Foreign' }), code('MISSING_REFERENCE'));
  await assert.rejects(act(a, { type: 'group.create', id: 'foreign-group', workspaceId: 'ordinary', name: 'Foreign', color: '#123456' }), code('MISSING_REFERENCE'));
  assert.deepEqual(a.getState(), before);
});

test('private organization, split and saved-home state remains usable within its own memory scope', async () => {
  const scope = createPrivateWorkspaceState({ now: () => 1 });
  await act(scope, { type: 'folder.create', id: 'notes', workspaceId: scope.workspaceId, groupId: scope.groupId, name: 'Notes', parentId: null });
  await act(scope, { type: 'tab.move', tabId: scope.tabId, groupId: scope.groupId, folderId: 'notes' });
  await act(scope, { type: 'tab.navigate', tabId: scope.tabId, url: 'https://example.test/private', now: 2 });
  await act(scope, { type: 'tab.pin', tabId: scope.tabId, pinned: true });
  await act(scope, { type: 'tab.duplicate', sourceTabId: scope.tabId, id: 'second-private-tab', now: 3 });
  await act(scope, { type: 'layout.set', id: 'private-split', groupId: scope.groupId, tabIds: [scope.tabId, 'second-private-tab'], orientation: 'horizontal', ratio: .5 });
  assert.equal(scope.getState().tabs.length, 2); assert.equal(scope.getState().layouts.length, 1);
  assert.equal(scope.getState().tabs[0].homeUrl, 'https://example.test/private');
  assert.deepEqual(scope.getState().projects, []); assert.deepEqual(scope.getState().sessions, []);
});

test('private CAS and synchronous commit fences reject stale or denied actions without publishing them', async () => {
  const scope = createPrivateWorkspaceState(), before = scope.getState();
  const command = { type: 'tab.rename', tabId: scope.tabId, label: 'One' };
  const first = scope.transact({ expectedRevision: before.revision, command });
  const stale = scope.transact({ expectedRevision: before.revision, command: { ...command, label: 'Two' } });
  await first; await assert.rejects(stale, code('REVISION_CONFLICT')); assert.equal(scope.getState().tabs[0].label, 'One');
  const current = scope.getState();
  for (const result of [false, null, 0, 1, 'yes', {}]) await assert.rejects(act(scope, { ...command, label: 'Denied' }, { beforeCommit: () => result }), code('FORBIDDEN'));
  await assert.rejects(act(scope, { ...command, label: 'Async' }, { beforeCommit: () => Promise.resolve(true) }), code('ASYNC_AUTHORIZATION_FENCE'));
  assert.deepEqual(scope.getState(), current);
});

test('disposal is generation-bound and fences already queued or callback-reentrant publication', async () => {
  const scope = createPrivateWorkspaceState();
  const pending = act(scope, { type: 'tab.rename', tabId: scope.tabId, label: 'Never published' });
  assert.throws(() => scope.dispose({ expectedGeneration: 99 }), code('PRIVATE_SCOPE_STALE'));
  scope.dispose({ expectedGeneration: 1 }); await assert.rejects(pending, code('PRIVATE_SCOPE_CLOSED'));
  await scope.flush(); assert.equal(scope.inspect().pending, 0); assert.equal(scope.inspect().revision, null);
  assert.throws(() => scope.getState(), code('PRIVATE_SCOPE_CLOSED'));
  assert.throws(() => scope.dispose({ expectedGeneration: 1 }), code('PRIVATE_SCOPE_STALE'));
  const second = createPrivateWorkspaceState();
  await assert.rejects(act(second, { type: 'tab.rename', tabId: second.tabId, label: 'No resurrection' }, { beforeCommit: () => second.dispose({ expectedGeneration: 1 }) }), code('PRIVATE_SCOPE_CLOSED'));
});

test('private queue and metadata limits reject atomically without trimming existing tabs', async () => {
  const scope = createPrivateWorkspaceState(), revision = scope.getState().revision;
  const requests = Array.from({ length: PRIVATE_STATE_LIMITS.pending }, (_, i) => scope.transact({ expectedRevision: revision + i, command: { type: 'tab.rename', tabId: scope.tabId, label: 'Label ' + i } }));
  assert.throws(() => act(scope, { type: 'tab.rename', tabId: scope.tabId, label: 'Overflow' }), code('PRIVATE_QUEUE_CAPACITY'));
  await Promise.all(requests); await scope.flush();
  for (let i = 1; i < PRIVATE_STATE_LIMITS.tabs; i++) await act(scope, { type: 'tab.create', id: 'private-extra-' + i, workspaceId: scope.workspaceId, groupId: scope.groupId, url: 'about:blank', title: '', now: i, activate: false });
  const full = scope.getState();
  await assert.rejects(act(scope, { type: 'tab.create', id: 'overflow', workspaceId: scope.workspaceId, groupId: scope.groupId, url: 'about:blank', title: '', now: 999, activate: false }), code('PRIVATE_STATE_CAPACITY'));
  assert.deepEqual(scope.getState(), full);
});
