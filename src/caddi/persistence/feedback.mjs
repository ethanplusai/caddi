import path from 'node:path';
import { assertId } from '../contracts.mjs';
import { privateDirectory } from '../feedback/files.mjs';
import { constructFeedbackStore } from '../feedback/store.mjs';
import { eligibleWorkspace } from './model.mjs';
import { fail, safeError, strictDecision, fence, synchronous } from './common.mjs';

/** Injected only by the main owner; all recovered recipient receipts remain historical. */
export function createPersistentFeedbackFactory(controller, { feedbackKeyProvider: provider, gate, allowTestProvider = false }) {
  const testing = allowTestProvider && provider?.kind === 'test-memory-workspace-keys' && provider.testOnly === true;
  const qualified = provider?.kind === 'os-protected-workspace-keys' && provider.testOnly === false && provider.productionQualified === true;
  if ((!testing && !qualified) || ['getWorkspaceKey', 'assertAvailable', 'onLock'].some(name => typeof provider?.[name] !== 'function')) fail('PERSISTENCE_UNAVAILABLE');
  const root = privateDirectory(path.join(controller.anchor.path, 'feedback'), { create: true }), contexts = new Set();
  let closed = false;
  function create({ privacy, policy, clock, authorizeHuman, validateTarget }) {
    if (closed || contexts.size >= 8) fail('PERSISTENCE_BUSY');
    const bindings = new Map(), workspaceEpochs = new Map(), listeners = new Set(), changeListeners = new Set();
    let retired = false, providerEpoch = 0, store;
    const invalidate = ({ workspaceId = null } = {}) => {
      if (workspaceId === null) { providerEpoch++; bindings.clear(); workspaceEpochs.clear(); }
      else {
        if (workspaceEpochs.has(workspaceId)) workspaceEpochs.set(workspaceId, workspaceEpochs.get(workspaceId) + 1);
        bindings.delete(workspaceId);
      }
      for (const listener of listeners) { try { strictDecision(listener({ workspaceId })); } catch {} }
      for (const listener of changeListeners) { try { strictDecision(listener({ workspaceId })); } catch {} }
    };
    function current(workspaceId, identityId, binding) {
      if (closed || retired) fail('PERSISTENCE_CLOSED');
      controller.boundary.capture().assertCurrent();
      controller.assertFeedbackBinding(workspaceId, identityId);
      eligibleWorkspace(controller.workspaceLookup, workspaceId, identityId);
      if (binding) {
        if (bindings.get(workspaceId) !== binding || binding.providerEpoch !== providerEpoch ||
            workspaceEpochs.get(workspaceId) !== binding.workspaceEpoch) fail('PERSISTENCE_LOCKED');
        const status = synchronous(gate.status(), 'PERSISTENCE_LOCKED');
        if (status?.locked !== false || status.epoch !== binding.gate.epoch || binding.gate.signal.aborted) fail('PERSISTENCE_LOCKED');
        fence(binding.gate.assertCurrent, 'PERSISTENCE_LOCKED');
      }
      return true;
    }
    const wrapped = {
      kind: testing ? 'test-memory-workspace-keys' : 'os-protected-workspace-keys', testOnly: Boolean(testing),
      async getWorkspaceKey({ workspaceId, create: createKey }) {
        const known = bindings.get(workspaceId); if (!known) fail('PERSISTENCE_IDENTITY_CHANGED');
        current(workspaceId, known.identityId, known);
        let slot, copy;
        try {
          slot = await provider.getWorkspaceKey({ workspaceId, create: createKey, signal: known.gate.signal });
          current(workspaceId, known.identityId, known);
          if (!slot || slot.workspaceId !== workspaceId || slot.protection !== (testing ? 'test-only-memory' : 'os-protected') ||
              !Buffer.isBuffer(slot.key) || slot.key.length !== 32 || typeof slot.release !== 'function' ||
              typeof slot.assertCurrent !== 'function') fail('PERSISTENCE_KEY_UNAVAILABLE');
          fence(slot.assertCurrent, 'PERSISTENCE_KEY_UNAVAILABLE');
          strictDecision(provider.assertAvailable({ workspaceId }), 'PERSISTENCE_KEY_UNAVAILABLE', true);
          copy = Buffer.from(slot.key);
          return { workspaceId, key: copy, protection: slot.protection, release() { copy.fill(0); } };
        } catch (error) { copy?.fill(0); throw safeError(error); }
        finally {
          if (Buffer.isBuffer(slot?.key)) slot.key.fill(0);
          if (typeof slot?.release === 'function') {
            try { strictDecision(slot.release(), 'PERSISTENCE_KEY_UNAVAILABLE'); }
            catch (error) { copy?.fill(0); throw safeError(error); }
          }
        }
      },
      assertAvailable({ workspaceId }) {
        try {
          const binding = bindings.get(workspaceId);
          if (!binding) return false;
          current(workspaceId, binding.identityId, binding);
          strictDecision(provider.assertAvailable({ workspaceId }), 'PERSISTENCE_KEY_UNAVAILABLE', true);
          return true;
        } catch { return false; }
      },
      onLock(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const offGate = gate.onLock(() => invalidate());
    const offOwner = controller.boundary.onInvalidate(() => invalidate());
    const offProvider = provider.onLock(event => invalidate(event));
    if ([offGate, offOwner, offProvider].some(value => typeof value !== 'function')) {
      for (const off of [offGate, offOwner, offProvider]) if (typeof off === 'function') off();
      fail('PERSISTENCE_UNAVAILABLE');
    }
    try {
      store = constructFeedbackStore({ rootDir: root.path, keyProvider: wrapped, privacy, policy, clock, authorizeHuman, validateTarget },
        { allowTestProvider: testing });
    } catch (error) { offGate(); offOwner(); offProvider(); throw error; }
    async function unlock({ workspaceId, humanContext, create: createWorkspace = false }) {
      assertId(workspaceId);
      if (retired || closed) fail('PERSISTENCE_CLOSED');
      const workspace = synchronous(controller.workspaceLookup(workspaceId), 'PERSISTENCE_IDENTITY_CHANGED');
      const identityId = assertId(workspace?.identityId);
      eligibleWorkspace(controller.workspaceLookup, workspaceId, identityId);
      if (!workspaceEpochs.has(workspaceId)) {
        if (workspaceEpochs.size >= 32) fail('PERSISTENCE_CAPACITY');
        workspaceEpochs.set(workspaceId, 0);
      }
      const workspaceEpoch = workspaceEpochs.get(workspaceId);
      const lifecycle = synchronous(gate.capture({ purpose: 'feedback-storage', workspaceId, identityId }), 'PERSISTENCE_LOCKED');
      if (!lifecycle || !Number.isSafeInteger(lifecycle.epoch) || !(lifecycle.signal instanceof AbortSignal) ||
          typeof lifecycle.assertCurrent !== 'function') fail('PERSISTENCE_LOCKED');
      const privacyGuard = privacy.captureGuard(workspaceId), epoch = providerEpoch;
      const check = () => {
        if (retired || closed || epoch !== providerEpoch || workspaceEpochs.get(workspaceId) !== workspaceEpoch || lifecycle.signal.aborted) fail('PERSISTENCE_LOCKED');
        fence(lifecycle.assertCurrent, 'PERSISTENCE_LOCKED');
        fence(privacyGuard.assertValid, 'PERSISTENCE_LOCKED');
        strictDecision(authorizeHuman(humanContext, { workspaceId, operation: 'feedback:restore' }), 'PERSISTENCE_SCOPE_DENIED', true);
        eligibleWorkspace(controller.workspaceLookup, workspaceId, identityId);
        return true;
      };
      check();
      let state = await controller.api.load({ assertCurrent: check, signal: lifecycle.signal });
      let found = state.feedback.find(value => value.workspaceId === workspaceId);
      if (!found && createWorkspace) {
        // A bounded CAS retry is allowed only while the original exact human,
        // identity, privacy and lifecycle review remains valid.
        for (let attempt = 0; attempt < 3 && !found; attempt++) {
          try {
            state = await controller.api.bindFeedbackWorkspace({ expectedRevision: state.revision, workspaceId, identityId }, { assertCurrent: check, signal: lifecycle.signal });
          } catch (error) {
            if (error.code !== 'PERSISTENCE_CONFLICT' || attempt === 2) throw error;
            state = await controller.api.load({ assertCurrent: check, signal: lifecycle.signal });
          }
          found = state.feedback.find(value => value.workspaceId === workspaceId);
        }
      }
      if (!found) fail('PERSISTENCE_NOT_FOUND');
      if (found.identityId !== identityId) fail('PERSISTENCE_IDENTITY_CHANGED');
      check();
      const existing = bindings.get(workspaceId);
      if (existing) { current(workspaceId, identityId, existing); return store.unlock({ workspaceId, create: createWorkspace }); }
      const binding = { identityId, providerEpoch: epoch, workspaceEpoch, gate: lifecycle };
      bindings.set(workspaceId, binding);
      try { const result = await store.unlock({ workspaceId, create: createWorkspace }); check(); current(workspaceId, identityId, binding); return result; }
      catch (error) { if (bindings.get(workspaceId) === binding) bindings.delete(workspaceId); store.lock(workspaceId); throw error; }
    }
    const context = Object.freeze({
      store, unlock, sessionOnly: false, testOnly: Boolean(testing),
      assertWorkspace(workspaceId) {
        const binding = bindings.get(workspaceId);
        if (!binding) fail('PERSISTENCE_LOCKED');
        return current(workspaceId, binding.identityId, binding);
      },
      onLock(listener) { if (typeof listener !== 'function') fail('INVALID_ARGUMENT'); changeListeners.add(listener); return () => changeListeners.delete(listener); },
      close() {
        if (retired) return;
        retired = true; invalidate(); store.close(); offGate(); offOwner(); offProvider(); contexts.delete(context);
        listeners.clear(); changeListeners.clear();
      },
    });
    contexts.add(context);
    return context;
  }
  return Object.freeze({
    mode: 'encrypted-durable', testOnly: Boolean(testing), open: create,
    close() { if (closed) return; closed = true; for (const context of [...contexts]) context.close(); },
  });
}
