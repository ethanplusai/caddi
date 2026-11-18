import { assertId, assertInteger, assertKeys, assertString, cloneData } from '../contracts.mjs';
import { serviceDefinition, serviceOperationScope, serviceScopeIdentity, sameServiceScope } from '../services/scope.mjs';
import { hash } from './crypto.mjs';
import { fail, synchronous } from './common.mjs';

export const LIMITS = Object.freeze({ clients: 32, feedback: 32, connections: 32, shares: 1024, tombstones: 4096, pending: 16 });
export const scopeDigest = value => hash(Buffer.from(JSON.stringify(serviceScopeIdentity(value))));
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('PERSISTENCE_CORRUPT'); return value; };
export function operations(raw, provider = 'github') {
  try { return serviceOperationScope(raw, provider); } catch { fail('INVALID_ARGUMENT'); }
}
export function eligibleWorkspace(lookup, workspaceId, identityId, { service = false } = {}) {
  assertId(workspaceId); assertId(identityId);
  const workspace = synchronous(lookup(workspaceId), 'PERSISTENCE_IDENTITY_CHANGED');
  if (!workspace || (workspace.workspaceId ?? workspace.id) !== workspaceId || workspace.identityId !== identityId ||
      workspace.durable !== true || workspace.private === true || !['personal', 'project'].includes(workspace.kind) ||
      (workspace.lifecycle != null && workspace.lifecycle.status !== 'active') || (service && workspace.kind === 'personal'))
    fail('PERSISTENCE_IDENTITY_CHANGED');
  return { workspaceId, identityId };
}
export function initialState({ installationId, vaultId }) {
  return { version: 1, installationId, vaultId, revision: 0, clients: [], feedback: [], connections: [], shares: [], tombstones: [] };
}
export function validateConnection(value) {
  const fields = ['serviceConnectionId', 'provider', 'label', 'generation', 'credentialVersion', 'scopeDigest', 'blobDigest'];
  serviceDefinition(value, fields, fields);
  assertId(value.serviceConnectionId); assertId(value.credentialVersion);
  assertInteger(value.generation, 'generation', { min: 1 });
  assertString(value.label, 'label', { min: 1, max: 120 });
  if (value.scopeDigest !== scopeDigest(value)) fail('PERSISTENCE_CORRUPT');
  digest(value.blobDigest);
  return value;
}
export function validateState(raw, identity) {
  const value = cloneData(raw);
  if (value.version > 1) fail('PERSISTENCE_FUTURE_VERSION');
  const fields = ['version', 'installationId', 'vaultId', 'revision', 'clients', 'feedback', 'connections', 'shares', 'tombstones'];
  assertKeys(value, fields, fields);
  if (value.version !== 1 || value.installationId !== identity.installationId || value.vaultId !== identity.vaultId) fail('PERSISTENCE_CORRUPT');
  assertId(value.installationId); assertId(value.vaultId); assertInteger(value.revision, 'revision');
  for (const name of ['clients', 'feedback', 'connections', 'shares', 'tombstones'])
    if (!Array.isArray(value[name]) || value[name].length > LIMITS[name]) fail('PERSISTENCE_CAPACITY');
  const unique = (items, key) => { if (new Set(items.map(key)).size !== items.length) fail('PERSISTENCE_CORRUPT'); };
  for (const item of value.clients) {
    assertKeys(item, ['clientId', 'label', 'transport'], ['clientId', 'label', 'transport']);
    assertId(item.clientId); assertString(item.label, 'label', { min: 1, max: 120 });
    if (item.transport !== 'mcp') fail('PERSISTENCE_CORRUPT');
  }
  for (const item of value.feedback) {
    assertKeys(item, ['workspaceId', 'identityId'], ['workspaceId', 'identityId']);
    assertId(item.workspaceId); assertId(item.identityId);
  }
  for (const item of value.connections) validateConnection(item);
  for (const item of value.shares) {
    const fields = ['serviceConnectionId', 'workspaceId', 'identityId', 'operations', 'generation'];
    assertKeys(item, fields, fields);
    assertId(item.serviceConnectionId); assertId(item.workspaceId); assertId(item.identityId);
    assertInteger(item.generation, 'generation', { min: 1 });
    const connection = value.connections.find(connection => connection.serviceConnectionId === item.serviceConnectionId);
    if (!connection) fail('PERSISTENCE_CORRUPT');
    operations(item.operations, connection.provider);
  }
  for (const item of value.tombstones) {
    assertKeys(item, ['kind', 'id', 'workspaceId', 'generation', 'removedAtRevision'], ['kind', 'id', 'workspaceId', 'generation', 'removedAtRevision']);
    if (!['client', 'connection', 'share'].includes(item.kind)) fail('PERSISTENCE_CORRUPT');
    assertId(item.id); assertInteger(item.generation, 'generation', { min: 1 });
    assertInteger(item.removedAtRevision, 'removedAtRevision', { min: 1, max: value.revision });
    if (item.kind === 'share') assertId(item.workspaceId); else if (item.workspaceId !== null) fail('PERSISTENCE_CORRUPT');
  }
  unique(value.clients, x => x.clientId); unique(value.feedback, x => x.workspaceId);
  unique(value.connections, x => x.serviceConnectionId); unique(value.shares, x => x.serviceConnectionId + ':' + x.workspaceId);
  unique(value.tombstones, x => x.kind + ':' + x.id + ':' + (x.workspaceId ?? ''));
  for (const item of value.clients) if (value.tombstones.some(x => x.kind === 'client' && x.id === item.clientId)) fail('PERSISTENCE_CORRUPT');
  for (const item of value.connections) if (value.tombstones.some(x => x.kind === 'connection' && x.id === item.serviceConnectionId)) fail('PERSISTENCE_CORRUPT');
  for (const item of value.shares) {
    const tomb = value.tombstones.find(x => x.kind === 'share' && x.id === item.serviceConnectionId && x.workspaceId === item.workspaceId);
    if (tomb && tomb.generation >= item.generation) fail('PERSISTENCE_CORRUPT');
  }
  return value;
}
function tombstone(state, kind, id, workspaceId, generation) {
  const found = state.tombstones.find(item => item.kind === kind && item.id === id && item.workspaceId === workspaceId);
  const next = { kind, id, workspaceId, generation, removedAtRevision: state.revision + 1 };
  if (found) Object.assign(found, next); else state.tombstones.push(next);
}
function connection(state, serviceConnectionId, expectedGeneration) {
  assertId(serviceConnectionId); assertInteger(expectedGeneration, 'expectedGeneration', { min: 1 });
  const value = state.connections.find(item => item.serviceConnectionId === serviceConnectionId);
  if (!value || value.generation !== expectedGeneration) fail('PERSISTENCE_CONFLICT');
  return value;
}
function share(state, { serviceConnectionId, workspaceId, identityId, operations: requested }, lookup) {
  eligibleWorkspace(lookup, workspaceId, identityId, { service: true });
  const connection = state.connections.find(item => item.serviceConnectionId === serviceConnectionId);
  if (!connection) fail('PERSISTENCE_SCOPE_DENIED');
  const selected = operations(requested, connection.provider);
  const existing = state.shares.find(item => item.serviceConnectionId === serviceConnectionId && item.workspaceId === workspaceId);
  const old = state.tombstones.find(item => item.kind === 'share' && item.id === serviceConnectionId && item.workspaceId === workspaceId);
  const generation = Math.max(existing?.generation ?? 0, old?.generation ?? 0) + 1;
  assertInteger(generation, 'generation', { min: 1 });
  const next = { serviceConnectionId, workspaceId, identityId, operations: selected, generation };
  if (existing) Object.assign(existing, next); else state.shares.push(next);
}
export function reduceOwnerCommand(current, command, lookup) {
  const state = cloneData(current);
  switch (command.type) {
    case 'client.remember': {
      assertKeys(command, ['type', 'clientId', 'label'], ['type', 'clientId', 'label']);
      assertId(command.clientId); assertString(command.label, 'label', { min: 1, max: 120 });
      if (state.tombstones.some(item => item.kind === 'client' && item.id === command.clientId)) fail('PERSISTENCE_CONFLICT');
      const item = { clientId: command.clientId, label: command.label, transport: 'mcp' };
      const found = state.clients.find(value => value.clientId === item.clientId);
      if (found) Object.assign(found, item); else state.clients.push(item);
      break;
    }
    case 'client.forget': {
      assertKeys(command, ['type', 'clientId'], ['type', 'clientId']); assertId(command.clientId);
      state.clients = state.clients.filter(item => item.clientId !== command.clientId);
      tombstone(state, 'client', command.clientId, null, 1);
      break;
    }
    case 'feedback.bind': {
      assertKeys(command, ['type', 'workspaceId', 'identityId'], ['type', 'workspaceId', 'identityId']);
      const binding = eligibleWorkspace(lookup, command.workspaceId, command.identityId);
      const old = state.feedback.find(item => item.workspaceId === binding.workspaceId);
      if (old && old.identityId !== binding.identityId) fail('PERSISTENCE_IDENTITY_CHANGED');
      if (!old) state.feedback.push(binding);
      break;
    }
    case 'share.set': {
      const fields = ['type', 'serviceConnectionId', 'expectedGeneration', 'workspaceId', 'identityId', 'operations'];
      assertKeys(command, fields, fields); connection(state, command.serviceConnectionId, command.expectedGeneration);
      share(state, command, lookup);
      break;
    }
    case 'share.revoke': {
      const fields = ['type', 'serviceConnectionId', 'expectedGeneration', 'workspaceId'];
      assertKeys(command, fields, fields); connection(state, command.serviceConnectionId, command.expectedGeneration); assertId(command.workspaceId);
      const old = state.shares.find(item => item.serviceConnectionId === command.serviceConnectionId && item.workspaceId === command.workspaceId);
      const prior = state.tombstones.find(item => item.kind === 'share' && item.id === command.serviceConnectionId && item.workspaceId === command.workspaceId);
      tombstone(state, 'share', command.serviceConnectionId, command.workspaceId, Math.max(old?.generation ?? 0, prior?.generation ?? 0) + 1);
      state.shares = state.shares.filter(item => item !== old);
      break;
    }
    case 'connection.remove': {
      const fields = ['type', 'serviceConnectionId', 'expectedGeneration']; assertKeys(command, fields, fields);
      const old = connection(state, command.serviceConnectionId, command.expectedGeneration);
      tombstone(state, 'connection', old.serviceConnectionId, null, old.generation + 1);
      for (const item of state.shares.filter(value => value.serviceConnectionId === old.serviceConnectionId))
        tombstone(state, 'share', item.serviceConnectionId, item.workspaceId, item.generation + 1);
      state.shares = state.shares.filter(value => value.serviceConnectionId !== old.serviceConnectionId);
      state.connections = state.connections.filter(value => value !== old);
      break;
    }
    default: fail('INVALID_ARGUMENT');
  }
  state.revision++;
  return state;
}
/** Internal vault publication only: the registry's public commands cannot forge a credential reference. */
export function installConnection(current, record, { expectedGeneration = null, initialShare = null } = {}, lookup) {
  const state = cloneData(current);
  validateConnection(record);
  const old = state.connections.find(item => item.serviceConnectionId === record.serviceConnectionId);
  if (expectedGeneration === null) {
    if (old || state.tombstones.some(item => item.kind === 'connection' && item.id === record.serviceConnectionId) || record.generation !== 1) fail('PERSISTENCE_CONFLICT');
    state.connections.push(record);
  } else {
    connection(state, record.serviceConnectionId, expectedGeneration);
    if (record.generation !== old.generation + 1 || !sameServiceScope(record, old) ||
        record.credentialVersion === old.credentialVersion) fail('PERSISTENCE_CONFLICT');
    Object.assign(old, record);
  }
  if (initialShare !== null) {
    assertKeys(initialShare, ['workspaceId', 'identityId', 'operations'], ['workspaceId', 'identityId', 'operations']);
    share(state, { ...initialShare, serviceConnectionId: record.serviceConnectionId }, lookup);
  }
  state.revision++;
  return state;
}
