import { assertInteger, assertKeys, assertRecord, assertString } from '../contracts.mjs';
import { serviceDefinition, RESEND_READ_OPERATIONS, opaqueServiceId } from './scope.mjs';
import { readServiceJson, serviceFailure as fail, shortServiceText as short, assertNoServiceReflection } from './read-transport.mjs';

export { RESEND_READ_OPERATIONS } from './scope.mjs';
export function resendRequest({ operation, parameters = {} }) {
  if (!RESEND_READ_OPERATIONS.includes(operation)) fail('SERVICE_ARGUMENT_INVALID');
  assertKeys(parameters, ['limit', 'after']);
  const url = new URL('https://api.resend.com/domains');
  url.searchParams.set('limit', String(assertInteger(parameters.limit ?? 20, 'limit', { min: 1, max: 50 })));
  if (Object.hasOwn(parameters, 'after')) url.searchParams.set('after', opaqueServiceId(parameters.after, 'after'));
  return Object.freeze({ url: url.toString(), operation });
}
function select(raw) {
  assertRecord(raw);
  if (raw.object !== 'list' || typeof raw.has_more !== 'boolean' || !Array.isArray(raw.data) || raw.data.length > 50 ||
      (raw.has_more && !raw.data.length)) fail('SERVICE_RESPONSE_INVALID');
  const domains = raw.data.map(item => {
    assertRecord(item);
    return { id: opaqueServiceId(item.id), name: short(item.name, 253), status: short(item.status, 40),
      region: short(item.region, 40), createdAt: short(item.created_at, 64) };
  });
  return { domains, hasMore: raw.has_more, next: raw.has_more ? domains.at(-1).id : null };
}
export function validateResendResult({ operation, result }) {
  try {
    resendRequest({ operation });
    assertKeys(result, ['domains', 'hasMore', 'next'], ['domains', 'hasMore', 'next']);
    if (!Array.isArray(result.domains) || result.domains.length > 50 || typeof result.hasMore !== 'boolean') fail('SERVICE_RESPONSE_INVALID');
    for (const item of result.domains) {
      const keys = ['id', 'name', 'status', 'region', 'createdAt']; assertKeys(item, keys, keys);
      opaqueServiceId(item.id);
      for (const [field, max] of [['name', 253], ['status', 40], ['region', 40], ['createdAt', 64]]) assertString(item[field], field, { max });
    }
    if (result.hasMore) {
      if (!result.domains.length || result.next !== result.domains.at(-1).id) fail('SERVICE_RESPONSE_INVALID');
      opaqueServiceId(result.next, 'next');
    } else if (result.next !== null) fail('SERVICE_RESPONSE_INVALID');
    return result;
  } catch { fail('SERVICE_RESPONSE_INVALID'); }
}
export function createResendTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('SERVICE_BACKEND_UNAVAILABLE');
  return Object.freeze({ async send(input) {
    const scope = serviceDefinition(input, ['operation', 'parameters', 'token', 'signal'], ['operation', 'token']);
    if (scope.provider !== 'resend') fail('SERVICE_ARGUMENT_INVALID');
    const { operation, token, signal } = input;
    const request = resendRequest({ operation, parameters: input.parameters });
    const raw = await readServiceJson({ fetchImpl, request, token, signal });
    try {
      const result = validateResendResult({ operation, result: select(raw) });
      assertNoServiceReflection(result, token); return result;
    } catch { fail('SERVICE_RESPONSE_INVALID'); }
  } });
}
