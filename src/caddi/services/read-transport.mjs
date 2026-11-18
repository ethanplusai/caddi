import { CaddiError } from '../contracts.mjs';

export const serviceFailure = code => { throw new CaddiError(code, 'Service read request is unavailable'); };
export const shortServiceText = (value, max = 512) => typeof value === 'string' ? value.slice(0, max) : '';
export const serviceInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const cancel = body => { try { void Promise.resolve(body?.cancel()).catch(() => {}); } catch {} };
export function assertNoServiceReflection(value, token) {
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    try { if (bytes.includes(token)) serviceFailure('SERVICE_RESPONSE_INVALID'); }
    finally { bytes.fill(0); }
  } else if (Array.isArray(value)) for (const item of value) assertNoServiceReflection(item, token);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    assertNoServiceReflection(key, token); assertNoServiceReflection(item, token);
  }
}
/** Fixed callers supply the URL. Credentials and response bytes never enter errors. */
export async function readServiceJson({ fetchImpl, request, token, signal }) {
  if (typeof fetchImpl !== 'function' || !Buffer.isBuffer(token) || token.length < 1 || token.length > 4096 ||
      token.some(byte => byte < 33 || byte > 126) || signal?.aborted) serviceFailure('SERVICE_BACKEND_UNAVAILABLE');
  let response;
  try {
    response = await fetchImpl(request.url, { method: 'GET', redirect: 'manual', signal,
      headers: { accept: 'application/json', authorization: 'Bearer ' + token.toString('utf8') } });
  } catch { serviceFailure('SERVICE_BACKEND_UNAVAILABLE'); }
  if (!response || response.status !== 200 || response.redirected || signal?.aborted) {
    cancel(response?.body); serviceFailure('SERVICE_BACKEND_UNAVAILABLE');
  }
  const stated = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(stated) && stated > 262144) { cancel(response.body); serviceFailure('SERVICE_RESPONSE_TOO_LARGE'); }
  const chunks = []; let size = 0, reader, combined;
  const abort = () => cancel(reader ?? response.body);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    reader = response.body?.getReader();
    if (!reader) serviceFailure('SERVICE_RESPONSE_INVALID');
    for (;;) {
      const part = await reader.read();
      if (signal?.aborted) serviceFailure('SERVICE_BACKEND_UNAVAILABLE');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) serviceFailure('SERVICE_RESPONSE_INVALID');
      size += part.value.byteLength;
      if (size > 262144) serviceFailure('SERVICE_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(part.value));
    }
    combined = Buffer.concat(chunks, size);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
  } catch (error) {
    cancel(reader ?? response.body);
    if (['SERVICE_BACKEND_UNAVAILABLE', 'SERVICE_RESPONSE_TOO_LARGE'].includes(error?.code)) throw error;
    serviceFailure('SERVICE_RESPONSE_INVALID');
  } finally {
    signal?.removeEventListener('abort', abort);
    combined?.fill(0); for (const chunk of chunks) chunk.fill(0);
    try { reader?.releaseLock(); } catch {}
  }
}
