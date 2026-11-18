import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createProductState, applyProductCommand, validateProductState } from '../src/caddi/state/model.mjs';
import { createProductStore, stateDigest } from '../src/caddi/state/store.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const encode = state => Buffer.from(JSON.stringify(canonical({ format: 'caddi-state-snapshot', schemaVersion: 1, sha256: stateDigest(state), state })) + '\n');
const code = expected => error => error?.code === expected;
const provision = (n = 'a') => ({ type: 'workspace.provision', workspaceId: 'w-' + n, identityId: 'i-' + n, projectId: 'p-' + n, groupId: 'g-' + n, tabId: 't-' + n, logicalTaskId: 'task-' + n, name: 'Project ' + n, now: 100 });
const lifecycle = (generation, status) => ({ type: 'workspace.lifecycle', workspaceId: 'w-a', identityId: 'i-a', expectedGeneration: generation, status });
async function fixture(t) {
  const base = fileURLToPath(new URL('../.test-artifacts/', import.meta.url)); await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'workspace-lifecycle-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'metadata'); await fs.mkdir(directory, { mode: 0o700 });
  return { directory, store: createProductStore({ directory }) };
}
function oldState() {
  const state = applyProductCommand(createProductState(), { type: 'workspace.create', id: 'ordinary', identityId: 'identity', name: 'Personal', projectId: null, kind: 'personal' });
  state.schemaVersion = 1; delete state.workspaces[0].lifecycle;
  return state;
}

test('managed provision is atomic metadata with one identity/task/tab and never changes human selection', () => {
  const old = applyProductCommand(createProductState(), { type: 'workspace.create', id: 'human', identityId: 'human-id', name: 'Personal', projectId: null, kind: 'personal' });
  const state = applyProductCommand(old, provision());
  assert.equal(state.revision, old.revision + 1); assert.equal(state.activeWorkspaceId, 'human');
  assert.deepEqual(state.workspaces[1].lifecycle, { status: 'active', generation: 1, logicalTaskId: 'task-a', initialTabId: 't-a' });
  assert.equal(state.logicalTasks[0].projectId, state.workspaces[1].projectId);
  assert.equal(state.identities[1].workspaceId, 'w-a'); assert.equal(state.tabs[0].url, 'about:blank');
  assert.equal(state.workspaces[1].agentPolicy, 'human-only');
  assert.throws(() => applyProductCommand(state, { ...provision('b'), logicalTaskId: 'task-a' }), code('DUPLICATE_ID'));
  assert.equal(state.workspaces.length, 2);
});

test('retained retirement, archive and reopen advance identity-bound generations without deleting pages or selection', () => {
  let state = applyProductCommand(createProductState(), provision());
  const original = structuredClone(state.tabs);
  state = applyProductCommand(state, lifecycle(1, 'active'));
  assert.equal(state.workspaces[0].lifecycle.generation, 2);
  state = applyProductCommand(state, lifecycle(2, 'archived'));
  assert.throws(() => applyProductCommand(state, lifecycle(2, 'active')), code('WORKSPACE_LIFECYCLE_STALE'));
  assert.throws(() => applyProductCommand(state, { ...lifecycle(3, 'active'), identityId: 'other' }), code('WORKSPACE_LIFECYCLE_STALE'));
  state = applyProductCommand(state, lifecycle(3, 'active'));
  assert.deepEqual(state.tabs, original); assert.equal(state.activeWorkspaceId, null);
  assert.equal(state.workspaces[0].lifecycle.generation, 4);
  const forged = structuredClone(state); forged.workspaces[0].lifecycle.grantId = 'never-persist-authority';
  assert.throws(() => validateProductState(forged), code('INVALID_ARGUMENT'));
});

test('160 background tab metadata entries preserve every workspace/group/layout selection', () => {
  let state = createProductState();
  for (let n = 0; n < 20; n++) state = applyProductCommand(state, provision(String(n)));
  state = applyProductCommand(state, { type: 'workspace.select', workspaceId: 'w-0' });
  const before = { active: state.activeWorkspaceId, groups: structuredClone(state.groups), workspaces: structuredClone(state.workspaces) };
  for (let n = 0; n < 20; n++) for (let i = 1; i < 8; i++) state = applyProductCommand(state, {
    type: 'tab.create', id: 'background-' + n + '-' + i, workspaceId: 'w-' + n, groupId: 'g-' + n,
    url: 'https://example.test/' + i, title: '', now: 101, activate: false });
  assert.equal(state.tabs.length, 160); assert.equal(state.activeWorkspaceId, before.active);
  assert.deepEqual(state.groups, before.groups); assert.deepEqual(state.workspaces, before.workspaces);
  assert.throws(() => applyProductCommand(state, { type: 'tab.create', id: 'invalid', workspaceId: 'w-0', groupId: 'g-0', url: 'about:blank', title: '', now: 102, activate: 'no' }), code('INVALID_STATE'));
});

test('verified schema1 migrates once and exact primary/backup sources survive subsequent commits', async t => {
  const { store, directory } = await fixture(t), old = oldState(), primary = encode(old);
  const backup = encode({ ...old, revision: 0 });
  await fs.writeFile(store.files.primary, primary, { mode: 0o600 }); await fs.writeFile(store.files.backup, backup, { mode: 0o600 });
  const migrated = await store.load();
  assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.revision, old.revision + 1);
  assert.equal(migrated.workspaces[0].lifecycle, null); assert.equal(migrated.activeWorkspaceId, old.activeWorkspaceId);
  assert.deepEqual(await createProductStore({ directory }).load(), migrated);
  await store.transact({ expectedRevision: migrated.revision, command: provision() });
  for (const [label, raw] of [['primary', primary], ['backup', backup]]) {
    const name = 'schema1-' + label + '-' + createHash('sha256').update(raw).digest('hex') + '.json';
    assert.deepEqual(await fs.readFile(path.join(directory, name)), raw);
    assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
});

test('corrupt old state and future backup refuse migration without overwriting original source', async t => {
  const { store, directory } = await fixture(t), raw = encode(oldState());
  const damaged = Buffer.from(raw.toString().replace('Personal', 'Tampered'));
  await fs.writeFile(store.files.primary, damaged, { mode: 0o600 });
  await assert.rejects(store.load(), code('RECOVERY_REQUIRED')); assert.deepEqual(await fs.readFile(store.files.primary), damaged);
  await fs.writeFile(store.files.primary, raw); await fs.writeFile(store.files.backup, JSON.stringify({ schemaVersion: 9 }));
  await assert.rejects(store.load(), code('UNSUPPORTED_SCHEMA')); assert.deepEqual(await fs.readFile(store.files.primary), raw);
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('schema1-')), false);
});

test('managed publication fence prevents an expired capability from leaving partial metadata', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.transact({ expectedRevision: 0, command: provision() }, { beforeCommit: () => false }), code('FORBIDDEN'));
  // A valid backup exists after the denied publication; explicit recovery remains necessary.
  assert.equal((await store.inspect()).primary.exists, false);
  assert.equal((await store.inspect()).backup.revision, 0);
});
