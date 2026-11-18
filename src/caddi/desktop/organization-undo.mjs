import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, cloneData } from '../contracts.mjs';
import { applyProductCommand, validateProductState } from '../state/model.mjs';

const fail = code => { throw new CaddiError(code, 'This folder removal can no longer be undone'); };
const MAX_ENTRY_BYTES = 128 * 1024;

/** Session-only inverse metadata; no URL, page state, credential or authority snapshot. */
export function createFolderRemovalUndo({ now = Date.now, maximumEntries = 24, lifetimeMs = 60 * 60 * 1000 } = {}) {
  assertInteger(maximumEntries, 'undo limit', { min: 1, max: 24 });
  assertInteger(lifetimeMs, 'undo lifetime', { min: 1, max: 60 * 60 * 1000 });
  if (typeof now !== 'function') fail('INVALID_ARGUMENT');
  const entries = new Map();
  let closed = false;
  function prune() {
    const time = now(); assertInteger(time, 'undo time', { max: Number.MAX_SAFE_INTEGER - lifetimeMs });
    for (const [id, entry] of entries) if (time >= entry.expiresAt) entries.delete(id);
    return time;
  }
  function restoreCommand(entry, state) {
    const command = cloneData(entry.command, { maxBytes: MAX_ENTRY_BYTES });
    // Missing unrelated siblings only remove an ordering anchor; they are never recreated.
    for (const item of command.folders) if (item.beforeId !== null && !state.folders.some(folder => folder.id === item.beforeId)) item.beforeId = null;
    applyProductCommand(state, command); return command;
  }
  function record(beforeInput, afterInput, folderId) {
    if (closed) fail('CLOSED'); assertId(folderId); const time = prune();
    const before = validateProductState(beforeInput), after = validateProductState(afterInput);
    const root = before.folders.find(folder => folder.id === folderId); if (!root) fail('MISSING_REFERENCE');
    const workspace = before.workspaces.find(item => item.id === root.workspaceId);
    const removed = new Set([root.id]); let changed = true;
    while (changed) { changed = false; for (const folder of before.folders) if (removed.has(folder.parentId) && !removed.has(folder.id)) { removed.add(folder.id); changed = true; } }
    const folders = before.folders.filter(folder => folder.groupId === root.groupId);
    const command = { type: 'folder.restore', workspaceId: root.workspaceId, identityId: workspace.identityId,
      groupId: root.groupId, expectedGeneration: workspace.lifecycle?.generation ?? 0,
      folders: folders.filter(folder => removed.has(folder.id)).map(folder => ({ folder,
        beforeId: folders.slice(folders.indexOf(folder) + 1).find(item => !removed.has(item.id))?.id ?? null })),
      tabFolders: before.tabs.filter(tab => removed.has(tab.folderId)).map(tab => ({ tabId: tab.id, folderId: tab.folderId })) };
    // An oversized inverse is not retained; the already-completed non-destructive removal stays truthful.
    if (Buffer.byteLength(JSON.stringify(command)) > MAX_ENTRY_BYTES) return { available: false, reason: 'UNDO_CAPACITY' };
    if (after.revision <= before.revision) fail('UNDO_STALE');
    const entry = { id: 'undo-' + randomUUID(), command: cloneData(command, { maxBytes: MAX_ENTRY_BYTES }), label: root.name, expiresAt: time + lifetimeMs };
    restoreCommand(entry, after);
    entries.set(entry.id, entry);
    while (entries.size > maximumEntries) entries.delete(entries.keys().next().value);
    return { available: true, id: entry.id };
  }
  function snapshot(state, workspaceId) {
    if (closed) return { available: false }; assertId(workspaceId); prune();
    const candidates = [...entries.values()].reverse().filter(entry => entry.command.workspaceId === workspaceId);
    for (const entry of candidates) {
      try { restoreCommand(entry, state); return { available: true, id: entry.id, label: entry.label }; }
      catch { entries.delete(entry.id); }
    }
    return { available: false };
  }
  function prepare(state, workspaceId, id) {
    if (closed) fail('CLOSED'); assertId(workspaceId); assertId(id); prune();
    const entry = entries.get(id);
    if (!entry || entry.command.workspaceId !== workspaceId) fail('UNDO_STALE');
    return restoreCommand(entry, state);
  }
  return Object.freeze({ record, snapshot, prepare,
    complete(id) { assertId(id); entries.delete(id); },
    forgetWorkspace(workspaceId) { assertId(workspaceId); for (const [id, entry] of entries) if (entry.command.workspaceId === workspaceId) entries.delete(id); },
    close() { closed = true; entries.clear(); } });
}
