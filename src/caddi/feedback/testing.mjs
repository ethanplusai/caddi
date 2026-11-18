// Explicit test-only entry. Never import this file from the ordinary app entry.
import { randomBytes } from 'node:crypto';
import { CaddiError, assertId } from '../contracts.mjs';
import { constructFeedbackStore } from './store.mjs';

export function createMemoryTestKeyProvider({ keys = new Map() } = {}) {
  const owned = new Map([...keys].map(([id, key]) => [assertId(id), Buffer.from(key)]));
  let locked = false, epoch = 0;
  const listeners = new Set(), transfers = new Set();
  const notifyLock = () => { epoch++; for (const key of transfers) key.fill(0); for (const listener of listeners) listener({ workspaceId: null }); };
  return Object.freeze({
    kind: 'test-memory-workspace-keys',
    testOnly: true,
    async getWorkspaceKey({ workspaceId, create }) {
      if (locked) throw new CaddiError('WORKSPACE_KEY_UNAVAILABLE', 'Test provider is locked');
      if (!owned.has(workspaceId) && create) owned.set(workspaceId, randomBytes(32));
      const key = owned.get(workspaceId);
      if (!key) throw new CaddiError('WORKSPACE_KEY_UNAVAILABLE', 'Test workspace key is unavailable');
      const transfer = Buffer.from(key), at = epoch;
      let released = false; transfers.add(transfer);
      return { workspaceId, key: transfer, protection: 'test-only-memory', assertCurrent() {
        if (released || locked || at !== epoch) throw new CaddiError('WORKSPACE_KEY_UNAVAILABLE', 'Test key lease is unavailable');
        return true;
      }, release() { if (released) return; released = true; transfer.fill(0); transfers.delete(transfer); } };
    },
    assertAvailable({ workspaceId }) { return !locked && owned.has(workspaceId); },
    onLock(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setLocked(value) { locked = Boolean(value); if (locked) notifyLock(); },
    destroy() { locked = true; notifyLock(); for (const key of owned.values()) key.fill(0); owned.clear(); },
  });
}
export function openTestFeedbackStore(options, { fault } = {}) {
  return constructFeedbackStore(options, { allowTestProvider: true, fault });
}
