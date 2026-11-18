// Explicit synthetic entry. No real account, native key store or network calls.
import { randomBytes } from 'node:crypto';
import { assertId } from '../contracts.mjs';
import { constructDesktopPersistence } from './index.mjs';
import { fail } from './common.mjs';

export const openTestDesktopPersistence = (options, { fault } = {}) =>
  constructDesktopPersistence(options, { allowTestProvider: true, fault });

export function createTestLifecycleGate() {
  let locked = false, epoch = 1, controller = new AbortController(), reason = null;
  const listeners = new Set();
  return Object.freeze({
    status: () => ({ locked, epoch, reason }),
    capture() {
      if (locked) fail('PERSISTENCE_LOCKED');
      const captured = epoch, signal = controller.signal;
      return Object.freeze({ epoch: captured, signal, assertCurrent() {
        if (locked || signal.aborted || captured !== epoch) fail('PERSISTENCE_LOCKED'); return true;
      } });
    },
    onLock(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    lock() {
      if (locked) return;
      locked = true; reason = 'synthetic-lock'; epoch++; controller.abort();
      for (const listener of listeners) listener();
    },
    observeUnlocked() { reason = 'synthetic-unlock-observed'; }, // Observation alone does not reopen authority.
    continueAsOwner() { if (!locked) return; epoch++; controller = new AbortController(); locked = false; reason = null; },
  });
}
export function createTestPersistenceKeys({ ownerKeys = new Map(), workspaceKeys = new Map() } = {}) {
  const listeners = new Set(), transfers = new Set();
  let locked = false, epoch = 1, released = 0;
  function available() { if (locked) fail('PERSISTENCE_KEY_UNAVAILABLE'); return true; }
  function lease(map, id, create, fields) {
    available(); assertId(id);
    if (!map.has(id) && create) map.set(id, randomBytes(32));
    if (!map.has(id)) fail('PERSISTENCE_KEY_UNAVAILABLE');
    const key = Buffer.from(map.get(id)), issuedEpoch = epoch;
    let retired = false; transfers.add(key);
    return { ...fields, key, protection: 'test-only-memory', assertCurrent() {
      available(); if (retired || issuedEpoch !== epoch) fail('PERSISTENCE_KEY_UNAVAILABLE'); return true;
    }, release() { if (retired) return; retired = true; released++; key.fill(0); transfers.delete(key); } };
  }
  const onLock = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  return Object.freeze({
    owner: Object.freeze({
      kind: 'test-owner-vault-keys', testOnly: true, productionQualified: false,
      assertAvailable: available, onLock,
      async acquireKey({ purpose, vaultId, create }) {
        if (purpose !== 'owner-vault') fail('PERSISTENCE_SCOPE_DENIED');
        return lease(ownerKeys, vaultId, create, { purpose, vaultId });
      },
    }),
    feedback: Object.freeze({
      kind: 'test-memory-workspace-keys', testOnly: true, productionQualified: false,
      onLock, assertAvailable({ workspaceId }) { return !locked && workspaceKeys.has(workspaceId); },
      async getWorkspaceKey({ workspaceId, create }) { return lease(workspaceKeys, workspaceId, create, { purpose: 'workspace', workspaceId }); },
    }),
    lock() { locked = true; epoch++; for (const key of transfers) key.fill(0); for (const listener of listeners) listener({ workspaceId: null }); },
    unlock() { locked = false; epoch++; },
    inspect: () => ({ outstanding: transfers.size, released, locked }),
    destroy() {
      locked = true; epoch++; for (const key of transfers) key.fill(0);
      for (const listener of listeners) listener({ workspaceId: null });
      for (const key of ownerKeys.values()) key.fill(0);
      for (const key of workspaceKeys.values()) key.fill(0);
      ownerKeys.clear(); workspaceKeys.clear();
    },
  });
}
