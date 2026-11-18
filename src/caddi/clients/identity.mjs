import { verify } from 'node:crypto';
import { isPromise } from 'node:util/types';
import {
  CLIENT_IDENTITY_LIMITS, identityFailure, identityRecord, identityInteger,
  identityBytes, clientPublicIdentity, canonicalClientIdentityChallenge,
  validateClientIdentityChallenge,
} from '../access/client-identity-wire.mjs';

export function createClientIdentitySigner() {
  identityFailure('CLIENT_IDENTITY_NATIVE_REQUIRED');
}

/**
 * Synthetic custody adapter only. The private key remains inside custody.sign;
 * this module receives only public metadata and an Ed25519 signature. A real
 * native adapter must qualify caller identity, protected key usage and endpoint
 * binding before a production signer constructor can be introduced.
 */
export function createSyntheticClientIdentitySigner({ policy, custody, now = Date.now } = {}) {
  if (policy !== 'synthetic-client-identity-only' || custody?.testOnly !== true) identityFailure('CLIENT_IDENTITY_NATIVE_REQUIRED');
  if (typeof custody.publicKey !== 'function' || typeof custody.assertCurrent !== 'function' ||
      typeof custody.sign !== 'function' || typeof now !== 'function') identityFailure();
  let identity;
  try { identity = clientPublicIdentity(custody.publicKey()); } catch { identityFailure(); }
  let closed = false, epoch = 0, active = 0, lastTime = 0;
  const time = () => { lastTime = Math.max(lastTime, identityInteger(now(), 1)); return lastTime; };
  function available() {
    if (closed) identityFailure();
    const value = custody.assertCurrent();
    if (isPromise(value)) { void value.catch(() => {}); identityFailure(); }
    if (value !== true) identityFailure();
    if (custody.publicKey() !== identity.publicKey) identityFailure();
  }
  return Object.freeze({
    testOnly: true, publicKey: identity.publicKey, fingerprint: identity.fingerprint,
    async signChallenge(challenge, { expected, role = 'current', signal } = {}) {
      let admitted = false;
      try {
        available();
        if (active >= CLIENT_IDENTITY_LIMITS.pending) identityFailure('CLIENT_IDENTITY_CAPACITY');
        if (signal && !(signal instanceof AbortSignal)) identityFailure();
        validateClientIdentityChallenge(challenge);
        challenge = Object.freeze({ ...challenge });
        identityRecord(expected, [
          'purpose', 'installationId', 'runtimeIncarnation', 'transport', 'channelBinding',
          'clientNonce', 'clientId', 'generation', 'registryRevision',
        ]);
        for (const key of ['purpose', 'installationId', 'runtimeIncarnation', 'transport', 'channelBinding', 'clientNonce', 'generation', 'registryRevision'])
          if (expected[key] !== challenge[key]) identityFailure();
        if (challenge.purpose === 'enroll' ? expected.clientId !== null : expected.clientId !== challenge.clientId) identityFailure();
        if ((role === 'current' ? challenge.publicKey : challenge.nextPublicKey) !== identity.publicKey) identityFailure();
        const bytes = canonicalClientIdentityChallenge(challenge, role), captured = epoch;
        const assertCurrent = () => {
          available();
          if (signal?.aborted || captured !== epoch || challenge.issuedAt > time() || challenge.expiresAt <= time()) identityFailure();
          return true;
        };
        assertCurrent(); active++; admitted = true;
        const signed = await custody.sign({ bytes: Buffer.from(bytes), role, signal, assertCurrent });
        assertCurrent();
        const encoded = Buffer.isBuffer(signed) || signed instanceof Uint8Array ? Buffer.from(signed).toString('base64url') : signed;
        const signature = identityBytes(encoded, 64);
        if (!verify(null, bytes, identity.key, signature)) identityFailure();
        assertCurrent();
        return encoded;
      } catch { identityFailure(); }
      finally { if (admitted) active--; }
    },
    close() { closed = true; epoch++; },
  });
}
