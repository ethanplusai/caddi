import { createHash, KeyObject, verify } from 'node:crypto';

export class UpdateError extends Error {
  constructor(code) { super(code); this.name = 'UpdateError'; this.code = code; }
}
export const fail = code => { throw new UpdateError(code); };
export const requireThat = (condition, code = 'UPDATE_INVALID_ARGUMENT') => { if (!condition) fail(code); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const MANIFEST_LIMIT = 16 * 1024;
export const ARTIFACT_LIMIT = 64 * 1024 * 1024;
export const TARGET_KEYS = ['product', 'bundleId', 'channel', 'platform', 'arch'];
const DOMAIN = Buffer.from('caddi-offline-update/v1\0');
const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u;

export function record(value, keys, code = 'UPDATE_INVALID_ARGUMENT') {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const names = Reflect.ownKeys(value);
  requireThat(names.length === keys.length && names.every(key => typeof key === 'string' &&
    keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), code);
  return value;
}
export function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, code = 'UPDATE_INVALID_ARGUMENT') {
  requireThat(Number.isSafeInteger(value) && value >= minimum && value <= maximum && !Object.is(value, -0), code);
}
export function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export function target(value) {
  record(value, TARGET_KEYS);
  requireThat(typeof value.product === 'string' && /^[A-Za-z][A-Za-z0-9 ._-]{0,95}$/u.test(value.product));
  for (const name of TARGET_KEYS.slice(1)) requireThat(typeof value[name] === 'string' && TOKEN.test(value[name]));
  requireThat(['darwin', 'linux', 'win32'].includes(value.platform) && ['arm64', 'x64'].includes(value.arch));
  return freeze({ ...value });
}
/** The wire format is sorted-key, whitespace-free UTF-8 JSON. There is exactly
 * one legal spelling; duplicate keys, alternate escapes and unknown fields are
 * rejected before any signature becomes authority. No reviver or URL is used. */
export function canonical(value, depth = 0) {
  requireThat(depth <= 8, 'UPDATE_INVALID_MANIFEST');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { integer(value, 0, Number.MAX_SAFE_INTEGER, 'UPDATE_INVALID_MANIFEST'); return String(value); }
  if (typeof value === 'string') {
    requireThat(value.length <= MANIFEST_LIMIT && !/[\uD800-\uDFFF]/u.test(value), 'UPDATE_INVALID_MANIFEST');
    return JSON.stringify(value);
  }
  requireThat(value !== null && typeof value === 'object', 'UPDATE_INVALID_MANIFEST');
  if (Array.isArray(value)) {
    requireThat(value.length <= 128, 'UPDATE_INVALID_MANIFEST');
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  requireThat([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'UPDATE_INVALID_MANIFEST');
  const keys = Object.keys(value).sort();
  requireThat(keys.length <= 64 && Reflect.ownKeys(value).length === keys.length, 'UPDATE_INVALID_MANIFEST');
  return '{' + keys.map(key => {
    requireThat(!['__proto__', 'prototype', 'constructor'].includes(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'), 'UPDATE_INVALID_MANIFEST');
    return JSON.stringify(key) + ':' + canonical(value[key], depth + 1);
  }).join(',') + '}';
}
export function parseCanonical(bytes, maximum = MANIFEST_LIMIT) {
  requireThat(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'UPDATE_INVALID_MANIFEST');
  requireThat(bytes.byteLength > 0 && bytes.byteLength <= maximum, 'UPDATE_INVALID_MANIFEST');
  let text, parsed;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('UPDATE_INVALID_MANIFEST'); }
  // Bound JSON nesting before the native parser allocates nested structures.
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 8) fail('UPDATE_INVALID_MANIFEST'); }
    else if (char === '}' || char === ']') { if (--depth < 0) fail('UPDATE_INVALID_MANIFEST'); }
  }
  try { parsed = JSON.parse(text); } catch { fail('UPDATE_INVALID_MANIFEST'); }
  requireThat(canonical(parsed) === text, 'UPDATE_INVALID_MANIFEST');
  return parsed;
}
export function signingBytes(envelope) {
  return Buffer.concat([DOMAIN, Buffer.from(canonical({
    algorithm: envelope.algorithm, format: envelope.format, keyId: envelope.keyId, signed: envelope.signed,
  }))]);
}
export function release(value) {
  record(value, ['sequence', 'version', 'sourceDigest', 'payloadDigest', 'artifactSha256', 'artifactBytes']);
  integer(value.sequence, 1);
  requireThat(typeof value.version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u.test(value.version) && value.version.length <= 96);
  for (const key of ['sourceDigest', 'payloadDigest', 'artifactSha256']) requireThat(typeof value[key] === 'string' && HASH.test(value[key]));
  integer(value.artifactBytes, 1, ARTIFACT_LIMIT);
}
export function pinPolicy(options) {
  record(options, ['expectedTarget', 'trustedKeys', 'initialKeyIds', 'rotations']);
  const expectedTarget = target(options.expectedTarget);
  requireThat(Array.isArray(options.trustedKeys) && options.trustedKeys.length > 0 && options.trustedKeys.length <= 16);
  const trustedKeys = new Map();
  for (const item of options.trustedKeys) {
    record(item, ['id', 'publicKey', 'status', 'notBefore', 'notAfter', 'minimumSequence', 'maximumSequence']);
    requireThat(typeof item.id === 'string' && TOKEN.test(item.id) && !trustedKeys.has(item.id) && item.publicKey instanceof KeyObject &&
      item.publicKey.type === 'public' && item.publicKey.asymmetricKeyType === 'ed25519' &&
      ['active', 'revoked'].includes(item.status));
    integer(item.notBefore); integer(item.notAfter, item.notBefore + 1);
    integer(item.minimumSequence, 1); integer(item.maximumSequence, item.minimumSequence);
    trustedKeys.set(item.id, Object.freeze({ ...item }));
  }
  requireThat(Array.isArray(options.initialKeyIds) && options.initialKeyIds.length > 0 &&
    options.initialKeyIds.length <= 16 && new Set(options.initialKeyIds).size === options.initialKeyIds.length &&
    options.initialKeyIds.every(id => typeof id === 'string' && trustedKeys.has(id)));
  requireThat(Array.isArray(options.rotations) && options.rotations.length <= 32);
  const rotations = options.rotations.map(rule => {
    record(rule, ['from', 'to', 'minimumSequence']);
    requireThat(typeof rule.from === 'string' && typeof rule.to === 'string' && rule.from !== rule.to &&
      trustedKeys.has(rule.from) && trustedKeys.has(rule.to));
    integer(rule.minimumSequence, 1);
    return Object.freeze({ ...rule });
  });
  return Object.freeze({ expectedTarget, trustedKeys, initialKeyIds: Object.freeze([...options.initialKeyIds]),
    rotations: Object.freeze(rotations) });
}
export function validateEnvelope(bytes, policy, now, previousKeyId, previousSequence, { historical = false } = {}) {
  integer(now);
  let envelope;
  try {
    envelope = parseCanonical(bytes);
    record(envelope, ['format', 'algorithm', 'keyId', 'signed', 'signature']);
    requireThat(envelope.format === 'caddi-update-envelope-v1' && envelope.algorithm === 'Ed25519');
    requireThat(typeof envelope.keyId === 'string' && TOKEN.test(envelope.keyId) && typeof envelope.signature === 'string' &&
      /^[A-Za-z0-9_-]{86}$/u.test(envelope.signature));
    const signed = envelope.signed;
    record(signed, ['format', 'target', 'release', 'issuedAt', 'notBefore', 'expiresAt']);
    requireThat(signed.format === 'caddi-offline-update-v1');
    target(signed.target); release(signed.release);
    for (const name of ['issuedAt', 'notBefore', 'expiresAt']) integer(signed[name]);
    requireThat(signed.issuedAt <= signed.notBefore && signed.notBefore < signed.expiresAt &&
      signed.expiresAt - signed.issuedAt <= 31 * 24 * 60 * 60 * 1000);
  } catch (error) {
    if (error instanceof UpdateError) fail('UPDATE_INVALID_MANIFEST'); throw error;
  }
  const signed = envelope.signed, item = policy.trustedKeys.get(envelope.keyId);
  requireThat(TARGET_KEYS.every(key => signed.target[key] === policy.expectedTarget[key]), 'UPDATE_WRONG_TARGET');
  requireThat(item && item.status === 'active', 'UPDATE_UNTRUSTED_KEY');
  requireThat(signed.issuedAt >= item.notBefore && signed.expiresAt <= item.notAfter &&
    signed.release.sequence >= item.minimumSequence && signed.release.sequence <= item.maximumSequence, 'UPDATE_KEY_INVALID');
  if (!historical) requireThat(now >= signed.notBefore && now >= signed.issuedAt && now < signed.expiresAt &&
    now >= item.notBefore && now < item.notAfter, 'UPDATE_MANIFEST_TIME');
  const signature = Buffer.from(envelope.signature, 'base64url');
  requireThat(signature.length === 64 && signature.toString('base64url') === envelope.signature &&
    verify(null, signingBytes(envelope), item.publicKey, signature), 'UPDATE_BAD_SIGNATURE');
  if (!historical) {
    requireThat(signed.release.sequence > previousSequence, 'UPDATE_ROLLBACK_OR_REPLAY');
    const allowed = previousKeyId === null ? policy.initialKeyIds.includes(envelope.keyId) :
      previousKeyId === envelope.keyId || policy.rotations.some(rule => rule.from === previousKeyId &&
        rule.to === envelope.keyId && signed.release.sequence >= rule.minimumSequence);
    requireThat(allowed, 'UPDATE_ROTATION_DENIED');
  }
  return freeze(envelope);
}
