import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createClientIdentityProtocol, createSyntheticClientIdentityProtocol } from '../src/caddi/access/client-identity.mjs';
import {
  CLIENT_IDENTITY_LIMITS, canonicalClientIdentityChallenge, clientIdentityComparisonCode,
  parseClientIdentityFrame,
} from '../src/caddi/access/client-identity-wire.mjs';
import { createClientIdentitySigner, createSyntheticClientIdentitySigner } from '../src/caddi/clients/identity.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';

const POLICY = 'synthetic-client-identity-only';
const denied = { code: 'CLIENT_IDENTITY_DENIED' };
const nonce = () => randomBytes(32).toString('base64url');
function gate() {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  return { wait, started, release, entered };
}
function emptyState(installationId = 'installation-one') {
  return { version: 1, installationId, revision: 0, clients: [], tombstones: [] };
}
function fixture({ storage = { snapshot: emptyState(), uncertain: false }, runtimeIncarnation = 'runtime-one', limits = {} } = {}) {
  const installationId = storage.snapshot.installationId;
  const hooks = { read: null, commit: null, recover: null, unknown: false, readError: null, commitError: null };
  const channels = new WeakMap(), approvals = new WeakMap();
  let tick = 100_000, pendingWrites = 0, reads = 0, commits = 0, recoveries = 0;
  const registry = {
    testOnly: true,
    assertAvailable() { return !storage.uncertain; },
    assertCurrentRevision(revision) { return storage.snapshot.revision === revision && !storage.uncertain; },
    async read() {
      reads++;
      if (hooks.readError) throw new Error(hooks.readError);
      const snapshot = structuredClone(storage.snapshot), held = hooks.read;
      hooks.read = null;
      if (held) { held.entered(); await held.wait; }
      return snapshot;
    },
    async compareAndSwap({ expectedRevision, next, assertCurrent }) {
      commits++; pendingWrites++;
      const held = hooks.commit; hooks.commit = null;
      try {
        if (held) { held.entered(); await held.wait; }
        if (hooks.commitError) { storage.uncertain = true; throw new Error(hooks.commitError); }
        if (storage.uncertain || storage.snapshot.revision !== expectedRevision) return { status: 'conflict' };
        // One synchronous linearization point, with no await between the fence,
        // generation comparison, and publication of the synthetic public state.
        try { assertCurrent(); } catch { return { status: 'conflict' }; }
        storage.snapshot = structuredClone(next);
        if (hooks.unknown) {
          hooks.unknown = false; storage.uncertain = true;
          return { status: 'unknown' };
        }
        return { status: 'committed' };
      } finally { pendingWrites--; }
    },
    async recover({ minimumRevision, assertCurrent }) {
      recoveries++;
      const held = hooks.recover; hooks.recover = null;
      if (held) { held.entered(); await held.wait; }
      assertCurrent();
      if (pendingWrites || storage.snapshot.revision < minimumRevision) throw new Error('recovery not quiescent');
      storage.uncertain = false;
      return { settled: true, snapshot: structuredClone(storage.snapshot) };
    },
  };
  const main = {
    testOnly: true,
    describeChannel(handle) {
      const item = channels.get(handle);
      if (!item?.live) throw new Error('native peer is not current');
      return { transport: item.transport, channelBinding: item.channelBinding };
    },
    captureOwnerFence(handle, intent) {
      const item = approvals.get(handle);
      if (!item?.live || !isDeepStrictEqual(item.intent, intent)) throw new Error('owner approval is not current');
      return () => item.live === true;
    },
  };
  function newChannel(transport = 'native-mcp') {
    const handle = Object.freeze(Object.create(null));
    channels.set(handle, { live: true, transport, channelBinding: nonce() });
    return handle;
  }
  function owner(intent) {
    const handle = Object.freeze(Object.create(null));
    approvals.set(handle, { live: true, intent: structuredClone(intent) });
    return handle;
  }
  const channel = newChannel();
  const protocol = createSyntheticClientIdentityProtocol({
    policy: POLICY, installationId, runtimeIncarnation, registry, main, now: () => tick, limits,
  });
  return {
    protocol, registry, main, storage, hooks, channel, installationId, runtimeIncarnation,
    now: () => tick, advance: ms => { tick += ms; }, setTime: value => { tick = value; },
    counts: () => ({ reads, commits, pendingWrites, recoveries }),
    newChannel, owner,
    closeChannel: handle => { channels.get(handle).live = false; },
    rebindChannel: handle => { channels.get(handle).channelBinding = nonce(); },
    withdraw: approval => { approvals.get(approval).live = false; },
    approve(challenge) {
      return owner({
        purpose: challenge.purpose, challengeId: challenge.challengeId,
        comparisonCode: clientIdentityComparisonCode(challenge),
        installationId, runtimeIncarnation, clientId: challenge.clientId, generation: challenge.generation,
        registryRevision: challenge.registryRevision, fingerprint: challenge.fingerprint,
        nextFingerprint: challenge.nextFingerprint,
      });
    },
    revokeApproval(identity) {
      return owner({ purpose: 'revoke', clientId: identity.clientId, generation: identity.generation, installationId, runtimeIncarnation });
    },
    recoveryApproval(minimumRevision) {
      return owner({ purpose: 'recover', installationId, runtimeIncarnation, minimumRevision });
    },
  };
}
function keyFixture(f) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const encoded = publicKey.export({ format: 'jwk' }).x;
  let live = true, nextHold = null, error = null;
  const custody = {
    testOnly: true, publicKey: () => encoded, assertCurrent: () => live,
    async sign({ bytes, assertCurrent }) {
      const held = nextHold; nextHold = null;
      if (held) { held.entered(); await held.wait; }
      assertCurrent();
      if (error) throw new Error(error);
      return sign(null, bytes, privateKey);
    },
  };
  const signer = createSyntheticClientIdentitySigner({ policy: POLICY, custody, now: f.now });
  return {
    publicKey: encoded, signer, custody,
    rawSign: (challenge, role = 'current') => sign(null, canonicalClientIdentityChallenge(challenge, role), privateKey).toString('base64url'),
    hold: held => { nextHold = held; }, retire: () => { live = false; }, fail: value => { error = value; },
  };
}
function expected(challenge) {
  return {
    purpose: challenge.purpose, installationId: challenge.installationId, runtimeIncarnation: challenge.runtimeIncarnation,
    transport: challenge.transport, channelBinding: challenge.channelBinding, clientNonce: challenge.clientNonce,
    clientId: challenge.purpose === 'enroll' ? null : challenge.clientId,
    generation: challenge.generation, registryRevision: challenge.registryRevision,
  };
}
const signature = (key, challenge, options = {}) => key.signer.signChallenge(challenge, { expected: expected(challenge), ...options });
const finishFrame = (challenge, signed, nextSignature) => JSON.stringify({
  type: 'finish', challengeId: challenge.challengeId, signature: signed,
  ...(nextSignature === undefined ? {} : { nextSignature }),
});
async function enroll(f, key = keyFixture(f), label = 'Remembered coding agent') {
  const opened = await f.protocol.begin(JSON.stringify({
    type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label,
  }), { channel: f.channel });
  const receipt = await f.protocol.finish(finishFrame(opened.challenge, await signature(key, opened.challenge)), {
    channel: f.channel, ownerApproval: f.approve(opened.challenge),
  });
  return { key, receipt, identity: await f.protocol.readReceipt(receipt, { channel: f.channel }), opened };
}
async function reconnect(f, key, identity, options = {}) {
  return f.protocol.begin(JSON.stringify({
    type: 'authenticate', clientId: identity.clientId, generation: identity.generation,
    publicKey: key.publicKey, clientNonce: nonce(),
  }), { channel: f.channel, ...options });
}
async function rotation(f, old, nextKey) {
  return f.protocol.begin(JSON.stringify({
    type: 'rotate', clientId: old.identity.clientId, generation: old.identity.generation,
    publicKey: old.key.publicKey, nextPublicKey: nextKey.publicKey, clientNonce: nonce(),
  }), { channel: f.channel });
}
async function revoke(f, identity) {
  return f.protocol.revoke({ clientId: identity.clientId, generation: identity.generation }, { ownerApproval: f.revokeApproval(identity) });
}

test('production construction cannot be enabled by flags, metadata, or claimed capabilities', () => {
  for (const flags of [undefined, { qualified: true }, { nativeCapabilities: { productionQualified: true }, testOnly: false }]) {
    assert.throws(() => createClientIdentityProtocol(flags), { code: 'CLIENT_IDENTITY_NATIVE_REQUIRED' });
    assert.throws(() => createClientIdentitySigner(flags), { code: 'CLIENT_IDENTITY_NATIVE_REQUIRED' });
  }
  assert.throws(() => createSyntheticClientIdentityProtocol({}), { code: 'CLIENT_IDENTITY_NATIVE_REQUIRED' });
});

test('first identity requires exact owner comparison approval; label memory cannot authenticate', async () => {
  const f = fixture(), key = keyFixture(f), frame = () => JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Same remembered label' });
  const first = await f.protocol.begin(frame(), { channel: f.channel });
  assert.equal(first.ownerApprovalRequired, true);
  assert.match(first.comparisonCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/u);
  await assert.rejects(f.protocol.finish(finishFrame(first.challenge, await signature(key, first.challenge)), { channel: f.channel }), denied);
  assert.deepEqual(f.storage.snapshot, emptyState());
  const second = await f.protocol.begin(frame(), { channel: f.channel });
  await assert.rejects(f.protocol.finish(finishFrame(second.challenge, await signature(key, second.challenge)), {
    channel: f.channel, ownerApproval: f.approve(first.challenge),
  }), denied);
  assert.equal(f.storage.snapshot.clients.length, 0);
  const approved = await enroll(f, key, 'Same remembered label');
  const impostor = keyFixture(f);
  await assert.rejects(reconnect(f, impostor, approved.identity), denied);
  const unrecognized = await f.protocol.begin(JSON.stringify({
    type: 'enroll', publicKey: impostor.publicKey, clientNonce: nonce(), label: 'Same remembered label',
  }), { channel: f.channel });
  assert.equal(unrecognized.ownerApprovalRequired, true);
  await assert.rejects(f.protocol.finish(finishFrame(unrecognized.challenge, await signature(impostor, unrecognized.challenge)), { channel: f.channel }), denied);
  assert.equal(f.storage.snapshot.clients.length, 1);
});

test('recognized identity proves current key and receives an opaque server-held identity-only receipt', async () => {
  const f = fixture(), enrolled = await enroll(f);
  assert.equal(JSON.stringify(enrolled.receipt), '{}');
  assert.equal(Object.getPrototypeOf(enrolled.receipt), null);
  await assert.rejects(f.protocol.readReceipt(JSON.parse(JSON.stringify(enrolled.receipt)), { channel: f.channel }), denied);
  const opened = await reconnect(f, enrolled.key, enrolled.identity);
  assert.equal(opened.ownerApprovalRequired, false);
  assert.equal(opened.comparisonCode, null);
  const before = f.counts().commits;
  const receipt = await f.protocol.finish(finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge)), { channel: f.channel });
  assert.equal(f.counts().commits, before);
  const info = await f.protocol.readReceipt(receipt, { channel: f.channel });
  assert.equal(info.clientId, enrolled.identity.clientId);
  assert.equal(info.identityOnly, true);
  assert.deepEqual(Object.keys(info).sort(), ['clientId', 'expiresAt', 'fingerprint', 'generation', 'identityOnly', 'installationId', 'runtimeIncarnation'].sort());
  await assert.rejects(f.protocol.readReceipt(receipt, { channel: f.newChannel() }), denied);
});

test('exact canonical proof binds every security context field and both nonces', async t => {
  const f = fixture(), enrolled = await enroll(f);
  const mutations = {
    installationId: 'different-installation', runtimeIncarnation: 'different-runtime',
    transport: 'other-native-transport', channelBinding: nonce(), clientNonce: nonce(),
    serverChallenge: nonce(), clientId: 'different-client', generation: 2,
    registryRevision: 999, challengeId: 'different-challenge', label: 'Changed label',
  };
  for (const [field, value] of Object.entries(mutations)) await t.test(field, async () => {
    const opened = await reconnect(f, enrolled.key, enrolled.identity), challenge = opened.challenge;
    const altered = { ...challenge, [field]: value };
    const forged = enrolled.key.rawSign(altered);
    await assert.rejects(f.protocol.finish(finishFrame(challenge, forged), { channel: f.channel }), denied);
  });
  const opened = await reconnect(f, enrolled.key, enrolled.identity), other = keyFixture(f);
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, other.rawSign(opened.challenge)), { channel: f.channel }), denied);
  const reordered = Object.fromEntries(Object.entries(opened.challenge).reverse());
  assert.deepEqual(canonicalClientIdentityChallenge(reordered), canonicalClientIdentityChallenge(opened.challenge));
});

test('client custody checks independently expected installation/runtime/native peer/nonce before signing', async () => {
  const f = fixture(), enrolled = await enroll(f), opened = await reconnect(f, enrolled.key, enrolled.identity);
  for (const key of ['purpose', 'installationId', 'runtimeIncarnation', 'transport', 'channelBinding', 'clientNonce', 'clientId', 'generation', 'registryRevision']) {
    const exp = expected(opened.challenge);
    exp[key] = typeof exp[key] === 'number' ? exp[key] + 1 : 'incorrect';
    await assert.rejects(enrolled.key.signer.signChallenge(opened.challenge, { expected: exp }), denied);
  }
  const changedFingerprint = { ...opened.challenge, fingerprint: 'sha256:' + '0'.repeat(64) };
  await assert.rejects(signature(enrolled.key, changedFingerprint), denied);
});

test('client-supplied channel IDs or copied handles cannot replace native/main binding', async () => {
  const f = fixture(), key = keyFixture(f), basic = { type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' };
  for (const extra of [{ transport: 'native-mcp' }, { channelBinding: nonce() }, { connectionId: 'chosen-by-client' }])
    await assert.rejects(f.protocol.begin(JSON.stringify({ ...basic, ...extra }), { channel: f.channel }), denied);
  await assert.rejects(f.protocol.begin(JSON.stringify(basic), { channel: {} }), denied);
  const enrolled = await enroll(f, key), opened = await reconnect(f, key, enrolled.identity);
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, await signature(key, opened.challenge)), { channel: f.newChannel() }), denied);
});

test('one-use challenges reject replay and duplicate concurrent finish before awaited registry read', async () => {
  const f = fixture(), enrolled = await enroll(f), opened = await reconnect(f, enrolled.key, enrolled.identity);
  const frame = finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge)), held = gate();
  f.hooks.read = held;
  const first = f.protocol.finish(frame, { channel: f.channel });
  await held.started;
  await assert.rejects(f.protocol.finish(frame, { channel: f.channel }), denied);
  held.release();
  const receipt = await first;
  assert.equal((await f.protocol.readReceipt(receipt, { channel: f.channel })).identityOnly, true);
  await assert.rejects(f.protocol.finish(frame, { channel: f.channel }), denied);
});

test('expiry is short, exact, and cannot be extended by a clock rollback', async () => {
  const f = fixture({ limits: { challengeMs: 20, receiptMs: 40 } }), enrolled = await enroll(f);
  const opened = await reconnect(f, enrolled.key, enrolled.identity);
  const frame = finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge));
  f.advance(20);
  await assert.rejects(f.protocol.finish(frame, { channel: f.channel }), denied);
  f.advance(21);
  await assert.rejects(f.protocol.readReceipt(enrolled.receipt, { channel: f.channel }), denied);
  f.setTime(1);
  await assert.rejects(f.protocol.finish(frame, { channel: f.channel }), denied);
});

test('restart reconnects the public identity but never restores a challenge, receipt, grant, or lease', async () => {
  const first = fixture(), enrolled = await enroll(first), old = await reconnect(first, enrolled.key, enrolled.identity);
  const oldFrame = finishFrame(old.challenge, await signature(enrolled.key, old.challenge));
  first.protocol.close();
  const second = fixture({ storage: first.storage, runtimeIncarnation: 'runtime-two' });
  await assert.rejects(second.protocol.finish(oldFrame, { channel: second.channel }), denied);
  await assert.rejects(second.protocol.readReceipt(enrolled.receipt, { channel: second.channel }), denied);
  const fresh = await reconnect(second, enrolled.key, enrolled.identity);
  assert.equal(fresh.ownerApprovalRequired, false);
  assert.equal(fresh.challenge.runtimeIncarnation, 'runtime-two');
  assert.notEqual(fresh.challenge.serverChallenge, old.challenge.serverChallenge);
  const receipt = await second.protocol.finish(finishFrame(fresh.challenge, await signature(enrolled.key, fresh.challenge)), { channel: second.channel });
  const identity = await second.protocol.readReceipt(receipt, { channel: second.channel });
  const policy = createAccessPolicy({ now: second.now, workspaceLookup: () => ({ id: 'project', kind: 'project' }) });
  const controls = createControlCoordinator({ now: second.now });
  assert.throws(() => policy.authorizeScope(identity, { grantId: 'old-grant', workspaceId: 'project', operation: 'workspace:observe' }), { code: 'ACCESS_DENIED' });
  assert.throws(() => controls.assertLease({ workspaceId: 'project', principalId: identity.clientId, connectionId: 'old-connection', agentSessionId: 'old-session', grantId: 'old-grant', leaseEpoch: 1 }), { code: 'LEASE_INVALID' });
  controls.dispose();
  assert.doesNotMatch(JSON.stringify(second.storage.snapshot), /grant|lease|workspace|credential|signature|privateKey|channelBinding|runtimeIncarnation/u);
});

test('current client generation is exact, independent revisions may advance, stale async reads are denied', async () => {
  const f = fixture(), enrolled = await enroll(f), stale = await reconnect(f, enrolled.key, enrolled.identity);
  const staleFrame = finishFrame(stale.challenge, await signature(enrolled.key, stale.challenge));
  await enroll(f, keyFixture(f), 'Other identity');
  const unchanged = await f.protocol.finish(staleFrame, { channel: f.channel });
  assert.equal((await f.protocol.readReceipt(unchanged, { channel: f.channel })).clientId, enrolled.identity.clientId);
  await assert.rejects(reconnect(f, enrolled.key, { ...enrolled.identity, generation: 2 }), denied);
  const fresh = await reconnect(f, enrolled.key, enrolled.identity), held = gate();
  f.hooks.read = held;
  const finishing = f.protocol.finish(finishFrame(fresh.challenge, await signature(enrolled.key, fresh.challenge)), { channel: f.channel });
  const rejected = assert.rejects(finishing, denied);
  await held.started;
  await enroll(f, keyFixture(f), 'Concurrent identity');
  held.release(); await rejected;
});

test('revocation ends authentication during a held registry read and tombstones the key across restart', async () => {
  const f = fixture(), enrolled = await enroll(f), opened = await reconnect(f, enrolled.key, enrolled.identity), held = gate();
  f.hooks.read = held;
  const finishing = f.protocol.finish(finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge)), { channel: f.channel });
  const rejected = assert.rejects(finishing, denied);
  await held.started;
  await revoke(f, enrolled.identity);
  held.release(); await rejected;
  await assert.rejects(f.protocol.readReceipt(enrolled.receipt, { channel: f.channel }), denied);
  assert.equal(f.storage.snapshot.clients.length, 0);
  assert.equal(f.storage.snapshot.tombstones.length, 1);
  const restarted = fixture({ storage: f.storage, runtimeIncarnation: 'runtime-after-revoke' });
  await assert.rejects(reconnect(restarted, enrolled.key, enrolled.identity), denied);
  await assert.rejects(restarted.protocol.begin(JSON.stringify({
    type: 'enroll', publicKey: enrolled.key.publicKey, clientNonce: nonce(), label: 'Renamed old key',
  }), { channel: restarted.channel }), denied);
});

test('enrollment, rotation and revocation of A preserve B receipts and independent authentication', async () => {
  const f = fixture(), b = await enroll(f, keyFixture(f), 'B'), a = await enroll(f, keyFixture(f), 'A');
  assert.equal((await f.protocol.readReceipt(b.receipt, { channel: f.channel })).clientId, b.identity.clientId);
  const bPending = await reconnect(f, b.key, b.identity), bSigned = await signature(b.key, bPending.challenge);
  const nextA = keyFixture(f), rotating = await rotation(f, a, nextA);
  const aReceipt = await f.protocol.finish(finishFrame(rotating.challenge,
    await signature(a.key, rotating.challenge), await signature(nextA, rotating.challenge, { role: 'new' })), {
    channel: f.channel, ownerApproval: f.approve(rotating.challenge),
  });
  const currentA = await f.protocol.readReceipt(aReceipt, { channel: f.channel });
  await assert.rejects(f.protocol.readReceipt(a.receipt, { channel: f.channel }), denied);
  assert.equal((await f.protocol.readReceipt(b.receipt, { channel: f.channel })).clientId, b.identity.clientId);
  const held = gate(), aPending = await reconnect(f, nextA, currentA);
  f.hooks.read = held;
  const finishingA = f.protocol.finish(finishFrame(aPending.challenge, await signature(nextA, aPending.challenge)), { channel: f.channel });
  const rejectedA = assert.rejects(finishingA, denied);
  await held.started;
  await revoke(f, currentA);
  held.release(); await rejectedA;
  await assert.rejects(f.protocol.readReceipt(aReceipt, { channel: f.channel }), denied);
  assert.equal((await f.protocol.readReceipt(b.receipt, { channel: f.channel })).clientId, b.identity.clientId);
  const bNewReceipt = await f.protocol.finish(finishFrame(bPending.challenge, bSigned), { channel: f.channel });
  assert.equal((await f.protocol.readReceipt(bNewReceipt, { channel: f.channel })).clientId, b.identity.clientId);
});

test('revocation during held custody cannot turn a late valid signature into a receipt', async () => {
  const f = fixture(), enrolled = await enroll(f), opened = await reconnect(f, enrolled.key, enrolled.identity), held = gate();
  enrolled.key.hold(held);
  const signing = signature(enrolled.key, opened.challenge);
  await held.started;
  await revoke(f, enrolled.identity);
  held.release();
  const late = await signing;
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, late), { channel: f.channel }), denied);
});

test('revocation wins over a rotation CAS held before its owner/channel/generation fence', async () => {
  const f = fixture(), enrolled = await enroll(f), next = keyFixture(f), opened = await rotation(f, enrolled, next), held = gate();
  const frame = finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge), await signature(next, opened.challenge, { role: 'new' }));
  f.hooks.commit = held;
  const rotating = f.protocol.finish(frame, { channel: f.channel, ownerApproval: f.approve(opened.challenge) });
  const rejected = assert.rejects(rotating, denied);
  await held.started;
  await revoke(f, enrolled.identity);
  held.release(); await rejected;
  assert.equal(f.storage.snapshot.clients.length, 0);
  assert.equal(f.protocol.status().phase, 'ready');
});

test('rotation requires old and new proof with distinct roles and current explicit owner comparison', async () => {
  const f = fixture(), enrolled = await enroll(f), next = keyFixture(f);
  let opened = await rotation(f, enrolled, next);
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge,
    await signature(enrolled.key, opened.challenge), await signature(next, opened.challenge, { role: 'new' })), { channel: f.channel }), denied);
  opened = await rotation(f, enrolled, next);
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge)), {
    channel: f.channel, ownerApproval: f.approve(opened.challenge),
  }), denied);
  opened = await rotation(f, enrolled, next);
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, next.rawSign(opened.challenge), next.rawSign(opened.challenge, 'new')), {
    channel: f.channel, ownerApproval: f.approve(opened.challenge),
  }), denied);
  opened = await rotation(f, enrolled, next);
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, enrolled.key.rawSign(opened.challenge), next.rawSign(opened.challenge)), {
    channel: f.channel, ownerApproval: f.approve(opened.challenge),
  }), denied);
  opened = await rotation(f, enrolled, next);
  const receipt = await f.protocol.finish(finishFrame(opened.challenge,
    await signature(enrolled.key, opened.challenge), await signature(next, opened.challenge, { role: 'new' })), {
    channel: f.channel, ownerApproval: f.approve(opened.challenge),
  });
  const changed = await f.protocol.readReceipt(receipt, { channel: f.channel });
  assert.equal(changed.clientId, enrolled.identity.clientId);
  assert.equal(changed.generation, enrolled.identity.generation + 1);
  await assert.rejects(reconnect(f, enrolled.key, enrolled.identity), denied);
  await assert.rejects(reconnect(f, next, enrolled.identity), denied);
  await assert.rejects(f.protocol.begin(JSON.stringify({
    type: 'enroll', publicKey: enrolled.key.publicKey, clientNonce: nonce(), label: 'Old key new name',
  }), { channel: f.channel }), denied);
  const fresh = await reconnect(f, next, changed);
  await f.protocol.finish(finishFrame(fresh.challenge, await signature(next, fresh.challenge)), { channel: f.channel });
  assert.equal(f.storage.snapshot.tombstones[0].fingerprint, enrolled.identity.fingerprint);
});

test('owner withdrawal before CAS commit suppresses persistence and identity release', async () => {
  const f = fixture(), key = keyFixture(f);
  const opened = await f.protocol.begin(JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' }), { channel: f.channel });
  const approval = f.approve(opened.challenge), held = gate();
  f.hooks.commit = held;
  const finishing = f.protocol.finish(finishFrame(opened.challenge, await signature(key, opened.challenge)), { channel: f.channel, ownerApproval: approval });
  const rejected = assert.rejects(finishing, denied);
  await held.started;
  f.withdraw(approval); held.release(); await rejected;
  assert.equal(f.storage.snapshot.clients.length, 0);
});

test('cancellation, close, and peer rebinding fence late registry and custody completions', async t => {
  for (const mutation of ['abort', 'cancel', 'close', 'peer-close', 'peer-rebind']) await t.test(mutation, async () => {
    const f = fixture(), enrolled = await enroll(f), controller = new AbortController();
    const opened = await reconnect(f, enrolled.key, enrolled.identity, { signal: controller.signal }), held = gate();
    f.hooks.read = held;
    const finishing = f.protocol.finish(finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge)), { channel: f.channel });
    const rejected = assert.rejects(finishing, denied);
    await held.started;
    if (mutation === 'abort') controller.abort();
    if (mutation === 'cancel') assert.equal(f.protocol.cancel(opened.challenge.challengeId, { channel: f.channel }), true);
    if (mutation === 'close') f.protocol.close();
    if (mutation === 'peer-close') f.closeChannel(f.channel);
    if (mutation === 'peer-rebind') f.rebindChannel(f.channel);
    held.release(); await rejected;
  });
  for (const mutation of ['abort', 'close', 'custody-retire']) await t.test('signer-' + mutation, async () => {
    const f = fixture(), enrolled = await enroll(f), opened = await reconnect(f, enrolled.key, enrolled.identity), held = gate(), controller = new AbortController();
    enrolled.key.hold(held);
    const signing = signature(enrolled.key, opened.challenge, { signal: controller.signal });
    const rejected = assert.rejects(signing, denied);
    await held.started;
    if (mutation === 'abort') controller.abort();
    if (mutation === 'close') enrolled.key.signer.close();
    if (mutation === 'custody-retire') enrolled.key.retire();
    held.release(); await rejected;
  });
});

test('unknown registry commit fences every future auth until explicit owner recovery and fresh proof', async () => {
  const f = fixture(), key = keyFixture(f);
  const opened = await f.protocol.begin(JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' }), { channel: f.channel });
  const frame = finishFrame(opened.challenge, await signature(key, opened.challenge));
  f.hooks.unknown = true;
  await assert.rejects(f.protocol.finish(frame, { channel: f.channel, ownerApproval: f.approve(opened.challenge) }), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  assert.equal(f.protocol.status().phase, 'recovery-required');
  assert.equal(f.storage.snapshot.clients.length, 1); // The write happened, acknowledgement was lost.
  const reads = f.counts().reads;
  await assert.rejects(reconnect(f, key, f.storage.snapshot.clients[0]), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  assert.equal(f.counts().reads, reads); // No blind read/retry while write outcome is unresolved.
  assert.throws(() => fixture({ storage: f.storage, runtimeIncarnation: 'unsafe-restart' }), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  await assert.rejects(f.protocol.recover(), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  await f.protocol.recover({ ownerApproval: f.recoveryApproval(0) });
  await assert.rejects(f.protocol.finish(frame, { channel: f.channel, ownerApproval: f.approve(opened.challenge) }), denied);
  const fresh = await reconnect(f, key, f.storage.snapshot.clients[0]);
  const receipt = await f.protocol.finish(finishFrame(fresh.challenge, await signature(key, fresh.challenge)), { channel: f.channel });
  assert.equal((await f.protocol.readReceipt(receipt, { channel: f.channel })).identityOnly, true);
});

test('a protected-store rollback is fenced instead of silently accepting an older generation', async () => {
  const f = fixture(), enrolled = await enroll(f);
  f.storage.snapshot = emptyState();
  await assert.rejects(reconnect(f, enrolled.key, enrolled.identity), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  await assert.rejects(f.protocol.recover({ ownerApproval: f.recoveryApproval(1) }), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  assert.equal(f.protocol.status().phase, 'recovery-required');
});

test('lost acknowledgements and thrown registry errors require one serialized explicit recovery', async () => {
  const f = fixture(), key = keyFixture(f), sentinel = 'PRIVATE_REGISTRY_FAILURE_NEVER_EXPOSE';
  const opened = await f.protocol.begin(JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' }), { channel: f.channel });
  f.hooks.commitError = sentinel;
  await assert.rejects(f.protocol.finish(finishFrame(opened.challenge, await signature(key, opened.challenge)), {
    channel: f.channel, ownerApproval: f.approve(opened.challenge),
  }), error => {
    assert.equal(error.code, 'CLIENT_IDENTITY_RECOVERY_REQUIRED');
    assert.doesNotMatch(JSON.stringify(error) + error.stack, new RegExp(sentinel)); return true;
  });
  assert.equal(f.counts().commits, 1);
  f.hooks.commitError = null;
  const held = gate(), approval = f.recoveryApproval(0);
  f.hooks.recover = held;
  const recovering = f.protocol.recover({ ownerApproval: approval });
  await held.started;
  await assert.rejects(f.protocol.recover({ ownerApproval: approval }), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  await assert.rejects(f.protocol.recover({ ownerApproval: approval }), { code: 'CLIENT_IDENTITY_RECOVERY_REQUIRED' });
  assert.equal(f.counts().recoveries, 1);
  held.release(); await recovering;
  assert.equal(f.protocol.status().phase, 'ready');
});

test('a saturated authentication queue cannot consume the owner revocation slot', async () => {
  const f = fixture({ limits: { pending: 1 } }), enrolled = await enroll(f);
  const opened = await reconnect(f, enrolled.key, enrolled.identity), held = gate();
  f.hooks.read = held;
  const finishing = f.protocol.finish(finishFrame(opened.challenge, await signature(enrolled.key, opened.challenge)), { channel: f.channel });
  const rejected = assert.rejects(finishing, denied);
  await held.started;
  await revoke(f, enrolled.identity);
  held.release(); await rejected;
  assert.equal(f.storage.snapshot.clients.length, 0);
  assert.equal(f.storage.snapshot.tombstones.length, 1);
});

test('pending jobs, clients, tombstones and receipts are bounded without evicting revocations', async () => {
  const limited = fixture({ limits: { pending: 1, clients: 1, tombstones: 1, receipts: 1 } }), key = keyFixture(limited);
  const frame = JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' });
  const waiting = await limited.protocol.begin(frame, { channel: limited.channel });
  await assert.rejects(limited.protocol.begin(frame, { channel: limited.channel }), { code: 'CLIENT_IDENTITY_CAPACITY' });
  assert.equal(limited.protocol.cancel(waiting.challenge.challengeId, { channel: limited.channel }), true);
  const enrolled = await enroll(limited, key);
  await assert.rejects(limited.protocol.begin(JSON.stringify({
    type: 'enroll', publicKey: keyFixture(limited).publicKey, clientNonce: nonce(), label: 'Other',
  }), { channel: limited.channel }), { code: 'CLIENT_IDENTITY_CAPACITY' });
  const opened = await reconnect(limited, key, enrolled.identity);
  await assert.rejects(limited.protocol.finish(finishFrame(opened.challenge, await signature(key, opened.challenge)), { channel: limited.channel }), { code: 'CLIENT_IDENTITY_CAPACITY' });
  await revoke(limited, enrolled.identity);
  await assert.rejects(enroll(limited, keyFixture(limited)), { code: 'CLIENT_IDENTITY_CAPACITY' });
  assert.equal(limited.storage.snapshot.tombstones.length, 1);
});

test('tombstone capacity reserves durable revocation for every admitted identity', async () => {
  const f = fixture({ limits: { clients: 2, tombstones: 2 } });
  const a = await enroll(f), b = await enroll(f);
  await assert.rejects(rotation(f, a, keyFixture(f)), { code: 'CLIENT_IDENTITY_CAPACITY' });
  await revoke(f, a.identity);
  await revoke(f, b.identity);
  assert.equal(f.storage.snapshot.clients.length, 0);
  assert.equal(f.storage.snapshot.tombstones.length, 2);
  await assert.rejects(enroll(f), { code: 'CLIENT_IDENTITY_CAPACITY' });
});

test('strict bounded wire parsing rejects malformed, duplicate, unknown and nested data', async () => {
  const f = fixture(), key = keyFixture(f), valid = JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' });
  const malformed = [
    JSON.parse(valid), '[]', 'null', '{}', valid + valid, valid.replace('"type":', '"type":"enroll","type":'),
    valid.replace('"type":', '"t\\u0079pe":"enroll","type":'), valid.replace('"label":"Agent"', '"label":"Agent","unknown":1'),
    valid.replace('"label":"Agent"', '"label":{"nested":true}'), valid.replace('"label":"Agent"', '"label":"\\u0000"'),
    valid.replace('"label":"Agent"', '"label":"\\ud800"'), valid.replace('"type":', '"__proto__":"bad","type":'),
    Buffer.from([0xff, 0xfe]), ' '.repeat(CLIENT_IDENTITY_LIMITS.frameBytes + 1),
  ];
  for (const frame of malformed) await assert.rejects(f.protocol.begin(frame, { channel: f.channel }), denied);
  assert.equal(f.protocol.status().pending, 0);
  assert.throws(() => parseClientIdentityFrame('{"a":1,"\\u0061":2}', ['a']), denied);
});

test('only validated public metadata persists; callback errors never expose secrets or credentials', async () => {
  const f = fixture(), sentinel = 'PRIVATE_CUSTODY_SENTINEL_NEVER_EXPOSE', key = keyFixture(f);
  const opened = await f.protocol.begin(JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' }), { channel: f.channel });
  key.fail(sentinel);
  await assert.rejects(signature(key, opened.challenge), error => {
    assert.equal(error.code, 'CLIENT_IDENTITY_DENIED');
    assert.doesNotMatch(JSON.stringify(error) + error.stack, new RegExp(sentinel)); return true;
  });
  f.hooks.readError = sentinel;
  await assert.rejects(f.protocol.begin(JSON.stringify({ type: 'enroll', publicKey: key.publicKey, clientNonce: nonce(), label: 'Agent' }), { channel: f.channel }), error => {
    assert.doesNotMatch(JSON.stringify(error) + error.stack, new RegExp(sentinel)); return true;
  });
  f.hooks.readError = null; key.fail(null);
  f.protocol.cancel(opened.challenge.challengeId, { channel: f.channel });
  const enrolled = await enroll(f, key);
  const snapshot = JSON.stringify(f.storage.snapshot);
  assert.doesNotMatch(snapshot, /PRIVATE|private|credential|secret|signature|BEGIN|grant|lease/u);
  assert.match(snapshot, /publicKey/u);
  f.storage.snapshot.clients[0].credential = sentinel;
  await assert.rejects(reconnect(f, key, enrolled.identity), denied);
});
