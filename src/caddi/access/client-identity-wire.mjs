import { createHash, createPublicKey } from 'node:crypto';
import { CaddiError } from '../contracts.mjs';

export const CLIENT_IDENTITY_LIMITS = Object.freeze({
  frameBytes: 4096, pending: 16, ownerOperations: 1, clients: 32, tombstones: 256, receipts: 64,
  challengeMs: 30_000, receiptMs: 300_000,
});
const decoder = new TextDecoder('utf-8', { fatal: true });
export const identityFailure = (code = 'CLIENT_IDENTITY_DENIED') => {
  throw new CaddiError(code, 'Client identity operation could not be completed.');
};
export function identityId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) identityFailure();
  return value;
}
export function identityInteger(value, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) identityFailure();
  return value;
}
export function identityBytes(value, length) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/u.test(value)) identityFailure();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) identityFailure();
  return bytes;
}
export function identityLabel(value) {
  if (typeof value !== 'string' || !value.length || value.length > 80 ||
      Buffer.byteLength(value, 'utf8') > 240 || /[\u0000-\u001f\u007f]/u.test(value) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) identityFailure();
  return value;
}
export function identityRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) identityFailure();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) identityFailure();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')) identityFailure();
  }
  return value;
}

/**
 * Wire frames are flat JSON objects. Parsing from bytes/text is mandatory:
 * accepting a previously JSON.parse'd object would hide duplicate keys.
 * Reject nested values, unknown/duplicate keys (including escaped aliases),
 * getters, non-UTF-8 bytes, trailing frames and oversized input.
 */
export function parseClientIdentityFrame(raw, fields) {
  try {
    let source;
    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw, 'utf8') > CLIENT_IDENTITY_LIMITS.frameBytes) identityFailure();
      source = raw;
    } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      if (raw.byteLength > CLIENT_IDENTITY_LIMITS.frameBytes) identityFailure();
      source = decoder.decode(raw);
    } else identityFailure();
    let at = 0;
    const white = () => { while (/[ \t\r\n]/u.test(source[at] ?? '') && at < source.length) at++; };
    const take = char => { white(); if (source[at++] !== char) identityFailure(); };
    const string = () => {
      white();
      const start = at;
      if (source[at++] !== '"') identityFailure();
      while (at < source.length) {
        const char = source[at++];
        if (char === '\\') { at++; continue; }
        if (char === '"') return JSON.parse(source.slice(start, at));
      }
      identityFailure();
    };
    take('{');
    const result = Object.create(null), seen = new Set();
    white();
    if (source[at] !== '}') {
      while (true) {
        const key = string();
        if (seen.has(key) || !fields.includes(key) || seen.size >= 32) identityFailure();
        seen.add(key); take(':'); white();
        let value;
        if (source[at] === '"') value = string();
        else {
          const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(at))?.[0];
          if (!token) identityFailure();
          at += token.length; value = JSON.parse(token);
        }
        result[key] = value;
        white();
        if (source[at] !== ',') break;
        at++;
      }
    }
    take('}'); white();
    if (at !== source.length) identityFailure();
    return Object.freeze(result);
  } catch { identityFailure(); }
}

export function clientPublicIdentity(publicKey) {
  const bytes = identityBytes(publicKey, 32);
  // Only the public Ed25519 X coordinate crosses this boundary.
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: publicKey } });
  if (key.asymmetricKeyType !== 'ed25519') identityFailure();
  return Object.freeze({
    publicKey, fingerprint: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), key,
  });
}
export const CHALLENGE_FIELDS = Object.freeze([
  'version', 'purpose', 'installationId', 'runtimeIncarnation', 'challengeId',
  'serverChallenge', 'clientNonce', 'transport', 'channelBinding', 'clientId',
  'generation', 'registryRevision', 'publicKey', 'fingerprint', 'nextPublicKey',
  'nextFingerprint', 'label', 'issuedAt', 'expiresAt',
]);
export function validateClientIdentityChallenge(challenge) {
  identityRecord(challenge, CHALLENGE_FIELDS);
  if (challenge.version !== 1 || !['enroll', 'authenticate', 'rotate'].includes(challenge.purpose)) identityFailure();
  for (const key of ['installationId', 'runtimeIncarnation', 'challengeId', 'clientId', 'transport']) identityId(challenge[key]);
  for (const key of ['serverChallenge', 'clientNonce', 'channelBinding']) identityBytes(challenge[key], 32);
  identityInteger(challenge.generation, 1); identityInteger(challenge.registryRevision);
  identityInteger(challenge.issuedAt, 1); identityInteger(challenge.expiresAt, challenge.issuedAt + 1);
  if (challenge.expiresAt - challenge.issuedAt > CLIENT_IDENTITY_LIMITS.challengeMs) identityFailure();
  identityLabel(challenge.label);
  if (clientPublicIdentity(challenge.publicKey).fingerprint !== challenge.fingerprint) identityFailure();
  if (challenge.purpose === 'rotate') {
    if (clientPublicIdentity(challenge.nextPublicKey).fingerprint !== challenge.nextFingerprint ||
        challenge.nextPublicKey === challenge.publicKey) identityFailure();
  } else if (challenge.nextPublicKey !== null || challenge.nextFingerprint !== null) identityFailure();
  return challenge;
}
/** Exact versioned UTF-8 bytes; property insertion order cannot affect signatures. */
export function canonicalClientIdentityChallenge(challenge, role = 'current') {
  validateClientIdentityChallenge(challenge);
  if (role !== 'current' && !(role === 'new' && challenge.purpose === 'rotate')) identityFailure();
  return Buffer.from(JSON.stringify([
    'caddi.client-identity.proof.v1', role, ...CHALLENGE_FIELDS.map(field => challenge[field]),
  ]), 'utf8');
}
export function clientIdentityComparisonCode(challenge) {
  return createHash('sha256').update(canonicalClientIdentityChallenge(challenge))
    .digest('hex').slice(0, 16).toUpperCase().match(/.{4}/gu).join('-');
}
