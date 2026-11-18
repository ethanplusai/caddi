import path from 'node:path';
import { createHash } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';

export const DOWNLOAD_LIMITS = Object.freeze({ active: 16, records: 128, bytes: 1024 * 1024 });
const fail = code => { throw new CaddiError(code, 'Download history is unavailable'); };
const hash = value => createHash('sha256').update(value).digest('hex');
export function safeDownloadName(value) {
  if (typeof value !== 'string') return 'download';
  let name = value.normalize('NFKC').split(/[\\/]/u).at(-1) ?? '';
  name = name.split(/[?#]/u)[0].replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|*]/gu, '')
    .replace(/^\.+/u, '').replace(/[. ]+$/u, '').trim().slice(0, 120);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^.]+)?$/iu.test(name)) return 'download';
  return name;
}
export function downloadJournalRows(raw) {
  const rows = cloneData(raw, { maxBytes: DOWNLOAD_LIMITS.bytes });
  if (!Array.isArray(rows) || rows.length > DOWNLOAD_LIMITS.records) fail('DOWNLOAD_HISTORY_CAPACITY');
  const ids = new Set();
  return rows.map(row => {
    assertKeys(row, ['id', 'workspaceId', 'identityId', 'tabId', 'name', 'state', 'receivedBytes', 'totalBytes',
      'createdAt', 'completedPath', 'fileIdentity'], ['id', 'workspaceId', 'identityId', 'tabId', 'name', 'state',
      'receivedBytes', 'totalBytes', 'createdAt', 'completedPath', 'fileIdentity']);
    for (const key of ['id', 'workspaceId', 'identityId', 'tabId']) assertId(row[key]);
    if (ids.has(row.id)) fail('DOWNLOAD_HISTORY_INVALID'); ids.add(row.id);
    assertString(row.name, 'download name', { min: 1, max: 120 });
    if (safeDownloadName(row.name) !== row.name || !['active', 'completed', 'interrupted', 'cancelled', 'failed'].includes(row.state))
      fail('DOWNLOAD_HISTORY_INVALID');
    for (const key of ['receivedBytes', 'totalBytes', 'createdAt']) assertInteger(row[key], key);
    if ((row.completedPath === null) !== (row.fileIdentity === null)) fail('DOWNLOAD_HISTORY_INVALID');
    if (row.state !== 'completed' && row.completedPath !== null) fail('DOWNLOAD_HISTORY_INVALID');
    let fileIdentity = null;
    if (row.completedPath !== null) {
      assertString(row.completedPath, 'download path', { min: 1, max: 4096 });
      if (!path.isAbsolute(row.completedPath) || path.normalize(row.completedPath) !== row.completedPath ||
          /[\u0000-\u001f\u007f]/u.test(row.completedPath)) fail('DOWNLOAD_HISTORY_INVALID');
      assertKeys(row.fileIdentity, ['dev', 'ino', 'birthtimeMs'], ['dev', 'ino', 'birthtimeMs']);
      assertInteger(row.fileIdentity.dev, 'device'); assertInteger(row.fileIdentity.ino, 'inode');
      if (!Number.isFinite(row.fileIdentity.birthtimeMs) || row.fileIdentity.birthtimeMs < 0 ||
          row.fileIdentity.birthtimeMs > Number.MAX_SAFE_INTEGER) fail('DOWNLOAD_HISTORY_INVALID');
      fileIdentity = { dev: row.fileIdentity.dev, ino: row.fileIdentity.ino, birthtimeMs: row.fileIdentity.birthtimeMs };
    }
    // Canonical fields deliberately omit request URLs, headers, validators,
    // cookies and any native DownloadItem or resume information.
    return { id: row.id, workspaceId: row.workspaceId, identityId: row.identityId, tabId: row.tabId,
      name: row.name, state: row.state, receivedBytes: row.receivedBytes, totalBytes: row.totalBytes,
      createdAt: row.createdAt, completedPath: row.completedPath, fileIdentity };
  });
}
export function encodeDownloadJournal(revision, raw) {
  assertInteger(revision, 'download history revision');
  const payload = { version: 1, revision, records: downloadJournalRows(raw) };
  const bytes = Buffer.from(JSON.stringify({ ...payload, sha256: hash(JSON.stringify(payload)) }) + '\n');
  if (bytes.length > DOWNLOAD_LIMITS.bytes) fail('DOWNLOAD_HISTORY_CAPACITY');
  return bytes;
}
export function decodeDownloadJournal(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > DOWNLOAD_LIMITS.bytes) fail('DOWNLOAD_HISTORY_INVALID');
  let input; try { input = JSON.parse(bytes.toString('utf8')); } catch { fail('DOWNLOAD_HISTORY_INVALID'); }
  if (input?.version !== 1) fail('DOWNLOAD_HISTORY_VERSION_UNSUPPORTED');
  try {
    assertKeys(input, ['version', 'revision', 'records', 'sha256'], ['version', 'revision', 'records', 'sha256']);
    assertInteger(input.revision, 'download history revision');
    const records = downloadJournalRows(input.records), payload = { version: 1, revision: input.revision, records };
    if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(input.sha256) ||
        hash(JSON.stringify(payload)) !== input.sha256) fail('DOWNLOAD_HISTORY_INVALID');
    return payload;
  } catch { fail('DOWNLOAD_HISTORY_INVALID'); }
}
