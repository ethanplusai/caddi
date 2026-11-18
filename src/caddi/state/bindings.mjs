import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData, normalizeOrigin } from '../contracts.mjs';
import { validateProductState, assertMetadataPath } from './model.mjs';

const fail = (code, message) => { throw new CaddiError(code, message); };
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
async function canonicalDirectory(value) {
  assertMetadataPath(value); if (value === null) fail('INVALID_PATH', 'A concrete directory is required');
  const resolved = await fs.realpath(value), info = await fs.lstat(value);
  if (resolved !== value || !info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_BINDING_PATH', 'Binding paths must be canonical directories without symlinks');
  return resolved;
}
function synchronousAuthority(authorize, context) {
  if (typeof authorize !== 'function') fail('AUTHORIZATION_REQUIRED', 'Binding changes require an authorization fence');
  const result = authorize(Object.freeze(context));
  if (result && typeof result.then === 'function') fail('ASYNC_AUTHORIZATION_FENCE', 'Binding authorization must be synchronous');
  if (result === false) fail('FORBIDDEN', 'Binding change was denied');
}

/** allowedRoots comes from trusted configuration, never an agent request. */
export async function prepareWorktreeBinding(input, { allowedRoots } = {}) {
  const binding = cloneData(input);
  const keys = ['id', 'projectId', 'name', 'repositoryRoot', 'root', 'artifactRoot', 'origins', 'bindingGeneration'];
  assertKeys(binding, keys, keys); assertId(binding.id); assertId(binding.projectId);
  assertString(binding.name, 'worktree name', { min: 1, max: 120 }); assertInteger(binding.bindingGeneration, 'bindingGeneration', { min: 1 });
  if (!Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.length > 32) fail('INVALID_ARGUMENT', 'Trusted approved roots are required');
  const approved = await Promise.all(allowedRoots.map(canonicalDirectory));
  for (const key of ['repositoryRoot', 'root', 'artifactRoot']) {
    assertMetadataPath(binding[key]);
    if (binding[key] === null || !approved.some(root => inside(root, binding[key]))) fail('PATH_NOT_AUTHORIZED', 'Binding directory is outside approved roots');
    binding[key] = await canonicalDirectory(binding[key]);
    if (!approved.some(root => inside(root, binding[key]))) fail('PATH_NOT_AUTHORIZED', 'Binding directory is outside approved roots');
  }
  if (!inside(binding.root, binding.artifactRoot) || binding.root === binding.artifactRoot) fail('UNSAFE_ARTIFACT_ROOT', 'Artifact export root must be a dedicated descendant of its worktree');
  if (!Array.isArray(binding.origins) || binding.origins.length > 64) fail('INVALID_ARGUMENT', 'Invalid origin list');
  binding.origins = [...new Set(binding.origins.map(normalizeOrigin))];
  return Object.freeze(binding);
}

export function resolveProjectBinding(input, { logicalTaskId, workspaceId, expectedBindingGeneration } = {}) {
  const state = validateProductState(input); assertId(logicalTaskId); assertId(workspaceId);
  const task = state.logicalTasks.find(item => item.id === logicalTaskId), workspace = state.workspaces.find(item => item.id === workspaceId);
  if (!task || !workspace || task.projectId !== workspace.projectId) fail('PROJECT_MISMATCH', 'Logical task does not belong to this workspace project');
  if (expectedBindingGeneration !== undefined && task.bindingGeneration !== expectedBindingGeneration) fail('BINDING_CONFLICT', 'Task binding changed');
  const worktree = task.worktreeId ? state.worktrees.find(item => item.id === task.worktreeId) : null;
  return cloneData({ logicalTaskId: task.id, projectId: task.projectId, workspaceId: workspace.id, identityId: workspace.identityId,
    bindingGeneration: task.bindingGeneration, worktreeId: worktree?.id ?? null, worktreeBindingGeneration: worktree?.bindingGeneration ?? null,
    repositoryRoot: worktree?.repositoryRoot ?? null, worktreeRoot: worktree?.root ?? null, artifactRoot: worktree?.artifactRoot ?? null, origins: worktree?.origins ?? [] });
}

/** Bindings do not infer a commit, repository, task or recipient from a URL/port. */
export async function bindWorktree({ store, input, expectedRevision }, { allowedRoots, authorize } = {}) {
  assertInteger(expectedRevision, 'expectedRevision');
  const captured = cloneData(input);
  assertId(captured.projectId); assertId(captured.id); assertInteger(captured.bindingGeneration, 'bindingGeneration', { min: 1 });
  synchronousAuthority(authorize, { operation: 'project:rebind', projectId: captured.projectId, worktreeId: captured.id, bindingGeneration: captured.bindingGeneration });
  const binding = await prepareWorktreeBinding(captured, { allowedRoots });
  return store.transact({ expectedRevision, command: { type: 'worktree.bind', binding } }, { beforeCommit: () => synchronousAuthority(authorize, { operation: 'project:rebind', projectId: binding.projectId, worktreeId: binding.id, bindingGeneration: binding.bindingGeneration }) });
}
export async function rebindLogicalTask({ store, logicalTaskId, worktreeId, expectedBindingGeneration, expectedRevision }, { authorize } = {}) {
  if (typeof authorize !== 'function') fail('AUTHORIZATION_REQUIRED', 'Binding changes require an authorization fence');
  assertId(logicalTaskId); if (worktreeId !== null) assertId(worktreeId);
  assertInteger(expectedBindingGeneration, 'expectedBindingGeneration', { min: 1 }); assertInteger(expectedRevision, 'expectedRevision');
  const state = await store.load(), task = state.logicalTasks.find(item => item.id === logicalTaskId);
  if (!task) fail('MISSING_REFERENCE', 'Unknown logical task');
  return store.transact({ expectedRevision, command: { type: 'logicalTask.rebind', id: logicalTaskId, worktreeId, expectedBindingGeneration } },
    { beforeCommit: () => synchronousAuthority(authorize, { operation: 'project:rebind', projectId: task.projectId, logicalTaskId, worktreeId, bindingGeneration: expectedBindingGeneration + 1 }) });
}

/** Path resolution is not an open-file capability; the eventual I/O must revalidate. */
export async function resolveBoundArtifactPath(bindingInput, relativePath) {
  const binding = cloneData(bindingInput);
  const keys = ['id', 'projectId', 'name', 'repositoryRoot', 'root', 'artifactRoot', 'origins', 'bindingGeneration'];
  assertKeys(binding, keys, keys); assertId(binding.id); assertId(binding.projectId);
  assertString(relativePath, 'relative artifact path', { min: 1, max: 4096 });
  if (path.isAbsolute(relativePath) || /[\u0000-\u001f\u007f\\]/u.test(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_PATH', 'Artifact path must be a normalized relative path');
  const root = await canonicalDirectory(binding.root), artifactRoot = await canonicalDirectory(binding.artifactRoot);
  if (!inside(root, artifactRoot) || root === artifactRoot) fail('UNSAFE_ARTIFACT_ROOT', 'Artifact root left its worktree');
  const destination = path.resolve(artifactRoot, relativePath);
  if (!inside(artifactRoot, destination)) fail('PATH_NOT_AUTHORIZED', 'Artifact path escaped its root');
  let current = artifactRoot;
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()) || (index === parts.length - 1 && (!info.isFile() || info.nlink !== 1))) fail('UNSAFE_ARTIFACT_PATH', 'Artifact path contains an unsafe entry');
    } catch (error) {
      if (error.code !== 'ENOENT' || index < parts.length - 1) throw error;
    }
  }
  return destination;
}
