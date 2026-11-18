/** Coalesce native page notifications into bounded, document-bound visits. */
export function createDesktopHistoryRecorder({ record, canCommit, onError = () => {}, onChange = () => {},
  now = Date.now, settleMs = 200, maxPending = 64 }) {
  const pending = new Map(), seen = new Map();
  let timer = null, pumping = null, active = null, closed = false, disabled = false, admitted = 0;
  const keyFor = token => JSON.stringify([token.workspaceId, token.tabId, token.runtimeIncarnation,
    token.documentGeneration, token.capturePrivacyEpoch]);
  const permitted = item => !item.cancelled && canCommit(item.token) === true;
  function schedule() {
    if (timer || pumping || disabled || !pending.size) return;
    const due = Math.min(...[...pending.values()].map(item => item.due));
    timer = setTimeout(() => { timer = null; void pump(); }, Math.max(0, due - now()));
    timer.unref?.();
  }
  function pump(force = false, through = admitted) {
    if (pumping) return pumping;
    clearTimeout(timer); timer = null;
    pumping = (async () => {
      while (!disabled && pending.size) {
        const item = [...pending.values()].find(value => value.sequence <= through && (force || value.due <= now()));
        if (!item) break;
        pending.delete(item.tabId); active = item;
        try {
          if (permitted(item)) {
            const visit = await record({ workspaceId: item.workspaceId, url: item.url, title: item.title,
              visitedAt: item.visitedAt }, { beforeCommit: () => permitted(item) });
            if (visit) onChange();
          }
        } catch (error) {
          // A transient full writer queue is not corrupt/unavailable storage.
          // Retry once, without allowing a title storm to create more entries.
          if (error.code === 'HISTORY_BUSY') {
            if (!item.retried && permitted(item) && !pending.has(item.tabId)) {
              item.retried = true; item.due = now() + 50; pending.set(item.tabId, item);
            } else onError(error);
          } else {
            disabled = true; pending.clear(); onError(error);
          }
        } finally { active = null; }
      }
    })().finally(() => { pumping = null; schedule(); });
    return pumping;
  }
  function accept({ reason, token, url, title }) {
    if (closed || disabled || !token || !canCommit(token) || url === 'about:blank') return false;
    const key = keyFor(token), previous = pending.get(token.tabId);
    if (previous?.key === key) {
      previous.title = title; previous.token = token;
      // Keep the first deadline: continuous title changes cannot starve a visit.
      return true;
    }
    if (!['navigation-commit', 'navigation-in-page', 'document-adopted'].includes(reason) || seen.get(token.tabId) === key) return false;
    seen.set(token.tabId, key);
    if (previous) { previous.cancelled = true; pending.delete(token.tabId); }
    if (pending.size >= maxPending) return false;
    pending.set(token.tabId, { key, sequence: ++admitted, workspaceId: token.workspaceId, tabId: token.tabId,
      token, url, title, visitedAt: now(), due: now() + settleMs, cancelled: false, retried: false });
    schedule(); return true;
  }
  function cancelWorkspace(workspaceId) {
    for (const [tabId, item] of pending) if (item.workspaceId === workspaceId) { item.cancelled = true; pending.delete(tabId); }
    if (active?.workspaceId === workspaceId) active.cancelled = true;
  }
  function forget(tabId) {
    const item = pending.get(tabId);
    if (item) item.cancelled = true;
    pending.delete(tabId); seen.delete(tabId);
    if (active?.tabId === tabId) active.cancelled = true;
  }
  async function flush() {
    // Capture the admission watermark. Later navigation must not extend a human
    // remove/clear workflow or keep it waiting behind a self-updating page.
    const through = admitted;
    clearTimeout(timer); timer = null;
    const remaining = () => (active && active.sequence <= through) || [...pending.values()].some(item => item.sequence <= through);
    while (remaining()) {
      if (pumping) await pumping;
      else await pump(true, through);
    }
  }
  async function close() { closed = true; await flush(); clearTimeout(timer); timer = null; seen.clear(); }
  return Object.freeze({ accept, cancelWorkspace, forget, flush, close });
}
