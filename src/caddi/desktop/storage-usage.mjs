import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CaddiError, assertId, assertInteger, assertKeys } from '../contracts.mjs';

const runFile = promisify(execFile);
const fail = code => { throw new CaddiError(code, 'Workspace storage measurement is unavailable'); };
const byteCount = value => Number.isSafeInteger(value) && value >= 0;
function fence(assertCurrent) {
  const result = assertCurrent();
  if (result && typeof result.then === 'function') { if (result instanceof Promise) void result.catch(() => {}); fail('STORAGE_CONTEXT_CHANGED'); }
  if (result !== true && result !== undefined) fail('STORAGE_CONTEXT_CHANGED');
}
async function ownedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory ||
      directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory)) fail('STORAGE_PATH_UNAVAILABLE');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) fail('STORAGE_PATH_UNAVAILABLE');
  return { dev: stat.dev, ino: stat.ino };
}

/** Counts allocated blocks in an already-owned normal profile, never file contents.
 * The fixed du invocation does not follow symbolic links. No path is returned. */
export async function measureProfileAllocation(directory, { signal, beforeRead = () => true } = {}) {
  fence(beforeRead); const before = await ownedDirectory(directory); fence(beforeRead);
  if (signal?.aborted) fail('STORAGE_MEASUREMENT_CANCELLED');
  let output;
  try { output = await runFile('/usr/bin/du', ['-skP', '--', directory], { encoding: 'utf8',
    timeout: 2500, maxBuffer: 16384, killSignal: 'SIGTERM', signal }); }
  catch { fail('STORAGE_MEASUREMENT_INCOMPLETE'); }
  const after = await ownedDirectory(directory); fence(beforeRead);
  if (before.dev !== after.dev || before.ino !== after.ino || signal?.aborted) fail('STORAGE_CONTEXT_CHANGED');
  const match = /^([0-9]+)\s/.exec(output.stdout);
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  if (!byteCount(bytes)) fail('STORAGE_MEASUREMENT_INCOMPLETE');
  return bytes;
}

/** Main-only meter. Native reads that outlive a deadline keep their bounded slot
 * until they actually settle; timed-out reads cannot publish into a later scope. */
export function createWorkspaceStorageMeter({ measureDisk = measureProfileAllocation, timeoutMs = 2500, maximumActive = 2, now = Date.now } = {}) {
  if (typeof measureDisk !== 'function' || typeof now !== 'function') fail('INVALID_ARGUMENT');
  assertInteger(timeoutMs, 'measurement timeout', { min: 10, max: 3000 });
  assertInteger(maximumActive, 'measurement capacity', { min: 1, max: 2 });
  const active = new Map(); let closed = false;
  async function measure(input, { assertCurrent = () => true } = {}) {
    assertKeys(input, ['workspaceId', 'identityId', 'storageMode', 'directory', 'getCacheSize'],
      ['workspaceId', 'identityId', 'storageMode', 'directory', 'getCacheSize']);
    const { workspaceId, identityId, storageMode, directory, getCacheSize } = input;
    assertId(workspaceId); assertId(identityId);
    if (typeof assertCurrent !== 'function' || typeof getCacheSize !== 'function' || !['persistent', 'ephemeral', 'private'].includes(storageMode)) fail('INVALID_ARGUMENT');
    if (closed) fail('STORAGE_METER_CLOSED'); fence(assertCurrent);
    const base = () => ({ workspaceId, identityId, measuredAt: now(), profileAllocatedBytes: null, httpCacheBytes: null,
      measurement: 'Allocated profile estimate and HTTP cache bytes overlap; do not add them.' });
    if (storageMode !== 'persistent') return { ...base(), status: 'not-applicable', reason: storageMode === 'private' ? 'PRIVATE_SESSION' : 'TEMPORARY_SESSION' };
    if (active.has(workspaceId) || active.size >= maximumActive) fail('STORAGE_MEASUREMENT_BUSY');
    const controller = new AbortController(), entry = { controller }; active.set(workspaceId, entry);
    let timer, timedOut = false;
    const current = () => {
      if (closed || active.get(workspaceId) !== entry || controller.signal.aborted) fail('STORAGE_CONTEXT_CHANGED');
      fence(assertCurrent); return true;
    };
    const work = Promise.allSettled([
      Promise.resolve().then(() => { current(); return measureDisk(directory, { signal: controller.signal, beforeRead: current }); }),
      Promise.resolve().then(() => { current(); return getCacheSize(); }),
    ]);
    const completed = work.then(results => {
      if (timedOut) return null;
      current();
      const values = results.map(result => result.status === 'fulfilled' && byteCount(result.value) ? result.value : null);
      return { ...base(), status: values.every(value => value !== null) ? 'measured' : 'partial',
        reason: values.every(value => value !== null) ? null : 'STORAGE_MEASUREMENT_INCOMPLETE',
        profileAllocatedBytes: values[0], httpCacheBytes: values[1] };
    }).finally(() => { if (active.get(workspaceId) === entry) active.delete(workspaceId); });
    void completed.catch(() => {});
    const deadline = new Promise(resolve => { timer = setTimeout(() => {
      timedOut = true; controller.abort();
      resolve({ ...base(), status: 'pending', reason: 'STORAGE_MEASUREMENT_PENDING' });
    }, timeoutMs); });
    try {
      const result = await Promise.race([completed, deadline]);
      if (closed) fail('STORAGE_METER_CLOSED'); fence(assertCurrent);
      return result;
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({ measure,
    inspect: () => ({ active: active.size, maximumActive, closed }),
    close() { if (closed) return; closed = true; for (const entry of active.values()) entry.controller.abort(); },
  });
}
