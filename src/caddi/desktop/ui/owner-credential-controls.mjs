import { serviceConnectionDescription, serviceOperations } from './service-catalog.mjs';

// This controller handles public review metadata only. Credentials are acquired
// directly by the main-owned native boundary and never become form values.
export function createOwnerCredentialControls({ getState, action, refresh, ownerDocument = document }) {
  const $ = id => ownerDocument.getElementById(id), dialog = $('agents-dialog');
  const panel = $('connection-acquisition-review'), description = $('connection-acquisition-description');
  const status = $('connection-acquisition-status'), confirm = $('connection-acquire-confirm'), cancelButton = $('connection-acquire-cancel');
  let review = null, job = null, generation = 0, context = null, disposed = false;
  const current = () => {
    const state = getState(), id = state?.metadata?.activeWorkspaceId;
    const workspace = state?.metadata?.workspaces?.find(item => item.id === id);
    return { state, workspace, key: JSON.stringify([id, workspace?.identityId, state?.systemLifecycle?.generation,
      state?.privacy?.[id]?.capturePrivacyEpoch, state?.privateBrowsing?.scopeId, state?.chromeRecovery?.generation]) };
  };
  const cancelMain = item => item && void action({ type: 'connections.acquire.cancel', reviewId: item.reviewId }, true).catch(() => {});
  function clear({ cancel = true, notice = '' } = {}) {
    const item = review; generation++; review = null; job = null;
    if (cancel) cancelMain(item);
    panel.hidden = true; confirm.disabled = true; cancelButton.disabled = true;
    status.textContent = notice;
  }
  function render() {
    if (disposed) return;
    const value = current();
    if (context !== value.key || !dialog.open) { context = value.key; if (review || job) clear(); }
    if (review && job?.kind !== 'acquire' && value.state?.services?.owner?.persistenceReview?.revision !== review.expectedRevision)
      clear({ notice: 'Saved connections changed. Review the current connection before continuing.' });
    if (!review) return;
    panel.hidden = false;
    confirm.disabled = !!job || !value.state?.services?.owner?.acquisition?.available;
    cancelButton.disabled = false;
  }
  const validReview = (value, request) => value && typeof value.reviewId === 'string' && /^acquisition-[a-zA-Z0-9-]+$/u.test(value.reviewId) &&
    value.workspaceId === request.workspaceId && value.workspaceIdentityId === request.expectedWorkspaceIdentityId &&
    value.expectedRevision === request.expectedRevision && ['create', 'rotate'].includes(value.kind) &&
    Number.isSafeInteger(value.expiresAt) && Array.isArray(value.operations) && value.operations.length <= 5 &&
    value.operations.every(id => serviceOperations.some(item => item.id === id));
  async function begin(kind, input) {
    const value = current();
    if (disposed || !dialog.open || job || !value.state?.services?.owner?.acquisition?.available ||
        value.workspace?.id !== input.workspaceId || value.workspace?.identityId !== input.expectedWorkspaceIdentityId) return false;
    clear(); context = value.key;
    const token = { kind: 'review', generation, context: value.key }; job = token;
    status.textContent = 'Preparing the connection review…';
    const stillCurrent = () => !disposed && dialog.open && job === token && token.generation === generation && current().key === token.context;
    try {
      const result = await action({ type: kind === 'create' ? 'connections.create.review' : 'connections.rotate.review', ...input }, true);
      if (!stillCurrent()) { cancelMain(result); return false; }
      if (!validReview(result, input) || result.kind !== kind) { cancelMain(result); throw new Error('Invalid review'); }
      review = result;
      const operations = serviceOperations.filter(item => result.operations.includes(item.id)).map(item => item.label).join(', ');
      description.textContent = result.label + ' · ' + serviceConnectionDescription(result) + '. ' +
        (kind === 'create' ? 'Initial access: ' + value.workspace.name + '. ' + operations + '. Agents still need a separate grant.' :
          'Replace the credential for this saved connection. Existing agent grants will expire; workspace access must be reviewed again.');
      confirm.textContent = kind === 'create' ? 'Continue to protected entry' : 'Replace through protected entry';
      status.textContent = 'Review the service and workspace before continuing.';
      panel.hidden = false; cancelButton.disabled = false;
      cancelButton.focus(); panel.scrollIntoView?.({ block: 'nearest' });
      return true;
    } catch {
      if (stillCurrent()) status.textContent = 'The connection review is unavailable. Reload saved connections and try again.';
      return false;
    } finally { if (job === token) { job = null; render(); } }
  }
  async function acquire() {
    render();
    if (disposed || !review || job || confirm.disabled || !dialog.open) return false;
    const item = review, token = { kind: 'acquire', generation, context: current().key }; job = token;
    status.textContent = 'Waiting for protected credential entry…'; render();
    const stillCurrent = () => !disposed && dialog.open && job === token && review === item && generation === token.generation && current().key === token.context;
    try {
      const result = await action({ type: 'connections.acquire', reviewId: item.reviewId }, true);
      if (!stillCurrent()) return false;
      const message = result?.status === 'saved' && result.applied === true && result.needsReload === false ?
        'Connection saved. Choose workspace access and a separate agent grant when needed.' :
        result?.status === 'cancelled' ? 'Credential entry cancelled.' :
        'The result could not be confirmed. Reload saved connections before trying again.';
      clear({ cancel: false, notice: message }); await refresh(); return result?.status === 'saved';
    } catch {
      if (stillCurrent()) { clear({ cancel: false, notice: 'The result could not be confirmed. Reload saved connections before trying again.' }); await refresh(); }
      return false;
    } finally { if (job === token) { job = null; render(); } }
  }
  const cancel = () => clear({ notice: job?.kind === 'acquire' ?
    'Entry cancelled. Reload saved connections if saving had already started.' : 'Connection review cancelled.' });
  const confirmClick = () => { void acquire(); };
  const close = () => clear();
  const closedEvent = () => { if (!dialog.open) close(); };
  confirm.addEventListener('click', confirmClick); cancelButton.addEventListener('click', cancel);
  dialog.addEventListener('close', closedEvent); dialog.addEventListener('cancel', close);
  clear({ cancel: false });
  return Object.freeze({ reviewCreate: input => begin('create', input), reviewRotate: input => begin('rotate', input), render,
    busy: () => !!job || !!review,
    dispose() { if (disposed) return; clear(); disposed = true;
      confirm.removeEventListener('click', confirmClick); cancelButton.removeEventListener('click', cancel);
      dialog.removeEventListener('close', closedEvent); dialog.removeEventListener('cancel', close); } });
}
