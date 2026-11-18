const messages = {
  STORAGE_MEASUREMENT_BUSY: 'Another measurement is still finishing. Wait a moment, then refresh.',
  STORAGE_CONTEXT_CHANGED: 'The workspace or window changed. Refresh to measure the current workspace.',
  STORAGE_PATH_UNAVAILABLE: 'This workspace profile could not be measured. Its files were left unchanged.',
  STORAGE_MEASUREMENT_INCOMPLETE: 'Storage measurement is unavailable. Its files were left unchanged.',
  STORAGE_METER_CLOSED: 'Storage measurement is unavailable while Caddi is closing.',
  PRIVATE_FEATURE_UNAVAILABLE: 'Storage measurement is unavailable in a private window.',
};
const bytes = value => {
  if (!Number.isSafeInteger(value) || value < 0) return 'Unavailable';
  if (value < 1024) return value + (value === 1 ? ' byte' : ' bytes');
  const units = ['KiB','MiB','GiB','TiB']; let number = value / 1024, index = 0;
  while (number >= 1024 && index < units.length - 1) { number /= 1024; index++; }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number) + ' ' + units[index];
};

/** The result is kept only in this trusted owner dialog, never in shared snapshots. */
export function createStorageControls({ getState, refreshState, action, openDialog, closeDialog }) {
  const $ = id => document.getElementById(id), dialog = $('storage-dialog');
  let binding = null, result = null, busy = false, sequence = 0, note = '', stateLabel = 'Ready';
  function scope() {
    const state = getState(), workspace = state?.metadata.workspaces.find(item => item.id === state.metadata.activeWorkspaceId);
    if (!workspace || state.privateBrowsing || state.chromeRecovery?.phase && state.chromeRecovery.phase !== 'ready') return null;
    return { workspaceId: workspace.id, identityId: workspace.identityId, name: workspace.name,
      key: [workspace.id,workspace.identityId,workspace.lifecycle?.generation ?? 0,
        state.privacy?.[workspace.id]?.capturePrivacyEpoch ?? 0,state.chromeRecovery?.generation ?? 0].join('/') };
  }
  function paint() {
    const current = scope();
    $('storage-workspace').textContent = current?.name ?? 'No normal workspace';
    $('storage-state').textContent = busy ? 'Measuring' : stateLabel;
    $('storage-profile').textContent = result ? bytes(result.profileAllocatedBytes) : '—';
    $('storage-cache').textContent = result ? bytes(result.httpCacheBytes) : '—';
    $('storage-status').textContent = busy ? 'Measuring this workspace’s profile allocation and HTTP cache…' : note;
    $('refresh-storage').disabled = busy || !current;
    $('refresh-storage').textContent = busy ? 'Measuring…' : 'Refresh measurement';
    dialog.setAttribute('aria-busy', String(busy));
  }
  function invalidate(message = messages.STORAGE_CONTEXT_CHANGED) {
    ++sequence; binding = null; result = null; busy = false; note = message; stateLabel = 'Unavailable'; paint();
  }
  function render() {
    if (!dialog.open) return;
    const current = scope();
    if (binding && binding.key !== current?.key) invalidate();
    else if (!current) invalidate(getState()?.privateBrowsing ? messages.PRIVATE_FEATURE_UNAVAILABLE : messages.STORAGE_CONTEXT_CHANGED);
    else paint();
  }
  async function measure() {
    if (busy) return;
    const request = ++sequence; result = null; binding = null; busy = true; note = ''; paint();
    try {
      await refreshState();
      if (request !== sequence || !dialog.open) return;
      const captured = scope();
      if (!captured) { invalidate(getState()?.privateBrowsing ? messages.PRIVATE_FEATURE_UNAVAILABLE : messages.STORAGE_CONTEXT_CHANGED); return; }
      binding = captured;
      const measured = await action({ type: 'storage.usage', workspaceId: captured.workspaceId }, true);
      if (request !== sequence || !dialog.open) return;
      if (scope()?.key !== captured.key) { invalidate(messages.STORAGE_CONTEXT_CHANGED); return; }
      if (measured?.workspaceId !== captured.workspaceId || measured.identityId !== captured.identityId) {
        invalidate(messages.STORAGE_CONTEXT_CHANGED); return;
      }
      if (!['measured','partial','pending','not-applicable'].includes(measured.status)) {
        stateLabel = 'Unavailable'; note = messages.STORAGE_MEASUREMENT_INCOMPLETE; return;
      }
      result = { profileAllocatedBytes: measured.profileAllocatedBytes, httpCacheBytes: measured.httpCacheBytes };
      if (measured.status === 'measured') {
        stateLabel = 'Measured';
        note = Number.isFinite(measured.measuredAt) ? 'Measured at ' + new Date(measured.measuredAt).toLocaleTimeString() + '. Values can change as sites store data.' : 'Values can change as sites store data.';
      } else if (measured.status === 'partial') {
        stateLabel = 'Partial'; note = 'Only part of this measurement is available. An unavailable value is not zero.';
      } else if (measured.status === 'pending') {
        result = null; stateLabel = 'Pending'; note = 'The measurement did not finish within its deadline. Wait a moment, then refresh.';
      } else {
        result = null; stateLabel = 'Not applicable'; note = 'This workspace uses a temporary session. Persistent profile allocation does not apply.';
      }
    } catch (error) {
      if (request !== sequence || !dialog.open) return;
      result = null; stateLabel = error.code === 'STORAGE_MEASUREMENT_BUSY' ? 'Busy' : 'Unavailable';
      note = messages[error.code] ?? messages.STORAGE_MEASUREMENT_INCOMPLETE;
    } finally {
      if (request === sequence) { busy = false; paint(); }
    }
  }
  async function show() {
    if (getState()?.privateBrowsing) return;
    if (dialog.open) { $('refresh-storage').focus(); return; }
    ++sequence; binding = null; result = null; busy = false; note = ''; stateLabel = 'Ready';
    await openDialog('storage-dialog'); await measure();
  }
  async function close() {
    ++sequence; binding = null; result = null; busy = false; note = ''; stateLabel = 'Ready'; paint();
    await closeDialog('storage-dialog');
  }
  $('refresh-storage').addEventListener('click', () => void measure());
  $('close-storage').addEventListener('click', () => void close().catch(() => {}));
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close().catch(() => {}); });
  window.addEventListener('pagehide', () => { ++sequence; binding = null; result = null; busy = false; });
  return Object.freeze({ show, render });
}
