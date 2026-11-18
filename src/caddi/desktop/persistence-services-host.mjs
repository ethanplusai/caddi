import { assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';
import { assertDesktopPersistenceBundle } from '../persistence/index.mjs';
import { fail, safeError, fence, strictDecision, synchronous, signalValid } from '../persistence/common.mjs';

const projection = state => ({ installationId: state.installationId, vaultId: state.vaultId,
  revision: state.revision, connections: state.connections, shares: state.shares });
const catalogSignature = state => JSON.stringify([state.connections, state.shares]);
const providerFields = Object.freeze({ github: ['owner', 'repository'], vercel: ['teamId', 'projectId'], resend: [] });
function connectionReview(item) {
  const fields = Object.hasOwn(providerFields, item.provider) ? providerFields[item.provider] : null;
  if (!fields) fail('PERSISTENCE_SCOPE_DENIED');
  return { serviceConnectionId: item.serviceConnectionId, generation: item.generation, provider: item.provider,
    label: item.label, ...Object.fromEntries(fields.map(name => [name, item[name]])) };
}

/**
 * Main-owned composition only. Owner intent may be restored; transport sessions,
 * principal grants, leases and queued service operations are never reconstructed.
 * The caller supplies the exact displayed owner/chrome review fence.
 */
export function createPersistenceServicesHost({ persistence, gate, services, allowTest = false, onChange = () => {} } = {}) {
  const metadata = assertDesktopPersistenceBundle(persistence, { gate, allowTest });
  if (['restoreOwnerCatalog', 'pauseDurableCatalog', 'revokeWorkspaceShare', 'removeConnection', 'revokeConnectionGrants']
    .some(name => typeof services?.[name] !== 'function') || typeof onChange !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  const pending = new Set();
  let closed = false, epoch = 0, loaded = false, needsReload = true, revision = null, lastSignature = null, lastError = null;
  const emit = () => { try { strictDecision(onChange()); } catch {} };
  function invalidate() {
    epoch++; loaded = false; needsReload = true; revision = null; lastSignature = null;
    for (const permit of pending) permit.controller.abort();
    try { strictDecision(services.pauseDurableCatalog()); } catch { lastError = 'PERSISTENCE_UNAVAILABLE'; }
    emit();
  }
  const unsubscribe = persistence.onLock(invalidate);
  function active() {
    if (closed) fail('PERSISTENCE_CLOSED');
    assertDesktopPersistenceBundle(persistence, { gate, allowTest });
  }
  function begin({ assertCurrent, signal } = {}) {
    active(); signalValid(signal);
    if (typeof assertCurrent !== 'function') fail('PERSISTENCE_REVIEW_REQUIRED');
    if (pending.size >= 16) fail('PERSISTENCE_BUSY');
    fence(assertCurrent);
    const captured = synchronous(gate.capture({ purpose: 'service-owner' }), 'PERSISTENCE_LOCKED');
    if (!captured || !Number.isSafeInteger(captured.epoch) || !(captured.signal instanceof AbortSignal) ||
        typeof captured.assertCurrent !== 'function') fail('PERSISTENCE_LOCKED');
    const at = epoch, controller = new AbortController();
    const abort = () => controller.abort();
    const check = () => {
      active();
      if (at !== epoch || signal?.aborted || controller.signal.aborted || captured.signal.aborted) fail('PERSISTENCE_CANCELLED');
      fence(captured.assertCurrent, 'PERSISTENCE_LOCKED'); fence(assertCurrent);
      return true;
    };
    if (signal?.aborted || captured.signal.aborted) fail('PERSISTENCE_CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    captured.signal.addEventListener('abort', abort, { once: true });
    const permit = { controller, check, finish() {
      signal?.removeEventListener('abort', abort); captured.signal.removeEventListener('abort', abort);
      pending.delete(permit);
    } };
    pending.add(permit);
    try { check(); return permit; } catch (error) { permit.finish(); throw error; }
  }
  function apply(state, permit) {
    permit.check();
    const accepted = synchronous(services.restoreOwnerCatalog(projection(state), { assertCurrent: permit.check }));
    if (!accepted || accepted.agentGrantsRestored !== 0) fail('PERSISTENCE_UNAVAILABLE');
    permit.check();
    loaded = true; needsReload = false; revision = state.revision; lastSignature = catalogSignature(state); lastError = null;
    emit();
    return accepted;
  }
  function review() {
    active();
    if (!loaded) fail('PERSISTENCE_REVIEW_REQUIRED');
    const state = persistence.registry.snapshot();
    if (catalogSignature(state) !== lastSignature) { needsReload = true; fail('PERSISTENCE_REVIEW_REQUIRED'); }
    // Feedback/client catalog changes advance the CAS revision without replaying
    // service settings or touching any unrelated live runtime grants.
    revision = state.revision;
    return cloneData({ revision, connections: state.connections.map(connectionReview), shares: state.shares });
  }
  async function load(options) {
    const permit = begin(options);
    try {
      const state = await persistence.registry.load({ assertCurrent: permit.check, signal: permit.controller.signal });
      const accepted = apply(state, permit);
      return { status: 'loaded', revision: state.revision, ...accepted };
    } catch (error) { lastError = safeError(error).code; emit(); throw safeError(error); }
    finally { permit.finish(); }
  }
  function prepare(kind, raw, options) {
    const permit = begin(options);
    try {
      const fields = {
        createConnection: ['expectedRevision', 'serviceConnectionId', 'provider', 'label', 'owner', 'repository', 'teamId', 'projectId', 'initialShare', 'credential'],
        shareConnection: ['expectedRevision', 'serviceConnectionId', 'expectedGeneration', 'workspaceId', 'identityId', 'operations'],
        revokeShare: ['expectedRevision', 'serviceConnectionId', 'expectedGeneration', 'workspaceId'],
        removeConnection: ['expectedRevision', 'serviceConnectionId', 'expectedGeneration'],
        rotateCredential: ['expectedRevision', 'serviceConnectionId', 'expectedGeneration', 'credential'],
      }[kind];
      const required = kind === 'createConnection' ?
        ['expectedRevision', 'provider', 'label', 'credential'] : fields;
      assertKeys(raw, fields, required);
      if (kind === 'createConnection') {
        const scope = Object.hasOwn(providerFields, raw.provider) ? providerFields[raw.provider] : null;
        if (!scope) fail('PERSISTENCE_SCOPE_DENIED');
        assertKeys(raw, ['expectedRevision', 'serviceConnectionId', 'provider', 'label', 'initialShare', 'credential', ...scope], [...required, ...scope]);
      }
      const { credential, ...plain } = raw, input = cloneData(plain, { maxBytes: 16384 });
      if (Object.hasOwn(raw, 'credential')) input.credential = credential;
      const displayed = review();
      assertInteger(input.expectedRevision, 'expectedRevision');
      if (input.expectedRevision !== displayed.revision) fail('PERSISTENCE_CONFLICT');
      if (kind !== 'createConnection') {
        assertId(input.serviceConnectionId); assertInteger(input.expectedGeneration, 'expectedGeneration', { min: 1 });
        const connection = displayed.connections.find(item => item.serviceConnectionId === input.serviceConnectionId);
        if (!connection || connection.generation !== input.expectedGeneration) fail('PERSISTENCE_CONFLICT');
      }
      if (kind === 'revokeShare') assertId(input.workspaceId);
      permit.check();
      // Runtime denial comes first and never depends on a disk write succeeding.
      if (kind === 'revokeShare') services.revokeWorkspaceShare(input);
      else if (kind === 'removeConnection') services.removeConnection(input.serviceConnectionId);
      else if (kind === 'rotateCredential') services.revokeConnectionGrants(input.serviceConnectionId);
      permit.check();
      return { permit, input };
    } catch (error) { permit.finish(); throw safeError(error); }
  }
  async function mutate(kind, raw, options) {
    const { permit, input } = prepare(kind, raw, options);
    let saved = null;
    try {
      const target = ['createConnection', 'rotateCredential'].includes(kind) ? persistence.vault : persistence.registry;
      const operation = target[kind](input, { assertCurrent: permit.check, signal: permit.controller.signal });
      // The vault synchronously copied a credential into its bounded operation;
      // this owner coordinator does not retain or export that caller-owned input.
      delete input.credential;
      saved = await operation;
      try {
        apply(saved, permit);
        return { status: 'saved', revision: saved.revision, applied: true, needsReload: false };
      } catch (error) {
        // An acknowledged disk commit is not reported as an uncommitted failure.
        // A later explicit owner load may publish it once authority is available.
        needsReload = true; lastError = safeError(error).code; emit();
        return { status: 'saved', revision: saved.revision, applied: false, needsReload: true };
      }
    } catch (error) {
      const clean = safeError(error);
      if (clean.commitOutcomeUnknown || clean.code === 'PERSISTENCE_COMMIT_UNKNOWN') {
        invalidate(); lastError = 'PERSISTENCE_COMMIT_UNKNOWN';
      } else {
        lastError = clean.code;
        if (clean.code === 'PERSISTENCE_CONFLICT') needsReload = true;
      }
      emit();
      throw clean;
    } finally { delete input.credential; permit.finish(); }
  }
  return Object.freeze({
    load, review,
    createConnection: (input, options) => mutate('createConnection', input, options),
    shareConnection: (input, options) => mutate('shareConnection', input, options),
    revokeShare: (input, options) => mutate('revokeShare', input, options),
    removeConnection: (input, options) => mutate('removeConnection', input, options),
    rotateCredential: (input, options) => mutate('rotateCredential', input, options),
    status: () => ({ mode: metadata.mode, testOnly: metadata.testOnly, loaded, needsReload, revision, pending: pending.size, closed, lastError }),
    close() { if (closed) return; closed = true; invalidate(); unsubscribe(); },
  });
}
