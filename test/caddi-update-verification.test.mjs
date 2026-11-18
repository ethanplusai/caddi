import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createSyntheticUpdateService } from '../src/caddi/updates/testing.mjs';
import { createMainUpdateConfiguration, createOfflineUpdateService } from '../src/caddi/updates/index.mjs';
import { canonical, signingBytes, digest, ARTIFACT_LIMIT, MANIFEST_LIMIT } from '../src/caddi/updates/manifest.mjs';

const NOW = Date.parse('2026-10-27T12:00:00Z'), HOUR = 3600000;
const target = { product: 'Caddi Test', bundleId: 'app.caddi.synthetic', channel: 'test', platform: 'darwin', arch: 'arm64' };
const baseline = { sequence: 0, version: '0.0.0', sourceDigest: '0'.repeat(64), payloadDigest: '0'.repeat(64), keyId: null };
const code = expected => error => error.code === expected;
const temporary = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caddi-update-test-'), { encoding: 'utf8' });
function owner() {
  const controller = new AbortController();
  let epoch = 1;
  const fence = { epoch, signal: controller.signal, assertCurrent: () => epoch === 1 };
  return { fence, controller, replace() { epoch++; } };
}
function fixture(t, { directory: requested, fault, policy: alterPolicy, initialRelease = baseline, expectedCheckpoint } = {}) {
  const directory = requested === null ? null : requested ?? temporary();
  const checkpointDirectory = directory ? temporary() : null;
  const root = generateKeyPairSync('ed25519'), next = generateKeyPairSync('ed25519');
  const artifact = Buffer.from('Synthetic offline artifact. Never an application or installer.\n');
  const key = (id, publicKey) => ({ id, publicKey, status: 'active', notBefore: NOW - HOUR, notAfter: NOW + 8 * HOUR,
    minimumSequence: 1, maximumSequence: 1000 });
  const policy = { expectedTarget: { ...target }, trustedKeys: [key('root', root.publicKey), key('next', next.publicKey)],
    initialKeyIds: ['root'], rotations: [] };
  alterPolicy?.(policy);
  let time = NOW;
  const services = [];
  const open = (options = {}) => {
    const service = createSyntheticUpdateService({ policy, initialRelease, directory, now: () => time,
      ...(fault ? { fault } : {}), ...(expectedCheckpoint ? { expectedCheckpoint } : {}), ...options });
    services.push(service); return service;
  };
  const service = open();
  const manifest = ({ keyId = 'root', privateKey = root.privateKey, sequence = 1, target: targetChange = {},
    signed: signedChange = {}, release: releaseChange = {}, mutate } = {}) => {
    const envelope = { format: 'caddi-update-envelope-v1', algorithm: 'Ed25519', keyId,
      signed: { format: 'caddi-offline-update-v1', target: { ...target, ...targetChange },
        release: { sequence, version: '1.0.' + sequence, sourceDigest: digest(Buffer.from('synthetic source ' + sequence)),
          payloadDigest: digest(Buffer.from('synthetic payload inventory ' + sequence)), artifactSha256: digest(artifact),
          artifactBytes: artifact.length, ...releaseChange },
        issuedAt: NOW - 1000, notBefore: NOW - 1000, expiresAt: NOW + HOUR, ...signedChange } };
    mutate?.(envelope);
    envelope.signature = sign(null, signingBytes(envelope), privateKey).toString('base64url');
    return Buffer.from(canonical(envelope));
  };
  const verify = (bytes = manifest(), instance = service) => instance.verifyManifest(bytes, { expectedCurrentState: instance.readState() });
  const stage = (candidate = verify(), instance = service, fence = owner().fence) =>
    instance.stageVerified(candidate, { artifactBytes: artifact, ownerFence: fence });
  const persistCheckpoint = state => {
    const bytes = Buffer.from(canonical(state.checkpoint)), file = path.join(checkpointDirectory, 'trusted-checkpoint.json');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const filefd = fs.openSync(file, 'r'), dirfd = fs.openSync(checkpointDirectory, 'r');
    try { fs.fsyncSync(filefd); fs.fsyncSync(dirfd); } finally { fs.closeSync(filefd); fs.closeSync(dirfd); }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const acknowledge = async (instance = service, fence = owner().fence) => {
    const state = instance.readState();
    persistCheckpoint(state);
    return instance.acknowledgeCheckpoint({ expectedCurrentState: state, ownerFence: fence });
  };
  t.after(async () => {
    for (const instance of services) { await instance.whenDrained(); instance.close(); }
    if (directory && requested === undefined) fs.rmSync(directory, { recursive: true, force: true });
    if (checkpointDirectory) fs.rmSync(checkpointDirectory, { recursive: true, force: true });
  });
  return { directory, service, root, next, policy, artifact, manifest, verify, stage, open, persistCheckpoint, acknowledge,
    setTime(value) { time = value; } };
}
const encode = value => Buffer.from(canonical(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('valid signed exact-target manifest stages only an opaque artifact receipt and survives a checkpointed restart', async t => {
  const f = fixture(t);
  const state = f.service.readState(), candidate = f.service.verifyManifest(f.manifest(), { expectedCurrentState: state });
  assert.equal(candidate.release.sequence, 1);
  assert.ok(Object.isFrozen(candidate.release));
  const receipt = await f.stage(candidate);
  assert.equal(receipt.kind, 'verified-artifact-staged');
  assert.equal(receipt.installed, false);
  assert.equal(f.service.inspectReceipt(receipt).release.artifactSha256, digest(f.artifact));
  assert.throws(() => f.service.inspectReceipt({ ...receipt }), code('UPDATE_FORGED_RECEIPT'));
  const after = f.service.readState();
  assert.equal(after.phase, 'artifact-staged');
  assert.equal(after.checkpointAcknowledgementRequired, true);
  assert.equal(after.checkpoint.keyId, 'root');
  assert.equal(after.checkpoint.generation, 1);
  assert.equal(fs.statSync(path.join(f.directory, 'update-state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.directory, 'artifact-' + receipt.id + '.bin')).mode & 0o777, 0o600);
  await f.acknowledge();
  const restarted = f.open({ expectedCheckpoint: after.checkpoint });
  assert.deepEqual(restarted.readState().receipt, receipt);
  assert.throws(() => f.verify(f.manifest(), restarted), code('UPDATE_ROLLBACK_OR_REPLAY'));
  const unanchored = f.open();
  assert.throws(() => unanchored.readState(), code('UPDATE_STATE_CONFLICT'));
});

test('signature mutations and every expected target component are rejected', t => {
  const f = fixture(t, { directory: null });
  const signed = JSON.parse(f.manifest());
  signed.signed.release.sourceDigest = 'f'.repeat(64);
  assert.throws(() => f.verify(encode(signed)), code('UPDATE_BAD_SIGNATURE'));
  signed.signed.release.sourceDigest = 'e'.repeat(64);
  signed.signature = 'A'.repeat(86);
  assert.throws(() => f.verify(encode(signed)), code('UPDATE_BAD_SIGNATURE'));
  for (const [name, value] of Object.entries({ product: 'Other', bundleId: 'app.other', channel: 'stable', platform: 'linux', arch: 'x64' })) {
    assert.throws(() => f.verify(f.manifest({ target: { [name]: value } })), code('UPDATE_WRONG_TARGET'), name);
  }
});

test('wire parser rejects duplicate/unknown fields, prototype names, noncanonical encodings, excessive depth and invalid UTF-8', t => {
  const f = fixture(t, { directory: null }), valid = f.manifest().toString('utf8');
  const inputs = [
    Buffer.from(valid.replace('{"algorithm":', '{"algorithm":"Ed25519","algorithm":')),
    Buffer.from(valid.replace('"sequence":1', '"sequence":0,"sequence":1')),
    Buffer.from(' ' + valid),
    Buffer.from(valid + '\n'),
    Buffer.from(valid.replace('"algorithm"', '"\\u0061lgorithm"')),
    Buffer.from(valid.replace('{"algorithm":', '{"__proto__":{},"algorithm":')),
    Buffer.from('['.repeat(10) + '0' + ']'.repeat(10)),
    Buffer.alloc(16385, 0x20), Buffer.from([0xc0, 0x80]), Buffer.from('\uFEFF' + valid),
    f.manifest({ mutate(envelope) { envelope.signed.url = 'https://never-dispatched.invalid/update'; } }),
    f.manifest({ mutate(envelope) { envelope.signed.release.path = '../../outside'; } }),
    f.manifest({ mutate(envelope) { envelope.signed.target.extra = true; } }),
    f.manifest({ release: { artifactSha256: 123 } }),
    f.manifest({ mutate(envelope) { envelope.algorithm = 'none'; } }),
  ];
  for (const [index, bytes] of inputs.entries()) assert.throws(() => f.verify(bytes), code('UPDATE_INVALID_MANIFEST'), 'input ' + index);
  assert.throws(() => f.service.verifyManifest(f.manifest(), { expectedCurrentState: { ...f.service.readState() } }), code('UPDATE_STALE_STATE'));
});

test('expiry, not-before, issuance bounds, unsafe sequences and rollback/replay fail closed', async t => {
  const f = fixture(t);
  assert.throws(() => f.verify(f.manifest({ signed: { issuedAt: NOW - HOUR, notBefore: NOW - HOUR, expiresAt: NOW } })), code('UPDATE_MANIFEST_TIME'));
  assert.throws(() => f.verify(f.manifest({ signed: { issuedAt: NOW + 1, notBefore: NOW + 1 } })), code('UPDATE_MANIFEST_TIME'));
  assert.throws(() => f.verify(f.manifest({ signed: { notBefore: NOW + 1 } })), code('UPDATE_MANIFEST_TIME'));
  assert.throws(() => f.verify(f.manifest({ signed: { expiresAt: NOW + 32 * 24 * HOUR } })), code('UPDATE_INVALID_MANIFEST'));
  const malformed = JSON.parse(f.manifest()); malformed.signed.release.sequence = 1.5;
  assert.throws(() => f.verify(Buffer.from(JSON.stringify(malformed))), code('UPDATE_INVALID_MANIFEST'));
  const candidate = f.verify();
  await f.stage(candidate);
  assert.throws(() => f.verify(), code('UPDATE_ROLLBACK_OR_REPLAY'));
  assert.throws(() => f.verify(f.manifest({ sequence: 0 })), code('UPDATE_INVALID_MANIFEST'));
  assert.throws(() => f.verify(f.manifest({ signed: { expiresAt: NOW + 9 * HOUR } })), code('UPDATE_KEY_INVALID'));
});

test('untrusted, revoked, out-of-sequence and wrong-type keys do not gain authority', t => {
  const f = fixture(t, { directory: null });
  assert.throws(() => f.verify(f.manifest({ keyId: 'not-pinned' })), code('UPDATE_UNTRUSTED_KEY'));
  assert.throws(() => f.verify(f.manifest({ privateKey: f.next.privateKey })), code('UPDATE_BAD_SIGNATURE'));
  assert.throws(() => f.verify(f.manifest({ sequence: 1001 })), code('UPDATE_KEY_INVALID'));
  const revoked = fixture(t, { directory: null, policy(policy) { policy.trustedKeys[0].status = 'revoked'; } });
  assert.throws(() => revoked.verify(), code('UPDATE_UNTRUSTED_KEY'));
  assert.throws(() => f.open({ policy: { ...f.policy, trustedKeys: [{ ...f.policy.trustedKeys[0], publicKey: f.root.privateKey }] } }), code('UPDATE_INVALID_ARGUMENT'));
  assert.throws(() => f.open({ policy: { ...f.policy, trustedKeys: [{ ...f.policy.trustedKeys[0], id: 7 }] } }), code('UPDATE_INVALID_ARGUMENT'));
});

test('pinned rotation policy is explicit and caller mutations cannot change trust', async t => {
  const f = fixture(t, { policy(policy) { policy.rotations = [{ from: 'root', to: 'next', minimumSequence: 3 }]; } });
  const first = f.verify();
  f.policy.initialKeyIds.push('next');
  f.policy.rotations[0].minimumSequence = 2;
  f.policy.expectedTarget.product = 'Changed after pin';
  f.policy.trustedKeys[0].status = 'revoked';
  await f.stage(first);
  await f.acknowledge();
  assert.throws(() => f.verify(f.manifest({ sequence: 2, keyId: 'next', privateKey: f.next.privateKey })), code('UPDATE_ROTATION_DENIED'));
  await f.stage(f.verify(f.manifest({ sequence: 3, keyId: 'next', privateKey: f.next.privateKey })));
  assert.equal(f.service.readState().keyId, 'next');
  assert.throws(() => f.verify(f.manifest({ sequence: 4 })), code('UPDATE_ROTATION_DENIED'));
});

test('configuration POJOs cannot enable production and the unsigned development identity remains verify-only', async t => {
  const f = fixture(t, { directory: null });
  assert.throws(() => createOfflineUpdateService({ mode: 'artifact-staging', productionQualified: true }), code('UPDATE_MAIN_CONFIGURATION_REQUIRED'));
  assert.throws(() => createMainUpdateConfiguration({ policy: f.policy, initialRelease: baseline,
    expectedCheckpoint: undefined, directory: null, qualification: null }), code('UPDATE_MAIN_CONFIGURATION_REQUIRED'));
  await assert.rejects(f.stage(), code('UPDATE_VERIFY_ONLY'));
  const prior = Object.getOwnPropertyDescriptor(process, 'type');
  try {
    Object.defineProperty(process, 'type', { configurable: true, value: 'browser' });
    const config = createMainUpdateConfiguration({
      policy: { ...f.policy, expectedTarget: { ...target, product: 'Caddi Development',
        bundleId: 'build.caddi.browser.development', channel: 'development' } },
      initialRelease: baseline, expectedCheckpoint: undefined, directory: null,
      qualification: { assertQualified: () => true, signal: new AbortController().signal },
    });
    const service = createOfflineUpdateService(config);
    assert.equal(service.status().mode, 'verify-only'); service.close();
  } finally {
    if (prior) Object.defineProperty(process, 'type', prior); else delete process.type;
  }
  assert.equal(ARTIFACT_LIMIT, 64 * 1024 * 1024);
});

test('forged/cross-service/consumed candidates and artifact mutations never publish state', async t => {
  const f = fixture(t), candidate = f.verify(), other = f.open();
  await assert.rejects(f.stage({ ...candidate }), code('UPDATE_FORGED_OR_STALE_CANDIDATE'));
  await assert.rejects(f.stage(candidate, other), code('UPDATE_FORGED_OR_STALE_CANDIDATE'));
  await assert.rejects(f.service.stageVerified(candidate, { artifactBytes: Buffer.alloc(f.artifact.length), ownerFence: owner().fence }), code('UPDATE_INVALID_ARTIFACT'));
  assert.deepEqual(fs.readdirSync(f.directory), []);
  await f.stage(candidate);
  await assert.rejects(f.stage(candidate), code('UPDATE_FORGED_OR_STALE_CANDIDATE'));
  assert.equal(f.service.readState().checkpoint.sequence, 1);
});

test('serialized stage CAS consumes only one of two candidates from the same state', async t => {
  const f = fixture(t);
  const first = f.verify(), later = f.verify(f.manifest({ sequence: 2 }));
  const results = await Promise.allSettled([f.stage(first), f.stage(later)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'UPDATE_FORGED_OR_STALE_CANDIDATE');
  assert.equal(f.service.readState().checkpoint.sequence, 1);
  await f.acknowledge();
  assert.equal(fs.readdirSync(f.directory).length, 2);
});

test('owner cancellation after an await fences writes until explicit uncommitted recovery', async t => {
  const guard = owner();
  const f = fixture(t, { fault(name) { if (name === 'after-artifact') guard.controller.abort(); } });
  const candidate = f.verify();
  await assert.rejects(f.stage(candidate, f.service, guard.fence), code('UPDATE_RECOVERY_REQUIRED'));
  assert.equal(fs.existsSync(path.join(f.directory, 'update-state.json')), false);
  assert.throws(() => f.service.readState(), code('UPDATE_RECOVERY_REQUIRED'));
  const recovered = await f.service.recoverState({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'not-committed');
  assert.equal(recovered.state.checkpoint.sequence, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  await assert.rejects(f.stage(candidate), code('UPDATE_FORGED_OR_STALE_CANDIDATE'));
});

test('owner epoch changes and time expiry at the last await are checked before commit', async t => {
  for (const mode of ['owner', 'time']) {
    const guard = owner();
    let fixtureRef;
    const f = fixture(t, { fault(name) {
      if (name === 'before-commit') {
        if (mode === 'owner') guard.replace(); else fixtureRef.setTime(NOW + HOUR);
      }
    } });
    fixtureRef = f;
    await assert.rejects(f.stage(f.verify(), f.service, guard.fence), code('UPDATE_RECOVERY_REQUIRED'));
    assert.equal(fs.existsSync(path.join(f.directory, 'update-state.json')), false);
    const recovered = await f.service.recoverState({ ownerFence: owner().fence });
    assert.equal(recovered.outcome, 'not-committed');
  }
});

test('an uncertain publication recovers its committed receipt instead of blindly retrying', async t => {
  let inject = true;
  const f = fixture(t, { fault(name) { if (name === 'after-commit' && inject) { inject = false; throw new Error('synthetic unknown outcome'); } } });
  const checkpointBefore = f.service.readState().checkpoint;
  await assert.rejects(f.stage(), code('UPDATE_RECOVERY_REQUIRED'));
  assert.equal(fs.existsSync(path.join(f.directory, 'update-state.json')), true);
  assert.throws(() => f.verify(f.manifest({ sequence: 2 })), code('UPDATE_RECOVERY_REQUIRED'));
  // A new service retains the trusted pre-transaction checkpoint and performs
  // explicit recovery; it never treats a successful rename as installation.
  const restarted = f.open({ expectedCheckpoint: checkpointBefore });
  assert.throws(() => restarted.readState(), code('UPDATE_RECOVERY_REQUIRED'));
  const result = await restarted.recoverState({ ownerFence: owner().fence });
  assert.equal(result.outcome, 'committed');
  assert.equal(result.state.receipt.installed, false);
  assert.equal(result.state.checkpoint.sequence, 1);
  assert.equal(result.state.checkpointAcknowledgementRequired, true);
  assert.throws(() => f.verify(f.manifest(), restarted), code('UPDATE_ROLLBACK_OR_REPLAY'));
  await f.acknowledge(restarted);
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), false);
});

test('a second service cannot steal a live transaction or adopt an unpinned checkpoint', async t => {
  const blocked = deferred(), release = deferred();
  const f = fixture(t, { async fault(name) { if (name === 'before-commit') { blocked.resolve(); await release.promise; } } });
  const other = f.open(), first = f.verify(), otherCandidate = f.verify(f.manifest({ sequence: 2 }), other);
  const pending = f.stage(first);
  await blocked.promise;
  await assert.rejects(f.stage(otherCandidate, other), code('UPDATE_RECOVERY_REQUIRED'));
  await assert.rejects(other.recoverState({ ownerFence: owner().fence }), code('UPDATE_BUSY'));
  release.resolve(); await pending;
  await f.acknowledge();
  await assert.rejects(other.recoverState({ ownerFence: owner().fence }), code('UPDATE_STATE_CONFLICT'));
  assert.equal(f.service.readState().checkpoint.sequence, 1);
});

test('state replacement ABA fails the final CAS and requires explicit recovery', async t => {
  let replace = false;
  const f = fixture(t, { fault(name) {
    if (replace && name === 'before-commit') {
      const file = path.join(f.directory, 'update-state.json'), bytes = fs.readFileSync(file);
      const copy = path.join(f.directory, 'synthetic-replacement');
      fs.writeFileSync(copy, bytes, { mode: 0o600 }); fs.renameSync(copy, file); replace = false;
    }
  } });
  await f.stage(); await f.acknowledge(); replace = true;
  await assert.rejects(f.stage(f.verify(f.manifest({ sequence: 2 }))), code('UPDATE_RECOVERY_REQUIRED'));
  const recovery = await f.service.recoverState({ ownerFence: owner().fence });
  assert.equal(recovery.outcome, 'not-committed');
  assert.equal(recovery.state.checkpoint.sequence, 1);
});

test('corrupt state and rollback to a previous state conflict with the trusted restart checkpoint', async t => {
  const f = fixture(t);
  await f.stage();
  await f.acknowledge();
  const first = fs.readFileSync(path.join(f.directory, 'update-state.json'));
  await f.stage(f.verify(f.manifest({ sequence: 2 })));
  await f.acknowledge();
  const checkpoint = f.service.readState().checkpoint;
  fs.writeFileSync(path.join(f.directory, 'update-state.json'), first, { mode: 0o600 });
  const restarted = f.open({ expectedCheckpoint: checkpoint });
  assert.throws(() => restarted.readState(), code('UPDATE_STATE_CONFLICT'));
  fs.writeFileSync(path.join(f.directory, 'update-state.json'), Buffer.from('{}'), { mode: 0o600 });
  assert.throws(() => restarted.readState());
});

test('symlinks, hard links, unsafe modes and relative storage paths are rejected without following targets', async t => {
  const f = fixture(t);
  assert.throws(() => f.open({ directory: '../relative' }), code('UPDATE_TEST_DIRECTORY_REQUIRED'));
  fs.chmodSync(f.directory, 0o755);
  assert.throws(() => f.open(), code('UPDATE_UNSAFE_STORAGE'));
  fs.chmodSync(f.directory, 0o700);
  const external = temporary(), sentinel = path.join(external, 'sentinel');
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.writeFileSync(sentinel, 'untouched', { mode: 0o600 });
  fs.symlinkSync(sentinel, path.join(f.directory, 'update-state.json'));
  assert.throws(() => f.service.readState(), code('UPDATE_UNSAFE_STORAGE'));
  fs.unlinkSync(path.join(f.directory, 'update-state.json'));
  assert.throws(() => f.service.readState(), code('UPDATE_RECOVERY_REQUIRED'));
  await f.service.recoverState({ ownerFence: owner().fence });
  const receipt = await f.stage();
  const artifact = path.join(f.directory, 'artifact-' + receipt.id + '.bin');
  fs.linkSync(artifact, path.join(f.directory, 'hardlink'));
  assert.throws(() => f.service.readState(), code('UPDATE_UNSAFE_STORAGE'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('recovery never follows a substituted artifact symlink or deletes unrelated files', async t => {
  const external = temporary(), sentinel = path.join(external, 'sentinel');
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.writeFileSync(sentinel, 'untouched', { mode: 0o600 });
  const f = fixture(t, { fault(name, detail) {
    if (name === 'after-lock') fs.symlinkSync(sentinel, path.join(detail.directory, 'artifact-' + detail.transactionId + '.bin'));
  } });
  await assert.rejects(f.stage(), code('UPDATE_RECOVERY_REQUIRED'));
  await assert.rejects(f.service.recoverState({ ownerFence: owner().fence }), code('UPDATE_UNSAFE_STORAGE'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
});

test('directory identity changes and partially corrupted transaction bytes stay fenced', async t => {
  const renamed = [];
  const f = fixture(t, { fault(name) {
    if (name === 'after-lock') {
      const alternate = f.directory + '-renamed';
      fs.renameSync(f.directory, alternate); renamed.push(alternate); fs.mkdirSync(f.directory, { mode: 0o700 });
    }
  } });
  t.after(() => { for (const directory of renamed) fs.rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(f.stage(), code('UPDATE_RECOVERY_REQUIRED'));
  assert.deepEqual(fs.readdirSync(f.directory), []);
  await assert.rejects(f.service.recoverState({ ownerFence: owner().fence }), code('UPDATE_STORAGE_CHANGED'));
  const g = fixture(t, { fault(name, detail) {
    if (name === 'after-lock') {
      fs.writeFileSync(path.join(detail.directory, 'update-transaction.json'), '{"partial":', { mode: 0o600 });
      throw new Error('synthetic partial write');
    }
  } });
  await assert.rejects(g.stage(), code('UPDATE_RECOVERY_REQUIRED'));
  await assert.rejects(g.service.recoverState({ ownerFence: owner().fence }));
  assert.equal(g.service.status().recoveryRequired, true);
});


function syntheticCommittedRecord(f, base, bytes, { anchor = base.token, previousKeyId = base.keyId } = {}) {
  const envelope = JSON.parse(bytes), id = randomUUID();
  const receipt = { id, kind: 'verified-artifact-staged', installed: false, target: envelope.signed.target,
    release: envelope.signed.release, keyId: envelope.keyId, manifestDigest: digest(bytes), stagedAt: envelope.signed.notBefore };
  const state = { format: 'caddi-staged-update-state-v1', anchor, generation: base.generation + 1,
    previousToken: base.token, previousKeyId, previousSequence: base.sequence, receipt, manifest: bytes.toString('utf8') };
  const transaction = { format: 'caddi-update-transaction-v1', id, pid: process.pid, base, nextState: canonical(state) };
  fs.writeFileSync(path.join(f.directory, 'update-state.json'), canonical(state), { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'artifact-' + id + '.bin'), f.artifact, { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'update-transaction.json'), canonical(transaction), { mode: 0o600 });
  return transaction;
}

test('recovery binds the predecessor signer to the trusted initial and noninitial checkpoints', async t => {
  for (const priorSequence of [0, 1]) {
    const f = fixture(t), initial = f.service.readState().checkpoint;
    if (priorSequence) { await f.stage(); await f.acknowledge(); }
    const base = f.service.readState().checkpoint;
    assert.equal(base.keyId, priorSequence ? 'root' : null);
    const bytes = f.manifest({ sequence: priorSequence + 1, keyId: 'next', privateKey: f.next.privateKey });
    assert.throws(() => f.verify(bytes), code('UPDATE_ROTATION_DENIED'));
    const transaction = syntheticCommittedRecord(f, base, bytes, { anchor: initial.token, previousKeyId: 'next' });
    await assert.rejects(f.service.recoverState({ ownerFence: owner().fence }), code('UPDATE_CORRUPT_TRANSACTION'));
    assert.equal(f.service.status().recoveryRequired, true);
    // Making both unsigned predecessor claims agree still cannot change the
    // keyId pinned alongside the trusted token, generation and sequence.
    transaction.base = { ...base, keyId: 'next' };
    fs.writeFileSync(path.join(f.directory, 'update-transaction.json'), canonical(transaction), { mode: 0o600 });
    await assert.rejects(f.service.recoverState({ ownerFence: owner().fence }),
      code(priorSequence ? 'UPDATE_STATE_CONFLICT' : 'UPDATE_INVALID_ARGUMENT'));
    assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  }
});

test('committed evidence is retained, staging is blocked, and acknowledgment requires the exact branded state and a current owner', async t => {
  const f = fixture(t);
  const prior = f.service.readState();
  await f.stage();
  const staged = f.service.readState();
  assert.equal(staged.checkpointAcknowledgementRequired, true);
  assert.equal(f.service.status().checkpointAcknowledgementRequired, true);
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  await assert.rejects(f.stage(f.verify(f.manifest({ sequence: 2 }))), code('UPDATE_CHECKPOINT_ACK_REQUIRED'));
  await assert.rejects(f.service.acknowledgeCheckpoint({ expectedCurrentState: { ...staged }, ownerFence: owner().fence }), code('UPDATE_STALE_STATE'));
  await assert.rejects(f.service.acknowledgeCheckpoint({ expectedCurrentState: prior, ownerFence: owner().fence }), code('UPDATE_STALE_STATE'));
  f.persistCheckpoint(staged);
  const guard = owner();
  const acknowledgement = f.service.acknowledgeCheckpoint({ expectedCurrentState: staged, ownerFence: guard.fence });
  guard.controller.abort();
  await assert.rejects(acknowledgement, code('UPDATE_CANCELLED'));
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  await f.acknowledge();
  assert.equal(f.service.readState().checkpointAcknowledgementRequired, false);
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), false);
  await assert.rejects(f.service.acknowledgeCheckpoint({ expectedCurrentState: staged, ownerFence: owner().fence }), code('UPDATE_STALE_STATE'));
  await f.stage(f.verify(f.manifest({ sequence: 2 })));
});

test('retained committed evidence recovers against either the predecessor or already-persisted successor checkpoint', async t => {
  const f = fixture(t), before = f.service.readState().checkpoint;
  await f.stage();
  const after = f.persistCheckpoint(f.service.readState());
  const oldAnchor = f.open({ expectedCheckpoint: before });
  const oldRecovery = await oldAnchor.recoverState({ ownerFence: owner().fence });
  assert.equal(oldRecovery.outcome, 'committed');
  assert.deepEqual(oldRecovery.state.checkpoint, after);
  assert.equal(oldRecovery.state.checkpointAcknowledgementRequired, true);
  const successorAnchor = f.open({ expectedCheckpoint: after });
  const successorRecovery = await successorAnchor.recoverState({ ownerFence: owner().fence });
  assert.equal(successorRecovery.outcome, 'committed');
  assert.deepEqual(successorRecovery.state.checkpoint, after);
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  await f.acknowledge(successorAnchor);
  const acknowledgedRestart = f.open({ expectedCheckpoint: after });
  assert.deepEqual(acknowledgedRestart.readState().checkpoint, after);
  assert.equal(acknowledgedRestart.readState().checkpointAcknowledgementRequired, false);
});

test('an acknowledgment fsync failure after marker unlink recovers with the durably saved successor checkpoint', async t => {
  const f = fixture(t), before = f.service.readState().checkpoint;
  await f.stage();
  const state = f.service.readState(), after = f.persistCheckpoint(state);
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => {
      fs.fsyncSync = original;
      throw Object.assign(new Error('synthetic ack directory fsync failure'), { code: 'EIO' });
    };
    await assert.rejects(f.service.acknowledgeCheckpoint({ expectedCurrentState: state, ownerFence: owner().fence }),
      code('UPDATE_RECOVERY_REQUIRED'));
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.existsSync(path.join(f.directory, 'update-state.json')), true);
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), false);
  assert.equal(f.service.status().recoveryRequired, true);
  const sameInstance = await f.service.recoverState({ ownerFence: owner().fence });
  assert.equal(sameInstance.outcome, 'unchanged');
  assert.deepEqual(sameInstance.state.checkpoint, after);
  const restarted = f.open({ expectedCheckpoint: after });
  assert.deepEqual((await restarted.recoverState({ ownerFence: owner().fence })).state.checkpoint, after);
  const stale = f.open({ expectedCheckpoint: before });
  await assert.rejects(stale.recoverState({ ownerFence: owner().fence }), code('UPDATE_STATE_CONFLICT'));
});

test('an acknowledgment unlink failure retains committed evidence and never restores the predecessor checkpoint', async t => {
  const f = fixture(t);
  await f.stage();
  const state = f.service.readState(), after = f.persistCheckpoint(state);
  const original = fs.unlinkSync;
  try {
    fs.unlinkSync = file => {
      if (file === path.join(f.directory, 'update-transaction.json')) {
        fs.unlinkSync = original;
        throw Object.assign(new Error('synthetic ack unlink failure'), { code: 'EIO' });
      }
      return original(file);
    };
    await assert.rejects(f.service.acknowledgeCheckpoint({ expectedCurrentState: state, ownerFence: owner().fence }),
      code('UPDATE_RECOVERY_REQUIRED'));
  } finally { fs.unlinkSync = original; }
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  const recovered = await f.service.recoverState({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'committed');
  assert.deepEqual(recovered.state.checkpoint, after);
  assert.equal(recovered.state.checkpointAcknowledgementRequired, true);
  await f.acknowledge();
});

test('recovery directory-fsync failure preserves committed evidence for a later anchored retry', async t => {
  const f = fixture(t, { fault(name) { if (name === 'after-commit') throw new Error('synthetic lost result'); } });
  const before = f.service.readState().checkpoint;
  await assert.rejects(f.stage(), code('UPDATE_RECOVERY_REQUIRED'));
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => {
      fs.fsyncSync = original;
      throw Object.assign(new Error('synthetic recovery fsync failure'), { code: 'EIO' });
    };
    await assert.rejects(f.service.recoverState({ ownerFence: owner().fence }), code('UPDATE_IO_FAILURE'));
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  const restarted = f.open({ expectedCheckpoint: before });
  const recovered = await restarted.recoverState({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'committed');
  assert.equal(recovered.state.checkpoint.sequence, 1);
  assert.equal(recovered.state.checkpointAcknowledgementRequired, true);
  await f.acknowledge(restarted);
});

test('adopting a successor rechecks current manifest validity while an already-trusted successor remains historical', async t => {
  const f = fixture(t), before = f.service.readState().checkpoint;
  await f.stage();
  const after = f.persistCheckpoint(f.service.readState());
  f.setTime(NOW + 2 * HOUR);
  const oldAnchor = f.open({ expectedCheckpoint: before });
  await assert.rejects(oldAnchor.recoverState({ ownerFence: owner().fence }), code('UPDATE_MANIFEST_TIME'));
  assert.equal(fs.existsSync(path.join(f.directory, 'update-transaction.json')), true);
  const trustedSuccessor = f.open({ expectedCheckpoint: after });
  const recovered = await trustedSuccessor.recoverState({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'committed');
  assert.deepEqual(recovered.state.checkpoint, after);
  await f.acknowledge(trustedSuccessor);
  const future = fixture(t), base = future.service.readState().checkpoint;
  const bytes = future.manifest({ signed: { issuedAt: NOW + HOUR, notBefore: NOW + HOUR, expiresAt: NOW + 2 * HOUR } });
  syntheticCommittedRecord(future, base, bytes);
  await assert.rejects(future.service.recoverState({ ownerFence: owner().fence }), code('UPDATE_MANIFEST_TIME'));
});

test('oversized manifest bytes are rejected before the service makes an owned copy', t => {
  const f = fixture(t, { directory: null }), bytes = Buffer.alloc(MANIFEST_LIMIT + 1), state = f.service.readState();
  const original = Buffer.from;
  let copied = false;
  try {
    Buffer.from = function (value, ...args) {
      if (value === bytes) copied = true;
      return Reflect.apply(original, Buffer, [value, ...args]);
    };
    assert.throws(() => f.service.verifyManifest(bytes, { expectedCurrentState: state }), code('UPDATE_INVALID_MANIFEST'));
  } finally { Buffer.from = original; }
  assert.equal(copied, false);
});
