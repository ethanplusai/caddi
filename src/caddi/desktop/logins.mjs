// Saved logins, per workspace. The password lives only in the login keychain
// (platform/login-secrets.mjs); this file keeps the metadata (site, username,
// label, workspaces, times, whether agents may use it) in a small versioned file
// in Caddi's data folder. The metadata never holds a password, and nothing this
// module returns to the shell or an agent does either.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, assertString, cloneData, normalizeOrigin } from '../contracts.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';

export const LOGIN_LIMITS = Object.freeze({ logins: 500, username: 256, label: 120, password: 1024, workspaces: 64 });
const FORMAT = 'caddi-saved-logins', VERSION = 1;
const fail = code => { throw new CaddiError(code, 'Saved login action could not be completed'); };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A site a login may be saved for and filled on: https, or http on this Mac only. */
export function usableLoginOrigin(value) {
  try {
    const origin = normalizeOrigin(value), url = new URL(origin);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  } catch { return false; }
}
export function loginOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || !usableLoginOrigin(value)) fail('LOGIN_SITE_INVALID');
  return normalizeOrigin(value);
}
/** Exact origin only: scheme, host and port. No subdomains, no suffixes. */
export const loginMatchesOrigin = (login, pageOrigin) => typeof pageOrigin === 'string' && login.origin === pageOrigin;
const cleanText = (value, label, max, min = 0) => {
  assertString(value, label, { min, max });
  if (/[\u0000-\u001f\u007f‪-‮⁦-⁩]/u.test(value)) fail('INVALID_ARGUMENT');
  return value.trim();
};
function passwordBuffer(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LOGIN_LIMITS.password || value.includes('\0')) fail('LOGIN_PASSWORD_INVALID');
  return Buffer.from(value, 'utf8');
}
function validRecord(raw) {
  assertKeys(raw, ['id', 'workspaceIds', 'origin', 'username', 'label', 'createdAt', 'updatedAt', 'lastUsedAt', 'agentUse'],
    ['id', 'workspaceIds', 'origin', 'username', 'label', 'createdAt', 'updatedAt', 'lastUsedAt', 'agentUse']);
  assertId(raw.id);
  if (!Array.isArray(raw.workspaceIds) || raw.workspaceIds.length < 1 || raw.workspaceIds.length > LOGIN_LIMITS.workspaces ||
      new Set(raw.workspaceIds).size !== raw.workspaceIds.length) fail('LOGINS_FILE_DAMAGED');
  raw.workspaceIds.forEach(id => assertId(id));
  if (loginOrigin(raw.origin) !== raw.origin) fail('LOGINS_FILE_DAMAGED');
  cleanText(raw.username, 'username', LOGIN_LIMITS.username); cleanText(raw.label, 'label', LOGIN_LIMITS.label, 1);
  assertInteger(raw.createdAt, 'createdAt'); assertInteger(raw.updatedAt, 'updatedAt');
  if (raw.lastUsedAt !== null) assertInteger(raw.lastUsedAt, 'lastUsedAt');
  if (typeof raw.agentUse !== 'boolean') fail('LOGINS_FILE_DAMAGED');
  return { ...raw, workspaceIds: [...raw.workspaceIds] };
}

/**
 * The owner's saved logins. `workspaceFor(id)` answers only for workspaces that may hold logins
 * (never a private window's). `secrets` is the keychain store or, in tests, its fake.
 */
export function createLoginStore({ directory, secrets, workspaceFor, now = Date.now, onChange = () => {} }) {
  if (!secrets || ['write', 'read', 'exists', 'remove', 'confirmPresence'].some(name => typeof secrets[name] !== 'function') ||
      typeof workspaceFor !== 'function') fail('INTEGRATION_REQUIRED');
  ensurePrivateDirectory(directory);
  const file = path.join(directory, 'logins.json');
  let logins = [], damaged = false, keychain = 'unchecked', closed = false;
  const states = new Map();
  const changed = () => { try { onChange(); } catch {} };
  const clock = () => assertInteger(now(), 'now');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) damaged = true;
    else {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      assertKeys(data, ['format', 'version', 'logins'], ['format', 'version', 'logins']);
      if (data.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.logins) || data.logins.length > LOGIN_LIMITS.logins) fail('LOGINS_FILE_DAMAGED');
      logins = data.logins.map(validRecord);
      if (new Set(logins.map(item => item.id)).size !== logins.length) fail('LOGINS_FILE_DAMAGED');
    }
  } catch (error) { if (error.code !== 'ENOENT') { damaged = true; logins = []; } }
  function persist(next) {
    if (damaged) fail('LOGINS_FILE_DAMAGED');
    const body = JSON.stringify({ format: FORMAT, version: VERSION, logins: next }, null, 1) + '\n';
    const temporary = path.join(directory, 'logins.json.' + randomUUID() + '.tmp');
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    try { const folder = fs.openSync(directory, 'r'); try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); } } catch {}
    logins = next; changed();
  }
  const usableWorkspace = id => { assertId(id, 'workspaceId'); const workspace = workspaceFor(id); if (!workspace) fail('WORKSPACE_UNAVAILABLE'); return workspace; };
  const open = () => { if (closed) fail('LOGINS_CLOSED'); if (damaged) fail('LOGINS_FILE_DAMAGED'); };
  function owned(loginId, workspaceId) {
    open(); assertId(loginId, 'loginId'); usableWorkspace(workspaceId);
    const login = logins.find(item => item.id === loginId);
    if (!login || !login.workspaceIds.includes(workspaceId)) fail('LOGIN_NOT_FOUND');
    return login;
  }
  const replace = (login, changes) => logins.map(item => item === login ? { ...item, ...changes } : item);
  function noteKeychain(error) {
    if (error?.code === 'KEYCHAIN_LOCKED') keychain = 'locked';
    else if (error?.code === 'KEYCHAIN_UNAVAILABLE') keychain = 'unavailable';
    changed();
  }
  function probe(id) {
    try { const present = secrets.exists(id); keychain = 'ready'; states.set(id, present ? 'ready' : 'needs-password'); }
    catch (error) { states.set(id, 'unknown'); noteKeychain(error); }
  }
  function refresh() {
    if (closed || damaged) return status();
    keychain = 'unchecked';
    for (const login of logins) probe(login.id);
    if (!logins.length) keychain = 'ready';
    changed(); return status();
  }
  // Reveal and copy need macOS to confirm the owner is present. Without that check, they are not offered.
  const presence = () => { try { return typeof secrets.presenceAvailable === 'function' ? secrets.presenceAvailable() === true : true; } catch { return false; } };
  const status = () => ({ available: !closed && !damaged, damaged, keychain, storage: secrets.kind === 'keychain' ? 'login-keychain' : 'test-only', reveal: presence() });
  const publicLogin = (login, workspaceId) => ({ loginId: login.id, origin: login.origin, username: login.username, label: login.label,
    createdAt: login.createdAt, updatedAt: login.updatedAt, lastUsedAt: login.lastUsedAt, agentUse: login.agentUse,
    sharedWith: login.workspaceIds.filter(id => id !== workspaceId), state: states.get(login.id) ?? 'unknown' });
  function input(raw, keys, required) {
    const value = cloneData(raw, { maxBytes: 16384 });
    assertKeys(value, keys, required);
    return value;
  }
  return Object.freeze({
    status, refresh,
    /** Metadata only, for the owner's shell. */
    view(workspaceId) {
      if (closed || damaged || !workspaceId) return { ...status(), logins: [] };
      try { usableWorkspace(workspaceId); } catch { return { ...status(), logins: [] }; }
      return { ...status(), logins: logins.filter(item => item.workspaceIds.includes(workspaceId)).map(item => publicLogin(item, workspaceId)) };
    },
    /** Logins for this exact page origin in this workspace: what the toolbar key offers. */
    matching(workspaceId, pageOrigin) {
      if (closed || damaged || !workspaceId || !usableLoginOrigin(pageOrigin ?? '')) return [];
      return logins.filter(item => item.workspaceIds.includes(workspaceId) && loginMatchesOrigin(item, pageOrigin))
        .map(item => ({ loginId: item.id, username: item.username, label: item.label, state: states.get(item.id) ?? 'unknown' }));
    },
    add(raw) {
      open();
      const value = input(raw, ['workspaceId', 'origin', 'username', 'label', 'password'], ['workspaceId', 'origin', 'username', 'password']);
      usableWorkspace(value.workspaceId);
      const origin = loginOrigin(value.origin), username = cleanText(value.username, 'username', LOGIN_LIMITS.username);
      const label = value.label === undefined || !String(value.label).trim() ? new URL(origin).host : cleanText(value.label, 'label', LOGIN_LIMITS.label, 1);
      if (logins.length >= LOGIN_LIMITS.logins) fail('LOGIN_CAPACITY');
      if (logins.some(item => item.workspaceIds.includes(value.workspaceId) && item.origin === origin && item.username === username)) fail('LOGIN_EXISTS');
      const id = 'login-' + randomUUID(), secret = passwordBuffer(value.password), time = clock();
      try { secrets.write(id, secret); } catch (error) { noteKeychain(error); throw error; } finally { secret.fill(0); }
      try {
        persist([...logins, { id, workspaceIds: [value.workspaceId], origin, username, label, createdAt: time, updatedAt: time, lastUsedAt: null, agentUse: false }]);
      } catch (error) {
        // The keychain item was created by this call, so it is removed by this call.
        try { secrets.remove(id); } catch {}
        throw error;
      }
      states.set(id, 'ready'); keychain = 'ready'; changed();
      return { loginId: id };
    },
    edit(raw) {
      const value = input(raw, ['loginId', 'workspaceId', 'origin', 'username', 'label', 'password'], ['loginId', 'workspaceId']);
      const login = owned(value.loginId, value.workspaceId), changes = { updatedAt: clock() };
      if (value.origin !== undefined) changes.origin = loginOrigin(value.origin);
      if (value.username !== undefined) changes.username = cleanText(value.username, 'username', LOGIN_LIMITS.username);
      if (value.label !== undefined) changes.label = cleanText(value.label, 'label', LOGIN_LIMITS.label, 1);
      const next = { ...login, ...changes };
      if (logins.some(item => item !== login && item.origin === next.origin && item.username === next.username &&
          item.workspaceIds.some(id => next.workspaceIds.includes(id)))) fail('LOGIN_EXISTS');
      if (value.password !== undefined) {
        const secret = passwordBuffer(value.password);
        try { secrets.write(login.id, secret); } catch (error) { noteKeychain(error); throw error; } finally { secret.fill(0); }
        states.set(login.id, 'ready');
      }
      persist(replace(login, changes));
      return { loginId: login.id };
    },
    /** Deletes the login everywhere: the keychain item Caddi created for it, then its metadata. */
    remove(raw) {
      const value = input(raw, ['loginId', 'workspaceId'], ['loginId', 'workspaceId']);
      const login = owned(value.loginId, value.workspaceId);
      try { secrets.remove(login.id); } catch (error) { if (error.code !== 'LOGIN_PASSWORD_MISSING') { noteKeychain(error); throw error; } }
      persist(logins.filter(item => item !== login)); states.delete(login.id);
      return { removed: true };
    },
    share(raw) {
      const value = input(raw, ['loginId', 'workspaceId', 'toWorkspaceId'], ['loginId', 'workspaceId', 'toWorkspaceId']);
      const login = owned(value.loginId, value.workspaceId);
      usableWorkspace(value.toWorkspaceId);
      if (login.workspaceIds.includes(value.toWorkspaceId)) return { loginId: login.id, shared: true };
      if (login.workspaceIds.length >= LOGIN_LIMITS.workspaces) fail('LOGIN_CAPACITY');
      if (logins.some(item => item !== login && item.workspaceIds.includes(value.toWorkspaceId) && item.origin === login.origin && item.username === login.username)) fail('LOGIN_EXISTS');
      persist(replace(login, { workspaceIds: [...login.workspaceIds, value.toWorkspaceId], updatedAt: clock() }));
      return { loginId: login.id, shared: true };
    },
    /** Removes the login from one workspace. From the last one it is deleted, and only with confirmDelete. */
    unshare(raw) {
      const value = input(raw, ['loginId', 'workspaceId', 'confirmDelete'], ['loginId', 'workspaceId']);
      const login = owned(value.loginId, value.workspaceId);
      if (login.workspaceIds.length === 1) {
        if (value.confirmDelete !== true) fail('LOGIN_LAST_WORKSPACE');
        try { secrets.remove(login.id); } catch (error) { if (error.code !== 'LOGIN_PASSWORD_MISSING') { noteKeychain(error); throw error; } }
        persist(logins.filter(item => item !== login)); states.delete(login.id);
        return { removed: true };
      }
      persist(replace(login, { workspaceIds: login.workspaceIds.filter(id => id !== value.workspaceId), updatedAt: clock() }));
      return { removed: false };
    },
    setAgentUse(raw) {
      const value = input(raw, ['loginId', 'workspaceId', 'allowed'], ['loginId', 'workspaceId', 'allowed']);
      if (typeof value.allowed !== 'boolean') fail('INVALID_ARGUMENT');
      const login = owned(value.loginId, value.workspaceId);
      persist(replace(login, { agentUse: value.allowed, updatedAt: clock() }));
      return { loginId: login.id, agentUse: value.allowed };
    },
    /** Main process only. The password Buffer is wiped as soon as `use` returns or throws. */
    async withSecret(loginId, workspaceId, use) {
      const login = owned(loginId, workspaceId);
      let password;
      try { password = secrets.read(login.id); keychain = 'ready'; states.set(login.id, 'ready'); }
      catch (error) {
        if (error.code === 'LOGIN_PASSWORD_MISSING') { states.set(login.id, 'needs-password'); changed(); }
        else noteKeychain(error);
        throw error;
      }
      try { return await use({ loginId: login.id, origin: login.origin, username: login.username, password }); }
      finally { password.fill(0); }
    },
    confirmPresence: reason => { if (!presence()) fail('PRESENCE_UNAVAILABLE'); return secrets.confirmPresence(reason); },
    /** Metadata of one login in one workspace, whatever its agent switch. For the owner's log and offers; never a password. */
    describe(loginId, workspaceId) {
      if (closed || damaged || typeof loginId !== 'string' || typeof workspaceId !== 'string') return null;
      const login = logins.find(item => item.id === loginId);
      return login && login.workspaceIds.includes(workspaceId) ? { loginId: login.id, origin: login.origin, username: login.username, label: login.label,
        agentUse: login.agentUse, workspaceIds: [...login.workspaceIds] } : null;
    },
    /** How many more logins may be saved. */
    capacityLeft: () => closed || damaged ? 0 : Math.max(0, LOGIN_LIMITS.logins - logins.length),
    /** This workspace's site and username pairs, to review an import against. */
    existing(workspaceId) {
      if (closed || damaged) return [];
      return logins.filter(item => item.workspaceIds.includes(workspaceId)).map(item => ({ origin: item.origin, username: item.username }));
    },
    touch(loginId) {
      const login = logins.find(item => item.id === loginId);
      if (!login || closed || damaged) return false;
      try { persist(replace(login, { lastUsedAt: clock() })); return true; } catch { return false; }
    },
    /** What an agent may know: never the password, only this workspace's logins it may use on its granted sites. */
    forAgent(workspaceId, origins) {
      if (closed || damaged || !Array.isArray(origins)) return [];
      return logins.filter(item => item.agentUse && item.workspaceIds.includes(workspaceId) && origins.includes(item.origin) && states.get(item.id) !== 'needs-password')
        .map(item => ({ loginId: item.id, origin: item.origin, label: item.label, username: item.username }));
    },
    agentLogin(loginId, workspaceId) {
      if (closed || damaged) return null;
      const login = logins.find(item => item.id === loginId);
      return login && login.agentUse && login.workspaceIds.includes(workspaceId) ? { loginId: login.id, origin: login.origin, username: login.username, label: login.label } : null;
    },
    close() { closed = true; states.clear(); },
  });
}
