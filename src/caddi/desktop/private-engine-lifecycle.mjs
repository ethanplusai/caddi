// Main-process capability ownership for newly created ephemeral identities.
// No filesystem operations, native destruction, or page-unload decisions occur here.
import { CaddiError, assertKeys, assertId } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Private browser identity is unavailable'); };
const allowedSync = (value, code = 'AUTHORIZATION_REQUIRED') => {
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail(code);
};
export const PRIVATE_ENGINE_LIMITS = Object.freeze({ active: 8, lifetimes: 128 });
export function createPrivateEngineLifetimes({ engineIncarnation, workspaceFor, pageCount, seal, cleanupSession, retireWorkspace } = {}) {
  assertId(engineIncarnation);
  for (const callback of [workspaceFor, pageCount, seal, cleanupSession, retireWorkspace]) if (typeof callback !== 'function') fail('INVALID_ARGUMENT');
  const records = new WeakMap(), active = new Map(), workspaceIds = new Set(), identityIds = new Set();
  function assertFresh({ workspaceId, identityId }) {
    assertId(workspaceId); assertId(identityId);
    if (workspaceIds.has(workspaceId) || identityIds.has(identityId)) fail('PRIVATE_IDENTITY_REUSED');
    if (active.size >= PRIVATE_ENGINE_LIMITS.active || workspaceIds.size >= PRIVATE_ENGINE_LIMITS.lifetimes) fail('PRIVATE_IDENTITY_CAPACITY');
    return true;
  }
  function owned(record) {
    const workspace = record.workspace;
    if (!workspace || workspaceFor(record.workspaceId) !== workspace || workspace.id !== record.workspaceId ||
        workspace.identityId !== record.identityId || workspace.privateScope !== true || workspace.storageMode !== 'ephemeral' ||
        workspace.session !== record.session || record.session.isPersistent() !== false || record.session.storagePath !== null)
      fail('PRIVATE_IDENTITY_MISMATCH');
    return workspace;
  }
  function binding(record) { return Object.freeze({ workspaceId: record.workspaceId, identityId: record.identityId,
    engineIncarnation, capability: record.capability }); }
  function register(workspace) {
    const workspaceId = workspace?.id, identityId = workspace?.identityId;
    assertFresh({ workspaceId, identityId });
    const capability = Object.freeze(Object.create(null));
    const record = { workspaceId, identityId, capability, workspace, session: workspace.session, phase: 'active', pending: null };
    owned(record); workspaceIds.add(workspaceId); identityIds.add(identityId);
    active.set(workspaceId, record); records.set(capability, record);
    return binding(record);
  }
  function validateRequest(input) {
    assertKeys(input, ['workspaceId', 'identityId', 'engineIncarnation', 'capability', 'beforeDispose'],
      ['workspaceId', 'identityId', 'engineIncarnation', 'capability', 'beforeDispose']);
    assertId(input.workspaceId); assertId(input.identityId); assertId(input.engineIncarnation);
    if (typeof input.beforeDispose !== 'function') fail('AUTHORIZATION_REQUIRED');
    const record = records.get(input.capability);
    if (!record || input.workspaceId !== record.workspaceId || input.identityId !== record.identityId || input.engineIncarnation !== engineIncarnation)
      fail('PRIVATE_CAPABILITY_INVALID');
    return record;
  }
  function dispose(input) {
    try {
      const record = validateRequest(input);
      if (record.phase === 'disposed') return Promise.resolve({ disposed: true });
      const workspace = owned(record);
      if (record.pending) return record.pending;
      allowedSync(input.beforeDispose());
      owned(record);
      // A crashed/closing page still counts until its actual native destruction
      // acknowledgment removes its allocation. This method never closes it.
      if (pageCount(workspace) !== 0) fail('PRIVATE_PAGES_OPEN');
      allowedSync(seal(workspace));
      if (pageCount(workspace) !== 0) fail('PRIVATE_PAGES_OPEN');
      record.phase = 'disposing';
      const session = record.session;
      record.pending = Promise.resolve().then(() => cleanupSession(session)).then(() => {
        owned(record);
        if (pageCount(workspace) !== 0) fail('PRIVATE_PAGES_OPEN');
        allowedSync(retireWorkspace(workspace), 'PRIVATE_RETIRE_UNCONFIRMED');
        if (workspaceFor(record.workspaceId) === workspace) fail('PRIVATE_RETIRE_UNCONFIRMED');
        active.delete(record.workspaceId); record.phase = 'disposed'; record.workspace = null; record.session = null;
        return { disposed: true };
      }).catch(error => {
        record.phase = 'quarantined'; throw new CaddiError('PRIVATE_DISPOSAL_INCOMPLETE', 'Private identity cleanup has not completed');
      }).finally(() => { record.pending = null; });
      return record.pending;
    } catch (error) { return Promise.reject(error); }
  }
  return Object.freeze({ assertFresh, register, dispose,
    hasSeen: ({ workspaceId, identityId }) => workspaceIds.has(workspaceId) || identityIds.has(identityId),
    bindings: () => [...active.values()].map(binding),
    status(input) { const record = validateRequest(input); return { phase: record.phase, disposed: record.phase === 'disposed' }; },
  });
}
