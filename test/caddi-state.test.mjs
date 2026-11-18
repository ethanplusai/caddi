import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand, validateProductState, exportProductMetadata, STATE_LIMITS, assertPageURL } from '../src/caddi/state/model.mjs';

const code = expected => error => error?.code === expected;
const workspace = (state, n, projectId = null) => applyProductCommand(state, { type: 'workspace.create', id: 'workspace-' + n, identityId: 'identity-' + n, name: 'Workspace ' + n, projectId, kind: projectId ? 'project' : 'personal' });
function populated(count = 24) {
  let state = createProductState();
  for (let n = 0; n < count; n++) {
    state = workspace(state, n);
    state = applyProductCommand(state, { type: 'group.create', id: 'group-' + n, workspaceId: 'workspace-' + n, name: 'Tabs', color: '#123456' });
    state = applyProductCommand(state, { type: 'tab.create', id: 'tab-' + n, workspaceId: 'workspace-' + n, groupId: 'group-' + n, title: 'Document ' + n, url: 'https://example.com/project/' + n, now: 100 });
  }
  return state;
}

test('24 independent workspace identities and tabs survive detached validation', () => {
  const state = populated();
  const result = validateProductState(state);
  assert.equal(result.workspaces.length, 24);
  assert.equal(new Set(result.workspaces.map(item => item.identityId)).size, 24);
  assert.ok(result.workspaces.every(item => item.agentPolicy === 'human-only'));
  assert.ok(result.identities.every(item => item.requiredIsolation === 'full-profile' && item.engineRef === null));
  result.workspaces[0].name = 'Changed';
  assert.equal(state.workspaces[0].name, 'Workspace 0');
  const changed = applyProductCommand(state, { type: 'tab.navigate', tabId: 'tab-0', url: 'https://other.example/', now: 200 });
  assert.equal(changed.tabs[1].url, state.tabs[1].url);
  assert.equal(state.tabs[0].url, 'https://example.com/project/0');
});

test('cross-workspace identity/tab/folder references fail closed', () => {
  const state = populated(2);
  const alias = structuredClone(state); alias.workspaces[1].identityId = 'identity-0';
  assert.throws(() => validateProductState(alias), code('IDENTITY_MISMATCH'));
  const profileAlias = structuredClone(state);
  profileAlias.identities.forEach(item => { item.engineRef = 'shared-profile'; });
  assert.throws(() => validateProductState(profileAlias), code('IDENTITY_MISMATCH'));
  const crossed = structuredClone(state); crossed.tabs[0].groupId = 'group-1'; crossed.groups[0].activeTabId = null;
  assert.throws(() => validateProductState(crossed), code('WORKSPACE_MISMATCH'));
  const cyclic = structuredClone(state);
  cyclic.folders.push({ id: 'folder-a', workspaceId: 'workspace-0', groupId: 'group-0', name: 'A', parentId: 'folder-a', collapsed: false });
  assert.throws(() => validateProductState(cyclic), code('FOLDER_CYCLE'));
});

test('unknown, secret, authority and active runtime fields cannot persist', () => {
  const state = populated(1);
  for (const [entity, key, value] of [[state, 'leases', []], [state.identities[0], 'cookies', []], [state.tabs[0], 'password', 'synthetic'], [state.workspaces[0], 'grant', {}]]) {
    entity[key] = value;
    assert.throws(() => validateProductState(state), code('INVALID_ARGUMENT'));
    delete entity[key];
  }
  const live = applyProductCommand(state, { type: 'session.register', id: 'session-1', workspaceId: 'workspace-0', logicalTaskId: null, clientLabel: 'Agent' });
  assert.equal(live.sessions[0].status, 'disconnected');
  live.sessions[0].status = 'connected';
  assert.throws(() => validateProductState(live), code('INVALID_STATE'));
  state.workspaces[0].agentPolicy = 'automatic';
  assert.throws(() => validateProductState(state), code('AUTHORITY_NOT_METADATA'));
});

test('accessors, poison keys and inherited command names never execute', () => {
  let reads = 0;
  const accessor = createProductState();
  Object.defineProperty(accessor, 'password', { enumerable: true, get() { reads++; return 'synthetic'; } });
  assert.throws(() => validateProductState(accessor), code('INVALID_ARGUMENT'));
  assert.equal(reads, 0);
  assert.throws(() => applyProductCommand(createProductState(), JSON.parse('{"type":"project.create","id":"p","name":"P","__proto__":{}}')), code('INVALID_ARGUMENT'));
  assert.throws(() => applyProductCommand(createProductState(), { type: 'toString' }), code('UNKNOWN_COMMAND'));
  assert.throws(() => validateProductState(null), code('INVALID_ARGUMENT'));
});

test('workspace bounds, duplicate IDs and future schemas reject without truncation', () => {
  let state = createProductState();
  for (let i = 0; i < STATE_LIMITS.workspaces; i++) {
    state.workspaces.push({ id: 'w' + i, name: 'W', identityId: 'i' + i, projectId: null, kind: 'personal', agentPolicy: 'human-only', activeGroupId: null, lifecycle: null });
    state.identities.push({ id: 'i' + i, workspaceId: 'w' + i, requiredIsolation: 'full-profile', engineRef: null });
  }
  validateProductState(state);
  assert.throws(() => workspace(state, 'overflow'), code('STATE_LIMIT'));
  assert.throws(() => workspace(state, 0), error => ['STATE_LIMIT', 'DUPLICATE_ID'].includes(error.code));
  assert.throws(() => validateProductState({ ...createProductState(), schemaVersion: 3 }), code('UNSUPPORTED_SCHEMA'));
});

test('portable metadata removes local roots and credential-like URL fields with an explicit residual privacy notice', () => {
  let state = populated(1);
  state = applyProductCommand(state, { type: 'project.create', id: 'p', name: 'Private project' });
  state = applyProductCommand(state, { type: 'worktree.bind', binding: { id: 'wt', projectId: 'p', name: 'Worktree', repositoryRoot: '/approved/repo', root: '/approved/worktree', artifactRoot: '/approved/worktree/artifacts', origins: ['http://localhost:3000'], bindingGeneration: 1 } });
  state.tabs[0].url = 'https://example.com/private-path?token=synthetic&token=second&api_key=third&term=visible#fragment';
  state.identities[0].engineRef = 'engine-1';
  const before = structuredClone(state);
  const exported = exportProductMetadata(state);
  assert.equal(exported.state.tabs[0].url, 'https://example.com/private-path?term=visible');
  assert.equal(exported.state.worktrees[0].root, null);
  assert.equal(exported.state.identities[0].engineRef, null);
  assert.match(exported.privacyNotice, /may still contain sensitive/);
  assert.deepEqual(state, before);
  assert.throws(() => assertPageURL('https://user:synthetic@example.com'), code('INVALID_URL'));
  assert.throws(() => assertPageURL('javascript:alert(1)'), code('INVALID_URL'));
});

test('logical-task bindings require expected generations and cannot cross projects', () => {
  let state = workspace(createProductState(), 'personal');
  for (const id of ['p', 'q']) state = applyProductCommand(state, { type: 'project.create', id, name: id });
  state = workspace(state, 'project', 'p');
  for (const [id, projectId] of [['wt-p', 'p'], ['wt-q', 'q']]) state = applyProductCommand(state, { type: 'worktree.bind', binding: { id, projectId, name: id, repositoryRoot: null, root: null, artifactRoot: null, origins: ['http://localhost:3000'], bindingGeneration: 1 } });
  state = applyProductCommand(state, { type: 'logicalTask.create', id: 'task', projectId: 'p', worktreeId: 'wt-p', name: 'Task' });
  assert.throws(() => applyProductCommand(state, { type: 'logicalTask.rebind', id: 'task', worktreeId: null, expectedBindingGeneration: 2 }), code('BINDING_CONFLICT'));
  assert.throws(() => applyProductCommand(state, { type: 'logicalTask.rebind', id: 'task', worktreeId: 'wt-q', expectedBindingGeneration: 1 }), code('PROJECT_MISMATCH'));
  const next = applyProductCommand(state, { type: 'logicalTask.rebind', id: 'task', worktreeId: null, expectedBindingGeneration: 1 });
  assert.equal(next.logicalTasks[0].bindingGeneration, 2);
});
