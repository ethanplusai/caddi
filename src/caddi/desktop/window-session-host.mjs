import { randomUUID } from 'node:crypto';
import { planWindowSessionRestore } from './window-session-store.mjs';

/** Durable-window topology only. Native views are created lazily by the caller. */
export async function createWindowSessionHost({ store, durableWorkspaceLookup, displays, contexts, onChange = () => {}, delayMs = 150 } = {}) {
  let state = null, errorCode = null, started = false, closed = false, timer = null, tail = Promise.resolve(), again = false, saving = false;
  let focusedKey = null, desired = null, desiredVersion = 0;
  let plan = { windows: [], skipped: [], focusedWindowKey: null, revision: 0 };
  try {
    state = await store.load();
    plan = planWindowSessionRestore(state, { durableWorkspaceLookup, displays });
    focusedKey = plan.focusedWindowKey;
  } catch (error) { errorCode = error.code ?? 'WINDOW_SESSION_UNAVAILABLE'; }
  function eligible(id, identityId) {
    let workspace;
    try { workspace = durableWorkspaceLookup(id); } catch { return null; }
    if (workspace instanceof Promise) { void workspace.catch(() => {}); return null; }
    return workspace?.id === id && workspace.persistence === 'durable' && workspace.lifecycle?.status !== 'archived' &&
      workspace.identityId === identityId ? workspace : null;
  }
  function projection() {
    const windows = [];
    for (const context of contexts()) {
      if (context.privateScopeId || context.closing || context.destroying || context.window.isDestroyed() || !context.workspaceId) continue;
      const workspace = eligible(context.workspaceId, context.workspaceIdentityId);
      if (!workspace) continue;
      if (!context.windowKey) context.windowKey = 'window-' + randomUUID();
      windows.push({ windowKey: context.windowKey, workspaceId: workspace.id, identityId: workspace.identityId,
        bounds: context.window.isMaximized() ? context.window.getNormalBounds() : context.window.getBounds(), maximized: context.window.isMaximized() });
    }
    return { windows, focusedWindowKey: windows.some(item => item.windowKey === focusedKey) ? focusedKey : windows[0]?.windowKey ?? null };
  }
  function remember() {
    if (!started || closed || errorCode) return desired;
    const live = projection();
    let next = null;
    if (live.windows.length) {
      next = { selected: live, bindings: live.windows.map(row => ({ workspaceId: row.workspaceId, identityId: row.identityId,
        generation: eligible(row.workspaceId, row.identityId)?.lifecycle?.generation ?? 0 })) };
    } else if (desired) {
      // Keep the most recent nonempty normal topology, not an older debounced
      // save. An identity or lifecycle change invalidates the retained intent.
      const bindings = desired.bindings.filter(binding => {
        const workspace = eligible(binding.workspaceId, binding.identityId);
        return workspace && (workspace.lifecycle?.generation ?? 0) === binding.generation;
      });
      const rows = desired.selected.windows.filter(row => bindings.some(binding => binding.workspaceId === row.workspaceId));
      if (rows.length) next = { selected: { windows: rows, focusedWindowKey: rows.some(row => row.windowKey === desired.selected.focusedWindowKey) ?
        desired.selected.focusedWindowKey : rows[0].windowKey }, bindings };
    }
    if (JSON.stringify(next) !== JSON.stringify(desired)) { desired = next; desiredVersion++; }
    return desired;
  }
  async function persist() {
    if (!started || closed || errorCode || !state) return;
    remember();
    if (saving) { again = true; return tail; }
    saving = true;
    tail = (async () => {
      let attempts = 0;
      do {
        attempts++;
        again = false;
        const intent = remember(), version = desiredVersion;
        // Closing the last normal window while a private one survives is not an
        // instruction to erase the saved normal session.
        if (!intent) continue;
        const selected = intent.selected;
        const signature = JSON.stringify(selected);
        if (JSON.stringify({ windows: state.windows, focusedWindowKey: state.focusedWindowKey }) === signature) continue;
        try {
          state = await store.save({ expectedRevision: state.revision, ...selected }, { beforeCommit: () => {
            remember();
            return !closed && desired !== null && desiredVersion === version;
          } });
        } catch (error) {
          if (error.code === 'WINDOW_SESSION_AUTHORITY_CHANGED') {
            remember();
            if (desiredVersion !== version) { again = desired !== null; continue; }
            // An unexplained authority rejection must not retry the same intent
            // forever. Preserve the source and wait for an explicit restart.
          }
          errorCode = error.code ?? 'WINDOW_SESSION_UNAVAILABLE'; onChange(); break;
        }
      } while (again && attempts < 4 && !closed && !errorCode);
      if (again && !closed && !errorCode) changed();
    })().finally(() => { saving = false; });
    return tail;
  }
  function changed() {
    if (!started || closed || errorCode) return;
    remember();
    clearTimeout(timer); timer = setTimeout(() => { timer = null; void persist(); }, delayMs);
  }
  return Object.freeze({
    plan: structuredClone(plan),
    start() { started = true; changed(); },
    changed,
    focus(context) { if (!context?.privateScopeId && context?.windowKey) { focusedKey = context.windowKey; changed(); } },
    snapshot() { return { available: !errorCode, errorCode, revision: state?.revision ?? null,
      restoredWindows: plan.windows.length, deferredWindows: contexts().filter(context => !context.privateScopeId && context.needsHydration).length }; },
    async flush() { clearTimeout(timer); timer = null; await persist(); await tail; },
    async close() { clearTimeout(timer); timer = null; await persist(); await tail; closed = true; await store.flush().catch(error => { errorCode ??= error.code ?? 'WINDOW_SESSION_UNAVAILABLE'; }); },
  });
}
