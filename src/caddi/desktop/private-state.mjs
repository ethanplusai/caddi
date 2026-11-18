import { randomUUID } from 'node:crypto';
import { CaddiError, assertInteger, assertKeys, assertRecord, cloneData } from '../contracts.mjs';
import { createProductState, applyProductCommand, validateProductState } from '../state/model.mjs';

export const PRIVATE_STATE_LIMITS = Object.freeze({ tabs: 128, groups: 64, folders: 512, bytes: 2 * 1024 * 1024, pending: 32 });
const COMMANDS = new Set(['workspace.select', 'workspace.rename', 'group.create', 'group.rename', 'group.reorder', 'group.select',
  'folder.create', 'folder.rename', 'folder.collapse', 'folder.move', 'folder.reorder', 'folder.remove', 'folder.restore',
  'tab.create', 'tab.duplicate', 'tab.move', 'tab.reorder', 'tab.select', 'tab.update', 'tab.rename', 'tab.pin', 'tab.favorite',
  'tab.reopen', 'tab.navigate', 'tab.close', 'layout.set', 'layout.clear']);
const fail = code => { throw new CaddiError(code, 'Private browsing state is unavailable'); };

/** An isolated metadata scope. This module has no filesystem, export, import or durable-store interface. */
export function createPrivateWorkspaceState({ settings, now = Date.now } = {}) {
  if (typeof now !== 'function') fail('INVALID_ARGUMENT');
  const scopeId = 'private-scope-' + randomUUID(), workspaceId = 'private-work-' + randomUUID();
  const identityId = 'private-identity-' + randomUUID(), groupId = 'private-group-' + randomUUID(), tabId = 'private-tab-' + randomUUID();
  const createdAt = now(); assertInteger(createdAt, 'private creation time');
  let state = createProductState();
  if (settings !== undefined) state.settings = cloneData(settings, { maxBytes: 1024 });
  state = validateProductState(state);
  for (const command of [
    { type: 'workspace.create', id: workspaceId, identityId, projectId: null, kind: 'personal', name: 'Private browsing' },
    { type: 'group.create', id: groupId, workspaceId, name: 'Private tabs', color: '#7d6aa6' },
    { type: 'tab.create', id: tabId, workspaceId, groupId, url: 'about:blank', title: '', now: createdAt },
  ]) state = applyProductCommand(state, command);
  let generation = 1, disposed = false, pending = 0, tail = Promise.resolve();
  const assertOpen = () => { if (disposed || !state) fail('PRIVATE_SCOPE_CLOSED'); };
  function validateScope(value) {
    const next = validateProductState(value);
    if (next.workspaces.length !== 1 || next.workspaces[0].id !== workspaceId || next.workspaces[0].identityId !== identityId ||
        next.workspaces[0].lifecycle !== null || next.identities.length !== 1 || next.identities[0].id !== identityId ||
        next.activeWorkspaceId !== workspaceId || ['projects', 'worktrees', 'logicalTasks', 'sessions', 'migrations'].some(key => next[key].length))
      fail('PRIVATE_SCOPE_MISMATCH');
    if (next.tabs.length > PRIVATE_STATE_LIMITS.tabs || next.groups.length > PRIVATE_STATE_LIMITS.groups ||
        next.folders.length > PRIVATE_STATE_LIMITS.folders || Buffer.byteLength(JSON.stringify(next)) > PRIVATE_STATE_LIMITS.bytes)
      fail('PRIVATE_STATE_CAPACITY');
    return next;
  }
  function transact(raw, { beforeCommit } = {}) {
    assertOpen(); assertKeys(raw, ['expectedRevision', 'command'], ['expectedRevision', 'command']);
    assertInteger(raw.expectedRevision, 'expectedRevision');
    const expectedRevision = raw.expectedRevision, command = cloneData(raw.command, { maxBytes: 128 * 1024 });
    assertRecord(command, 'private command');
    if (!COMMANDS.has(command.type)) fail('PRIVATE_COMMAND_DENIED');
    if (beforeCommit !== undefined && typeof beforeCommit !== 'function') fail('INVALID_ARGUMENT');
    if (pending >= PRIVATE_STATE_LIMITS.pending) fail('PRIVATE_QUEUE_CAPACITY');
    const admittedGeneration = generation; pending++;
    const task = tail.then(() => {
      assertOpen();
      if (admittedGeneration !== generation) fail('PRIVATE_SCOPE_STALE');
      if (state.revision !== expectedRevision) fail('REVISION_CONFLICT');
      const next = validateScope(applyProductCommand(state, command));
      if (beforeCommit) {
        const accepted = beforeCommit();
        if (accepted && typeof accepted.then === 'function') {
          Promise.resolve(accepted).catch(() => {}); fail('ASYNC_AUTHORIZATION_FENCE');
        }
        if (accepted !== true && accepted !== undefined) fail('FORBIDDEN');
      }
      assertOpen();
      if (admittedGeneration !== generation || state.revision !== expectedRevision) fail('PRIVATE_SCOPE_STALE');
      state = next; return { state: validateScope(state), revision: state.revision, ephemeral: true };
    });
    tail = task.catch(() => {}).finally(() => { pending--; });
    return task;
  }
  return Object.freeze({ scopeId, workspaceId, identityId, groupId, tabId,
    get generation() { return generation; },
    getState() { assertOpen(); return validateScope(state); },
    load() { assertOpen(); return Promise.resolve(validateScope(state)); },
    transact,
    inspect() { return { scopeId, workspaceId, identityId, generation, status: disposed ? 'disposed' : 'active', pending, revision: state?.revision ?? null, ephemeral: true }; },
    async flush() { await tail; },
    dispose(raw) {
      assertKeys(raw, ['expectedGeneration'], ['expectedGeneration']); assertInteger(raw.expectedGeneration, 'private generation', { min: 1 });
      if (raw.expectedGeneration !== generation) fail('PRIVATE_SCOPE_STALE');
      if (disposed) return false;
      disposed = true; generation++; state = null; return true;
    },
  });
}
