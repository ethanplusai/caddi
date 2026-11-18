// The Vault's access log: every attempt to use a saved login, by the owner or by an agent, per workspace.
// What it records: when, which workspace, the site, the login's label and username (never the password),
// who (you, or an agent with the name its connection showed when you approved it), what was tried and what
// happened. One small file per workspace in Caddi's data folder, 0600, validated on read, capped, cleared
// only by the owner. Agents have no way to read it, and it is never part of an export.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, assertString, cloneData } from '../contracts.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';
import { VAULT_REASONS } from './vault.mjs';

export const VAULT_ACTIVITY_LIMITS = Object.freeze({ entries: 1000, workspaces: 512, label: 120, username: 256, name: 120, origin: 2048,
  listDefault: 200, listMax: 1000, recentPerLogin: 3, mergeWindowMs: 60_000, count: 100_000 });
const FORMAT = 'caddi-vault-activity', VERSION = 1;
export const VAULT_ACTIONS = Object.freeze(['fill', 'copy', 'reveal']);
export const VAULT_OUTCOMES = Object.freeze(['filled', 'copied', 'shown', 'waiting', 'denied', 'failed']);
export { VAULT_REASONS };
const REASON_CODES = Object.freeze({
  LOGIN_NOT_AVAILABLE: 'switch-off', ACCESS_DENIED: 'not-approved', UNSUPPORTED_OPERATION: 'not-approved',
  LOGIN_CONFIRMATION_PENDING: 'waiting-for-you', LOGIN_NOT_ALLOWED: 'first-use-declined', LOGIN_SITE_MISMATCH: 'origin-mismatch',
  PRIVACY_BLOCKED: 'paused', SYSTEM_PAUSED: 'paused', LOGIN_SECRET_EXPOSED: 'sensitive-context', SENSITIVE_OR_STALE_TARGET: 'sensitive-context',
  LEASE_INVALID: 'no-control', LEASE_EXPIRED: 'no-control', LEASE_BUSY: 'no-control',
  NO_PASSWORD_FIELD: 'no-password-field', AMBIGUOUS_LOGIN_FORM: 'ambiguous-form', STALE_TARGET: 'page-changed', TARGET_NOT_FOUND: 'page-changed',
  KEYCHAIN_LOCKED: 'keychain-locked', KEYCHAIN_UNAVAILABLE: 'keychain-unavailable', LOGIN_PASSWORD_MISSING: 'password-missing',
  PRESENCE_NOT_CONFIRMED: 'presence-not-confirmed', ATTENTION_BUSY: 'too-many-requests', ATTENTION_RATE_LIMIT: 'too-many-requests',
  OUTCOME_UNKNOWN: 'outcome-unknown', CANCELLED: 'cancelled', DEADLINE: 'cancelled',
});
// Reasons that are a rule saying no, as opposed to something that went wrong.
const DENIALS = new Set(['switch-off', 'not-approved', 'first-use-declined', 'origin-mismatch', 'paused', 'sensitive-context', 'no-control',
  'presence-not-confirmed', 'too-many-requests']);

/** The log's outcome and reason for an error code (or a completed result when `code` is null). */
export function activityOutcome(action, code) {
  if (!VAULT_ACTIONS.includes(action)) throw new CaddiError('INVALID_ARGUMENT', 'Unknown Vault action');
  if (code === null || code === undefined) return { outcome: action === 'fill' ? 'filled' : action === 'copy' ? 'copied' : 'shown', reason: null };
  const reason = REASON_CODES[code] ?? 'failed';
  return { outcome: reason === 'waiting-for-you' ? 'waiting' : DENIALS.has(reason) ? 'denied' : 'failed', reason };
}

const fail = code => { throw new CaddiError(code, 'Vault activity could not be used'); };
const plain = (value, label, max, min = 0) => {
  assertString(value, label, { min, max });
  if (/[\u0000-\u001f\u007f‪-‮⁦-⁩]/u.test(value)) fail('INVALID_ARGUMENT');
  return value;
};
function validActor(raw) {
  assertKeys(raw, ['kind', 'agentSessionId', 'name', 'startedBy'], ['kind']);
  if (raw.kind === 'owner') { assertKeys(raw, ['kind'], ['kind']); return { kind: 'owner' }; }
  if (raw.kind !== 'agent') fail('INVALID_ARGUMENT');
  assertKeys(raw, ['kind', 'agentSessionId', 'name', 'startedBy'], ['kind', 'agentSessionId', 'name', 'startedBy']);
  // 'chat' is from a removed feature; a log written then still loads, as an ordinary agent.
  if (!['owner', 'chat'].includes(raw.startedBy)) fail('INVALID_ARGUMENT');
  return { kind: 'agent', agentSessionId: assertId(raw.agentSessionId, 'agentSessionId'), name: plain(raw.name, 'name', VAULT_ACTIVITY_LIMITS.name, 1), startedBy: 'owner' };
}
const ENTRY_KEYS = ['id', 'at', 'loginId', 'origin', 'label', 'username', 'actor', 'action', 'outcome', 'reason', 'count'];
function validEntry(raw) {
  assertKeys(raw, ENTRY_KEYS, ENTRY_KEYS);
  assertId(raw.id); assertInteger(raw.at, 'at'); assertId(raw.loginId, 'loginId');
  plain(raw.origin, 'origin', VAULT_ACTIVITY_LIMITS.origin, 1); plain(raw.label, 'label', VAULT_ACTIVITY_LIMITS.label);
  plain(raw.username, 'username', VAULT_ACTIVITY_LIMITS.username);
  if (!VAULT_ACTIONS.includes(raw.action) || !VAULT_OUTCOMES.includes(raw.outcome)) fail('ACTIVITY_FILE_DAMAGED');
  if (raw.reason !== null && !Object.hasOwn(VAULT_REASONS, raw.reason)) fail('ACTIVITY_FILE_DAMAGED');
  assertInteger(raw.count, 'count', { min: 1, max: VAULT_ACTIVITY_LIMITS.count });
  return { ...raw, actor: validActor(raw.actor) };
}
const sameKind = (a, b) => a.loginId === b.loginId && a.action === b.action && a.outcome === b.outcome && a.reason === b.reason &&
  a.actor.kind === b.actor.kind && a.actor.agentSessionId === b.actor.agentSessionId;

/**
 * Per-workspace access log. `directory` is created 0700; each workspace's log is `<workspaceId>.json`, 0600.
 * A file that fails validation is left alone and reported as damaged; nothing is written over it until the owner clears it.
 */
export function createVaultActivity({ directory, now = Date.now, onChange = () => {} }) {
  ensurePrivateDirectory(directory);
  const cache = new Map(), damaged = new Set();
  const changed = () => { try { onChange(); } catch {} };
  const fileFor = workspaceId => path.join(directory, assertId(workspaceId, 'workspaceId') + '.json');
  function load(workspaceId) {
    if (cache.has(workspaceId)) return cache.get(workspaceId);
    const file = fileFor(workspaceId);
    let entries = [];
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 2_000_000) fail('ACTIVITY_FILE_DAMAGED');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      assertKeys(data, ['format', 'version', 'workspaceId', 'entries'], ['format', 'version', 'workspaceId', 'entries']);
      if (data.format !== FORMAT || data.version !== VERSION || data.workspaceId !== workspaceId || !Array.isArray(data.entries) ||
          data.entries.length > VAULT_ACTIVITY_LIMITS.entries) fail('ACTIVITY_FILE_DAMAGED');
      entries = data.entries.map(validEntry);
      if (new Set(entries.map(item => item.id)).size !== entries.length) fail('ACTIVITY_FILE_DAMAGED');
    } catch (error) {
      if (error.code !== 'ENOENT') { damaged.add(workspaceId); entries = []; }
    }
    if (cache.size >= VAULT_ACTIVITY_LIMITS.workspaces) cache.delete(cache.keys().next().value);
    cache.set(workspaceId, entries);
    return entries;
  }
  function persist(workspaceId, entries) {
    if (damaged.has(workspaceId)) fail('ACTIVITY_FILE_DAMAGED');
    const file = fileFor(workspaceId);
    const body = JSON.stringify({ format: FORMAT, version: VERSION, workspaceId, entries }) + '\n';
    const temporary = path.join(directory, '.' + workspaceId + '.' + randomUUID() + '.tmp');
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    cache.set(workspaceId, entries); changed();
  }
  return Object.freeze({
    /** Adds one entry, or counts a repeat of the same attempt within a minute on the last entry. Never throws to the caller's flow. */
    record(raw) {
      try {
        const value = cloneData(raw, { maxBytes: 8192 });
        // An agent's name is its own unverified text: kept as plain text, never refused for its characters.
        if (value?.actor?.kind === 'agent' && typeof value.actor.name === 'string')
          value.actor.name = value.actor.name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim().slice(0, VAULT_ACTIVITY_LIMITS.name) || 'Agent';
        assertKeys(value, ['workspaceId', 'loginId', 'origin', 'label', 'username', 'actor', 'action', 'outcome', 'reason'],
          ['workspaceId', 'loginId', 'origin', 'label', 'username', 'actor', 'action', 'outcome', 'reason']);
        const time = assertInteger(now(), 'now');
        const entry = validEntry({ id: 'activity-' + randomUUID(), at: time, loginId: value.loginId, origin: value.origin,
          label: String(value.label).slice(0, VAULT_ACTIVITY_LIMITS.label), username: String(value.username).slice(0, VAULT_ACTIVITY_LIMITS.username),
          actor: value.actor, action: value.action, outcome: value.outcome, reason: value.reason, count: 1 });
        const workspaceId = assertId(value.workspaceId, 'workspaceId');
        const entries = load(workspaceId), last = entries[entries.length - 1];
        if (last && sameKind(last, entry) && time - last.at <= VAULT_ACTIVITY_LIMITS.mergeWindowMs && last.count < VAULT_ACTIVITY_LIMITS.count) {
          persist(workspaceId, [...entries.slice(0, -1), { ...last, at: time, count: last.count + 1 }]);
          return { recorded: true, merged: true };
        }
        const next = [...entries, entry];
        persist(workspaceId, next.slice(Math.max(0, next.length - VAULT_ACTIVITY_LIMITS.entries)));
        return { recorded: true, merged: false };
      } catch { return { recorded: false, merged: false }; }
    },
    /** Newest first. Filtered by login when `loginId` is given. Owner only: never wired to any agent operation. */
    list(workspaceId, { loginId = null, limit = VAULT_ACTIVITY_LIMITS.listDefault } = {}) {
      assertId(workspaceId, 'workspaceId');
      if (loginId !== null) assertId(loginId, 'loginId');
      assertInteger(limit, 'limit', { min: 1, max: VAULT_ACTIVITY_LIMITS.listMax });
      const entries = load(workspaceId);
      const matching = loginId ? entries.filter(item => item.loginId === loginId) : entries;
      return { damaged: damaged.has(workspaceId), total: matching.length, entries: matching.slice(-limit).reverse().map(item => cloneData(item)) };
    },
    /** The last few uses of each login, for the login rows. */
    recentByLogin(workspaceId, count = VAULT_ACTIVITY_LIMITS.recentPerLogin) {
      const result = new Map();
      for (const item of [...load(assertId(workspaceId, 'workspaceId'))].reverse()) {
        const list = result.get(item.loginId) ?? [];
        if (list.length < count) { list.push(cloneData(item)); result.set(item.loginId, list); }
      }
      return result;
    },
    damaged: workspaceId => damaged.has(workspaceId),
    /** The owner's Clear: the workspace's log is deleted, including a damaged one. */
    clear(workspaceId) {
      const file = fileFor(workspaceId);
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      damaged.delete(workspaceId); cache.set(workspaceId, []); changed();
      return { cleared: true };
    },
    /** Deletes logs of workspaces that no longer exist, as the workspace's other data goes with it. */
    retain(workspaceIds) {
      const keep = new Set(workspaceIds);
      let removed = 0;
      for (const name of fs.readdirSync(directory)) {
        const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/.exec(name);
        if (match && !keep.has(match[1])) { try { fs.unlinkSync(path.join(directory, name)); removed++; } catch {} cache.delete(match[1]); damaged.delete(match[1]); }
      }
      if (removed) changed();
      return { removed };
    },
  });
}
