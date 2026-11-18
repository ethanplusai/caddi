import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductStore } from '../src/caddi/state/store.mjs';
import { prepareWorktreeBinding, bindWorktree, resolveProjectBinding, rebindLogicalTask, resolveBoundArtifactPath } from '../src/caddi/state/bindings.mjs';

const base = fileURLToPath(new URL('../.test-artifacts/', import.meta.url));
const code = expected => error => error?.code === expected;
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'caddi-bindings-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['repo', 'worktree-a/artifacts', 'worktree-b/artifacts']) await fs.mkdir(path.join(root, directory), { recursive: true });
  const store = createProductStore({ directory: path.join(root, 'store') });
  await store.transact({ expectedRevision: 0, command: { type: 'project.create', id: 'project', name: 'Project' } });
  const input = id => ({ id, projectId: 'project', name: id, repositoryRoot: path.join(root, 'repo'), root: path.join(root, id), artifactRoot: path.join(root, id, 'artifacts'), origins: ['http://localhost:3000/'], bindingGeneration: 1 });
  return { root, store, input, allowedRoots: [root] };
}

test('same local origin in two Git-worktree-shaped directories never aliases task or workspace binding', async t => {
  const { root, store, input, allowedRoots } = await fixture(t);
  for (const id of ['worktree-a', 'worktree-b']) {
    const state = await store.load();
    await bindWorktree({ store, input: input(id), expectedRevision: state.revision }, { allowedRoots, authorize: () => true });
  }
  for (const [workspace, task, worktree] of [['workspace-a', 'task-a', 'worktree-a'], ['workspace-b', 'task-b', 'worktree-b']]) {
    let state = await store.load();
    await store.transact({ expectedRevision: state.revision, command: { type: 'workspace.create', id: workspace, identityId: 'identity-' + workspace, name: workspace, projectId: 'project', kind: 'project' } });
    state = await store.load();
    await store.transact({ expectedRevision: state.revision, command: { type: 'logicalTask.create', id: task, projectId: 'project', worktreeId: worktree, name: task } });
  }
  const state = await store.load();
  const a = resolveProjectBinding(state, { logicalTaskId: 'task-a', workspaceId: 'workspace-a' });
  const b = resolveProjectBinding(state, { logicalTaskId: 'task-b', workspaceId: 'workspace-b' });
  assert.deepEqual(a.origins, b.origins);
  assert.notEqual(a.worktreeRoot, b.worktreeRoot);
  assert.notEqual(a.identityId, b.identityId);
  assert.equal(a.worktreeRoot, path.join(root, 'worktree-a'));
  assert.equal(Object.hasOwn(a, 'commit'), false);
});

test('rebind requires authority and matching task/state generations, which survive restart', async t => {
  const { root, store, input, allowedRoots } = await fixture(t);
  for (const id of ['worktree-a', 'worktree-b']) {
    await bindWorktree({ store, input: input(id), expectedRevision: (await store.load()).revision }, { allowedRoots, authorize: () => true });
  }
  await store.transact({ expectedRevision: (await store.load()).revision, command: { type: 'logicalTask.create', id: 'task', projectId: 'project', worktreeId: 'worktree-a', name: 'Task' } });
  const state = await store.load(), request = { store, logicalTaskId: 'task', worktreeId: 'worktree-b', expectedBindingGeneration: 1, expectedRevision: state.revision };
  await assert.rejects(rebindLogicalTask(request, { authorize: () => false }), code('FORBIDDEN'));
  assert.equal((await store.load()).logicalTasks[0].worktreeId, 'worktree-a');
  const contexts = [];
  const rebound = await rebindLogicalTask(request, { authorize: context => { contexts.push(context); return true; } });
  assert.equal(rebound.state.logicalTasks[0].bindingGeneration, 2);
  assert.equal(contexts[0].operation, 'project:rebind');
  const restored = await createProductStore({ directory: path.join(root, 'store') }).load();
  assert.equal(restored.logicalTasks[0].worktreeId, 'worktree-b');
  await assert.rejects(rebindLogicalTask({ ...request, expectedRevision: restored.revision }, { authorize: () => true }), code('BINDING_CONFLICT'));
});

test('binding authorization occurs before filesystem inspection and again at final commit', async t => {
  const { store, input, allowedRoots } = await fixture(t);
  const hostile = input('worktree-a'); hostile.root = '/not-approved-not-read';
  await assert.rejects(bindWorktree({ store, input: hostile, expectedRevision: 1 }, { allowedRoots, authorize: () => false }), code('FORBIDDEN'));
  let calls = 0;
  await assert.rejects(bindWorktree({ store, input: input('worktree-a'), expectedRevision: 1 }, { allowedRoots, authorize: () => ++calls === 1 }), code('FORBIDDEN'));
  assert.equal(calls, 2);
  assert.equal((await store.load()).worktrees.length, 0);
});

test('worktree binding rejects lexical escape, symlink ancestry and non-dedicated artifact roots', async t => {
  const { root, input, allowedRoots } = await fixture(t);
  const outside = input('worktree-a'); outside.root = path.join(root, '..', 'unapproved');
  await assert.rejects(prepareWorktreeBinding(outside, { allowedRoots }), code('PATH_NOT_AUTHORIZED'));
  await fs.symlink(path.join(root, 'worktree-a'), path.join(root, 'alias'));
  const linked = input('worktree-a'); linked.root = path.join(root, 'alias'); linked.artifactRoot = path.join(root, 'alias', 'artifacts');
  await assert.rejects(prepareWorktreeBinding(linked, { allowedRoots }), code('UNSAFE_BINDING_PATH'));
  const same = input('worktree-a'); same.artifactRoot = same.root;
  await assert.rejects(prepareWorktreeBinding(same, { allowedRoots }), code('UNSAFE_ARTIFACT_ROOT'));
  const credentialOrigin = input('worktree-a'); credentialOrigin.origins = ['https://user:synthetic@example.com'];
  await assert.rejects(prepareWorktreeBinding(credentialOrigin, { allowedRoots }), code('INVALID_ARGUMENT'));
});

test('artifact paths reject traversal and symlinks and require existing canonical parents', async t => {
  const { root, input, allowedRoots } = await fixture(t);
  const binding = await prepareWorktreeBinding(input('worktree-a'), { allowedRoots });
  assert.equal(await resolveBoundArtifactPath(binding, 'result.json'), path.join(binding.artifactRoot, 'result.json'));
  for (const relative of ['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b']) await assert.rejects(resolveBoundArtifactPath(binding, relative), code('INVALID_PATH'));
  await fs.symlink(path.join(root, 'repo'), path.join(binding.artifactRoot, 'linked'));
  await assert.rejects(resolveBoundArtifactPath(binding, 'linked/result.json'), code('UNSAFE_ARTIFACT_PATH'));
  await assert.rejects(resolveBoundArtifactPath(binding, 'absent/result.json'), error => error.code === 'ENOENT');
  await fs.writeFile(path.join(binding.artifactRoot, 'existing.json'), '{}');
  assert.equal(await resolveBoundArtifactPath(binding, 'existing.json'), path.join(binding.artifactRoot, 'existing.json'));
  await fs.link(path.join(binding.artifactRoot, 'existing.json'), path.join(root, 'second-name.json'));
  await assert.rejects(resolveBoundArtifactPath(binding, 'existing.json'), code('UNSAFE_ARTIFACT_PATH'));
});
