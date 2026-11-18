import { createHash } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, assertString, cloneData } from '../contracts.mjs';
import { serviceDefinition, serviceScopeIdentity, serviceOperationScope } from './scope.mjs';

const fail = () => { throw new CaddiError('SERVICE_CATALOG_INVALID', 'Saved service settings are unavailable'); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (items, key) => [...items].sort((a, b) => key(a).localeCompare(key(b)));
export function assertServiceFence(check) {
  if (typeof check !== 'function') fail();
  const value = check();
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail();
  return true;
}
export function durableServiceWorkspace(workspace, workspaceId, identityId) {
  if (workspace instanceof Promise) void workspace.catch(() => {});
  if (workspace && typeof workspace.then === 'function') fail();
  return !!workspace && workspace.durable === true && workspace.kind === 'project' &&
    (workspace.id ?? workspace.workspaceId) === workspaceId && workspace.identityId === identityId &&
    workspace.private !== true && !workspace.personal && !workspace.humanOnly &&
    (workspace.lifecycle == null || workspace.lifecycle.status === 'active');
}

/** Closed main-only projection. Never accepts persisted principal grants,
 * transport sessions, leases, raw credentials or callbacks from chrome. */
export function validateOwnerServiceCatalog(raw, workspaceLookup) {
  try {
    const value = cloneData(raw, { maxBytes: 1_048_576 });
    const fields = ['installationId', 'vaultId', 'revision', 'connections', 'shares'];
    assertKeys(value, fields, fields); assertId(value.installationId); assertId(value.vaultId); assertInteger(value.revision);
    if (typeof workspaceLookup !== 'function' || !Array.isArray(value.connections) || value.connections.length > 32 ||
        !Array.isArray(value.shares) || value.shares.length > 1024) fail();
    const connections = new Map(), shares = new Map(), eligibleShares = [];
    for (const item of value.connections) {
      const keys = ['serviceConnectionId', 'provider', 'label', 'generation', 'credentialVersion', 'scopeDigest', 'blobDigest'];
      serviceDefinition(item, keys, keys);
      assertId(item.serviceConnectionId); assertId(item.credentialVersion); assertInteger(item.generation, 'generation', { min: 1 });
      assertString(item.label, 'label', { min: 1, max: 120 });
      if (connections.has(item.serviceConnectionId) ||
          item.scopeDigest !== hash(serviceScopeIdentity(item)) || !/^[a-f0-9]{64}$/u.test(item.blobDigest)) fail();
      connections.set(item.serviceConnectionId, item);
    }
    for (const item of value.shares) {
      const keys = ['serviceConnectionId', 'workspaceId', 'identityId', 'operations', 'generation'];
      assertKeys(item, keys, keys);
      for (const key of ['serviceConnectionId', 'workspaceId', 'identityId']) assertId(item[key]);
      assertInteger(item.generation, 'generation', { min: 1 });
      const key = item.serviceConnectionId + '/' + item.workspaceId;
      if (!connections.has(item.serviceConnectionId) || shares.has(key)) fail();
      serviceOperationScope(item.operations, connections.get(item.serviceConnectionId).provider);
      shares.set(key, item);
      if (durableServiceWorkspace(workspaceLookup(item.workspaceId), item.workspaceId, item.identityId)) eligibleShares.push(item);
    }
    return { installationId: value.installationId, vaultId: value.vaultId, revision: value.revision,
      digest: hash([value.installationId, value.vaultId, value.revision,
        sorted([...connections.values()], item => item.serviceConnectionId),
        sorted([...shares.values()], item => item.serviceConnectionId + '/' + item.workspaceId)]),
      connections: [...connections.values()], shares: eligibleShares,
      withheldShares: value.shares.length - eligibleShares.length };
  } catch { fail(); }
}
