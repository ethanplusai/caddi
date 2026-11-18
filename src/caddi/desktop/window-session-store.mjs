// Owner-only normal-window topology. This file stores identity references and
// geometry, never page URLs, private scopes, grants, credentials or native IDs.
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, cloneData } from '../contracts.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';

export const WINDOW_SESSION_LIMITS = Object.freeze({ windows: 8, bytes: 32768, pending: 16,
  coordinate: 1000000, dimension: 16384, displays: 16, minimumWidth: 1040, minimumHeight: 660 });
const FORMAT = 'caddi-window-session', VERSION = 1;
const fail = code => { throw new CaddiError(code, 'Saved window layout is unavailable'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const empty = () => ({ version: VERSION, revision: 0, windows: [], focusedWindowKey: null });
function rect(raw, display = false) {
  assertKeys(raw, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
  for (const key of ['x', 'y']) assertInteger(raw[key], key, { min: -WINDOW_SESSION_LIMITS.coordinate, max: WINDOW_SESSION_LIMITS.coordinate });
  for (const key of ['width', 'height']) assertInteger(raw[key], key, { min: 1, max: display ? 65536 : WINDOW_SESSION_LIMITS.dimension });
  return { ...raw };
}
function validate(raw) {
  const state = cloneData(raw, { maxBytes: WINDOW_SESSION_LIMITS.bytes });
  assertKeys(state, ['version', 'revision', 'windows', 'focusedWindowKey'], ['version', 'revision', 'windows', 'focusedWindowKey']);
  if (state.version !== VERSION) fail('WINDOW_SESSION_UNSUPPORTED_VERSION');
  assertInteger(state.revision, 'revision');
  if (!Array.isArray(state.windows) || state.windows.length > WINDOW_SESSION_LIMITS.windows) fail('WINDOW_SESSION_LIMIT');
  const keys = new Set(), workspaces = new Set(), identities = new Set();
  for (const item of state.windows) {
    assertKeys(item, ['windowKey', 'workspaceId', 'identityId', 'bounds', 'maximized'], ['windowKey', 'workspaceId', 'identityId', 'bounds', 'maximized']);
    for (const key of ['windowKey', 'workspaceId', 'identityId']) assertId(item[key], key);
    if (keys.has(item.windowKey) || workspaces.has(item.workspaceId) || identities.has(item.identityId)) fail('WINDOW_SESSION_DUPLICATE');
    keys.add(item.windowKey); workspaces.add(item.workspaceId); identities.add(item.identityId);
    item.bounds = rect(item.bounds);
    if (typeof item.maximized !== 'boolean') fail('INVALID_ARGUMENT');
  }
  if (!state.windows.length) { if (state.focusedWindowKey !== null) fail('WINDOW_SESSION_FOCUS'); }
  else if (!keys.has(assertId(state.focusedWindowKey, 'focused window'))) fail('WINDOW_SESSION_FOCUS');
  return state;
}
function encode(state) {
  const payload = validate(state), checksum = digest(JSON.stringify(canonical(payload)));
  const raw = Buffer.from(JSON.stringify(canonical({ format: FORMAT, sha256: checksum, payload })) + '\n');
  if (raw.length > WINDOW_SESSION_LIMITS.bytes) fail('WINDOW_SESSION_LIMIT');
  return raw;
}
function decode(raw) {
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { fail('WINDOW_SESSION_CORRUPT'); }
  if (Number.isSafeInteger(envelope?.payload?.version) && envelope.payload.version !== VERSION) fail('WINDOW_SESSION_UNSUPPORTED_VERSION');
  try {
    assertKeys(envelope, ['format', 'sha256', 'payload'], ['format', 'sha256', 'payload']);
    if (envelope.format !== FORMAT || typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256)) fail('WINDOW_SESSION_CORRUPT');
    const state = validate(envelope.payload);
    if (!raw.equals(encode(state))) fail('WINDOW_SESSION_CORRUPT');
    return state;
  } catch (error) { if (error.code === 'WINDOW_SESSION_UNSUPPORTED_VERSION') throw error; fail('WINDOW_SESSION_CORRUPT'); }
}
function eligibility(entry, lookup) {
  let workspace;
  try { workspace = lookup(entry.workspaceId); } catch { return 'WORKSPACE_UNAVAILABLE'; }
  if (workspace && typeof workspace.then === 'function') {
    if (workspace instanceof Promise) void workspace.catch(() => {});
    fail('WINDOW_SESSION_ASYNC_LOOKUP');
  }
  if (!workspace || workspace.id !== entry.workspaceId) return 'WORKSPACE_UNAVAILABLE';
  if (workspace.persistence !== 'durable') return 'NOT_DURABLE';
  if (workspace.lifecycle?.status === 'archived') return 'WORKSPACE_ARCHIVED';
  if (workspace.identityId !== entry.identityId) return 'IDENTITY_CHANGED';
  return null;
}
function authorize(state, lookup) {
  if (state.windows.some(entry => eligibility(entry, lookup))) fail('WINDOW_SESSION_AUTHORITY_CHANGED');
}
function fence(callback) {
  if (!callback) return;
  const result = callback();
  if (result && typeof result.then === 'function') {
    if (result instanceof Promise) void result.catch(() => {});
    fail('WINDOW_SESSION_ASYNC_FENCE');
  }
  if (result !== true && result !== undefined) fail('WINDOW_SESSION_AUTHORITY_CHANGED');
}

/** Pure restoration plan. Primary display first. No engine/session/window creation.
 * The host must recheck identity and reserve actual visible panes on each activation.
 */
export function planWindowSessionRestore(raw, { durableWorkspaceLookup, displays } = {}) {
  if (typeof durableWorkspaceLookup !== 'function') fail('INVALID_ARGUMENT');
  const state = validate(raw), screens = cloneData(displays, { maxBytes: WINDOW_SESSION_LIMITS.bytes });
  if (!Array.isArray(screens) || !screens.length || screens.length > WINDOW_SESSION_LIMITS.displays) fail('WINDOW_SESSION_DISPLAYS');
  const displayIds = new Set();
  for (const screen of screens) {
    assertKeys(screen, ['id', 'workArea'], ['id', 'workArea']);
    if (!Number.isSafeInteger(screen.id) || displayIds.has(screen.id)) fail('WINDOW_SESSION_DISPLAYS');
    displayIds.add(screen.id); screen.workArea = rect(screen.workArea, true);
  }
  const windows = [], skipped = [];
  for (const entry of state.windows) {
    const reason = eligibility(entry, durableWorkspaceLookup);
    if (reason) { skipped.push({ windowKey: entry.windowKey, reason }); continue; }
    const area = work => Math.max(0, Math.min(entry.bounds.x + entry.bounds.width, work.x + work.width) - Math.max(entry.bounds.x, work.x)) *
      Math.max(0, Math.min(entry.bounds.y + entry.bounds.height, work.y + work.height) - Math.max(entry.bounds.y, work.y));
    let screen = screens[0], overlap = area(screen.workArea);
    for (const candidate of screens.slice(1)) { const candidateOverlap = area(candidate.workArea); if (candidateOverlap > overlap) { screen = candidate; overlap = candidateOverlap; } }
    const work = screen.workArea, minimumSize = { width: Math.min(WINDOW_SESSION_LIMITS.minimumWidth, work.width), height: Math.min(WINDOW_SESSION_LIMITS.minimumHeight, work.height) };
    const width = Math.min(work.width, Math.max(minimumSize.width, entry.bounds.width));
    const height = Math.min(work.height, Math.max(minimumSize.height, entry.bounds.height));
    windows.push({ ...entry, displayId: screen.id, minimumSize, bounds: {
      x: Math.max(work.x, Math.min(entry.bounds.x, work.x + work.width - width)),
      y: Math.max(work.y, Math.min(entry.bounds.y, work.y + work.height - height)), width, height } });
  }
  const focusedWindowKey = windows.some(item => item.windowKey === state.focusedWindowKey) ? state.focusedWindowKey : windows[0]?.windowKey ?? null;
  return { revision: state.revision, focusedWindowKey, skipped, windows: windows.map(item => ({ ...item,
    hydrateOn: item.windowKey === focusedWindowKey ? 'initial-focus' : 'activation', requiresPageAdmission: true })) };
}

/** Private-file topology store; "private-file" means 0700/0600 filesystem access,
 * not an incognito session. The lookup must explicitly attest persistence:'durable'.
 * load validates source structure only; use the restore planner for live eligibility.
 * Corruption, future formats and ambiguous publication never reset/overwrite sources.
 */
export function createWindowSessionStore({ directory, durableWorkspaceLookup, lockTimeoutMs = 500, fault } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes('\0') ||
      typeof durableWorkspaceLookup !== 'function' || (fault !== undefined && typeof fault !== 'function')) fail('INVALID_ARGUMENT');
  assertInteger(lockTimeoutMs, 'lock timeout', { min: 1, max: 2000 });
  const files = Object.freeze({ primary: path.join(directory, 'windows.json'), backup: path.join(directory, 'windows.previous.json'), lock: path.join(directory, 'writer.lock') });
  let tail = Promise.resolve(), pending = 0, lastError = null, uncertain = false;
  const enqueue = operation => {
    if (pending >= WINDOW_SESSION_LIMITS.pending) return Promise.reject(new CaddiError('WINDOW_SESSION_BUSY', 'Saved window layout writer is busy'));
    pending++;
    const result = tail.then(operation);
    tail = result.then(() => { if (!uncertain) lastError = null; }, error => { lastError = error; }).finally(() => { pending--; });
    return result;
  };
  function active() { if (uncertain) fail('WINDOW_SESSION_REOPEN_REQUIRED'); }
  function ensureDirectory() { try { ensurePrivateDirectory(directory); } catch { fail('WINDOW_SESSION_UNSAFE_PATH'); } }
  const statFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink', 'uid', 'gid'];
  function same(a, b) { if (statFields.some(key => a[key] !== b[key])) fail('WINDOW_SESSION_SOURCE_CHANGED'); }
  async function read(file) {
    let before;
    try { before = await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o077n) || before.uid !== BigInt(process.getuid())) fail('WINDOW_SESSION_UNSAFE_PATH');
    if (before.size > BigInt(WINDOW_SESSION_LIMITS.bytes)) fail('WINDOW_SESSION_TOO_LARGE');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      same(before, await handle.stat({ bigint: true }));
      const buffer = Buffer.alloc(WINDOW_SESSION_LIMITS.bytes + 1); let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead; }
      if (total > WINDOW_SESSION_LIMITS.bytes) fail('WINDOW_SESSION_TOO_LARGE');
      same(before, await handle.stat({ bigint: true })); same(before, await fs.lstat(file, { bigint: true }));
      return buffer.subarray(0, total);
    } finally { await handle.close(); }
  }
  async function candidate(file) {
    const raw = await read(file);
    if (raw === null) return { exists: false, valid: false };
    try { return { exists: true, valid: true, digest: digest(raw), raw, state: decode(raw) }; }
    catch (error) { return { exists: true, valid: false, digest: digest(raw), error: error.code ?? 'WINDOW_SESSION_CORRUPT' }; }
  }
  async function sources() { return { primary: await candidate(files.primary), backup: await candidate(files.backup) }; }
  async function current() {
    const values = await sources();
    for (const item of Object.values(values)) if (item.error === 'WINDOW_SESSION_UNSUPPORTED_VERSION') fail(item.error);
    if (Object.values(values).some(item => item.exists && !item.valid) || (!values.primary.exists && values.backup.exists)) fail('WINDOW_SESSION_RECOVERY_REQUIRED');
    if (values.primary.valid && values.backup.valid && values.backup.state.revision > values.primary.state.revision) fail('WINDOW_SESSION_ORDER_CONFLICT');
    return { ...values, state: values.primary.state ?? empty() };
  }
  async function withLock(operation) {
    ensureDirectory(); const deadline = performance.now() + lockTimeoutMs;
    for (;;) {
      try { await fs.mkdir(files.lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let info;
        try { info = await fs.lstat(files.lock); } catch (next) { if (next.code === 'ENOENT') continue; throw next; }
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) fail('WINDOW_SESSION_UNSAFE_PATH');
        if (performance.now() >= deadline) fail('WINDOW_SESSION_LOCKED');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const identity = await fs.lstat(files.lock), token = randomUUID(), owner = path.join(files.lock, 'owner.json');
    let written = false;
    try {
      await fs.writeFile(owner, JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 }); written = true;
      return await operation();
    } finally {
      const info = await fs.lstat(files.lock);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) fail('WINDOW_SESSION_LOCK_LOST');
      if (written) { const bytes = await read(owner); if (!bytes || JSON.parse(bytes.toString('utf8')).token !== token) fail('WINDOW_SESSION_LOCK_LOST'); await fs.unlink(owner); }
      await fs.rmdir(files.lock);
    }
  }
  async function syncDirectory() {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function atomicWrite(file, bytes, beforePublish, primary = false) {
    const temporary = path.join(directory, '.windows-' + randomUUID() + '.tmp');
    let handle, renamed = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      if (primary && fault) await fault('after-temp-sync');
      beforePublish?.(); renameSync(temporary, file); renamed = true;
      if (primary && fault) await fault('after-primary-rename');
      await syncDirectory();
    } catch (error) {
      if (renamed) { uncertain = true; fail('WINDOW_SESSION_COMMIT_UNKNOWN'); }
      throw error;
    } finally {
      if (handle) await handle.close();
      if (!renamed) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return Object.freeze({ directory, files,
    load() { return enqueue(() => { active(); return withLock(async () => validate((await current()).state)); }); },
    async save(raw, options = {}) {
      assertKeys(raw, ['expectedRevision', 'windows', 'focusedWindowKey'], ['expectedRevision', 'windows', 'focusedWindowKey']);
      assertKeys(options, ['beforeCommit']);
      if (options.beforeCommit !== undefined && typeof options.beforeCommit !== 'function') fail('INVALID_ARGUMENT');
      assertInteger(raw.expectedRevision, 'expected revision', { max: Number.MAX_SAFE_INTEGER - 1 });
      const next = validate({ version: VERSION, revision: raw.expectedRevision + 1, windows: raw.windows, focusedWindowKey: raw.focusedWindowKey });
      authorize(next, durableWorkspaceLookup); const expectedRevision = raw.expectedRevision, beforeCommit = options.beforeCommit;
      return enqueue(() => { active(); return withLock(async () => {
        const previous = await current();
        if (previous.state.revision !== expectedRevision) fail('WINDOW_SESSION_REVISION_CONFLICT');
        authorize(next, durableWorkspaceLookup);
        if (previous.primary.exists) await atomicWrite(files.backup, previous.primary.raw);
        if (fault) await fault('after-backup');
        await atomicWrite(files.primary, encode(next), () => { fence(beforeCommit); authorize(next, durableWorkspaceLookup); }, true);
        return validate(next);
      }); });
    },
    inspect() { return enqueue(() => withLock(async () => {
      const values = await sources(), describe = item => ({ exists: item.exists, valid: item.valid, digest: item.digest ?? null,
        revision: item.valid ? item.state.revision : null, error: item.error ?? null });
      return { primary: describe(values.primary), backup: describe(values.backup), reopenRequired: uncertain };
    })); },
    async flush() { await tail; if (uncertain) fail('WINDOW_SESSION_REOPEN_REQUIRED'); if (lastError) throw lastError; },
  });
}
