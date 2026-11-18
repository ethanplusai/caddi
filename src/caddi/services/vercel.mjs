import { assertInteger, assertKeys, assertRecord, assertString } from '../contracts.mjs';
import { serviceDefinition, serviceScope, VERCEL_READ_OPERATIONS, opaqueServiceId } from './scope.mjs';
import { readServiceJson, serviceFailure as fail, shortServiceText as short, serviceInteger as integer, assertNoServiceReflection } from './read-transport.mjs';

export { VERCEL_READ_OPERATIONS } from './scope.mjs';
function projectCursor(value) {
  assertString(value, 'from', { min: 1, max: 256 });
  if (!/^[\x20-\x7e]+$/u.test(value)) fail('SERVICE_ARGUMENT_INVALID');
  return value;
}
export function vercelRequest({ teamId, projectId, operation, parameters = {} }) {
  serviceScope({ provider: 'vercel', teamId, projectId });
  if (!VERCEL_READ_OPERATIONS.includes(operation)) fail('SERVICE_ARGUMENT_INVALID');
  assertKeys(parameters, operation === 'projects:list' ? ['limit', 'until', 'from'] : ['limit', 'until']);
  if (Object.hasOwn(parameters, 'from') && Object.hasOwn(parameters, 'until')) fail('SERVICE_ARGUMENT_INVALID');
  const limit = assertInteger(parameters.limit ?? 20, 'limit', { min: 1, max: 50 });
  const url = new URL(operation === 'projects:list' ? 'https://api.vercel.com/v10/projects' : 'https://api.vercel.com/v7/deployments');
  url.searchParams.set('teamId', teamId);
  if (operation === 'deployments:list') url.searchParams.set('projectId', projectId);
  url.searchParams.set('limit', String(limit));
  if (Object.hasOwn(parameters, 'until')) url.searchParams.set('until', String(assertInteger(parameters.until, 'until')));
  if (Object.hasOwn(parameters, 'from')) url.searchParams.set('from', projectCursor(parameters.from));
  return Object.freeze({ url: url.toString(), operation });
}
function nextPage(raw, operation) {
  if (raw.pagination == null) return null;
  assertRecord(raw.pagination);
  const next = raw.pagination.next ?? null;
  // Projects may use opaque cursors; return them exactly as received. Deployment
  // cursors remain timestamps, and numeric strings are never coerced.
  if (typeof next === 'string' && operation === 'projects:list') projectCursor(next);
  else if (next !== null) assertInteger(next, 'next');
  return next;
}
function select(scope, operation, raw) {
  if (operation === 'projects:list') {
    const projects = Array.isArray(raw) ? raw : (assertRecord(raw), raw.projects);
    if (!Array.isArray(projects) || projects.length > 50) fail('SERVICE_RESPONSE_INVALID');
    const selected = [];
    for (const item of projects) {
      assertRecord(item);
      if (item.id !== scope.projectId) continue;
      if (item.accountId !== scope.teamId || selected.length) fail('SERVICE_RESPONSE_INVALID');
      selected.push({ id: item.id, name: short(item.name, 100), framework: short(item.framework, 100), updatedAt: integer(item.updatedAt) });
    }
    return { teamId: scope.teamId, projectId: scope.projectId, projects: selected, next: Array.isArray(raw) ? null : nextPage(raw, operation) };
  }
  assertRecord(raw);
  if (!Array.isArray(raw.deployments) || raw.deployments.length > 50) fail('SERVICE_RESPONSE_INVALID');
  const deployments = raw.deployments.map(item => {
    assertRecord(item);
    // Require response identity as well as the fixed request query.
    if (item.projectId !== scope.projectId ||
        (Object.hasOwn(item, 'accountId') && item.accountId !== scope.teamId)) fail('SERVICE_RESPONSE_INVALID');
    const id = opaqueServiceId(item.uid ?? item.id);
    return { id, name: short(item.name, 100), state: short(item.readyState ?? item.state, 40),
      target: short(item.target, 40), createdAt: integer(item.createdAt ?? item.created) };
  });
  return { teamId: scope.teamId, projectId: scope.projectId, deployments, next: nextPage(raw, operation) };
}
export function validateVercelResult({ teamId, projectId, operation, result }) {
  try {
    vercelRequest({ teamId, projectId, operation });
    const name = operation === 'projects:list' ? 'projects' : 'deployments';
    const keys = ['teamId', 'projectId', name, 'next']; assertKeys(result, keys, keys);
    if (result.teamId !== teamId || result.projectId !== projectId || !Array.isArray(result[name]) ||
        result[name].length > (name === 'projects' ? 1 : 50)) fail('SERVICE_RESPONSE_INVALID');
    if (typeof result.next === 'string' && name === 'projects') projectCursor(result.next);
    else if (result.next !== null) assertInteger(result.next, 'next');
    for (const item of result[name]) {
      const fields = name === 'projects' ? ['id', 'name', 'framework', 'updatedAt'] : ['id', 'name', 'state', 'target', 'createdAt'];
      assertKeys(item, fields, fields); opaqueServiceId(item.id); assertString(item.name, 'name', { max: 100 });
      if (name === 'projects') {
        if (item.id !== projectId) fail('SERVICE_RESPONSE_INVALID');
        assertString(item.framework, 'framework', { max: 100 }); assertInteger(item.updatedAt, 'updatedAt');
      } else {
        assertString(item.state, 'state', { max: 40 }); assertString(item.target, 'target', { max: 40 }); assertInteger(item.createdAt, 'createdAt');
      }
    }
    return result;
  } catch { fail('SERVICE_RESPONSE_INVALID'); }
}
export function createVercelTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('SERVICE_BACKEND_UNAVAILABLE');
  return Object.freeze({ async send(input) {
    const scope = serviceDefinition(input, ['operation', 'parameters', 'token', 'signal'], ['operation', 'token']);
    if (scope.provider !== 'vercel') fail('SERVICE_ARGUMENT_INVALID');
    const { operation, token, signal } = input;
    const request = vercelRequest({ ...scope, operation, parameters: input.parameters });
    const raw = await readServiceJson({ fetchImpl, request, token, signal });
    try {
      const result = validateVercelResult({ ...scope, operation, result: select(scope, operation, raw) });
      assertNoServiceReflection(result, token); return result;
    } catch { fail('SERVICE_RESPONSE_INVALID'); }
  } });
}
