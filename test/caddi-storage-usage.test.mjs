import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWorkspaceStorageMeter, measureProfileAllocation } from '../src/caddi/desktop/storage-usage.mjs';

const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = (workspaceId = 'workspace', overrides = {}) => ({ workspaceId, identityId: 'identity-' + workspaceId,
  storageMode: 'persistent', directory: '/synthetic/owned-profile', getCacheSize: async () => 10, ...overrides });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function root(t) {
  const parent = path.resolve('.test-artifacts'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(parent, 'caddi-storage-usage-'))); await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}

test('bounded native allocation measurement reads no file content and never follows a linked outside directory', async t => {
  const base = await root(t), profile = path.join(base, 'profile'), outside = path.join(base, 'outside');
  await fs.mkdir(profile, { mode: 0o700 }); await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(profile, 'small'), Buffer.alloc(8192, 19), { mode: 0o600 });
  await fs.writeFile(path.join(outside, 'large'), randomBytes(2 * 1024 * 1024), { mode: 0o600 });
  await fs.symlink(outside, path.join(profile, 'linked-outside'));
  const bytes = await measureProfileAllocation(profile);
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && bytes < 512 * 1024);
  const link = path.join(base, 'profile-link'); await fs.symlink(profile, link);
  await assert.rejects(measureProfileAllocation(link), code('STORAGE_PATH_UNAVAILABLE'));
});

test('private and temporary sessions never invoke profile or cache measurement', async () => {
  let reads = 0;
  const meter = createWorkspaceStorageMeter({ measureDisk: async () => { reads++; return 1; } });
  for (const storageMode of ['private', 'ephemeral']) {
    const result = await meter.measure(input('a', { storageMode, directory: null, getCacheSize: async () => { reads++; return 2; } }));
    assert.equal(result.status, 'not-applicable'); assert.equal(result.profileAllocatedBytes, null); assert.equal(result.httpCacheBytes, null);
  }
  assert.equal(reads, 0); meter.close();
});

test('human results contain byte counts and exact identity without paths, filenames or raw backend errors', async () => {
  const meter = createWorkspaceStorageMeter({ measureDisk: async () => 4096, now: () => 7 });
  const result = await meter.measure(input());
  assert.equal(result.status, 'measured'); assert.equal(result.profileAllocatedBytes, 4096); assert.equal(result.httpCacheBytes, 10);
  assert.equal(result.measuredAt, 7); assert.equal(result.identityId, 'identity-workspace');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|owned-profile|getCacheSize|directory/);
  const partial = createWorkspaceStorageMeter({ measureDisk: async () => { throw new Error('/private/path/contains-sensitive-name'); } });
  const failure = await partial.measure(input());
  assert.equal(failure.status, 'partial'); assert.equal(failure.profileAllocatedBytes, null); assert.equal(failure.httpCacheBytes, 10);
  assert.doesNotMatch(JSON.stringify(failure), /sensitive-name|private\/path/); meter.close(); partial.close();
});

test('a changed owner during measurement cannot receive a late result', async () => {
  const held = deferred(); let current = true;
  const meter = createWorkspaceStorageMeter({ measureDisk: () => held.promise });
  const pending = meter.measure(input(), { assertCurrent: () => current });
  const rejected = assert.rejects(pending, code('STORAGE_CONTEXT_CHANGED'));
  await turn(); current = false; held.resolve(512); await rejected;
  assert.equal(meter.inspect().active, 0); meter.close();
});

test('deadlines retain bounded native-read slots until actual completion, without queueing duplicate jobs', async () => {
  const held = deferred(); let diskCalls = 0;
  const meter = createWorkspaceStorageMeter({ timeoutMs: 15, maximumActive: 1, measureDisk: async () => { diskCalls++; return 1024; } });
  const first = await meter.measure(input('a', { getCacheSize: () => held.promise }));
  assert.equal(first.status, 'pending'); assert.equal(meter.inspect().active, 1);
  await assert.rejects(meter.measure(input('a')), code('STORAGE_MEASUREMENT_BUSY'));
  await assert.rejects(meter.measure(input('b')), code('STORAGE_MEASUREMENT_BUSY'));
  assert.equal(diskCalls, 1); held.resolve(25); await turn(); assert.equal(meter.inspect().active, 0);
  assert.equal((await meter.measure(input('b'))).status, 'measured'); meter.close();
});

test('close prevents late publication and asynchronous authority checks start no work', async () => {
  let calls = 0; const meter = createWorkspaceStorageMeter({ measureDisk: async () => { calls++; return 10; } });
  await assert.rejects(meter.measure(input(), { assertCurrent: async () => true }), code('STORAGE_CONTEXT_CHANGED'));
  assert.equal(calls, 0);
  const held = deferred(), pending = meter.measure(input('a', { getCacheSize: () => held.promise }));
  const denied = assert.rejects(pending, error => ['STORAGE_CONTEXT_CHANGED', 'STORAGE_METER_CLOSED'].includes(error.code));
  await turn(); meter.close(); held.resolve(20); await denied;
  await assert.rejects(meter.measure(input()), code('STORAGE_METER_CLOSED'));
});
