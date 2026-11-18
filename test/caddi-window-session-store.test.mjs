import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWindowSessionStore, planWindowSessionRestore, WINDOW_SESSION_LIMITS } from '../src/caddi/desktop/window-session-store.mjs';

const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const row = (index = 0, bounds = { x: 30, y: 40, width: 1440, height: 940 }) => ({ windowKey: 'window-' + index,
  workspaceId: 'workspace-' + index, identityId: 'identity-' + index, bounds, maximized: false });
const input = (expectedRevision = 0, windows = [row()], focusedWindowKey = windows[0]?.windowKey ?? null) => ({ expectedRevision, windows, focusedWindowKey });
const snapshot = (windows = [row()], focusedWindowKey = windows[0]?.windowKey ?? null) => ({ version: 1, revision: 3, windows, focusedWindowKey });
const screens = [{ id: 1, workArea: { x: 0, y: 24, width: 1728, height: 1057 } }, { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }];
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, overrides = {}) {
  const parent = path.resolve('.test-artifacts'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'caddi-window-session-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'windows'), workspaces = new Map(Array.from({ length: 9 }, (_, index) => {
    const item = row(index); return [item.workspaceId, { id: item.workspaceId, identityId: item.identityId, persistence: 'durable', lifecycle: null }];
  }));
  const lookup = id => workspaces.get(id) ?? null;
  const create = options => createWindowSessionStore({ directory, durableWorkspaceLookup: lookup, ...options });
  const store = create(overrides);
  return { root, directory, workspaces, lookup, create, store };
}

test('eight normal windows round-trip as bounded identity references with private file modes and a previous source', async t => {
  const f = await fixture(t), empty = await f.store.load();
  assert.deepEqual(empty, { version: 1, revision: 0, windows: [], focusedWindowKey: null });
  assert.deepEqual(await fs.readdir(f.directory), []);
  const rows = Array.from({ length: 8 }, (_, index) => row(index));
  const saved = await f.store.save(input(0, rows, 'window-7'));
  assert.equal(saved.revision, 1); saved.windows[0].bounds.x = 8000; rows[1].bounds.y = 8000;
  const restored = await f.create().load(); assert.equal(restored.windows[0].bounds.x, 30); assert.equal(restored.windows[1].bounds.y, 40);
  assert.equal(restored.focusedWindowKey, 'window-7');
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.store.files.primary)).mode & 0o777, 0o600);
  const first = await fs.readFile(f.store.files.primary);
  await f.store.save(input(1, [row(2)])); await f.store.flush();
  assert.deepEqual(await fs.readFile(f.store.files.backup), first);
  assert.equal((await f.store.inspect()).backup.revision, 1);
  const disk = (await fs.readFile(f.store.files.primary)).toString();
  assert.ok(Buffer.byteLength(disk) < WINDOW_SESSION_LIMITS.bytes);
  assert.doesNotMatch(disk, /https?:|cookies|principal|grant|tabId|profilePath|url|title/);
});

test('private, unknown, archived and changed identities cannot enter the save queue', async t => {
  const f = await fixture(t); await f.store.load();
  for (const change of [null, { persistence: 'private' }, { lifecycle: { status: 'archived' } }, { identityId: 'identity-replaced' }, { persistence: undefined }]) {
    const original = { id: 'workspace-0', identityId: 'identity-0', persistence: 'durable', lifecycle: null };
    if (change === null) f.workspaces.delete('workspace-0'); else f.workspaces.set('workspace-0', { ...original, ...change });
    await assert.rejects(f.store.save(input()), code('WINDOW_SESSION_AUTHORITY_CHANGED'));
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
  const asyncStore = createWindowSessionStore({ directory: f.directory, durableWorkspaceLookup: async () => ({ id: 'workspace-0', identityId: 'identity-0', persistence: 'durable' }) });
  await assert.rejects(asyncStore.save(input()), code('WINDOW_SESSION_ASYNC_LOOKUP'));
  const rejectedLookup = createWindowSessionStore({ directory: f.directory, durableWorkspaceLookup: async () => { throw new Error('synthetic unavailable lookup'); } });
  await assert.rejects(rejectedLookup.save(input()), code('WINDOW_SESSION_ASYNC_LOOKUP'));
});

test('unknown page fields, unsafe geometry, duplicate identities, capacity and invalid focus fail without writing', async t => {
  const f = await fixture(t); await f.store.load();
  const invalid = [];
  for (const key of ['url', 'title', 'tabId', 'cookie', 'private', 'grant', 'nativeWindowId']) invalid.push(input(0, [{ ...row(), [key]: 'synthetic-private-sentinel' }]));
  invalid.push(input(0, Array.from({ length: 9 }, (_, index) => row(index))));
  invalid.push(input(0, [row(), { ...row(1), windowKey: 'window-0' }]));
  invalid.push(input(0, [row(), { ...row(1), workspaceId: 'workspace-0' }]));
  invalid.push(input(0, [row(), { ...row(1), identityId: 'identity-0' }]));
  invalid.push(input(0, [row()], 'absent'), input(0, [], 'window-0'));
  for (const bounds of [{ x: NaN, y: 0, width: 1200, height: 800 }, { x: 0, y: 0, width: 0, height: 800 },
    { x: 1000001, y: 0, width: 1200, height: 800 }, { x: 0, y: 0, width: 16385, height: 800 },
    { x: 0, y: 0, width: 1200, height: 800, url: 'synthetic-private-sentinel' }]) invalid.push(input(0, [row(0, bounds)]));
  for (const item of invalid) await assert.rejects(f.store.save(item));
  let called = false; const hostile = row(); Object.defineProperty(hostile, 'url', { enumerable: true, get() { called = true; return 'synthetic-private-sentinel'; } });
  await assert.rejects(f.store.save(input(0, [hostile]))); assert.equal(called, false);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('identity changes after temporary-file sync abort publication and remove the candidate', async t => {
  const f = await fixture(t); await f.store.save(input(0, [row(1)]));
  const original = await fs.readFile(f.store.files.primary), reached = deferred(), release = deferred();
  const store = f.create({ fault: async stage => { if (stage === 'after-temp-sync') { reached.resolve(); await release.promise; } } });
  const pending = store.save(input(1, [row()])); void pending.catch(() => {});
  await reached.promise; f.workspaces.get('workspace-0').persistence = 'private'; release.resolve();
  await assert.rejects(pending, code('WINDOW_SESSION_AUTHORITY_CHANGED'));
  assert.deepEqual(await fs.readFile(store.files.primary), original);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['windows.json', 'windows.previous.json']);
});

test('a queued save rechecks live durability after earlier work settles', async t => {
  const reached = deferred(), release = deferred(); let hold = true;
  const f = await fixture(t, { fault: async stage => { if (stage === 'after-temp-sync' && hold) { hold = false; reached.resolve(); await release.promise; } } });
  const first = f.store.save(input(0, [row(1)])); await reached.promise;
  const later = f.store.save(input(1, [row()])); void later.catch(() => {});
  f.workspaces.get('workspace-0').identityId = 'new-identity'; release.resolve(); await first;
  await assert.rejects(later, code('WINDOW_SESSION_AUTHORITY_CHANGED'));
  assert.deepEqual((await f.create().load()).windows, [row(1)]);
});

test('commit fences cannot be asynchronous and cannot change authority between review and publication', async t => {
  const f = await fixture(t); await f.store.load();
  await assert.rejects(f.store.save(input(), { beforeCommit: async () => true }), code('WINDOW_SESSION_ASYNC_FENCE'));
  await assert.rejects(f.store.save(input(), { beforeCommit: async () => { throw new Error('synthetic invalidated fence'); } }), code('WINDOW_SESSION_ASYNC_FENCE'));
  for (const result of [false, null, 0, 1, 'yes', {}]) {
    await assert.rejects(f.store.save(input(), { beforeCommit: () => result }), code('WINDOW_SESSION_AUTHORITY_CHANGED'));
  }
  await assert.rejects(f.store.save(input(), { beforeCommit: () => { f.workspaces.get('workspace-0').persistence = 'private'; return true; } }), code('WINDOW_SESSION_AUTHORITY_CHANGED'));
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('cooperating writers serialize and reject a stale revision instead of overwriting another layout', async t => {
  const f = await fixture(t), other = f.create();
  const results = await Promise.allSettled([f.store.save(input(0, [row()])), other.save(input(0, [row(1)]))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'WINDOW_SESSION_REVISION_CONFLICT');
  assert.equal((await f.create().load()).revision, 1);
});

test('writer queue and lock waiting are bounded; a stale lock is never stolen', async t => {
  const reached = deferred(), release = deferred(); let hold = true;
  const f = await fixture(t, { fault: async stage => { if (stage === 'after-temp-sync' && hold) { hold = false; reached.resolve(); await release.promise; } } });
  const work = [f.store.save(input())]; await reached.promise;
  for (let index = 1; index < WINDOW_SESSION_LIMITS.pending; index++) work.push(f.store.load());
  await assert.rejects(f.store.load(), code('WINDOW_SESSION_BUSY')); release.resolve(); await Promise.all(work);
  await fs.mkdir(f.store.files.lock, { mode: 0o700 });
  await fs.writeFile(path.join(f.store.files.lock, 'owner.json'), '{"synthetic":"stale-lock"}', { mode: 0o600 });
  await assert.rejects(f.create({ lockTimeoutMs: 20 }).save(input(1)), code('WINDOW_SESSION_LOCKED'));
  assert.equal(await fs.readFile(path.join(f.store.files.lock, 'owner.json'), 'utf8'), '{"synthetic":"stale-lock"}');
});

test('an uncertain rename fences queued writes and requires a fresh store before reuse', async t => {
  const reached = deferred(), release = deferred();
  const f = await fixture(t, { fault: async stage => { if (stage === 'after-primary-rename') { reached.resolve(); await release.promise; throw new Error('synthetic fsync fault'); } } });
  const first = f.store.save(input()); void first.catch(() => {}); await reached.promise;
  const queued = f.store.save(input(1, [row(1)])); void queued.catch(() => {}); release.resolve();
  await assert.rejects(first, code('WINDOW_SESSION_COMMIT_UNKNOWN'));
  await assert.rejects(queued, code('WINDOW_SESSION_REOPEN_REQUIRED'));
  await assert.rejects(f.store.flush(), code('WINDOW_SESSION_REOPEN_REQUIRED'));
  const fresh = await f.create().load(); assert.equal(fresh.revision, 1); assert.deepEqual(fresh.windows, [row()]);
  assert.equal((await f.store.inspect()).reopenRequired, true);
});

test('corrupt and future primary or backup bytes remain exact and cannot be silently reset', async t => {
  for (const mode of ['corrupt-primary', 'future-primary', 'future-backup']) {
    const f = await fixture(t); await f.store.save(input()); await f.store.save(input(1, [row(1)]));
    const file = mode === 'future-backup' ? f.store.files.backup : f.store.files.primary;
    const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    if (mode.startsWith('future')) envelope.payload.version = 9; else envelope.payload.windows[0].bounds.x++;
    const raw = Buffer.from(JSON.stringify(envelope) + '\n'); await fs.writeFile(file, raw, { mode: 0o600 });
    const expected = mode.startsWith('future') ? 'WINDOW_SESSION_UNSUPPORTED_VERSION' : 'WINDOW_SESSION_RECOVERY_REQUIRED';
    await assert.rejects(f.create().load(), code(expected)); await assert.rejects(f.create().save(input(2)), code(expected));
    assert.deepEqual(await fs.readFile(file), raw);
    const report = await f.create().inspect(), source = mode === 'future-backup' ? report.backup : report.primary;
    assert.equal(source.digest, sha(raw)); assert.equal(source.valid, false);
    assert.equal((await fs.readdir(f.directory)).some(name => name.endsWith('.tmp')), false);
  }
});

test('missing primary with a previous snapshot is preserved for review rather than automatically recovered', async t => {
  const f = await fixture(t); await f.store.save(input()); await f.store.save(input(1, [row(1)]));
  const previous = await fs.readFile(f.store.files.backup); await fs.unlink(f.store.files.primary);
  await assert.rejects(f.create().load(), code('WINDOW_SESSION_RECOVERY_REQUIRED'));
  await assert.rejects(f.create().save(input()), code('WINDOW_SESSION_RECOVERY_REQUIRED'));
  assert.deepEqual(await fs.readFile(f.store.files.backup), previous);
  assert.deepEqual(await fs.readdir(f.directory), ['windows.previous.json']);
});

test('symlinks, hard links, public files and oversized files are rejected without changing their bytes', async t => {
  for (const mode of ['symlink', 'hardlink', 'public', 'oversized']) {
    const f = await fixture(t); await f.store.load();
    const outside = path.join(f.root, 'sentinel'), raw = Buffer.from(mode === 'oversized' ? 'x'.repeat(WINDOW_SESSION_LIMITS.bytes + 1) : 'synthetic-retained-source');
    await fs.writeFile(outside, raw, { mode: 0o600 });
    if (mode === 'symlink') await fs.symlink(outside, f.store.files.primary);
    else if (mode === 'hardlink') await fs.link(outside, f.store.files.primary);
    else { await fs.writeFile(f.store.files.primary, raw, { mode: 0o600 }); if (mode === 'public') await fs.chmod(f.store.files.primary, 0o644); }
    await assert.rejects(f.store.load(), code(mode === 'oversized' ? 'WINDOW_SESSION_TOO_LARGE' : 'WINDOW_SESSION_UNSAFE_PATH'));
    assert.deepEqual(await fs.readFile(outside), raw); assert.deepEqual(await fs.readFile(f.store.files.primary), raw);
  }
});

test('restore planning filters retired identities and clamps every normal window on-screen without opening views', async t => {
  const f = await fixture(t), rows = [row(0, { x: 90000, y: -90000, width: 8000, height: 8000 }),
    row(1, { x: -1800, y: 100, width: 1200, height: 800 }), row(2), row(3), row(4), row(5)];
  f.workspaces.get('workspace-2').persistence = 'private'; f.workspaces.get('workspace-3').identityId = 'replacement';
  f.workspaces.get('workspace-4').lifecycle = { status: 'archived' }; f.workspaces.delete('workspace-5');
  const plan = planWindowSessionRestore(snapshot(rows, 'window-2'), { durableWorkspaceLookup: f.lookup, displays: screens });
  assert.equal(plan.windows.length, 2); assert.equal(plan.focusedWindowKey, 'window-0');
  assert.deepEqual(plan.windows[0].bounds, screens[0].workArea); assert.equal(plan.windows[1].displayId, 2);
  assert.equal(plan.windows[0].identityId, 'identity-0'); assert.equal(plan.windows[1].identityId, 'identity-1');
  assert.deepEqual(plan.windows.map(item => item.hydrateOn), ['initial-focus', 'activation']);
  assert.ok(plan.windows.every(item => item.requiresPageAdmission === true));
  assert.deepEqual(plan.skipped.map(item => item.reason), ['NOT_DURABLE', 'IDENTITY_CHANGED', 'WORKSPACE_ARCHIVED', 'WORKSPACE_UNAVAILABLE']);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('small or rearranged displays receive fitting bounds and effective minimum sizes; duplicate restoration identities reject', async t => {
  const f = await fixture(t), displays = [{ id: 6, workArea: { x: -800, y: 70, width: 800, height: 530 } }];
  const plan = planWindowSessionRestore(snapshot(), { durableWorkspaceLookup: f.lookup, displays });
  assert.deepEqual(plan.windows[0].bounds, displays[0].workArea);
  assert.deepEqual(plan.windows[0].minimumSize, { width: 800, height: 530 });
  assert.throws(() => planWindowSessionRestore(snapshot([row(), { ...row(1), identityId: 'identity-0' }]), { durableWorkspaceLookup: f.lookup, displays }), code('WINDOW_SESSION_DUPLICATE'));
  assert.throws(() => planWindowSessionRestore(snapshot(), { durableWorkspaceLookup: f.lookup, displays: [] }), code('WINDOW_SESSION_DISPLAYS'));
  const none = planWindowSessionRestore(snapshot([], null), { durableWorkspaceLookup: f.lookup, displays });
  assert.deepEqual(none.windows, []); assert.equal(none.focusedWindowKey, null);
});

test('load preserves verified source references while restoration rechecks a later durability change', async t => {
  const f = await fixture(t); await f.store.save(input()); const raw = await fs.readFile(f.store.files.primary);
  f.workspaces.get('workspace-0').persistence = 'private';
  const loaded = await f.create().load(), plan = planWindowSessionRestore(loaded, { durableWorkspaceLookup: f.lookup, displays: screens });
  assert.equal(loaded.windows.length, 1); assert.equal(plan.windows.length, 0); assert.equal(plan.focusedWindowKey, null);
  assert.deepEqual(await fs.readFile(f.store.files.primary), raw);
});
