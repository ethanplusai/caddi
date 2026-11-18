import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId } from '../contracts.mjs';
import { createDownloadJournal } from './journal.mjs';
import { DOWNLOAD_LIMITS, downloadJournalRows, safeDownloadName } from './model.mjs';

export { safeDownloadName } from './model.mjs';

const fail = (code, message = 'Download action is unavailable') => { throw new CaddiError(code, message); };
const ACTIVE_LIMIT = DOWNLOAD_LIMITS.active, TOTAL_LIMIT = DOWNLOAD_LIMITS.records;
const activeStatus = status => ['choosing', 'progressing', 'paused', 'interrupted', 'cancelling'].includes(status);
const safeBytes = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const safeHistoryError = error => /^DOWNLOAD_HISTORY_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'DOWNLOAD_HISTORY_UNAVAILABLE';
function syncFence(callback) {
  if (typeof callback !== 'function') fail('DOWNLOAD_CONTEXT_CHANGED');
  const allowed = callback();
  if (allowed instanceof Promise) void allowed.catch(() => {});
  if (allowed !== true && allowed !== undefined) fail('DOWNLOAD_CONTEXT_CHANGED');
}
/** A download journal is ordinary local metadata. It never stores credentials,
 * request URLs, HTTP validators or native resume parameters. */
export async function createPersistentDownloadManager({ directory, workspaceIdentity, ...callbacks } = {}) {
  if (typeof workspaceIdentity !== 'function') fail('INVALID_ARGUMENT');
  let journal = null, historyErrorCode = null, restoredRows = [];
  try {
    journal = await createDownloadJournal({ directory, workspaceIdentity });
    const snapshot = journal.snapshot(); historyErrorCode = snapshot.errorCode; restoredRows = snapshot.records;
  } catch (error) { historyErrorCode = safeHistoryError(error); }
  return createDownloadManager({ ...callbacks, journal, workspaceIdentity, restoredRows, historyErrorCode, persistentHistory: true });
}

/** Host-only manager. Pages and MCP clients never receive native items or paths. */
export function createDownloadManager({ onChange = () => {}, onNotice = () => {}, revealFile = () => {}, testSavePath = null,
  journal = null, workspaceIdentity = null, restoredRows = [], historyErrorCode = null, persistentHistory = false } = {}) {
  if (typeof onChange !== 'function' || typeof onNotice !== 'function' || typeof revealFile !== 'function' ||
      (testSavePath !== null && typeof testSavePath !== 'function') ||
      (workspaceIdentity !== null && typeof workspaceIdentity !== 'function') ||
      (journal !== null && !['replace', 'snapshot', 'status', 'flush', 'close'].every(key => typeof journal[key] === 'function'))) fail('INVALID_ARGUMENT');
  const records = new Map(), dismissedHistory = new Set();
  let closing = false, closeTask = null;
  let dirtyVersion = 0, savedVersion = 0, historyTimer = null, historyTask = null, historyError = historyErrorCode, notifiedError = null;
  function currentIdentity(workspaceId) {
    if (!workspaceIdentity) return null;
    let value;
    try { value = workspaceIdentity(workspaceId); } catch { return null; }
    if (value instanceof Promise) void value.catch(() => {});
    if (typeof value !== 'string') return null;
    try { return assertId(value); } catch { return null; }
  }
  const currentRecord = record => !workspaceIdentity || currentIdentity(record.workspaceId) === record.identityId;
  for (const row of downloadJournalRows(restoredRows).sort((a, b) => a.createdAt - b.createdAt)) {
    if (!workspaceIdentity || currentIdentity(row.workspaceId) !== row.identityId) continue;
    records.set(row.id, { ...row, item: null, status: row.state === 'active' ? 'interrupted' : row.state,
      identity: row.fileIdentity, terminal: true, restored: true, done: Promise.resolve(), resolveDone() {},
      historyGuard: () => true, historyBlocked: false,
      error: row.state === 'active' ? 'Download stopped when Caddi closed. Start a new download from the page.' :
        row.state === 'interrupted' ? 'Transfer interrupted. Start a new download from the page.' :
        row.state === 'failed' ? 'Download did not complete.' : null });
    if (row.state === 'active') dirtyVersion++;
  }
  function historyStatus() {
    const status = journal?.status();
    return { available: !!status?.available && !historyError, persistent: persistentHistory || !!journal,
      errorCode: historyError ?? status?.errorCode ?? null };
  }
  function notify() { try { onChange(); } catch {} }
  function historyEligible(record) {
    if (record.historyBlocked) return false;
    let allowed;
    try { allowed = record.historyGuard?.(); } catch {}
    if (allowed instanceof Promise) void allowed.catch(() => {});
    // This is a main-process provenance callback, never a renderer assertion.
    // An initially private download cannot become public after Resume.
    if (allowed !== true) record.historyBlocked = true;
    return !record.historyBlocked;
  }
  function historyProjection() {
    const previousRows = journal.snapshot().records;
    // RAM retention is separate from disk retention: a run of private transfers
    // may evict visible session rows, but must not erase prior public history.
    const projected = new Map(previousRows.filter(row => !dismissedHistory.has(row.id)).map(row => [row.id, row]));
    const bindings = new Map();
    for (const record of records.values()) {
      if (!record.identityId || !currentRecord(record)) continue;
      const live = historyEligible(record);
      if (!live) {
        // Keep only the last safely committed public version. A later private
        // takeover must neither publish fresh paths/progress nor erase history.
        if (projected.has(record.id)) bindings.set(record.id, { record, live: false });
        continue;
      }
      const usablePath = record.status === 'completed' && record.completedPath && record.identity &&
        !/[\u0000-\u001f\u007f]/u.test(record.completedPath) && record.completedPath.length <= 4096;
      projected.set(record.id, { id: record.id, workspaceId: record.workspaceId, identityId: record.identityId, tabId: record.tabId,
        name: record.name, state: record.terminal ? record.status : 'active', receivedBytes: record.receivedBytes,
        totalBytes: record.totalBytes, createdAt: record.createdAt,
        completedPath: usablePath ? record.completedPath : null, fileIdentity: usablePath ? record.identity : null });
      bindings.set(record.id, { record, live: true });
    }
    const rows = [...projected.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-TOTAL_LIMIT);
    return { rows, unchanged: JSON.stringify(rows) === JSON.stringify(previousRows),
      beforeCommit: () => rows.every(row => {
        if (dismissedHistory.has(row.id)) return false;
        const binding = bindings.get(row.id);
        return !binding || (records.get(row.id) === binding.record && currentRecord(binding.record) &&
          (!binding.live || historyEligible(binding.record)));
      }) };
  }
  function scheduleHistory() {
    if (!journal?.status().available || historyTimer || historyTask) return;
    historyTimer = setTimeout(() => { historyTimer = null; void saveHistory(); }, 250);
  }
  function emit() { dirtyVersion++; scheduleHistory(); notify(); }
  function saveHistory() {
    clearTimeout(historyTimer); historyTimer = null;
    if (historyTask) return historyTask;
    if (!journal?.status().available || dirtyVersion === savedVersion) return Promise.resolve(historyStatus());
    let attemptedVersion = dirtyVersion;
    historyTask = (async () => {
      // At most one writer and one coalesced latest snapshot. Progress events do
      // not create an unbounded queue of filesystem writes.
      let scopeRetries = 0;
      for (let attempt = 0; attempt < 2 && dirtyVersion !== savedVersion; attempt++) {
        attemptedVersion = dirtyVersion;
        const projection = historyProjection();
        try {
          // Private-only activity does not even create a journal or revision.
          if (!projection.unchanged) await journal.replace(projection.rows, { beforeCommit: projection.beforeCommit });
        } catch (error) {
          if (error.code === 'DOWNLOAD_HISTORY_SCOPE_CHANGED' && scopeRetries++ < 2) { attempt--; continue; }
          throw error;
        }
        savedVersion = attemptedVersion; historyError = null; notifiedError = null;
        const retainedIds = new Set(journal.snapshot().records.map(row => row.id));
        for (const id of dismissedHistory) if (!retainedIds.has(id)) dismissedHistory.delete(id);
      }
    })().catch(error => {
      historyError = safeHistoryError(error);
      if (notifiedError !== historyError) {
        notifiedError = historyError;
        try { onNotice('Download history could not be saved. Current transfers are still available in this session.'); } catch {}
      }
    }).finally(() => {
      historyTask = null; notify();
      if (!closing && !historyError && dirtyVersion !== savedVersion && dirtyVersion !== attemptedVersion) scheduleHistory();
    });
    return historyTask;
  }
  async function flush() {
    clearTimeout(historyTimer); historyTimer = null;
    for (let attempt = 0; attempt < 4 && journal?.status().available && dirtyVersion !== savedVersion; attempt++) {
      await saveHistory(); if (historyError) break;
    }
    await journal?.flush(); return historyStatus();
  }
  if (dirtyVersion) scheduleHistory();
  function publicRow(record) {
    const item = record.item;
    let canResume = false;
    if (item && (record.status === 'paused' || record.status === 'interrupted' || record.status === 'progressing')) {
      try { canResume = item.canResume() === true && !!item.getETag() && !!item.getLastModifiedTime(); } catch {}
    }
    return { id: record.id, workspaceId: record.workspaceId, tabId: record.tabId, name: record.name,
      status: record.status, receivedBytes: record.receivedBytes, totalBytes: record.totalBytes, createdAt: record.createdAt, restored: record.restored === true,
      canPause: record.status === 'progressing' && canResume, canResume: ['paused', 'interrupted'].includes(record.status) && canResume,
      canCancel: !!item && !record.terminal && activeStatus(record.status) && record.status !== 'cancelling',
      canReveal: record.terminal && record.status === 'completed' && !!record.completedPath,
      canDismiss: record.terminal, error: record.error ?? (record.status === 'interrupted' && !record.terminal ?
        canResume ? 'Transfer interrupted. Resume or cancel this download.' : 'Transfer interrupted. Cancel to end this download.' : null) };
  }
  function list(workspaceId) {
    assertId(workspaceId);
    return [...records.values()].filter(record => record.workspaceId === workspaceId && currentRecord(record))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, TOTAL_LIMIT).map(publicRow);
  }
  function requireRecord({ workspaceId, downloadId }) {
    assertKeys({ workspaceId, downloadId }, ['workspaceId', 'downloadId'], ['workspaceId', 'downloadId']);
    assertId(workspaceId); assertId(downloadId);
    const record = records.get(downloadId);
    if (!record || record.workspaceId !== workspaceId || !currentRecord(record)) fail('DOWNLOAD_NOT_FOUND');
    return record;
  }
  function accept({ item, workspaceId, tabId, historyGuard = null }) {
    if (closing) fail('DOWNLOAD_CLOSED');
    assertId(workspaceId); assertId(tabId);
    const identityId = currentIdentity(workspaceId);
    if (workspaceIdentity && !identityId) fail('DOWNLOAD_WORKSPACE_UNAVAILABLE');
    if (historyGuard !== null && typeof historyGuard !== 'function') fail('INVALID_ARGUMENT');
    if (!item || typeof item.setSaveDialogOptions !== 'function' || typeof item.once !== 'function') fail('INVALID_ARGUMENT');
    if ([...records.values()].filter(record => !record.terminal).length >= ACTIVE_LIMIT) fail('DOWNLOAD_CAPACITY');
    if (records.size >= TOTAL_LIMIT) {
      const oldest = [...records.values()].find(record => record.terminal);
      if (!oldest) fail('DOWNLOAD_CAPACITY');
      records.delete(oldest.id);
    }
    const record = { id: 'download-' + randomUUID(), workspaceId, identityId, tabId, item, name: safeDownloadName(item.getFilename()),
      status: 'choosing', receivedBytes: 0, totalBytes: 0, createdAt: Date.now(), completedPath: null,
      identity: null, error: null, terminal: false, done: null, resolveDone: null, historyGuard, historyBlocked: false };
    historyEligible(record);
    record.done = new Promise(resolve => { record.resolveDone = resolve; });
    try {
      // Electron owns the native Save dialog. No setSavePath is used in normal
      // browsing, so a website cannot select a destination or overwrite one.
      item.setSaveDialogOptions({ title: 'Save download', defaultPath: record.name,
        properties: process.platform === 'linux' ? ['showOverwriteConfirmation'] : [] });
      if (testSavePath) {
        const selected = testSavePath({ workspaceId, tabId, name: record.name });
        if (typeof selected !== 'string' || !path.isAbsolute(selected)) fail('INVALID_PATH');
        item.setSavePath(selected);
      }
      item.on('updated', (_event, state) => {
        if (!records.has(record.id) || !record.item || record.status === 'cancelling') return;
        record.receivedBytes = safeBytes(item.getReceivedBytes());
        record.totalBytes = safeBytes(item.getTotalBytes());
        record.status = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        emit();
      });
      item.once('done', (_event, state) => {
        void (async () => {
          record.receivedBytes = safeBytes(item.getReceivedBytes());
          record.totalBytes = safeBytes(item.getTotalBytes());
          record.item = null;
          if (state === 'completed') {
            try {
              const selected = item.getSavePath();
              if (typeof selected !== 'string' || !path.isAbsolute(selected)) fail('DOWNLOAD_PATH_UNAVAILABLE');
              const real = await fs.realpath(selected), info = await fs.lstat(real);
              if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('DOWNLOAD_PATH_UNAVAILABLE');
              record.completedPath = real;
              record.identity = { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
              record.status = 'completed';
            } catch { record.status = 'failed'; record.error = 'Saved file could not be verified.'; }
          } else {
            record.status = state === 'cancelled' ? 'cancelled' : 'interrupted';
            record.error = state === 'interrupted' ? 'Transfer interrupted. Start a new download from the page.' : null;
          }
          record.terminal = true; record.resolveDone(); emit();
        })().catch(() => { record.item = null; record.status = 'failed'; record.error = 'Download status is unavailable.'; record.terminal = true; record.resolveDone(); emit(); });
      });
      records.set(record.id, record); emit(); return record.id;
    } catch (error) { record.resolveDone(); throw error; }
  }
  function control(raw) {
    assertKeys(raw, ['workspaceId', 'downloadId', 'operation'], ['workspaceId', 'downloadId', 'operation']);
    const record = requireRecord(raw), item = record.item;
    if (!['pause', 'resume', 'cancel', 'dismiss'].includes(raw.operation)) fail('INVALID_ARGUMENT');
    const row = publicRow(record);
    if (raw.operation === 'dismiss') {
      if (!record.terminal) fail('DOWNLOAD_ACTIVE');
      if (journal?.snapshot().records.some(row => row.id === record.id)) dismissedHistory.add(record.id);
      records.delete(record.id); emit(); return true;
    }
    if (!item) fail('DOWNLOAD_FINISHED');
    if (raw.operation === 'cancel') {
      if (!row.canCancel) fail('DOWNLOAD_FINISHED');
      record.status = 'cancelling'; item.cancel(); emit(); return true;
    }
    if (raw.operation === 'pause') {
      if (!row.canPause) fail('DOWNLOAD_NOT_RESUMABLE');
      item.pause(); record.status = 'paused'; emit(); return true;
    }
    if (!row.canResume) fail('DOWNLOAD_NOT_RESUMABLE');
    item.resume(); record.status = 'progressing'; emit(); return true;
  }
  async function reveal(raw, { beforeReveal = () => true } = {}) {
    assertKeys(raw, ['workspaceId', 'downloadId'], ['workspaceId', 'downloadId']);
    const record = requireRecord(raw);
    syncFence(beforeReveal);
    if (record.status !== 'completed' || !record.completedPath || !record.identity) fail('DOWNLOAD_NOT_READY');
    const info = await fs.lstat(record.completedPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        info.dev !== record.identity.dev || info.ino !== record.identity.ino || info.birthtimeMs !== record.identity.birthtimeMs ||
        await fs.realpath(record.completedPath) !== record.completedPath) fail('DOWNLOAD_FILE_CHANGED');
    if (requireRecord(raw) !== record) fail('DOWNLOAD_CONTEXT_CHANGED');
    syncFence(beforeReveal);
    await revealFile(record.completedPath);
    return true;
  }
  async function cancelWorkspace(workspaceId) {
    assertId(workspaceId);
    const pending = [...records.values()].filter(record => record.workspaceId === workspaceId && !record.terminal);
    for (const record of pending) if (record.item) {
      try { record.status = 'cancelling'; record.item.cancel(); } catch {}
    }
    emit();
    if (pending.length) {
      let timer;
      try {
        await Promise.race([Promise.all(pending.map(record => record.done)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new CaddiError('DOWNLOAD_STOP_PENDING', 'Download cancellation is still pending')), 5000); })]);
      } finally { clearTimeout(timer); }
    }
  }
  function close() {
    if (!closeTask) closeTask = (async () => {
      closing = true;
      const pending = [...records.values()].filter(record => !record.terminal);
      for (const record of pending) {
        if (record.item) try { record.status = 'cancelling'; record.item.cancel(); } catch {}
      }
      emit();
      if (pending.length) {
        let timer;
        try {
          await Promise.race([Promise.all(pending.map(record => record.done)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new CaddiError('DOWNLOAD_STOP_PENDING', 'Download cancellation is still pending')), 5000); })]);
        } finally { clearTimeout(timer); }
      }
      await flush(); await journal?.close(); clearTimeout(historyTimer); historyTimer = null;
    })().catch(error => { closing = false; closeTask = null; throw error; });
    return closeTask;
  }
  return Object.freeze({ accept, list, control, reveal, cancelWorkspace, close, flush, historyStatus,
    get activeCount() { return [...records.values()].filter(record => !record.terminal).length; } });
}
