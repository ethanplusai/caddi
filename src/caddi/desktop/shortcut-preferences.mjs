import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { assertKeys, assertInteger, cloneData } from '../contracts.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';
import { SHORTCUT_COMMANDS, defaultShortcuts, validateShortcuts, shortcutAccelerator, shortcutLabel } from './shortcuts.mjs';

const fail = code => { throw Object.assign(new Error('Shortcut preferences are unavailable'), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const maximumBytes = 8192;
// Commands added after the first catalogue, oldest first, with their default keys.
const ADDED_COMMANDS = [['normal-window', 'Primary+N'], ['vault', 'Primary+Shift+U']];
// Commands that no longer exist. A saved file may still name them; they are dropped on load.
const REMOVED_COMMANDS = ['chat'];
function loadedBindings(saved) {
  const raw = saved && typeof saved === 'object' && !Array.isArray(saved) && REMOVED_COMMANDS.some(id => Object.hasOwn(saved, id))
    ? Object.fromEntries(Object.entries(saved).filter(([id]) => !REMOVED_COMMANDS.includes(id))) : saved;
  const missing = raw && typeof raw === 'object' ? ADDED_COMMANDS.filter(([id]) => !Object.hasOwn(raw, id)) : [];
  if (missing.length) {
    // An earlier catalogue lacked commands added since. Accept only an exact
    // earlier key set, preserve every binding, and never overwrite its source
    // until the owner explicitly saves. A key the owner already assigned wins:
    // the new command is then left unassigned.
    let current = validateShortcuts({ ...raw, ...Object.fromEntries(missing.map(([id]) => [id, null])) });
    for (const [id, binding] of missing) {
      try { current = validateShortcuts({ ...current, [id]: binding }); }
      catch (error) { if (error.code !== 'SHORTCUT_CONFLICT') throw error; }
    }
    return current;
  }
  return validateShortcuts(raw);
}
const check = fn => {
  const result = fn();
  if (result && typeof result.then === 'function') { if (result instanceof Promise) void result.catch(() => {}); fail('SHORTCUT_ASYNC_FENCE'); }
  if (result !== true && result !== undefined) fail('SHORTCUT_CONTEXT_CHANGED');
};
/** Single-host preferences; the desktop's single-instance lock owns this store. */
export async function createShortcutPreferences(dataRoot) {
  const directory = ensurePrivateDirectory(path.join(dataRoot, 'preferences'));
  const file = path.join(directory, 'shortcuts.json');
  let state = { version: 1, revision: 0, bindings: defaultShortcuts() }, sourceDigest = null, errorCode = null;
  let tail = Promise.resolve(), pending = 0, closed = false;
  async function source() {
    ensurePrivateDirectory(directory);
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maximumBytes ||
          (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) fail('SHORTCUT_FILE_UNSAFE');
      const bytes = await handle.readFile();
      if (bytes.length > maximumBytes) fail('SHORTCUT_FILE_UNSAFE');
      return { bytes, digest: digest(bytes) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (['ELOOP', 'EISDIR'].includes(error.code)) fail('SHORTCUT_FILE_UNSAFE');
      throw error;
    } finally { await handle?.close(); }
  }
  try {
    const existing = await source();
    if (existing) {
      sourceDigest = existing.digest;
      const input = JSON.parse(existing.bytes.toString('utf8'));
      if (input?.version !== 1) fail('SHORTCUT_VERSION_UNSUPPORTED');
      assertKeys(input, ['version', 'revision', 'bindings'], ['version', 'revision', 'bindings']);
      assertInteger(input.revision, 'shortcut revision');
      state = { version: 1, revision: input.revision, bindings: loadedBindings(input.bindings) };
    }
  } catch (error) {
    errorCode = ['SHORTCUT_FILE_UNSAFE', 'SHORTCUT_VERSION_UNSUPPORTED'].includes(error.code) ? error.code : 'SHORTCUT_FILE_INVALID';
    // Default keys remain usable; unknown or damaged original bytes are not replaced.
  }
  const snapshot = () => ({ revision: state.revision, editable: !closed && !errorCode, errorCode,
    bindings: { ...state.bindings }, commands: SHORTCUT_COMMANDS.map(item => ({ id: item.id, label: item.label,
      binding: state.bindings[item.id], display: shortcutLabel(state.bindings[item.id]),
      accelerator: shortcutAccelerator(state.bindings[item.id]) ?? null, defaultBinding: item.binding })) });
  function save(raw, { beforeCommit = () => true } = {}) {
    if (closed || errorCode) return Promise.reject(Object.assign(new Error('Preferences are unavailable'), { code: errorCode ?? 'SHORTCUT_CLOSED' }));
    if (pending >= 8) return Promise.reject(Object.assign(new Error('Preferences are busy'), { code: 'SHORTCUT_CAPACITY' }));
    let input, bindings;
    try {
      input = cloneData(raw, { maxBytes: maximumBytes });
      assertKeys(input, ['expectedRevision', 'bindings'], ['expectedRevision', 'bindings']);
      assertInteger(input.expectedRevision, 'shortcut revision', { max: Number.MAX_SAFE_INTEGER - 1 });
      if (typeof beforeCommit !== 'function') fail('SHORTCUT_CONTEXT_CHANGED');
      bindings = validateShortcuts(input.bindings);
    } catch (error) { return Promise.reject(error); }
    pending++;
    const result = tail.then(async () => {
      if (closed || errorCode) fail(errorCode ?? 'SHORTCUT_CLOSED');
      if (state.revision !== input.expectedRevision) fail('SHORTCUT_REVISION_CONFLICT');
      check(beforeCommit);
      const prior = await source();
      if ((prior?.digest ?? null) !== sourceDigest) { errorCode = 'SHORTCUT_SOURCE_CHANGED'; fail(errorCode); }
      const next = { version: 1, revision: state.revision + 1, bindings };
      const bytes = Buffer.from(JSON.stringify(next) + '\n');
      const temporary = path.join(directory, '.shortcuts-' + randomUUID() + '.tmp');
      let renamed = false;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const current = await source();
        if ((current?.digest ?? null) !== sourceDigest) { errorCode = 'SHORTCUT_SOURCE_CHANGED'; fail(errorCode); }
        if (closed) fail('SHORTCUT_CLOSED');
        check(beforeCommit);
        await fs.rename(temporary, file); renamed = true;
        const directoryHandle = await fs.open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        state = next; sourceDigest = digest(bytes); return snapshot();
      } catch (error) {
        if (renamed) { errorCode = 'SHORTCUT_COMMIT_UNCERTAIN'; fail(errorCode); }
        throw error;
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
    tail = result.catch(() => {}).finally(() => { pending--; });
    return result;
  }
  return Object.freeze({ snapshot, save, flush: () => tail,
    close() { closed = true; return tail; } });
}
