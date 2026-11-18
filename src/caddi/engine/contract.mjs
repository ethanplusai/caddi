import { CaddiError, assertKeys, assertId, assertInteger, assertString, assertRecord, cloneData } from '../contracts.mjs';
import { assertPageURL } from '../state/model.mjs';
import { assertAgentPayload } from '../desktop/agent-input.mjs';

// Operations whose payloads follow the agent input rules (an element or a point, allow-listed keys, bounded text).
const AGENT_OPERATIONS = new Set(['page:observe', 'page:click', 'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag',
  'page:scroll-by', 'page:scroll-into-view', 'page:wait', 'page:screenshot', 'page:read', 'page:extract']);

export const ENGINE_TARGET_FIELDS = Object.freeze(['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'documentGeneration', 'observationId', 'viewportRevision', 'capturePrivacyEpoch']);
/** @typedef {{workspaceId:string,tabId:string,frameId:string,runtimeIncarnation:string,documentGeneration:number,observationId:string,viewportRevision:number,capturePrivacyEpoch:number}} EngineTarget */
export function assertEngineTarget(value) {
  const target = cloneData(value, { maxBytes: 4096 });
  assertKeys(target, ENGINE_TARGET_FIELDS, ENGINE_TARGET_FIELDS);
  for (const key of ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'observationId']) assertId(target[key], key);
  for (const key of ['documentGeneration', 'viewportRevision', 'capturePrivacyEpoch']) assertInteger(target[key], key);
  return Object.freeze(target);
}
export const FIXTURE_CAPABILITIES = Object.freeze({
  implementation: 'fixture', isolation: 'full-profile', isolationEvidence: 'simulated',
  persistentStorage: false, input: 'target-scoped', capture: 'synthetic',
  extensions: false, passwordManagers: false, passkeys: false,
});
export function validateEngineCapabilities(value) {
  const result = cloneData(value);
  assertKeys(result, Object.keys(FIXTURE_CAPABILITIES), Object.keys(FIXTURE_CAPABILITIES));
  if (!['fixture', 'development', 'production'].includes(result.implementation) || !['full-profile', 'storage-partition', 'shared-session'].includes(result.isolation) || !['simulated', 'qualified', 'unqualified'].includes(result.isolationEvidence) || !['target-scoped', 'focus-required'].includes(result.input) || !['synthetic', 'engine', 'none'].includes(result.capture)) throw new CaddiError('INVALID_CAPABILITY', 'Invalid engine capability declaration');
  for (const key of ['persistentStorage', 'extensions', 'passwordManagers', 'passkeys']) if (typeof result[key] !== 'boolean') throw new CaddiError('INVALID_CAPABILITY', 'Expected capability boolean');
  if (result.implementation === 'fixture' && (result.isolationEvidence !== 'simulated' || result.persistentStorage || result.extensions || result.passwordManagers || result.passkeys || result.capture === 'engine')) throw new CaddiError('INVALID_CAPABILITY', 'Fixture cannot claim browser qualification');
  if (result.implementation === 'development' && result.isolationEvidence !== 'unqualified') throw new CaddiError('INVALID_CAPABILITY', 'Development adapters cannot claim isolation qualification');
  return Object.freeze(result);
}
export function validateEngineOperation(value) {
  const request = cloneData(value, { maxBytes: 32 * 1024 });
  assertKeys(request, ['operation', 'target', 'payload'], ['operation', 'target', 'payload']);
  request.target = assertEngineTarget(request.target);
  const shapes = {
    'page:navigate': ['url'], 'page:fill': ['elementId', 'value'], 'page:scroll': ['x', 'y'],
    // Built by Caddi from a saved login after its checks; an agent request carries only the login ID.
    'page:fill-login': ['origin', 'username', 'password'],
  };
  if (AGENT_OPERATIONS.has(request.operation)) {
    assertRecord(request.payload);
    assertAgentPayload(request.operation, request.payload);
    return request;
  }
  const shape = Object.hasOwn(shapes, request.operation) ? shapes[request.operation] : null;
  if (!shape) throw new CaddiError('UNSUPPORTED_OPERATION', 'Engine operation is unsupported');
  assertKeys(request.payload, shape, shape);
  if (request.operation === 'page:navigate') assertPageURL(request.payload.url);
  if (request.payload.elementId !== undefined) assertId(request.payload.elementId, 'elementId');
  if (request.operation === 'page:fill') assertString(request.payload.value, 'value', { max: 4096 });
  if (request.operation === 'page:fill-login') {
    assertString(request.payload.origin, 'origin', { min: 1, max: 2048 });
    assertString(request.payload.username, 'username', { max: 256 });
    assertString(request.payload.password, 'password', { min: 1, max: 1024 });
  }
  if (request.operation === 'page:scroll') {
    assertInteger(request.payload.x, 'x', { min: -1_000_000, max: 1_000_000 });
    assertInteger(request.payload.y, 'y', { min: -1_000_000, max: 1_000_000 });
  }
  return request;
}
