import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys } from '../contracts.mjs';
import { stateDigest } from '../state/store.mjs';

const fail = code => { throw new CaddiError(code, 'Organization transfer is unavailable'); };
const FORMATS = new Set(['caddi', 'bookmarks']), SECTIONS = new Set(['mappings', 'skipped', 'redactions']);
const MAX_REVIEWS = 8, MAX_BYTES = 32 * 1024 * 1024, LIFETIME = 5 * 60_000, PAGE_SIZE = 20;
const safeName = file => path.basename(file).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, 240) || 'Organization export';
const sync = callback => {
  const result = callback();
  if (result instanceof Promise) void result.catch(() => {});
  if (result !== true && result !== undefined) fail('PORTABILITY_REVIEW_STALE');
  return true;
};
const safeError = error => /^PORTABILITY_[A-Z_]+$/u.test(error?.code ?? '') ? error.code :
  ['WORKSPACE_CAPACITY', 'TAB_CAPACITY', 'CHROME_RECOVERY_REQUIRED', 'PRIVACY_BLOCKED'].includes(error?.code) ? error.code :
    ['REVISION_CONFLICT', 'TAB_RESERVATION_STALE'].includes(error?.code) ? 'PORTABILITY_REVISION_STALE' : 'PORTABILITY_UNAVAILABLE';

/** Main-only receipts. File paths, source bytes, remapped metadata and native
 * dialog ownership never enter renderer-controlled arguments or snapshots. */
export function createPortabilityHost({ getState, captureOwner, chooseImportFile, chooseExportFile,
  captureSource, prepareImport, prepareExport, inspectCapacity, publishImport, saveExport,
  onChange = () => {}, now = Date.now, id = randomUUID } = {}) {
  if (![getState, captureOwner, chooseImportFile, chooseExportFile, captureSource, prepareImport, prepareExport,
    inspectCapacity, publishImport, saveExport, onChange, now, id].every(value => typeof value === 'function')) fail('INVALID_ARGUMENT');
  const owners = new Map(), tasks = new Set(); let closed = false, recoveryRequired = false, nativeDialog = null;
  const notify = () => { try { onChange(); } catch {} };
  const track = operation => {
    const task = Promise.resolve().then(operation); tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {}); return task;
  };
  const settle = async () => { while (tasks.size) await Promise.allSettled([...tasks]); };
  const format = value => { if (!FORMATS.has(value)) fail('INVALID_ARGUMENT'); return value; };
  const bytesHeld = () => [...owners.values()].reduce((total, item) => total + (item.bytesHeld ?? 0), 0);
  function dispose(item) {
    if (owners.get(item.owner) === item) owners.delete(item.owner);
    clearTimeout(item.timer); item.timer = null;
    try { item.source?.dispose(); } catch {}
    item.source = null; item.plan = null; item.exported?.bytes?.fill(0); item.exported = null; item.bytesHeld = 0;
    notify();
  }
  function invalidate(owner) {
    const item = owners.get(owner); if (!item) return;
    item.revoked = true;
    if (!item.busy) dispose(item); else notify();
  }
  function check(item, { permitBusy = true, source = false, base = false } = {}) {
    if (closed || !item || owners.get(item.owner) !== item || item.revoked || now() >= item.expiresAt) fail('PORTABILITY_REVIEW_STALE');
    if (!permitBusy && item.busy) fail('PORTABILITY_BUSY');
    sync(item.binding.assertCurrent);
    if (source) sync(item.source.assertCurrent);
    if (base && (getState().revision !== item.baseRevision || stateDigest(getState()) !== item.baseDigest)) fail('PORTABILITY_REVISION_STALE');
    return true;
  }
  function begin(owner, kind, value, workspaceIds = []) {
    if (closed) fail('PORTABILITY_UNAVAILABLE');
    if (kind === 'import' && recoveryRequired) fail('PORTABILITY_RECOVERY_REQUIRED');
    format(value);
    const previous = owners.get(owner);
    if (previous?.busy) fail('PORTABILITY_BUSY');
    if (previous) dispose(previous);
    if (owners.size >= MAX_REVIEWS) fail('PORTABILITY_BUSY');
    const binding = captureOwner(owner, { kind, workspaceIds: [...workspaceIds] });
    if (!binding || typeof binding.assertCurrent !== 'function') { if (binding instanceof Promise) void binding.catch(() => {}); fail('PORTABILITY_UNAVAILABLE'); }
    sync(binding.assertCurrent);
    const item = { owner, binding, kind, format: value, reviewId: assertId('portability-' + id()), generation: 1,
      phase: 'choosing', busy: false, revoked: false, expiresAt: now() + LIFETIME, timer: null, bytesHeld: 0 };
    owners.set(owner, item);
    item.timer = setTimeout(() => invalidate(owner), LIFETIME); item.timer.unref?.(); notify(); return item;
  }
  function account(item, size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || bytesHeld() - item.bytesHeld + size > MAX_BYTES) fail('PORTABILITY_CAPACITY');
    item.bytesHeld = size;
  }
  function details(item) {
    const value = item.plan ?? item.exported;
    return Object.fromEntries([...SECTIONS].map(section => [section, value.details?.[section] ?? []]));
  }
  function review(item) {
    check(item);
    const value = item.plan ?? item.exported, capacity = item.capacity;
    return { reviewId: item.reviewId, generation: item.generation, kind: item.kind, format: item.format,
      expiresAt: item.expiresAt, baseRevision: item.baseRevision, sourceName: item.source?.sourceName ?? null,
      counts: structuredClone(value.counts), warnings: [...(value.warnings ?? [])], capacity: structuredClone(capacity),
      canApply: capacity.fits && (item.kind === 'export' || value.workspaceIds.length > 0),
      details: Object.fromEntries(Object.entries(details(item)).map(([section, rows]) => [section, { total: rows.length }])) };
  }
  function locate(owner, input) {
    assertId(input.reviewId); assertInteger(input.generation, 'review generation', { min: 1 });
    const item = owners.get(owner);
    if (!item || item.reviewId !== input.reviewId || item.generation !== input.generation) fail('PORTABILITY_REVIEW_STALE');
    check(item, { permitBusy: false }); if (item.phase !== 'review') fail('PORTABILITY_REVIEW_STALE'); return item;
  }
  function validateReport(value) {
    if (!value || !value.counts || !value.details || !Array.isArray(value.warnings) || value.warnings.length > 64) fail('PORTABILITY_UNAVAILABLE');
    let bytes = 0;
    for (const section of SECTIONS) {
      const rows = value.details[section];
      if (!Array.isArray(rows) || rows.length > 10000) fail('PORTABILITY_CAPACITY');
      for (const row of rows) { if (typeof row !== 'string' || row.length > 8192) fail('PORTABILITY_CAPACITY'); bytes += Buffer.byteLength(row); }
    }
    for (const warning of value.warnings) if (typeof warning !== 'string' || warning.length > 2048) fail('PORTABILITY_CAPACITY');
    for (const name of ['workspaces', 'groups', 'folders', 'tabs', 'layouts']) assertInteger(value.counts[name], 'count', { min: 0, max: 10000 });
    if (bytes > 10 * 1024 * 1024) fail('PORTABILITY_CAPACITY');
    return bytes;
  }
  async function chooseImport(owner, input) {
    assertKeys(input, ['format'], ['format']);
    if (nativeDialog) fail('PORTABILITY_BUSY');
    const item = begin(owner, 'import', input.format); item.busy = true; nativeDialog = item;
    try {
      check(item);
      const file = await chooseImportFile(owner, { format: item.format, assertCurrent: () => check(item) });
      if (!file) { dispose(item); return { canceled: true }; }
      check(item);
      item.source = await captureSource(file); check(item, { source: true });
      if (!Buffer.isBuffer(item.source.bytes)) fail('PORTABILITY_SOURCE_INVALID');
      const base = getState(); item.baseRevision = base.revision; item.baseDigest = stateDigest(base);
      item.plan = prepareImport({ format: item.format, bytes: item.source.bytes, targetState: base, importId: item.reviewId, now: now() });
      const detailBytes = validateReport(item.plan);
      if (item.plan.baseRevision !== item.baseRevision || item.plan.baseDigest !== item.baseDigest ||
          stateDigest(item.plan.nextState) !== item.plan.nextDigest) fail('PORTABILITY_PLAN_INVALID');
      account(item, item.source.bytes.byteLength + detailBytes + Buffer.byteLength(JSON.stringify(item.plan.nextState)));
      item.capacity = inspectCapacity(item.plan.nextState); item.phase = 'review'; item.busy = false;
      check(item, { source: true, base: true }); notify(); return review(item);
    } catch (error) { dispose(item); fail(safeError(error)); }
    finally { item.busy = false; if (nativeDialog === item) nativeDialog = null; if (item.revoked) dispose(item); }
  }
  function reviewExport(owner, input) {
    assertKeys(input, ['format', 'workspaceIds'], ['format', 'workspaceIds']);
    if (!Array.isArray(input.workspaceIds) || input.workspaceIds.length < 1 || input.workspaceIds.length > 32 || new Set(input.workspaceIds).size !== input.workspaceIds.length) fail('INVALID_ARGUMENT');
    for (const workspaceId of input.workspaceIds) assertId(workspaceId);
    const item = begin(owner, 'export', input.format, input.workspaceIds);
    try {
      const base = getState(); item.baseRevision = base.revision; item.baseDigest = stateDigest(base);
      item.exported = prepareExport({ format: item.format, state: base, workspaceIds: [...input.workspaceIds] });
      const detailBytes = validateReport(item.exported);
      if (!Buffer.isBuffer(item.exported.bytes)) fail('PORTABILITY_PLAN_INVALID');
      item.exported = { ...item.exported, bytes: Buffer.from(item.exported.bytes) }; account(item, item.exported.bytes.byteLength + detailBytes);
      item.capacity = inspectCapacity(null); item.phase = 'review'; notify(); return review(item);
    } catch (error) { dispose(item); fail(safeError(error)); }
  }
  function page(owner, input) {
    assertKeys(input, ['reviewId', 'generation', 'section', 'offset'], ['reviewId', 'generation', 'section', 'offset']);
    const item = locate(owner, input);
    if (!SECTIONS.has(input.section)) fail('INVALID_ARGUMENT');
    assertInteger(input.offset, 'review offset', { min: 0, max: 10000 });
    const rows = details(item)[input.section];
    if (input.offset % PAGE_SIZE || input.offset > rows.length) fail('INVALID_ARGUMENT');
    return { reviewId: item.reviewId, generation: item.generation, section: input.section, offset: input.offset, total: rows.length,
      rows: rows.slice(input.offset, input.offset + PAGE_SIZE).map(label => ({ kind: '', label, detail: '' })) };
  }
  async function applyImport(owner, input) {
    assertKeys(input, ['reviewId', 'generation', 'expectedRevision'], ['reviewId', 'generation', 'expectedRevision']);
    const item = locate(owner, input);
    if (item.kind !== 'import' || recoveryRequired) fail('PORTABILITY_REVIEW_STALE');
    assertInteger(input.expectedRevision, 'reviewed revision', { min: 0 });
    if (input.expectedRevision !== item.baseRevision) fail('PORTABILITY_REVISION_STALE');
    check(item, { source: true, base: true });
    if (!item.plan.workspaceIds.length) fail('PORTABILITY_EMPTY_IMPORT');
    const capacity = inspectCapacity(item.plan.nextState); if (!capacity.fits) fail(capacity.reason ?? 'PORTABILITY_CAPACITY');
    item.busy = true; item.phase = 'applying'; notify();
    try {
      const plan = item.plan;
      const publication = await publishImport({ plan, assertCurrent: () => check(item, { source: true, base: true }) });
      const result = { imported: true, counts: structuredClone(plan.counts), workspaceIds: [...plan.workspaceIds],
        ...(publication?.presentationPending ? { presentationPending: true } : {}) };
      dispose(item); return result;
    } catch (error) {
      if (['COMMIT_OUTCOME_UNKNOWN', 'PORTABILITY_IMPORT_UNCERTAIN'].includes(error?.code)) {
        recoveryRequired = true; dispose(item); fail('PORTABILITY_IMPORT_UNCERTAIN');
      }
      dispose(item); fail(safeError(error));
    } finally { item.busy = false; notify(); }
  }
  async function exportSave(owner, input) {
    assertKeys(input, ['reviewId', 'generation'], ['reviewId', 'generation']);
    const item = locate(owner, input); if (item.kind !== 'export') fail('PORTABILITY_REVIEW_STALE');
    if (nativeDialog) fail('PORTABILITY_BUSY');
    item.busy = true; item.phase = 'saving'; nativeDialog = item; notify();
    try {
      check(item);
      const file = await chooseExportFile(owner, { format: item.format, suggestedName: item.exported.suggestedName,
        extension: item.exported.extension, assertCurrent: () => check(item) });
      if (!file) { item.busy = false; item.phase = 'review'; notify(); return { canceled: true }; }
      check(item);
      await saveExport({ file, bytes: item.exported.bytes, extension: item.exported.extension, assertCurrent: () => check(item) });
      dispose(item); return { saved: true, name: safeName(file) };
    } catch (error) {
      dispose(item);
      if (['PORTABILITY_EXPORT_OUTCOME_UNKNOWN', 'PORTABILITY_EXPORT_UNCERTAIN', 'COMMIT_OUTCOME_UNKNOWN'].includes(error?.code)) fail('PORTABILITY_EXPORT_OUTCOME_UNKNOWN');
      fail(safeError(error));
    } finally { item.busy = false; if (nativeDialog === item) nativeDialog = null; if (item.revoked) dispose(item); }
  }
  return Object.freeze({ chooseImport: (owner, input) => track(() => chooseImport(owner, input)), reviewExport,
    applyImport: (owner, input) => track(() => applyImport(owner, input)),
    exportSave: (owner, input) => track(() => exportSave(owner, input)), page,
    cancel(owner, input) {
      assertKeys(input, ['reviewId', 'generation'], ['reviewId', 'generation']);
      const item = owners.get(owner);
      if (item?.reviewId === input.reviewId && item.generation === input.generation) invalidate(owner);
      return { canceled: true };
    },
    invalidate,
    invalidateAll() { for (const owner of [...owners.keys()]) invalidate(owner); },
    settle,
    summary(owner) { const item = owners.get(owner); return { available: !closed, importAvailable: !closed && !recoveryRequired,
      active: !!item && !item.revoked, phase: item?.phase ?? 'idle', ...(item && !item.revoked ? { reviewId: item.reviewId, generation: item.generation } : {}) }; },
    close() { closed = true; for (const owner of [...owners.keys()]) invalidate(owner); return settle(); },
  });
}
