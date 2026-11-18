import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError } from '../contracts.mjs';

const fail = (code, message) => { throw new CaddiError(code, message); };
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
export function assertNoSymlinks(location) {
  const absolute = path.resolve(location);
  let cursor = path.parse(absolute).root;
  for (const component of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH', 'Symbolic links are not allowed in storage paths');
  }
  return absolute;
}
export function privateDirectory(location, { create = false } = {}) {
  const absolute = path.resolve(location);
  if (create && !fs.existsSync(absolute)) {
    assertNoSymlinks(path.dirname(absolute));
    fs.mkdirSync(absolute, { mode: 0o700 });
  }
  assertNoSymlinks(absolute);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    fail('UNSAFE_STORAGE_PATH', 'Storage directory must be private and owned by this user');
  }
  return { path: absolute, dev: stat.dev, ino: stat.ino };
}
export function assertDirectory(anchor) {
  const current = privateDirectory(anchor.path);
  if (current.dev !== anchor.dev || current.ino !== anchor.ino) fail('STORAGE_PATH_CHANGED', 'Storage directory identity changed');
}
function regularPrivate(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    fail('UNSAFE_STORAGE_PATH', 'Storage files must be private regular files with one link');
  }
}
export function readPrivateFile(location, maxBytes = 64 * 1024 * 1024 + 36) {
  assertNoSymlinks(path.dirname(location));
  const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    regularPrivate(stat);
    if (stat.size > maxBytes) fail('STORE_LIMIT_EXCEEDED', 'Storage file exceeds its byte limit');
    const value = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || value.length !== stat.size) fail('STORAGE_PATH_CHANGED', 'Storage file changed during read');
    return value;
  } finally { fs.closeSync(fd); }
}
export function syncDirectory(location) {
  const fd = fs.openSync(location, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function atomicWrite(anchor, name, bytes, { replace = false, check = () => {}, fault = () => {} } = {}) {
  assertDirectory(anchor);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name)) fail('UNSAFE_STORAGE_PATH', 'Invalid storage filename');
  const destination = path.join(anchor.path, name);
  if (fs.existsSync(destination)) {
    if (!replace) fail('STORE_CONFLICT', 'Transaction already exists');
    readPrivateFile(destination);
  }
  const temporary = path.join(anchor.path, '.' + name + '.tmp-' + randomUUID());
  let fd;
  let committed = false;
  try {
    check();
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fault('after-temp-fsync');
    check();
    assertDirectory(anchor);
    fs.renameSync(temporary, destination);
    committed = true;
    fault('after-rename');
    syncDirectory(anchor.path);
    fault('after-commit');
  } catch (error) {
    if (committed) error.commitOutcomeUnknown = true;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!committed) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
export function removePrivateFile(anchor, name) {
  assertDirectory(anchor);
  const location = path.join(anchor.path, name);
  readPrivateFile(location);
  fs.unlinkSync(location);
}
function acquisitionArbiter(anchor) {
  assertDirectory(anchor);
  const location = path.join(anchor.path, 'writer.acquiring');
  const nonce = randomUUID();
  let fd;
  try { fd = fs.openSync(location, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let record;
    try { record = JSON.parse(readPrivateFile(location, 1024).toString('utf8')); }
    catch { fail('STORE_RECOVERY_REQUIRED', 'Acquisition arbiter is incomplete; explicit recovery is required'); }
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.nonce !== 'string') fail('STORE_RECOVERY_REQUIRED', 'Acquisition arbiter is invalid');
    try { process.kill(record.pid, 0); }
    catch (probe) {
      if (probe.code === 'ESRCH') fail('STORE_RECOVERY_REQUIRED', 'A crashed acquisition arbiter must be recovered explicitly');
      throw probe;
    }
    fail('STORE_BUSY', 'Another process is acquiring workspace storage');
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(anchor.path);
  return () => {
    assertDirectory(anchor);
    const record = JSON.parse(readPrivateFile(location, 1024).toString('utf8'));
    if (record.nonce !== nonce || record.pid !== process.pid) fail('STORAGE_LOCK_CHANGED', 'Acquisition arbiter ownership changed');
    fs.unlinkSync(location);
    syncDirectory(anchor.path);
  };
}
export function acquireLock(anchor) {
  // Every contender takes this non-stealable arbiter before inspecting/reaping
  // writer.lock. Otherwise two stale-lock reapers can unlink a newly won lock.
  const releaseArbiter = acquisitionArbiter(anchor);
  const location = path.join(anchor.path, 'writer.lock');
  const nonce = randomUUID();
  try {
    if (fs.existsSync(location)) {
      let record;
      try { record = JSON.parse(readPrivateFile(location, 1024).toString('utf8')); }
      catch { fail('STORE_RECOVERY_REQUIRED', 'Writer lock is invalid; explicit recovery is required'); }
      if (!Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.nonce !== 'string') fail('STORE_RECOVERY_REQUIRED', 'Writer lock is invalid');
      try { process.kill(record.pid, 0); fail('STORE_BUSY', 'Workspace already has a live writer'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      // A dead process lock can be reclaimed. A reused, live PID stays locked.
      fs.unlinkSync(location);
      syncDirectory(anchor.path);
    }
    const fd = fs.openSync(location, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(anchor.path);
    return () => {
      assertDirectory(anchor);
      let record;
      try { record = JSON.parse(readPrivateFile(location, 1024).toString('utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (record.nonce !== nonce || record.pid !== process.pid) fail('STORAGE_LOCK_CHANGED', 'Storage lock ownership changed');
      // A live releasing owner cannot be deemed a dead writer by an acquirer.
      // Its sole unlink therefore cannot remove a replacement owner's lock.
      fs.unlinkSync(location);
      syncDirectory(anchor.path);
    };
  } finally { releaseArbiter(); }
}
export function cleanTemporaryFiles(anchor) {
  assertDirectory(anchor);
  for (const name of fs.readdirSync(anchor.path)) {
    if (/^\.[A-Za-z0-9._-]+\.tmp-[a-f0-9-]{36}$/.test(name)) removePrivateFile(anchor, name);
  }
}
