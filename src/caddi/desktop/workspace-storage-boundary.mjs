// Main-only binding around the read-only storage meter. Paths originate solely
// from the exact Session/profile created by this engine, never renderer input.
import { CaddiError, assertId, assertKeys } from '../contracts.mjs';

const fail = () => { throw new CaddiError('STORAGE_CONTEXT_CHANGED', 'Workspace storage context changed'); };
export function createWorkspaceStorageBoundary({ workspaceFor, getRuntimeIncarnation, getPrivacyState, assertOwner, isClosed, meter } = {}) {
  if (![workspaceFor, getRuntimeIncarnation, getPrivacyState, assertOwner, isClosed].every(fn => typeof fn === 'function') || typeof meter?.measure !== 'function')
    throw new CaddiError('INVALID_ARGUMENT', 'Workspace storage boundary is unavailable');
  async function humanStorageUsage(input) {
    assertKeys(input, ['workspaceId', 'identityId', 'expectedOwnerWindow', 'beforeRead'], ['workspaceId', 'identityId', 'expectedOwnerWindow', 'beforeRead']);
    const { workspaceId, identityId, expectedOwnerWindow, beforeRead } = input;
    assertId(workspaceId); assertId(identityId);
    if (typeof beforeRead !== 'function') fail();
    const workspace = workspaceFor(workspaceId);
    if (!workspace || workspace.identityId !== identityId || !expectedOwnerWindow) fail();
    const binding = { session: workspace.session, ownerRevision: workspace.ownerRevision, privateScope: workspace.privateScope,
      storageMode: workspace.storageMode, profilePath: workspace.profilePath,
      runtime: getRuntimeIncarnation(), privacyEpoch: getPrivacyState(workspaceId).capturePrivacyEpoch };
    function check() {
      let valid = false;
      try {
        valid = !isClosed() && workspaceFor(workspaceId) === workspace && workspace.open && !workspace.quarantined &&
          workspace.identityId === identityId && workspace.session === binding.session && workspace.ownerWindow === expectedOwnerWindow &&
          workspace.ownerRevision === binding.ownerRevision && Number.isSafeInteger(binding.ownerRevision) && binding.ownerRevision >= 0 &&
          assertOwner(workspace) === expectedOwnerWindow && workspace.privateScope === binding.privateScope &&
          workspace.storageMode === binding.storageMode && workspace.profilePath === binding.profilePath &&
          getRuntimeIncarnation() === binding.runtime && getPrivacyState(workspaceId).capturePrivacyEpoch === binding.privacyEpoch &&
          Number.isSafeInteger(binding.privacyEpoch) && binding.privacyEpoch >= 0 &&
          ((binding.storageMode === 'persistent' && !binding.privateScope && typeof binding.profilePath === 'string' &&
              binding.session.isPersistent() === true && binding.session.storagePath === binding.profilePath) ||
            (binding.storageMode === 'ephemeral' && binding.profilePath === null && binding.session.isPersistent() === false && binding.session.storagePath === null));
      } catch {}
      if (!valid) fail();
    }
    function assertCurrent() {
      check(); let allowed;
      try { allowed = beforeRead(); } catch { fail(); }
      if (allowed instanceof Promise) void allowed.catch(() => {});
      if (allowed !== true && allowed !== undefined) fail();
      check(); return true;
    }
    assertCurrent();
    return meter.measure({ workspaceId, identityId, storageMode: binding.privateScope ? 'private' : binding.storageMode,
      directory: binding.profilePath, getCacheSize: () => { assertCurrent(); return binding.session.getCacheSize(); } }, { assertCurrent });
  }
  return Object.freeze({ humanStorageUsage });
}
