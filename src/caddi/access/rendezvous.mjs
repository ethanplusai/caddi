/**
 * A stable, private locator for the current human-approved enrollment socket.
 * This is NOT authentication: ps start times have one-second granularity, Node
 * exposes no macOS peer audit token here, and process/socket checks are separate.
 * The public runtime nonce detects stale legitimate endpoints, not same-user
 * impersonation. Never send a saved credential based on this descriptor. Every
 * runtime still requires the existing visible comparison-code approval.
 *
 * A publisher must already hold the application's exclusive single-instance
 * ownership for this data directory. This helper does not manufacture that
 * authority or delete stale sockets, run roots, profiles, or unknown files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isPromise } from 'node:util/types';
import { CaddiError } from '../contracts.mjs';

export const RENDEZVOUS_LIMITS = Object.freeze({ descriptorBytes: 4096, processBytes: 8192, processMs: 1500, processConcurrency: 4 });
const FORMAT = 'caddi-desktop-rendezvous', VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const publishing = new Set();
const publications = new WeakMap();
let processQueries = 0;
const fail = code => { throw new CaddiError(code, 'Caddi local connection locator is unavailable'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(value);
const ownUid = () => {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') fail('RENDEZVOUS_UNSUPPORTED');
  return process.getuid();
};
function cancelled(signal) { if (signal?.aborted) fail('CANCELLED'); }
function ownerFence(callback) {
  if (typeof callback !== 'function') fail('RENDEZVOUS_OWNER_REQUIRED');
  let value;
  try { value = callback(); } catch { fail('RENDEZVOUS_OWNER_STALE'); }
  if (isPromise(value)) { value.catch(() => {}); fail('RENDEZVOUS_OWNER_STALE'); }
  if (value !== true && value !== undefined) fail('RENDEZVOUS_OWNER_STALE');
}
function absolute(value, maximum = 2048) {
  return typeof value === 'string' && Buffer.byteLength(value) <= maximum && path.isAbsolute(value) &&
    path.resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function stat(filename) {
  try { return fs.lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('RENDEZVOUS_PATH_UNAVAILABLE'); }
}
function privateParent(filename) {
  const uid = BigInt(ownUid()), directory = path.dirname(filename);
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const value = stat(current);
    if (!value?.isDirectory() || value.isSymbolicLink() || ![0n, uid].includes(value.uid) ||
        ((value.mode & 0o022n) !== 0n && !(value.uid === 0n && (value.mode & 0o1000n) !== 0n))) fail('RENDEZVOUS_PRIVATE_PATH');
  }
  const value = stat(directory);
  let canonical;
  try { canonical = fs.realpathSync(directory); } catch { fail('RENDEZVOUS_PRIVATE_PATH'); }
  if (!value?.isDirectory() || value.uid !== uid || (value.mode & 0o777n) !== 0o700n || canonical !== directory) fail('RENDEZVOUS_PRIVATE_PATH');
  return { directory, dev: String(value.dev), ino: String(value.ino) };
}
function descriptorParent(filename) {
  if (!absolute(filename) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.json$/.test(path.basename(filename))) fail('RENDEZVOUS_PATH_INVALID');
  return privateParent(filename);
}
const sameParent = (a, b) => a.directory === b.directory && a.dev === b.dev && a.ino === b.ino;
const fileStamp = value => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(value[key])).join(':');
// Timestamps must stay stable throughout each individual read. Across the
// publication lifetime, the capability binds the same owned inode and bytes;
// metadata timestamp changes alone do not identify a different publication.
const fileIdentity = value => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'].map(key => String(value[key])).join(':');
function regular(value) {
  if (!value?.isFile() || value.isSymbolicLink() || value.uid !== BigInt(ownUid()) ||
      (value.mode & 0o777n) !== 0o600n || value.nlink !== 1n || value.size < 1n ||
      value.size > BigInt(RENDEZVOUS_LIMITS.descriptorBytes)) fail('RENDEZVOUS_FILE_INVALID');
}
function processValue(value) {
  if (!exact(value, ['pid', 'uid', 'started', 'executable']) || !Number.isSafeInteger(value.pid) || value.pid <= 1 || value.pid > 2147483647 ||
      value.uid !== ownUid() || typeof value.started !== 'string' || !START.test(value.started) || !absolute(value.executable, 1024)) fail('RENDEZVOUS_PROCESS_INVALID');
  return value;
}
function parseDescriptor(bytes) {
  let value;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { fail('RENDEZVOUS_FILE_INVALID'); }
  if (!exact(value, ['format', 'version', 'runtimeId', 'process', 'enrollment', 'publishedAt']) || value.format !== FORMAT) fail('RENDEZVOUS_FILE_INVALID');
  if (value.version !== VERSION) fail('RENDEZVOUS_VERSION');
  if (!UUID.test(value.runtimeId ?? '') || !Number.isSafeInteger(value.publishedAt) || value.publishedAt <= 0) fail('RENDEZVOUS_FILE_INVALID');
  processValue(value.process);
  const endpoint = value.enrollment;
  if (!exact(endpoint, ['path', 'parentDev', 'parentIno', 'socketDev', 'socketIno']) || !absolute(endpoint.path, 100) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(path.basename(endpoint.path)) ||
      !['parentDev', 'parentIno', 'socketDev', 'socketIno'].every(key => decimal(endpoint[key]))) fail('RENDEZVOUS_FILE_INVALID');
  return value;
}
function readDescriptor(filename, { allowAbsent = false } = {}) {
  const parent = descriptorParent(filename), before = stat(filename);
  if (!before && allowAbsent) return null;
  if (!before) fail('RENDEZVOUS_NOT_RUNNING');
  regular(before);
  let handle;
  try {
    handle = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(handle, { bigint: true }); regular(opened);
    if (fileStamp(before) !== fileStamp(opened)) fail('RENDEZVOUS_CHANGED');
    const buffer = Buffer.alloc(RENDEZVOUS_LIMITS.descriptorBytes + 1);
    const length = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(handle, { bigint: true }), named = stat(filename);
    if (length !== Number(after.size) || !named || fileStamp(before) !== fileStamp(after) || fileStamp(after) !== fileStamp(named) ||
        !sameParent(parent, descriptorParent(filename))) fail('RENDEZVOUS_CHANGED');
    const bytes = buffer.subarray(0, length), descriptor = parseDescriptor(bytes);
    return { descriptor, digest: digest(bytes), identity: fileIdentity(after), dev: String(after.dev), ino: String(after.ino), parent };
  } catch (error) {
    if (error instanceof CaddiError) throw error;
    fail('RENDEZVOUS_FILE_INVALID');
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function socketIdentity(socketPath) {
  if (!absolute(socketPath, 100) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(path.basename(socketPath))) fail('RENDEZVOUS_SOCKET_INVALID');
  const parent = privateParent(socketPath), socket = stat(socketPath);
  if (!socket?.isSocket() || socket.isSymbolicLink() || socket.uid !== BigInt(ownUid()) || (socket.mode & 0o777n) !== 0o600n) fail('RENDEZVOUS_SOCKET_INVALID');
  return { path: socketPath, parentDev: parent.dev, parentIno: parent.ino, socketDev: String(socket.dev), socketIno: String(socket.ino) };
}
const sameEndpoint = (a, b) => Object.keys(a).every(key => a[key] === b[key]);
const sameProcess = (a, b) => !!a && !!b && ['pid', 'uid', 'started', 'executable'].every(key => a[key] === b[key]);

// Fixed native executable/arguments, bounded output/deadline/concurrency. No shell,
// process-name search, signals to another process, or native code-identity claim.
async function inspectProcess(pid, signal) {
  ownUid(); cancelled(signal);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2147483647) fail('RENDEZVOUS_PROCESS_INVALID');
  if (processQueries >= RENDEZVOUS_LIMITS.processConcurrency) fail('RENDEZVOUS_BUSY');
  processQueries++;
  let spawned = false;
  try {
    const output = await new Promise((resolve, reject) => {
      const child = execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,uid=,lstart=,comm='], {
        timeout: RENDEZVOUS_LIMITS.processMs, killSignal: 'SIGKILL', maxBuffer: RENDEZVOUS_LIMITS.processBytes,
        encoding: 'utf8', signal, env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin' },
      }, (error, stdout, stderr) => {
        if (error && !(error.code === 1 && !stdout.trim() && !stderr.trim())) reject(error);
        else if (stderr.trim()) reject(new Error('process output'));
        else resolve(stdout);
      });
      spawned = true;
      // Abort can settle execFile's callback before the exact spawned process has
      // exited. Keep its real concurrency slot until close, not caller receipt.
      child.once('close', () => { processQueries--; });
    });
    cancelled(signal);
    if (!output.trim()) return null;
    const lines = output.trim().split('\n');
    if (lines.length !== 1) fail('RENDEZVOUS_PROCESS_UNAVAILABLE');
    const match = lines[0].trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match || Number(match[1]) !== pid) fail('RENDEZVOUS_PROCESS_UNAVAILABLE');
    return processValue({ pid, uid: Number(match[2]), started: match[3].replace(/\s+/g, ' '), executable: match[4] });
  } catch (error) {
    cancelled(signal);
    if (error instanceof CaddiError) throw error;
    fail('RENDEZVOUS_PROCESS_UNAVAILABLE');
  } finally { if (!spawned) processQueries--; }
}
const samePublication = (a, b) => !!a && !!b && a.digest === b.digest && a.identity === b.identity &&
  a.descriptor.runtimeId === b.descriptor.runtimeId && sameParent(a.parent, b.parent);
function flushDirectory(directory) {
  const handle = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

export async function publishDesktopRendezvous({ descriptorPath, enrollmentSocket, runtimeId, assertOwner } = {}) {
  ownUid(); descriptorParent(descriptorPath);
  if (!UUID.test(runtimeId ?? '')) fail('RENDEZVOUS_RUNTIME_INVALID');
  ownerFence(assertOwner);
  if (publishing.has(descriptorPath)) fail('RENDEZVOUS_BUSY');
  publishing.add(descriptorPath);
  let temporary, temporaryStamp, published, candidate, publicationSucceeded = false;
  try {
    const initial = readDescriptor(descriptorPath, { allowAbsent: true });
    if (initial && sameProcess(initial.descriptor.process, await inspectProcess(initial.descriptor.process.pid))) fail('RENDEZVOUS_LIVE');
    const owner = await inspectProcess(process.pid);
    if (!owner || owner.pid !== process.pid || owner.uid !== ownUid()) fail('RENDEZVOUS_PROCESS_UNAVAILABLE');
    ownerFence(assertOwner);
    const parent = descriptorParent(descriptorPath), endpoint = socketIdentity(enrollmentSocket);
    const descriptor = { format: FORMAT, version: VERSION, runtimeId, process: owner, enrollment: endpoint, publishedAt: Date.now() };
    const bytes = Buffer.from(JSON.stringify(descriptor) + '\n');
    if (bytes.length > RENDEZVOUS_LIMITS.descriptorBytes) fail('RENDEZVOUS_FILE_INVALID');
    temporary = path.join(parent.directory, '.caddi-rendezvous-' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryStamp = fs.fstatSync(handle, { bigint: true });
      fs.writeFileSync(handle, bytes); fs.fsyncSync(handle);
    } finally { if (handle !== undefined) fs.closeSync(handle); }
    candidate = { dev: String(temporaryStamp.dev), ino: String(temporaryStamp.ino), digest: digest(bytes), parent };
    ownerFence(assertOwner);
    if (!sameParent(parent, descriptorParent(descriptorPath)) || !sameEndpoint(endpoint, socketIdentity(enrollmentSocket))) fail('RENDEZVOUS_CHANGED');
    const current = readDescriptor(descriptorPath, { allowAbsent: true });
    if ((initial && !samePublication(initial, current)) || (!initial && current)) fail('RENDEZVOUS_CHANGED');
    // No await between final owner/CAS check and publication. The external writer
    // exclusion is the caller's already-held Electron single-instance ownership.
    if (initial) { fs.renameSync(temporary, descriptorPath); publicationSucceeded = true; }
    else { fs.linkSync(temporary, descriptorPath); publicationSucceeded = true; fs.unlinkSync(temporary); }
    temporary = null;
    flushDirectory(parent.directory);
    published = readDescriptor(descriptorPath);
    if (published.digest !== digest(bytes) || !sameParent(parent, published.parent)) fail('RENDEZVOUS_CHANGED');
    ownerFence(assertOwner);
    let closed = false;
    const receipt = Object.freeze({
      descriptorPath, runtimeId,
      // Cleanup remains authorized by this exact publication capability after the
      // startup owner guard is false. Caller closes access BEFORE calling close.
      close() {
        if (closed) return Object.freeze({ removed: false });
        let current;
        try { current = readDescriptor(descriptorPath, { allowAbsent: true }); }
        catch { closed = true; return Object.freeze({ removed: false }); }
        if (!samePublication(published, current) || current.descriptor.runtimeId !== runtimeId) { closed = true; return Object.freeze({ removed: false }); }
        try { fs.unlinkSync(descriptorPath); flushDirectory(published.parent.directory); }
        catch { fail('RENDEZVOUS_CLEANUP_PENDING'); }
        closed = true; return Object.freeze({ removed: true });
      },
    });
    publications.set(receipt, () => {
      if (closed) fail('RENDEZVOUS_CLOSED');
      ownerFence(assertOwner);
      if (!samePublication(published, readDescriptor(descriptorPath)) || !sameEndpoint(endpoint, socketIdentity(enrollmentSocket))) fail('RENDEZVOUS_CHANGED');
      return Object.freeze({ descriptorPath, runtimeId });
    });
    return receipt;
  } catch (error) {
    // A failed post-publication check must not leave a live-looking advertisement
    // without its owner capability. Remove only the exact bytes/inode we published.
    if (publicationSucceeded && candidate) {
      try {
        if (temporary) {
          const remaining = stat(temporary);
          if (remaining?.dev === temporaryStamp.dev && remaining?.ino === temporaryStamp.ino) fs.unlinkSync(temporary);
          temporary = null;
        }
        const current = readDescriptor(descriptorPath, { allowAbsent: true });
        if (current && current.dev === candidate.dev && current.ino === candidate.ino && current.digest === candidate.digest &&
            sameParent(candidate.parent, current.parent)) { fs.unlinkSync(descriptorPath); flushDirectory(current.parent.directory); }
      } catch {}
    }
    if (error instanceof CaddiError) throw error;
    fail('RENDEZVOUS_PUBLICATION_FAILED');
  } finally {
    if (temporary && temporaryStamp) {
      try { const current = stat(temporary); if (current?.dev === temporaryStamp.dev && current?.ino === temporaryStamp.ino) fs.unlinkSync(temporary); } catch {}
    }
    publishing.delete(descriptorPath);
  }
}

/** Main-only publication identity validation; cloned/renderer-shaped records fail. */
export function assertDesktopRendezvousPublication(receipt) {
  const validate = receipt && typeof receipt === 'object' ? publications.get(receipt) : null;
  if (!validate) fail('RENDEZVOUS_PUBLICATION_REQUIRED');
  return validate();
}

export async function resolveDesktopRendezvous({ descriptorPath, signal } = {}) {
  cancelled(signal);
  let publication;
  // Retry once only for an atomic publication race, never for malformed, future,
  // absent, stale, or permission failures. No background scanning/reconnect loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { publication = readDescriptor(descriptorPath); break; }
    catch (error) { if (error.code !== 'RENDEZVOUS_CHANGED' || attempt) throw error; }
  }
  const expected = publication.descriptor;
  async function assertCurrent() {
    cancelled(signal);
    if (!samePublication(publication, readDescriptor(descriptorPath))) fail('RENDEZVOUS_CHANGED');
    if (!sameEndpoint(expected.enrollment, socketIdentity(expected.enrollment.path))) fail('RENDEZVOUS_CHANGED');
    const actual = await inspectProcess(expected.process.pid, signal);
    cancelled(signal);
    if (!sameProcess(expected.process, actual)) fail('RENDEZVOUS_NOT_RUNNING');
    if (!samePublication(publication, readDescriptor(descriptorPath)) || !sameEndpoint(expected.enrollment, socketIdentity(expected.enrollment.path))) fail('RENDEZVOUS_CHANGED');
    return true;
  }
  await assertCurrent();
  return Object.freeze({ socketPath: expected.enrollment.path, runtimeId: expected.runtimeId, assertCurrent });
}
