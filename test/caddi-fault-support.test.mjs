import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessRows, sameProcess, validateOwnedGroup, validateGpuIdentity, readCheckpointAtExit } from './caddi-fault-support.mjs';

const bundlePath = '/fixture/Electron.app', mainExecutable = bundlePath + '/Contents/MacOS/Electron';
const main = { pid: 201, ppid: 100, pgid: 201, uid: 501, started: 'Tue Oct 27 12:00:00 2026', executable: mainExecutable };
const gpu = { pid: 202, ppid: 201, pgid: 201, uid: 501, started: main.started,
  executable: bundlePath + '/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)' };
const owner = { mainPid: 201, uid: 501, bundlePath, mainExecutable };
const metric = { pid: 202, type: 'GPU', creationTime: 1793102400000 };

test('fault process parsing retains spaced bundle names without reading command arguments', () => {
  const row = '  202  201 201 501 Tue Oct 27 12:00:00 2026 ' + gpu.executable + '\n';
  assert.deepEqual(parseProcessRows(row), [gpu]);
  assert.deepEqual(parseProcessRows(''), []);
  assert.throws(() => parseProcessRows('202 201 201 501 unexpected'));
  assert.throws(() => parseProcessRows(row.repeat(65)));
});
test('fault GPU target rejects unrelated owner, reused identity and non-GPU metrics', () => {
  assert.equal(validateGpuIdentity(metric, gpu, owner), true);
  for (const replacement of [{ ppid: 999 }, { pgid: 999 }, { uid: 0 }, { pid: 203 }, { executable: '/user/app' },
    { executable: bundlePath + '-different/Contents/MacOS/Electron' }])
    assert.equal(validateGpuIdentity(metric, { ...gpu, ...replacement }, owner), false);
  for (const replacement of [{ type: 'Tab' }, { pid: main.pid }, { creationTime: NaN }, { creationTime: 0 }])
    assert.equal(validateGpuIdentity({ ...metric, ...replacement }, gpu, owner), false);
  assert.equal(sameProcess(gpu, { ...gpu, ppid: 1 }), true, 'an orphan can retain its exact captured lifetime');
  for (const replacement of [{ started: 'Tue Oct 27 12:01:00 2026' }, { pgid: 999 }, { uid: 0 }, { executable: '/replacement' }, { pid: 203 }])
    assert.equal(sameProcess(gpu, { ...gpu, ...replacement }), false);
  assert.equal(sameProcess(gpu, null), false);
});
test('fault process group requires the exact spawned leader and a closed owned ancestry', () => {
  assert.equal(validateOwnedGroup([main, gpu], owner), true);
  const child = { ...gpu, pid: 203, ppid: 202 };
  assert.equal(validateOwnedGroup([main, gpu, child], owner), true);
  assert.equal(validateOwnedGroup([gpu], owner), false);
  assert.equal(validateOwnedGroup([main, gpu, gpu], owner), false);
  assert.equal(validateOwnedGroup([main, { ...gpu, ppid: 999 }], owner), false);
  assert.equal(validateOwnedGroup([main, { ...gpu, ppid: 203 }, { ...child, ppid: 202 }], owner), false);
  assert.equal(validateOwnedGroup([main, { ...gpu, executable: '/outside/helper' }], owner), false);
  assert.equal(validateOwnedGroup([main, { ...gpu, pgid: 998 }], owner), false);
});
test('fault completion rereads the validated final checkpoint when exit overtakes an older file read', async () => {
  let exited = false, reads = 0;
  const final = { status: 'complete', nonce: 'validated-child-nonce', pid: 201, phase: 'restore' };
  const result = await readCheckpointAtExit({ requested: 'complete', hasExited: () => exited,
    async readState() { if (++reads === 1) { exited = true; return { ...final, status: 'restore-verified' }; } return final; } });
  assert.equal(result, final); assert.equal(reads, 2);
  assert.equal(await readCheckpointAtExit({ requested: 'complete', hasExited: () => false,
    readState: async () => ({ status: 'restore-verified' }) }), null);
});
test('fault final reread preserves failed, incomplete and invalid-identity outcomes', async () => {
  for (const last of [null, { status: 'restore-verified' }, { status: 'failed' }]) {
    let reads = 0;
    await assert.rejects(readCheckpointAtExit({ requested: 'complete', hasExited: () => true,
      readState: async () => ++reads === 1 ? { status: 'restore-verified' } : last }),
    new RegExp(last?.status === 'failed' ? 'FAULT_CHILD_REPORTED_FAILURE' : 'FAULT_CHILD_EARLY_EXIT'));
    assert.equal(reads, 2);
  }
  let reads = 0;
  await assert.rejects(readCheckpointAtExit({ requested: 'complete', hasExited: () => true,
    async readState() { if (++reads === 1) return null; throw new Error('Exact nonce/PID/phase validation failed'); } }), /nonce\/PID\/phase/);
});
