import { CaddiError, assertKeys, assertRecord, assertString } from '../contracts.mjs';
import { githubRequest, GITHUB_READ_OPERATIONS } from './github.mjs';

const fail = () => { throw new CaddiError('SERVICE_ARGUMENT_INVALID', 'Service scope is unavailable'); };
export const VERCEL_READ_OPERATIONS = Object.freeze(['projects:list', 'deployments:list']);
export const RESEND_READ_OPERATIONS = Object.freeze(['domains:list']);
const providers = Object.freeze({ github: GITHUB_READ_OPERATIONS, vercel: VERCEL_READ_OPERATIONS, resend: RESEND_READ_OPERATIONS });
const fields = Object.freeze({ github: Object.freeze(['owner', 'repository']), vercel: Object.freeze(['teamId', 'projectId']), resend: Object.freeze([]) });
export function serviceProvider(value = 'github') {
  if (typeof value !== 'string' || !Object.hasOwn(providers, value)) fail();
  return value;
}
export const serviceOperations = provider => providers[serviceProvider(provider)];
export const serviceScopeFields = provider => fields[serviceProvider(provider)];
export const serviceProviderLabel = provider => ({ github: 'GitHub', vercel: 'Vercel', resend: 'Resend' })[serviceProvider(provider)];
export function opaqueServiceId(value, label = 'id') {
  assertString(value, label, { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) fail();
  return value;
}
/** Extract a fixed provider scope while refusing fields from another provider. */
export function serviceScope(value) {
  assertRecord(value);
  const provider = serviceProvider(value.provider), selected = fields[provider];
  for (const key of ['owner', 'repository', 'teamId', 'projectId'])
    if (Object.hasOwn(value, key) && !selected.includes(key)) fail();
  const result = { provider };
  for (const key of selected) result[key] = value[key];
  if (provider === 'github') githubRequest({ ...result, operation: 'repository:get' });
  if (provider === 'vercel') {
    opaqueServiceId(result.teamId, 'teamId'); opaqueServiceId(result.projectId, 'projectId');
    if (!result.teamId.startsWith('team_') || !result.projectId.startsWith('prj_')) fail();
  }
  return Object.freeze(result);
}
/** Closed creation/record shape; callers explicitly list their non-scope keys. */
export function serviceDefinition(value, allowed = [], required = []) {
  assertRecord(value);
  const scope = serviceScope(value), keys = serviceScopeFields(scope.provider);
  assertKeys(value, ['provider', ...keys, ...allowed], [...keys, ...required]);
  return scope;
}
export function serviceOperationScope(operations, provider = 'github') {
  const accepted = serviceOperations(provider);
  if (!Array.isArray(operations) || !operations.length || operations.length > accepted.length ||
      new Set(operations).size !== operations.length || operations.some(value => !accepted.includes(value))) fail();
  return accepted.filter(value => operations.includes(value));
}
/** Keep the original GitHub tuple byte-for-byte compatible with saved digests. */
export function serviceScopeIdentity(value) {
  const scope = serviceScope(value);
  return [scope.provider, ...serviceScopeFields(scope.provider).map(key => scope[key])];
}
export function sameServiceScope(left, right) {
  try { return JSON.stringify(serviceScopeIdentity(left)) === JSON.stringify(serviceScopeIdentity(right)); }
  catch { return false; }
}
export function servicePublicScope(value) {
  const { provider, ...scope } = serviceScope(value);
  return { provider: serviceProviderLabel(provider), providerId: provider, ...scope };
}
