import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';

export const HISTORY_LIMITS = Object.freeze({ perWorkspace: 500, total: 5000, bytes: 8 * 1024 * 1024, query: 256, result: 200, dedupeMs: 30_000, queued: 128 });
const DATE_MAX = 8_640_000_000_000_000;
const fail = (code, message) => { throw new CaddiError(code, message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = state => createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
const compare = (a, b) => b.visitedAt - a.visitedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function cleanHistoryURL(value) {
  assertString(value, 'history URL', { min: 1, max: 8192 });
  if (value === 'about:blank') return null;
  if (/[\s\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_URL', 'History URL contains whitespace or controls');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL', 'History URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('INVALID_URL', 'History accepts HTTP(S) without credentials');
  for (const name of [...url.searchParams.keys()]) {
    if (/token|password|passwd|secret|api.?key|authorization|credential|session|jwt|assertion|saml|signature|^sig$|^code$|^state$|^key$|^auth$/i.test(name)) url.searchParams.delete(name);
  }
  url.hash = '';
  if (url.href.length > 8192) fail('INVALID_URL', 'Canonical history URL exceeds bounds');
  return url.href;
}

export function cleanHistoryTitle(value) {
  assertString(value, 'history title', { max: 1024 });
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function historyRecordInput(raw, clock) {
  const input = cloneData(raw, { maxBytes: 16_384 });
  assertKeys(input, ['workspaceId', 'url', 'title', 'visitedAt'], ['workspaceId', 'url', 'title']);
  assertId(input.workspaceId);
  const url = cleanHistoryURL(input.url), title = cleanHistoryTitle(input.title);
  const visitedAt = Object.hasOwn(input, 'visitedAt') ? input.visitedAt : clock();
  assertInteger(visitedAt, 'visitedAt', { max: DATE_MAX });
  return { workspaceId: input.workspaceId, url, title, visitedAt };
}

export const emptyHistory = () => ({ format: 'caddi-history', schemaVersion: 1, revision: 0, visits: [] });
export function encodeHistory(state) {
  return Buffer.from(JSON.stringify(canonical({ format: 'caddi-history-snapshot', schemaVersion: 1, sha256: digest(state), state })) + '\n');
}
export function validateHistory(raw) {
  const state = cloneData(raw, { maxBytes: HISTORY_LIMITS.bytes });
  assertKeys(state, ['format', 'schemaVersion', 'revision', 'visits'], ['format', 'schemaVersion', 'revision', 'visits']);
  if (state.format !== 'caddi-history' || state.schemaVersion !== 1) fail('HISTORY_SCHEMA', 'Unsupported history schema');
  assertInteger(state.revision, 'revision');
  if (!Array.isArray(state.visits) || state.visits.length > HISTORY_LIMITS.total) fail('HISTORY_LIMIT', 'History entry limit exceeded');
  const ids = new Set(), counts = new Map();
  let previous;
  for (const visit of state.visits) {
    assertKeys(visit, ['id', 'workspaceId', 'url', 'title', 'visitedAt', 'visitCount'], ['id', 'workspaceId', 'url', 'title', 'visitedAt', 'visitCount']);
    assertId(visit.id); assertId(visit.workspaceId);
    if (ids.has(visit.id)) fail('HISTORY_CORRUPT', 'Duplicate history identifier');
    ids.add(visit.id);
    if (cleanHistoryURL(visit.url) !== visit.url || cleanHistoryTitle(visit.title) !== visit.title) fail('HISTORY_CORRUPT', 'History metadata is not sanitized');
    assertInteger(visit.visitedAt, 'visitedAt', { max: DATE_MAX });
    assertInteger(visit.visitCount, 'visitCount', { min: 1, max: 1_000_000 });
    const count = (counts.get(visit.workspaceId) ?? 0) + 1; counts.set(visit.workspaceId, count);
    if (count > HISTORY_LIMITS.perWorkspace || (previous && compare(previous, visit) > 0)) fail('HISTORY_CORRUPT', 'History ordering or workspace limit is invalid');
    previous = visit;
  }
  if (encodeHistory(state).length > HISTORY_LIMITS.bytes) fail('HISTORY_LIMIT', 'History byte limit exceeded');
  return state;
}
export function decodeHistory(raw) {
  if (raw.length > HISTORY_LIMITS.bytes) fail('HISTORY_LIMIT', 'History snapshot exceeds bounds');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { fail('HISTORY_CORRUPT', 'History is not valid UTF-8 JSON'); }
  assertKeys(envelope, ['format', 'schemaVersion', 'sha256', 'state'], ['format', 'schemaVersion', 'sha256', 'state']);
  if (envelope.format !== 'caddi-history-snapshot' || envelope.schemaVersion !== 1) fail('HISTORY_SCHEMA', 'Unsupported history snapshot');
  const state = validateHistory(envelope.state);
  if (envelope.sha256 !== digest(state) || !raw.equals(encodeHistory(state))) fail('HISTORY_CORRUPT', 'History checksum or canonical encoding differs');
  return state;
}
function advance(state) {
  if (state.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'History revision is exhausted');
  return state.revision + 1;
}
/** Newest entries survive both count and serialized-byte limits. */
export function constrainHistory(state) {
  const counts = new Map();
  const visits = [...state.visits].sort(compare).filter(visit => {
    const count = (counts.get(visit.workspaceId) ?? 0) + 1; counts.set(visit.workspaceId, count);
    return count <= HISTORY_LIMITS.perWorkspace;
  }).slice(0, HISTORY_LIMITS.total);
  const next = { ...state, visits };
  if (encodeHistory(next).length <= HISTORY_LIMITS.bytes) return next;
  let low = 0, high = visits.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodeHistory({ ...next, visits: visits.slice(0, middle) }).length <= HISTORY_LIMITS.bytes) low = middle;
    else high = middle - 1;
  }
  return { ...next, visits: visits.slice(0, low) };
}
export function insertHistory(state, input) {
  const prior = state.visits.find(visit => visit.workspaceId === input.workspaceId && visit.url === input.url && Math.abs(visit.visitedAt - input.visitedAt) <= HISTORY_LIMITS.dedupeMs);
  const visit = { id: prior?.id ?? 'history-' + randomUUID(), workspaceId: input.workspaceId, url: input.url,
    title: prior && prior.visitedAt > input.visitedAt ? prior.title : input.title,
    visitedAt: Math.max(prior?.visitedAt ?? 0, input.visitedAt), visitCount: Math.min(1_000_000, (prior?.visitCount ?? 0) + 1) };
  const next = constrainHistory({ ...state, revision: advance(state), visits: [visit, ...state.visits.filter(item => item.id !== visit.id)] });
  if (!next.visits.some(item => item.id === visit.id)) return { state, visit: null };
  return { state: next, visit };
}
export function deleteHistory(state, predicate) {
  const visits = state.visits.filter(visit => !predicate(visit));
  if (visits.length === state.visits.length) return { state, removed: 0 };
  return { state: { ...state, revision: advance(state), visits }, removed: state.visits.length - visits.length };
}
