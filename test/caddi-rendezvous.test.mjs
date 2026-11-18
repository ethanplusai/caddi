import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createEnrollmentServer } from '../src/caddi/desktop/enrollment.mjs';
import { publishDesktopRendezvous, resolveDesktopRendezvous, assertDesktopRendezvousPublication } from '../src/caddi/access/rendezvous.mjs';

const options = { timeout: 7000, skip: process.platform !== 'darwin' ? 'macOS native process inspection is required' : false };
const code = expected => error => error.code === expected;
async function fixture(t) {
  const base = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(base, 'rv-'));
  await fsp.chmod(directory, 0o700);
  const descriptorPath = path.join(directory, 'runtime.json'), receipts = [], servers = [];
  t.after(async () => {
    for (const server of [...servers].reverse()) await server.close();
    for (const receipt of receipts) receipt.close();
    await fsp.rm(directory, { recursive: true, force: true });
  });
  async function server(name = 'e.sock') {
    const value = await createEnrollmentServer({ socketPath: path.join(directory, name) }); servers.push(value); return value;
  }
  async function publish(enrollment, assertOwner = () => true) {
    const receipt = await publishDesktopRendezvous({ descriptorPath, enrollmentSocket: enrollment.socketPath, runtimeId: enrollment.runtimeId, assertOwner });
    receipts.push(receipt); return receipt;
  }
  function put(value) {
    const temporary = path.join(directory, 'fixture-replacement.json');
    fs.writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, descriptorPath);
  }
  return { directory, descriptorPath, server, publish, put, read: () => JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) };
}

test('private locator resolves the actual native process/socket without storing authentication', options, async t => {
  const f = await fixture(t), enrollment = await f.server();
  let owner = true;
  const publication = await f.publish(enrollment, () => owner);
  const value = f.read(), raw = fs.readFileSync(f.descriptorPath, 'utf8');
  assert.deepEqual(Object.keys(value).sort(), ['enrollment', 'format', 'process', 'publishedAt', 'runtimeId', 'version']);
  assert.equal(value.process.pid, process.pid); assert.equal(value.process.uid, process.getuid());
  assert.equal(value.runtimeId, enrollment.runtimeId);
  assert.equal(fs.statSync(f.descriptorPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.descriptorPath).nlink, 1);
  assert.doesNotMatch(raw, /credential|principalId|agentSessionId|workspaceId|grantId|secret/);
  const locator = await resolveDesktopRendezvous({ descriptorPath: f.descriptorPath });
  assert.equal(locator.socketPath, enrollment.socketPath); assert.equal(locator.runtimeId, enrollment.runtimeId);
  assert.equal(await locator.assertCurrent(), true);
  assert.deepEqual(assertDesktopRendezvousPublication(publication), { descriptorPath: f.descriptorPath, runtimeId: enrollment.runtimeId });
  assert.throws(() => assertDesktopRendezvousPublication({ ...publication }), code('RENDEZVOUS_PUBLICATION_REQUIRED'));
  owner = false;
  assert.throws(() => assertDesktopRendezvousPublication(publication), code('RENDEZVOUS_OWNER_STALE'));
  await enrollment.close();
  assert.deepEqual(publication.close(), { removed: true });
  assert.deepEqual(publication.close(), { removed: false });
  assert.throws(() => assertDesktopRendezvousPublication(publication), code('RENDEZVOUS_CLOSED'));
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), code('RENDEZVOUS_NOT_RUNNING'));
});

test('live owner and concurrent publication cannot overwrite the current descriptor', options, async t => {
  const f = await fixture(t), enrollment = await f.server();
  const first = f.publish(enrollment);
  await assert.rejects(f.publish(enrollment), code('RENDEZVOUS_BUSY'));
  await first;
  const bytes = fs.readFileSync(f.descriptorPath), inode = fs.statSync(f.descriptorPath).ino;
  const other = await f.server('next.sock');
  await assert.rejects(f.publish(other), code('RENDEZVOUS_LIVE'));
  assert.deepEqual(fs.readFileSync(f.descriptorPath), bytes); assert.equal(fs.statSync(f.descriptorPath).ino, inode);
});

test('valid stale process tuple can be replaced without deleting its socket or old owner successor', options, async t => {
  const f = await fixture(t), firstServer = await f.server(), first = await f.publish(firstServer);
  const stale = f.read(); stale.process.started = 'Mon Jan 1 00:00:00 2001'; f.put(stale);
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), code('RENDEZVOUS_NOT_RUNNING'));
  const secondServer = await f.server('next.sock'), next = await f.publish(secondServer);
  const bytes = fs.readFileSync(f.descriptorPath);
  assert.equal(f.read().runtimeId, secondServer.runtimeId);
  assert.ok(fs.lstatSync(firstServer.socketPath).isSocket());
  assert.deepEqual(first.close(), { removed: false });
  assert.deepEqual(fs.readFileSync(f.descriptorPath), bytes);
  assert.equal(assertDesktopRendezvousPublication(next).runtimeId, secondServer.runtimeId);
});

test('malformed future oversized and unexpectedly permissive descriptors are preserved exactly', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), publication = await f.publish(enrollment);
  const valid = f.read(); publication.close();
  for (const value of ['{broken', { ...valid, version: 2 }, { ...valid, credential: 'never-accepted' }, 'x'.repeat(4097), { ...valid, process: { ...valid.process, uid: process.getuid() + 1 } }]) {
    f.put(value);
    const bytes = fs.readFileSync(f.descriptorPath), inode = fs.statSync(f.descriptorPath).ino;
    await assert.rejects(f.publish(enrollment), error => /^RENDEZVOUS_/.test(error.code));
    await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), error => /^RENDEZVOUS_/.test(error.code));
    assert.deepEqual(fs.readFileSync(f.descriptorPath), bytes); assert.equal(fs.statSync(f.descriptorPath).ino, inode);
  }
  f.put(valid); fs.chmodSync(f.descriptorPath, 0o644);
  await assert.rejects(f.publish(enrollment), code('RENDEZVOUS_FILE_INVALID'));
  assert.equal(fs.statSync(f.descriptorPath).mode & 0o777, 0o644);
});

test('symlink hardlink and non-private parent are rejected without deleting foreign paths', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), receipt = await f.publish(enrollment);
  const bytes = fs.readFileSync(f.descriptorPath); receipt.close();
  const target = path.join(f.directory, 'foreign.json'); fs.writeFileSync(target, bytes, { mode: 0o600 });
  fs.symlinkSync(target, f.descriptorPath);
  await assert.rejects(f.publish(enrollment), code('RENDEZVOUS_FILE_INVALID'));
  assert.ok(fs.lstatSync(f.descriptorPath).isSymbolicLink()); assert.deepEqual(fs.readFileSync(target), bytes);
  fs.unlinkSync(f.descriptorPath); fs.linkSync(target, f.descriptorPath);
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), code('RENDEZVOUS_FILE_INVALID'));
  assert.equal(fs.statSync(target).nlink, 2);
  fs.unlinkSync(f.descriptorPath); f.put(JSON.parse(bytes)); fs.chmodSync(f.directory, 0o750);
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), code('RENDEZVOUS_PRIVATE_PATH'));
  fs.chmodSync(f.directory, 0o700);
  const alias = path.join(f.directory, 'alias'); fs.symlinkSync(f.directory, alias);
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: path.join(alias, 'runtime.json') }), code('RENDEZVOUS_PRIVATE_PATH'));
});

test('byte-identical replacement invalidates old receipts and exact-owner cleanup', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), receipt = await f.publish(enrollment);
  const locator = await resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), bytes = fs.readFileSync(f.descriptorPath, 'utf8');
  f.put(bytes);
  await assert.rejects(locator.assertCurrent(), code('RENDEZVOUS_CHANGED'));
  assert.throws(() => assertDesktopRendezvousPublication(receipt), code('RENDEZVOUS_CHANGED'));
  assert.deepEqual(receipt.close(), { removed: false });
  assert.equal(fs.readFileSync(f.descriptorPath, 'utf8'), bytes);
});

test('ctime-only drift on the same private inode and bytes preserves lookup and exact cleanup', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), receipt = await f.publish(enrollment);
  const locator = await resolveDesktopRendezvous({ descriptorPath: f.descriptorPath });
  const before = fs.statSync(f.descriptorPath, { bigint: true }), bytes = fs.readFileSync(f.descriptorPath);
  // Reproduce metadata-only ctime drift deliberately; the external cause of the
  // observed Electron proof drift is unknown and is not inferred by this test.
  fs.chmodSync(f.descriptorPath, 0o400); fs.chmodSync(f.descriptorPath, 0o600);
  const after = fs.statSync(f.descriptorPath, { bigint: true });
  assert.notEqual(after.ctimeNs, before.ctimeNs); assert.equal(after.mtimeNs, before.mtimeNs);
  for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size']) assert.equal(after[key], before[key]);
  assert.deepEqual(fs.readFileSync(f.descriptorPath), bytes);
  assert.equal(await locator.assertCurrent(), true);
  assert.equal(assertDesktopRendezvousPublication(receipt).runtimeId, enrollment.runtimeId);
  await enrollment.close(); assert.deepEqual(receipt.close(), { removed: true });
});

test('changed content on the same inode remains stale even when byte length is unchanged', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), receipt = await f.publish(enrollment);
  const locator = await resolveDesktopRendezvous({ descriptorPath: f.descriptorPath });
  const before = fs.statSync(f.descriptorPath, { bigint: true }), value = f.read(); value.runtimeId = randomUUID();
  const bytes = Buffer.from(JSON.stringify(value) + '\n'); assert.equal(bytes.length, Number(before.size));
  fs.writeFileSync(f.descriptorPath, bytes, { flag: 'r+' });
  assert.equal(fs.statSync(f.descriptorPath, { bigint: true }).ino, before.ino);
  await assert.rejects(locator.assertCurrent(), code('RENDEZVOUS_CHANGED'));
  assert.throws(() => assertDesktopRendezvousPublication(receipt), code('RENDEZVOUS_CHANGED'));
  assert.deepEqual(receipt.close(), { removed: false }); assert.deepEqual(fs.readFileSync(f.descriptorPath), bytes);
});

test('socket replacement invalidates a locator even when process and descriptor remain unchanged', options, async t => {
  const f = await fixture(t), enrollment = await f.server(); await f.publish(enrollment);
  const locator = await resolveDesktopRendezvous({ descriptorPath: f.descriptorPath });
  const previous = fs.lstatSync(enrollment.socketPath, { bigint: true }).ino;
  fs.renameSync(enrollment.socketPath, path.join(f.directory, 'retained.sock'));
  await f.server();
  // The previous bound socket inode remains allocated at the retained owned path.
  assert.notEqual(fs.lstatSync(enrollment.socketPath, { bigint: true }).ino, previous);
  await assert.rejects(locator.assertCurrent(), code('RENDEZVOUS_CHANGED'));
});

test('strict synchronous owner fence denies malformed and asynchronous authority without publication', options, async t => {
  const f = await fixture(t), enrollment = await f.server();
  for (const callback of [() => false, () => null, () => 0, () => ({}), () => Promise.resolve(true), () => Promise.reject(new Error('sensitive callback detail'))]) {
    await assert.rejects(f.publish(enrollment, callback), code('RENDEZVOUS_OWNER_STALE'));
    assert.equal(fs.existsSync(f.descriptorPath), false);
  }
  await assert.rejects(f.publish(enrollment, () => { throw new Error('sensitive callback detail'); }), error => {
    assert.doesNotMatch(error.message, /sensitive/); return error.code === 'RENDEZVOUS_OWNER_STALE';
  });
});

test('owner loss before commit preserves stale bytes and removes only its temporary file', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), receipt = await f.publish(enrollment);
  const stale = f.read(); stale.process.started = 'Mon Jan 1 00:00:00 2001'; f.put(stale); receipt.close();
  const original = fs.readFileSync(f.descriptorPath); let checks = 0;
  await assert.rejects(f.publish(enrollment, () => ++checks < 3), code('RENDEZVOUS_OWNER_STALE'));
  assert.deepEqual(fs.readFileSync(f.descriptorPath), original);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
});

test('post-publication owner loss removes only the exact new advertisement', options, async t => {
  const f = await fixture(t), enrollment = await f.server(); let checks = 0;
  await assert.rejects(f.publish(enrollment, () => ++checks < 4), code('RENDEZVOUS_OWNER_STALE'));
  assert.equal(fs.existsSync(f.descriptorPath), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
});

test('owner callback replacement during publication is preserved by the final compare-and-swap fence', options, async t => {
  const f = await fixture(t), enrollment = await f.server(), receipt = await f.publish(enrollment);
  const stale = f.read(); stale.process.started = 'Mon Jan 1 00:00:00 2001'; f.put(stale); receipt.close();
  const replacement = { ...stale, runtimeId: randomUUID() }; let checks = 0;
  await assert.rejects(f.publish(enrollment, () => { if (++checks === 3) f.put(replacement); return true; }), code('RENDEZVOUS_CHANGED'));
  assert.deepEqual(f.read(), replacement);
});

test('descriptor absence, pre-abort and unsafe path do not fall back to scanning or connecting', options, async t => {
  const f = await fixture(t), signal = AbortSignal.abort();
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }), code('RENDEZVOUS_NOT_RUNNING'));
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: f.descriptorPath, signal }), code('CANCELLED'));
  await assert.rejects(resolveDesktopRendezvous({ descriptorPath: 'runtime.json' }), code('RENDEZVOUS_PATH_INVALID'));
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('concurrent locator reads have bounded native probes and all cancelled reads withhold endpoints', options, async t => {
  const f = await fixture(t), enrollment = await f.server(); await f.publish(enrollment);
  const controller = new AbortController();
  const calls = Array.from({ length: 8 }, () => resolveDesktopRendezvous({ descriptorPath: f.descriptorPath, signal: controller.signal }));
  controller.abort();
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 0);
  assert.equal(results.filter(value => value.reason?.code === 'RENDEZVOUS_BUSY').length, 4);
  assert.equal(results.filter(value => value.reason?.code === 'CANCELLED').length, 4);
});
