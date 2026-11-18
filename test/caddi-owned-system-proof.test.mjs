import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createOwnedSystemProof, openOwnedSystemProof, assertOwnedSystemProof } from '../src/caddi/desktop/owned-system-proof.mjs';
import { createSystemLifecycle, assertSystemLifecycle } from '../src/caddi/desktop/system-lifecycle.mjs';
import { systemCleanupAction } from '../src/caddi/desktop/system-actions.mjs';
import { createTestDesktopPersistenceConfiguration } from '../src/caddi/persistence/configuration-testing.mjs';
import { createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caddi-system-proof-')));
  fs.chmodSync(root, 0o700); const dataRoot = path.join(root, 'data'), sessionDataRoot = path.join(root, 'session');
  fs.mkdirSync(dataRoot, { mode: 0o700 }); fs.mkdirSync(sessionDataRoot, { mode: 0o700 });
  let now = Date.now(); const args = { proofRoot: root, dataRoot, sessionDataRoot, runRoots: [root], now: () => now };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, args, advance: ms => { now += ms; }, options: { dataRoot, sessionDataRoot, runRoot: root, show: false, enableMicrophone: false, nativeKeyStatus: { productionQualified: false } } };
}
test('synthetic lifecycle requires branded owned capability and exact native monitor identity', t => {
  const f = fixture(t), proof = createOwnedSystemProof(f.args), gate = proof.createLifecycle();
  assertOwnedSystemProof(proof, gate, f.options);
  assert.throws(() => assertOwnedSystemProof({}, gate, f.options), { code: 'SYSTEM_PROOF_DENIED' });
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
  const forged = createSystemLifecycle({ monitor });
  assert.throws(() => assertOwnedSystemProof(proof, forged, f.options), { code: 'SYSTEM_PROOF_DENIED' });
  assert.throws(() => assertSystemLifecycle(forged, { monitor: new EventEmitter() }), { code: 'SYSTEM_LIFECYCLE_REQUIRED' });
  proof.close();
});
test('hidden, no microphone, no qualified backend and exact profile paths are mandatory', t => {
  const f = fixture(t), proof = createOwnedSystemProof(f.args), gate = proof.createLifecycle();
  for (const changes of [{ show: true }, { enableMicrophone: true }, { nativeKeyStatus: { productionQualified: true } },
    { persistence: {} }, { dataRoot: f.root }, { sessionDataRoot: f.root }, { runRoot: path.dirname(f.root) }])
    assert.throws(() => assertOwnedSystemProof(proof, gate, { ...f.options, ...changes }), { code: 'SYSTEM_PROOF_DENIED' });
  proof.close();
});
test('existing ordinary metadata cannot be relabeled as a new owned proof', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.args.dataRoot, 'metadata'), { mode: 0o700 });
  assert.throws(() => createOwnedSystemProof(f.args), { code: 'SYSTEM_PROOF_DENIED' });
  assert.equal(fs.existsSync(path.join(f.root, 'system-proof.json')), false);
});
test('only an issued synthetic configuration at the exact owned protected directory can join a proof', t => {
  const f = fixture(t), proof = createOwnedSystemProof(f.args), gate = proof.createLifecycle(), keys = createTestPersistenceKeys();
  const configured = createTestDesktopPersistenceConfiguration({ directory: path.join(f.args.dataRoot, 'protected'),
    installationId: 'installation', vaultId: 'vault', keyProvider: keys.owner, feedbackKeyProvider: keys.feedback, create: true });
  const outside = createTestDesktopPersistenceConfiguration({ directory: path.join(f.root, 'wrong-protected'),
    installationId: 'installation', vaultId: 'vault', keyProvider: keys.owner, create: true });
  t.after(() => { configured.close(); outside.close(); proof.close(); keys.destroy(); });
  assertOwnedSystemProof(proof, gate, { ...f.options, persistence: configured });
  assert.equal(fs.existsSync(path.join(f.args.dataRoot, 'protected')), false);
  assert.equal(keys.inspect().outstanding, 0);
  assert.throws(() => assertOwnedSystemProof(proof, gate, { ...f.options, persistence: outside }), { code: 'SYSTEM_PROOF_DENIED' });
  assert.throws(() => assertOwnedSystemProof(proof, gate, { ...f.options, persistence: { ...configured } }), { code: 'SYSTEM_PROOF_DENIED' });
});
test('initial runtime directories must be empty or an exact owned child marker', t => {
  const f = fixture(t), runtime = path.join(f.root, 'runtime'); fs.mkdirSync(runtime, { mode: 0o700 });
  fs.writeFileSync(path.join(runtime, 'ordinary.txt'), 'preserve');
  assert.throws(() => createOwnedSystemProof({ ...f.args, runRoots: [runtime] }), { code: 'SYSTEM_PROOF_DENIED' });
  fs.unlinkSync(path.join(runtime, 'ordinary.txt'));
  fs.writeFileSync(path.join(runtime, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(48), phase: 'seed', proofRoot: '/wrong', driverPid: process.pid }), { mode: 0o600 });
  assert.throws(() => createOwnedSystemProof({ ...f.args, runRoots: [runtime] }), { code: 'SYSTEM_PROOF_DENIED' });
  fs.writeFileSync(path.join(runtime, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(48), phase: 'seed', proofRoot: f.root, driverPid: process.pid }));
  const proof = createOwnedSystemProof({ ...f.args, runRoots: [runtime] }); proof.close();
});
test('owned persistent restart reopens pinned receipt and authorizes only a fresh exact run root', t => {
  const f = fixture(t), first = createOwnedSystemProof(f.args);
  fs.mkdirSync(path.join(f.args.dataRoot, 'metadata'), { mode: 0o700 }); // synthetic data produced after issuance
  const receipt = first.receipt(), second = openOwnedSystemProof(receipt, { now: f.args.now });
  const restart = path.join(f.root, 'restart'); fs.mkdirSync(restart, { mode: 0o700 });
  second.authorizeRunRoot(restart); const gate = second.createLifecycle();
  assertOwnedSystemProof(second, gate, { ...f.options, runRoot: restart });
  assert.throws(() => openOwnedSystemProof(receipt, { now: f.args.now }), { code: 'SYSTEM_PROOF_DENIED' });
  assert.throws(() => createOwnedSystemProof(f.args), { code: 'SYSTEM_PROOF_DENIED' }); second.close();
});
test('unrelated external empty or nonempty directories are refused while the exact driver marker chain is pinned', t => {
  const f = fixture(t), external = fs.realpathSync(fs.mkdtempSync('/private/tmp/caddi-proof-unrelated-'));
  fs.chmodSync(external, 0o700); t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  assert.throws(() => createOwnedSystemProof({ ...f.args, runRoots: [external] }), { code: 'SYSTEM_PROOF_DENIED' });
  fs.writeFileSync(path.join(external, 'preserve.txt'), 'unrelated bytes', { mode: 0o600 });
  assert.throws(() => createOwnedSystemProof({ ...f.args, runRoots: [external] }), { code: 'SYSTEM_PROOF_DENIED' });
  assert.equal(fs.readFileSync(path.join(external, 'preserve.txt'), 'utf8'), 'unrelated bytes');
  fs.unlinkSync(path.join(external, 'preserve.txt'));
  const file = path.join(external, 'owner.json'), value = { driverPid: process.pid, nonce: 'e'.repeat(48), phase: 'seed', proofRoot: f.root };
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const proof = createOwnedSystemProof({ ...f.args, runRoots: [external] }), gate = proof.createLifecycle();
  assertOwnedSystemProof(proof, gate, { ...f.options, runRoot: external });
  const reopened = openOwnedSystemProof(proof.receipt(), { now: f.args.now }); reopened.assertCurrent(); reopened.close();
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  assert.throws(proof.assertCurrent, { code: 'SYSTEM_PROOF_DENIED' }); proof.close();
});
test('no-path runtime factory owns a short marked directory and refuses arbitrary external authorization', t => {
  const f = fixture(t), proof = createOwnedSystemProof(f.args), external = fs.realpathSync(fs.mkdtempSync('/private/tmp/caddi-proof-unrelated-'));
  fs.chmodSync(external, 0o700); t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  assert.throws(() => proof.authorizeRunRoot(external), { code: 'SYSTEM_PROOF_DENIED' });
  const runtime = proof.createRunRoot(); t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  assert.equal(Buffer.byteLength(path.join(runtime, 'b.sock')) <= 100, true);
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  const marker = JSON.parse(fs.readFileSync(path.join(runtime, 'owner.json')));
  assert.equal(marker.phase, 'runtime'); assert.equal(marker.proofRoot, f.root); assert.equal(marker.driverPid, process.pid);
  assert.equal(marker.nonce, proof.receipt().nonce);
  const gate = proof.createLifecycle(); assertOwnedSystemProof(proof, gate, { ...f.options, runRoot: runtime });
  const reopened = openOwnedSystemProof(proof.receipt(), { now: f.args.now }); reopened.assertCurrent(); reopened.close();
  fs.writeFileSync(path.join(runtime, 'owner.json'), JSON.stringify({ ...marker, nonce: 'f'.repeat(48) }));
  assert.throws(proof.assertCurrent, { code: 'SYSTEM_PROOF_DENIED' }); proof.close();
});
test('marker replacement, directory replacement, nonce changes and expiration reject stale proof', t => {
  const f = fixture(t), proof = createOwnedSystemProof(f.args), receipt = proof.receipt();
  assert.throws(() => openOwnedSystemProof({ ...receipt, nonce: 'a'.repeat(48) }, { now: f.args.now }), { code: 'SYSTEM_PROOF_DENIED' });
  fs.renameSync(f.args.sessionDataRoot, f.args.sessionDataRoot + '-old'); fs.mkdirSync(f.args.sessionDataRoot, { mode: 0o700 });
  assert.throws(proof.assertCurrent, { code: 'SYSTEM_PROOF_DENIED' });
  fs.rmdirSync(f.args.sessionDataRoot); fs.renameSync(f.args.sessionDataRoot + '-old', f.args.sessionDataRoot);
  const bytes = fs.readFileSync(receipt.file); fs.renameSync(receipt.file, receipt.file + '.old'); fs.writeFileSync(receipt.file, bytes, { mode: 0o600 });
  assert.throws(() => openOwnedSystemProof(receipt, { now: f.args.now }), { code: 'SYSTEM_PROOF_DENIED' });
  fs.unlinkSync(receipt.file); fs.renameSync(receipt.file + '.old', receipt.file);
  f.advance(600001); assert.throws(proof.assertCurrent, { code: 'SYSTEM_PROOF_DENIED' });
});
test('owned monitor starts locked, never resumes on unlock, and cannot outlive proof capability', async t => {
  const f = fixture(t), proof = createOwnedSystemProof(f.args), gate = proof.createLifecycle({ initialState: 'locked' });
  gate.start(); gate.attachHost({ protect: () => ({ stopped: true }), onChange() {} });
  await new Promise(resolve => setImmediate(resolve)); proof.drive(gate, 'unlock-screen', 'active');
  assert.equal(gate.status().locked, true); gate.continue({ expectedGeneration: gate.status().epoch, assertOwner: () => true });
  const before = gate.capture(); proof.close(); assert.equal(before.signal.aborted, true);
});
test('paused-action policy permits exact cleanup and denies starts, reads and authority grants', () => {
  for (const type of ['system.continue', 'system.retry-stop', 'window.close', 'tab.close', 'preview.close', 'permission.media.end', 'agent.revoke', 'service.grant.revoke'])
    assert.equal(systemCleanupAction({ type }), true);
  for (const type of ['navigate', 'workspace.select', 'tab.create', 'agent.approve', 'review.send', 'review.prepare-local', 'voice.begin', 'moments.start', 'portability.export.save', 'storage.usage', 'privacy.resume'])
    assert.equal(systemCleanupAction({ type }), false);
  assert.equal(systemCleanupAction({ type: 'permission.respond', allow: true }), false);
  assert.equal(systemCleanupAction({ type: 'permission.respond', allow: false }), true);
  assert.equal(systemCleanupAction({ type: 'download.control', operation: 'resume' }), false);
  assert.equal(systemCleanupAction({ type: 'shortcuts.recording', active: true }), false);
});
