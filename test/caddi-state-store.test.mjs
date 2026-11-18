import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductStore, stateDigest } from '../src/caddi/state/store.mjs';
import { readStableSnapshot } from '../src/caddi/state/snapshot-io.mjs';
import { STATE_LIMITS } from '../src/caddi/state/model.mjs';

const base = fileURLToPath(new URL('../.test-artifacts/', import.meta.url));
const moduleURL = new URL('../src/caddi/state/store.mjs', import.meta.url).href;
const code = expected => error => error?.code === expected;
const command = id => ({ type: 'project.create', id, name: 'Project ' + id });
async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'caddi-state-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'store');
  return { root, directory, store: createProductStore({ directory, ...options }) };
}
function child(script, args) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  process.stdout.on('data', chunk => { output += chunk; if (output.includes('READY\n')) readyResolve(); });
  process.stderr.on('data', chunk => { errors += chunk; });
  const done = once(process, 'close').then(([exitCode]) => ({ exitCode, output, errors }));
  return { process, ready, done };
}

test('atomic metadata survives a new store instance and returned snapshots cannot mutate disk', async t => {
  const { store, directory } = await fixture(t);
  assert.equal((await store.load()).revision, 0);
  const result = await store.transact({ expectedRevision: 0, command: command('one') });
  result.state.projects[0].name = 'Mutated return';
  const restored = await createProductStore({ directory }).load();
  assert.equal(restored.projects[0].name, 'Project one');
  assert.equal(restored.revision, 1);
  const info = await fs.stat(store.files.primary);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});

test('same-instance and separate-instance writers use revision CAS', async t => {
  const { store, directory } = await fixture(t);
  const second = createProductStore({ directory });
  const results = await Promise.allSettled([
    store.transact({ expectedRevision: 0, command: command('one') }),
    second.transact({ expectedRevision: 0, command: command('two') }),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const next = await store.load();
  const result = await store.transact({ expectedRevision: next.revision, command: command('three') });
  assert.equal(result.revision, 2);
});

test('two actual Node processes serialize commits and only one wins the same revision', async t => {
  const { directory, store } = await fixture(t);
  const script = 'import {createProductStore} from ' + JSON.stringify(moduleURL) + ';' +
    'const store=createProductStore({directory:process.argv[1]}); await store.load(); process.stdout.write("READY\\n");' +
    'await new Promise(r=>process.stdin.once("data",r)); try {await store.transact({expectedRevision:0,command:{type:"project.create",id:process.argv[2],name:"Project"}}); console.log("RESULT:OK");}' +
    'catch(e){console.log("RESULT:"+e.code)} process.stdin.destroy();';
  const a = child(script, [directory, 'a']), b = child(script, [directory, 'b']);
  t.after(() => { a.process.kill(); b.process.kill(); });
  await Promise.all([a.ready, b.ready]); a.process.stdin.end('GO'); b.process.stdin.end('GO');
  const results = await Promise.all([a.done, b.done]);
  assert.ok(results.every(item => item.exitCode === 0), JSON.stringify(results));
  assert.equal(results.filter(item => item.output.includes('RESULT:OK')).length, 1);
  assert.equal(results.filter(item => item.output.includes('RESULT:REVISION_CONFLICT')).length, 1);
  assert.equal((await store.load()).projects.length, 1);
});

test('faults before primary rename preserve the last committed revision and clean own temporaries', async t => {
  for (const stage of ['after-backup', 'after-temp-sync']) {
    const { store, directory } = await fixture(t);
    await store.transact({ expectedRevision: 0, command: command('baseline') });
    const faulty = createProductStore({ directory, fault: current => { if (current === stage) throw new Error('injected'); } });
    await assert.rejects(faulty.transact({ expectedRevision: 1, command: command('next') }), /injected/);
    const state = await store.load();
    assert.equal(state.revision, 1);
    assert.equal(state.projects.length, 1);
    assert.ok((await fs.readdir(directory)).every(name => !name.startsWith('state-tmp-')));
  }
});

test('after-rename errors report uncertain outcome and reload proves whether commit landed', async t => {
  const { store, directory } = await fixture(t);
  await store.transact({ expectedRevision: 0, command: command('baseline') });
  const faulty = createProductStore({ directory, fault: stage => { if (stage === 'after-primary-rename') throw new Error('injected'); } });
  await assert.rejects(faulty.transact({ expectedRevision: 1, command: command('next') }), code('COMMIT_OUTCOME_UNKNOWN'));
  assert.equal((await store.load()).revision, 2);
  await assert.rejects(store.transact({ expectedRevision: 1, command: command('duplicate') }), code('REVISION_CONFLICT'));
});

test('real process death on both sides of rename leaves an atomic snapshot and a fail-closed abandoned lock', async t => {
  for (const stage of ['after-temp-sync', 'after-primary-rename']) {
    const { store, directory } = await fixture(t, { lockTimeoutMs: 30 });
    await store.transact({ expectedRevision: 0, command: command('baseline') });
    const script = 'import {createProductStore} from ' + JSON.stringify(moduleURL) + ';' +
      'const store=createProductStore({directory:process.argv[1],fault:stage=>{if(stage===process.argv[2])process.exit(77)}});' +
      'await store.transact({expectedRevision:1,command:{type:"project.create",id:"crash",name:"Crash"}});';
    const run = child(script, [directory, stage]);
    const result = await run.done;
    assert.equal(result.exitCode, 77, result.errors);
    await assert.rejects(store.load(), code('STORE_LOCKED'));
    // Explicit test-operator recovery only after observing the owner process exit.
    await fs.rm(store.files.lock, { recursive: true });
    const restored = await store.load();
    assert.equal(restored.revision, stage === 'after-primary-rename' ? 2 : 1);
    assert.equal(restored.projects.length, restored.revision);
  }
});

test('corrupt primary is preserved and requires an exact explicit backup-recovery decision', async t => {
  const { store, directory } = await fixture(t);
  await store.transact({ expectedRevision: 0, command: command('baseline') });
  await store.transact({ expectedRevision: 1, command: command('next') });
  const damaged = Buffer.from('{"unfinished":');
  await fs.writeFile(store.files.primary, damaged);
  await assert.rejects(store.load(), code('RECOVERY_REQUIRED'));
  const inspected = await store.inspect();
  assert.equal(inspected.primary.valid, false);
  assert.equal(inspected.backup.revision, 1);
  await assert.rejects(store.recoverFromBackup({ expectedPrimaryDigest: 'a'.repeat(64) }), code('RECOVERY_CONFLICT'));
  const recovered = await store.recoverFromBackup({ expectedPrimaryDigest: inspected.primary.digest });
  assert.deepEqual(await fs.readFile(path.join(directory, recovered.preservedFile)), damaged);
  assert.equal(recovered.recoveredFromRevision, 1);
  assert.equal((await store.load()).projects[0].id, 'baseline');
});

test('recovery refuses a backup changed after review and preserves both current files', async t => {
  const { store, directory } = await fixture(t);
  await store.transact({ expectedRevision: 0, command: command('baseline') });
  await store.transact({ expectedRevision: 1, command: command('next') });
  const replacementBackup = await fs.readFile(store.files.primary);
  const damagedPrimary = Buffer.from('{"unfinished":');
  await fs.writeFile(store.files.primary, damagedPrimary);
  const reviewed = await store.inspect();
  assert.equal(reviewed.backup.revision, 1);
  await fs.writeFile(store.files.backup, replacementBackup);
  const filesBefore = await fs.readdir(directory);
  await assert.rejects(store.recoverFromBackup({
    expectedPrimaryDigest: reviewed.primary.digest,
    expectedBackupDigest: reviewed.backup.digest,
  }), code('RECOVERY_CONFLICT'));
  assert.deepEqual(await fs.readFile(store.files.primary), damagedPrimary);
  assert.deepEqual(await fs.readFile(store.files.backup), replacementBackup);
  assert.deepEqual(await fs.readdir(directory), filesBefore);
});

test('future schema, noncanonical JSON, checksum mutation and oversized snapshots never reset to empty state', async t => {
  const { store } = await fixture(t);
  await store.transact({ expectedRevision: 0, command: command('baseline') });
  const original = await fs.readFile(store.files.primary);
  await fs.writeFile(store.files.primary, JSON.stringify({ schemaVersion: 2 }));
  await assert.rejects(store.load(), code('UNSUPPORTED_SCHEMA'));
  await assert.rejects(store.recoverFromBackup({ expectedPrimaryDigest: null }), code('UNSUPPORTED_SCHEMA'));
  assert.equal(JSON.parse(await fs.readFile(store.files.primary)).schemaVersion, 2);
  for (const content of [JSON.stringify(JSON.parse(original), null, 2), original.toString().replace('Project baseline', 'Project tampered'), '{}']) {
    await fs.writeFile(store.files.primary, content);
    await assert.rejects(store.load(), code('RECOVERY_REQUIRED'));
  }
  await fs.writeFile(store.files.primary, Buffer.alloc(STATE_LIMITS.bytes + 8193));
  await assert.rejects(store.load(), code('STORE_TOO_LARGE'));
});

test('symlink, hardlink, nonprivate directory and aliased parent store paths are rejected', async t => {
  const { store, root, directory } = await fixture(t);
  await store.transact({ expectedRevision: 0, command: command('baseline') });
  const preserved = path.join(root, 'preserved');
  await fs.rename(store.files.primary, preserved);
  await fs.symlink(preserved, store.files.primary);
  await assert.rejects(store.load(), code('UNSAFE_STORE_PATH'));
  await fs.unlink(store.files.primary);
  await fs.link(preserved, store.files.primary);
  await assert.rejects(store.load(), code('UNSAFE_STORE_PATH'));
  await fs.unlink(store.files.primary);
  await fs.rename(preserved, store.files.primary);
  await fs.chmod(directory, 0o755);
  await assert.rejects(store.load(), code('UNSAFE_STORE_PATH'));
  await fs.chmod(directory, 0o700);
  await fs.symlink(directory, path.join(root, 'alias'));
  const alias = createProductStore({ directory: path.join(root, 'alias', 'nested') });
  await assert.rejects(alias.load(), code('UNSAFE_STORE_PATH'));
});

test('commit fence runs after staging, so revoked metadata authority cannot rename the primary', async t => {
  const { store, directory } = await fixture(t);
  await store.transact({ expectedRevision: 0, command: command('baseline') });
  let authority = true, seen = 0;
  const guarded = createProductStore({ directory, fault: stage => { if (stage === 'after-temp-sync') authority = false; } });
  await assert.rejects(guarded.transact({ expectedRevision: 1, command: command('forbidden') }, { beforeCommit() { seen++; return authority; } }), code('FORBIDDEN'));
  assert.equal(seen, 1);
  assert.equal((await store.load()).revision, 1);
  await assert.rejects(guarded.transact({ expectedRevision: 1, command: command('async') }, { beforeCommit: async () => true }), code('ASYNC_AUTHORIZATION_FENCE'));
});

test('metadata publication stays in the same turn as the final privacy fence', async t => {
  const { directory } = await fixture(t);
  let revoked = false, observedAtPublication;
  const store = createProductStore({ directory, fault: stage => {
    if (stage === 'after-primary-rename') observedAtPublication = revoked;
  } });
  await store.transact({ expectedRevision: 0, command: command('public') }, { beforeCommit() {
    queueMicrotask(() => { revoked = true; });
    return !revoked;
  } });
  assert.equal(observedAtPublication, false);
  assert.equal(revoked, true);
});

test('rollback is pinned to both current revision and previous contents and advances revision', async t => {
  const { store } = await fixture(t);
  const first = await store.transact({ expectedRevision: 0, command: command('one') });
  const second = await store.transact({ expectedRevision: 1, command: command('two') });
  await assert.rejects(store.rollback(first.rollback), code('REVISION_CONFLICT'));
  await assert.rejects(store.rollback({ ...second.rollback, expectedPreviousDigest: 'a'.repeat(64) }), code('REVISION_CONFLICT'));
  const rolled = await store.rollback(second.rollback);
  assert.equal(rolled.revision, 3);
  assert.deepEqual(rolled.state.projects, first.state.projects);
  assert.equal(stateDigest(rolled.state), rolled.digest);
});

test('ambiguous lock is never deleted by timeout', async t => {
  const { store } = await fixture(t, { lockTimeoutMs: 25 });
  await store.load();
  await fs.mkdir(store.files.lock, { mode: 0o700 });
  await fs.writeFile(path.join(store.files.lock, 'owner.json'), '{"pid":1,"token":"unknown"}');
  await assert.rejects(store.load(), code('STORE_LOCKED'));
  assert.equal((await fs.stat(store.files.lock)).isDirectory(), true);
});

function syntheticStatIO(change) {
  const bytes = Buffer.from('synthetic snapshot bytes');
  let pathStats = 0, opens = 0, closes = 0, ctime = 10n;
  const make = () => ({ dev: 1n, ino: 2n, size: BigInt(bytes.length), mtimeNs: 3n, ctimeNs: ctime,
    mode: 0o100600n, nlink: 1n, uid: 100n, gid: 100n, isFile: () => true, isSymbolicLink: () => false });
  const io = {
    async lstat() {
      const stage = ++pathStats, patch = change(stage) ?? {};
      if (patch.ctimeNs !== undefined) ctime = patch.ctimeNs;
      return { ...make(), ...patch };
    },
    async open() {
      opens++; let offset = 0;
      return {
        async stat() { return make(); },
        async read(buffer, start, length) {
          const count = Math.min(length, bytes.length - offset);
          bytes.copy(buffer, start, offset, offset + count); offset += count; return { bytesRead: count };
        },
        async close() { closes++; },
      };
    },
  };
  return { io, bytes, counters: () => ({ opens, closes, pathStats }) };
}

test('a ctime-only transition retries the entire read and accepts only a fully stable attempt', async () => {
  const fixture = syntheticStatIO(stage => stage === 2 ? { ctimeNs: 11n } : {});
  const result = await readStableSnapshot('synthetic-test-path', { io: fixture.io });
  assert.deepEqual(result, fixture.bytes);
  assert.deepEqual(fixture.counters(), { opens: 2, closes: 2, pathStats: 4 });
});

test('continued ctime churn fails closed after exactly two whole-read retries', async () => {
  const fixture = syntheticStatIO(stage => stage % 2 === 0 ? { ctimeNs: 10n + BigInt(stage) } : {});
  await assert.rejects(readStableSnapshot('synthetic-test-path', { io: fixture.io }), error => error.code === 'STATE_CHANGED_DURING_READ' && Object.keys(error.statChanges).join() === 'ctimeNs');
  assert.equal(fixture.counters().opens, 3);
  assert.equal(fixture.counters().closes, 3);
});

test('inode, size, mtime, mode, links and ownership changes never use the ctime retry allowance', async () => {
  for (const [field, value] of Object.entries({ dev: 9n, ino: 9n, size: 999n, mtimeNs: 9n, mode: 0o100644n, nlink: 2n, uid: 9n, gid: 9n })) {
    const fixture = syntheticStatIO(stage => stage === 2 ? { [field]: value } : {});
    await assert.rejects(readStableSnapshot('synthetic-test-path', { io: fixture.io }), code('STATE_CHANGED_DURING_READ'));
    assert.equal(fixture.counters().opens, 1, field);
    assert.equal(fixture.counters().closes, 1, field);
  }
});

test('a replacement inode between ctime retries is rejected before opening the replacement', async () => {
  const fixture = syntheticStatIO(stage => stage === 2 ? { ctimeNs: 11n } : stage === 3 ? { ino: 99n } : {});
  await assert.rejects(readStableSnapshot('synthetic-test-path', { io: fixture.io }), error => error.code === 'STATE_CHANGED_DURING_READ' && Object.hasOwn(error.statChanges, 'ino'));
  assert.equal(fixture.counters().opens, 1);
});
