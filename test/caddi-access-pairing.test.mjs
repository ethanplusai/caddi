import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPairingProvider } from '../src/caddi/access/pairing.mjs';

const code = expected => error => error?.code === expected;
function fixtureKeys() {
  const keys = new Map(), locks = new Set();
  let locked = false, deleteFails = false;
  return {
    testOnly: true,
    assertAvailable() { if (locked) throw new Error('Fixture is locked'); return true; },
    onLock(listener) { locks.add(listener); return () => locks.delete(listener); },
    async getPairingKey({ pairingId, create }) {
      this.assertAvailable();
      if (!keys.has(pairingId) && create) keys.set(pairingId, randomBytes(32));
      if (!keys.has(pairingId)) throw new Error('No fixture slot');
      return { pairingId, key: Buffer.from(keys.get(pairingId)), protection: 'ephemeral-fixture' };
    },
    async deletePairingKey({ pairingId }) { if (deleteFails) throw new Error('Fixture delete failed'); keys.get(pairingId)?.fill(0); keys.delete(pairingId); },
    lock() { locked = true; for (const listener of locks) listener(); },
    failDelete() { deleteFails = true; },
  };
}
test('pairing enrollment is explicit, metadata excludes the credential, and audience/session are server-bound', async t => {
  const keyProvider = fixtureKeys();
  assert.throws(() => createPairingProvider({ keyProvider, audience: 'broker' }), code('PAIRING_PROVIDER_REQUIRED'));
  const provider = createPairingProvider({ keyProvider, audience: 'broker', testOnly: true });
  t.after(() => provider.close());
  const enrolled = await provider.createPairing({ principalId: 'principal', agentSessionId: 'agent', expiresAt: Date.now() + 5000 });
  assert.equal(provider.protection, 'ephemeral-fixture');
  assert.equal(JSON.stringify(provider.exportRecords()).includes(enrolled.credential), false);
  assert.deepEqual(provider.exportRecords(), [enrolled.record]);
  const auth = await provider.authenticate({ credential: enrolled.credential, audience: 'broker' });
  assert.equal(auth.principalId, 'principal');
  assert.equal(auth.agentSessionId, 'agent');
  assert.equal(provider.isCurrent({ ...auth, audience: 'broker' }), true);
  assert.equal(provider.isCurrent({ ...auth, audience: 'broker', agentSessionId: 'forged' }), false);
  await assert.rejects(provider.authenticate({ credential: enrolled.credential, audience: 'wrong' }), code('AUTHENTICATION_FAILED'));
  await assert.rejects(provider.authenticate({ credential: enrolled.credential.slice(0, -1) + '.', audience: 'broker' }), code('AUTHENTICATION_FAILED'));
});
test('lock invalidates current pairing and revocation remains authoritative when slot deletion fails', async t => {
  const keys = fixtureKeys(), provider = createPairingProvider({ keyProvider: keys, audience: 'broker', testOnly: true });
  t.after(() => provider.close());
  const enrolled = await provider.createPairing({ principalId: 'principal', agentSessionId: 'agent', expiresAt: Date.now() + 5000 });
  const auth = { ...await provider.authenticate({ credential: enrolled.credential, audience: 'broker' }), audience: 'broker' };
  let notices = 0; provider.subscribeRevocation(() => notices++);
  keys.failDelete();
  await assert.rejects(provider.revokePairing({ pairingId: enrolled.record.pairingId }), code('PAIRING_REVOKE_PENDING'));
  assert.equal(provider.isCurrent(auth), false);
  assert.equal(provider.exportRecords()[0].revoked, true);
  await assert.rejects(provider.authenticate({ credential: enrolled.credential, audience: 'broker' }), code('AUTHENTICATION_FAILED'));
  keys.lock();
  assert.ok(notices >= 2);
});
test('pairing expiry and cancelled authentication fail closed with no credential in errors', async t => {
  let time = 1000;
  const provider = createPairingProvider({ keyProvider: fixtureKeys(), audience: 'broker', testOnly: true, now: () => time });
  t.after(() => provider.close());
  const enrolled = await provider.createPairing({ principalId: 'principal', agentSessionId: 'agent', expiresAt: 2000 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.authenticate({ credential: enrolled.credential, audience: 'broker', signal: controller.signal }), code('AUTHENTICATION_FAILED'));
  time = 2000;
  await assert.rejects(provider.authenticate({ credential: enrolled.credential, audience: 'broker' }), error => error.code === 'AUTHENTICATION_FAILED' && !error.message.includes(enrolled.credential));
});

test('pairing requires a positive synchronous availability decision', async () => {
  for (const decision of [undefined, null, 0, {}, Promise.reject(new Error('synthetic provider failure'))]) {
    const keys = fixtureKeys(); keys.assertAvailable = () => decision;
    const provider = createPairingProvider({ keyProvider: keys, audience: 'broker', testOnly: true });
    await assert.rejects(provider.createPairing({ principalId: 'principal', agentSessionId: 'agent', expiresAt: Date.now() + 5000 }), code('AUTHENTICATION_FAILED'));
    provider.close();
  }
});

test('pairing wipes and releases valid, malformed and late native transfer buffers', async () => {
  for (const scenario of ['valid', 'wrong-id', 'short', 'late-lock', 'release-rejected']) {
    const keys = fixtureKeys(), transfers = [];
    let releases = 0;
    keys.getPairingKey = async ({ pairingId }) => {
      const key = Buffer.alloc(scenario === 'short' ? 31 : 32, 67); transfers.push(key);
      if (scenario === 'late-lock') keys.lock();
      return { pairingId: scenario === 'wrong-id' ? 'wrong' : pairingId, key, protection: 'ephemeral-fixture',
        release() { releases++; if (scenario === 'release-rejected') return Promise.reject(new Error('synthetic release failure')); } };
    };
    const provider = createPairingProvider({ keyProvider: keys, audience: 'broker', testOnly: true });
    const request = provider.createPairing({ principalId: 'principal', agentSessionId: 'agent', expiresAt: Date.now() + 5000 });
    if (scenario === 'valid') { const result = await request; assert.equal(Buffer.from(result.credential.slice(37), 'base64url')[0], 67); }
    else await assert.rejects(request);
    assert.equal(releases, 1, scenario);
    assert.ok(transfers.every(key => key.every(byte => byte === 0)), scenario);
    assert.equal(provider.exportRecords().length, scenario === 'valid' ? 1 : 0);
    provider.close();
  }
});
