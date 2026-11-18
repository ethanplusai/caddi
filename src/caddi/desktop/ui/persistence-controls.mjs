import { systemLifecycleView, systemLifecycleMessages } from './system-lifecycle-controls.mjs';

export const persistenceMessages = Object.freeze({
  ...systemLifecycleMessages,
  PERSISTENCE_UNAVAILABLE: 'Protected storage is unavailable. No temporary replacement was opened.',
  PERSISTENCE_LOCKED: 'Protected data is locked. Resume this workspace, then load it again when you are ready.',
  PERSISTENCE_KEY_UNAVAILABLE: 'The protected key is unavailable. Saved data remains closed.',
  PERSISTENCE_REVIEW_REQUIRED: 'Load the current saved data before changing its access.',
  PERSISTENCE_LOAD_REQUIRED: 'Open protected storage before loading saved connections or drafts.',
  PERSISTENCE_FEEDBACK_UNAVAILABLE: 'Saved feedback is not available from this protected store.',
  PERSISTENCE_NOT_FOUND: 'This workspace has no saved feedback to load yet.',
  PERSISTENCE_REVIEW_STALE: 'This owner view changed. Review the current workspace before loading saved data.',
  PERSISTENCE_CANCELLED: 'The owner view or protection state changed. Review it before trying again.',
  PERSISTENCE_CONFLICT: 'Saved connection settings changed. Reload and review the latest access before applying changes.',
  PERSISTENCE_IDENTITY_CHANGED: 'The workspace identity changed. Saved data was not attached to a replacement workspace.',
  PERSISTENCE_BUSY: 'A protected-data operation is still finishing. Wait for it to settle.',
  PERSISTENCE_COMMIT_UNKNOWN: 'The save outcome is uncertain. Reload protected storage before making another change.',
  PERSISTENCE_CLOSED: 'Protected storage is closing. No new operation can start.',
  PERSISTENCE_CORRUPT: 'Saved data could not be verified. It was preserved without opening a replacement.',
  PERSISTENCE_SOURCE_CHANGED: 'The protected source changed. It was preserved without opening a replacement.',
  PERSISTENCE_FEEDBACK_DIRTY: 'Save the current feedback edits before loading saved drafts.',
});
const phases = new Set(['session-only','unopened','opening','draining','ready','locked','unavailable','closed']);
const fail = code => { throw Object.assign(new Error(persistenceMessages[code] ?? persistenceMessages.PERSISTENCE_UNAVAILABLE), { code }); };

/** Human status only. Provider type never implies native or production qualification. */
export function persistenceView(snapshot, { dirtyFeedback = false } = {}) {
  const source = snapshot?.persistence;
  const mode = source?.mode ?? 'session-only';
  const phase = phases.has(source?.phase) ? source.phase : mode === 'session-only' ? 'session-only' : 'unavailable';
  const workspace = snapshot?.metadata?.workspaces?.find(item => item.id === snapshot.metadata.activeWorkspaceId);
  const privacy = workspace && snapshot?.privacy?.[workspace.id];
  const privateWindow = !!snapshot?.privateBrowsing;
  const configured = mode === 'encrypted-durable' && !privateWindow;
  const ownerReady = !!workspace && !privateWindow && workspace.lifecycle?.status !== 'archived' &&
    systemLifecycleView(snapshot).ready && !snapshot?.preview && !privacy?.blocked && !privacy?.transitioning &&
    (!snapshot?.chromeRecovery?.phase || snapshot.chromeRecovery.phase === 'ready');
  const scopeKey = JSON.stringify([workspace?.id ?? null, workspace?.identityId ?? null, workspace?.lifecycle?.generation ?? null,
    privacy?.capturePrivacyEpoch ?? null, snapshot?.chromeRecovery?.generation ?? null,
    snapshot?.systemLifecycle?.generation ?? null, snapshot?.systemLifecycle?.phase ?? null, privateWindow]);
  const ready = configured && phase === 'ready';
  const retryable = source?.retryable === true && phase === 'unavailable';
  const canOpen = configured && ownerReady && (['unopened','locked'].includes(phase) || retryable);
  const canConnections = ready && ownerReady;
  const canFeedback = ready && ownerReady && source.feedbackAvailable === true && !dirtyFeedback;
  const title = privateWindow ? 'Private window' : !configured ? mode === 'session-only' ? 'Temporary feedback' : 'Protected data unavailable' :
    ({ unopened: 'Saved data is closed', opening: 'Opening protected storage…', draining: 'Finishing a protected-data operation…',
      ready: 'Protected storage is open', locked: 'Saved data is locked', unavailable: 'Protected data unavailable', closed: 'Protected storage is closed' })[phase] ?? 'Protected data unavailable';
  const qualification = configured && source?.testOnly === true ? 'Synthetic keys · development proof only. ' : '';
  const description = privateWindow ? 'Saved connections and feedback are unavailable in this temporary window.' : !configured ?
    mode === 'session-only' ? 'Feedback lasts for this app session. Protected service storage is not configured.' : 'The configured store could not be opened. Caddi has not substituted temporary storage.' :
    qualification + (phase === 'ready' ? 'Load saved connections and workspace drafts separately. Agent access must be granted again.' :
      phase === 'opening' || phase === 'draining' ? 'Wait for the current operation to finish. No temporary store is substituted.' :
      phase === 'locked' ? 'Unlocking or continuing does not reload saved data. Choose what to load when this workspace is ready.' :
      phase === 'unavailable' ? 'The configured store remains unavailable. Its data has been preserved.' :
      'Open protected storage when you need it. Saved drafts and agent grants are not restored automatically.');
  const blockedNote = privateWindow ? '' : !workspace ? 'Choose a normal workspace to load saved data.' :
    !systemLifecycleView(snapshot).ready ? 'Continue Caddi before loading saved data.' : snapshot?.preview ? 'Close or keep the preview before loading saved data.' :
    privacy?.blocked || privacy?.transitioning ? 'Resume this workspace before loading saved data.' :
    snapshot?.chromeRecovery?.phase && snapshot.chromeRecovery.phase !== 'ready' ? 'Wait for this window to finish recovery.' : '';
  const connectionsDescription = !configured ? snapshot?.services?.qualification === 'synthetic-test' ?
    'Temporary test connections · no real account access.' : 'Service connections are unavailable in this development build.' :
    source?.connectionsLoaded === true ? 'Saved connections are loaded. Workspace shares persist; individual agent grants last only for this session.' :
      'Saved connections are not loaded. Loading them does not connect or authorize an agent.';
  const feedbackDescription = !configured ? 'Feedback stays in this app session.' :
    'Saved drafts are encrypted locally. Loading an earlier draft does not restore an agent recipient or make its page context current.';
  return { mode, phase, configured, privateWindow, scopeKey, workspaceId: workspace?.id ?? null, identityId: workspace?.identityId ?? null,
    ready, canOpen, canConnections, canFeedback, dirtyFeedback, retryable, title, description, blockedNote, connectionsDescription, feedbackDescription,
    connectionsLoaded: source?.connectionsLoaded === true, lastError: persistenceMessages[source?.lastError] ?? '',
    about: configured ? 'Site sign-ins stay in each workspace profile. Saved connections and feedback load only when you choose; agents reconnect with fresh grants.' :
      'Caddi Development keeps site sign-ins in each workspace profile. Agent connections and feedback last only for this app session.' };
}

export function reviewedPersistenceAction(snapshot, displayed, kind, options = {}) {
  const current = persistenceView(snapshot, options);
  if (!displayed || displayed.scopeKey !== current.scopeKey || displayed.phase !== current.phase || displayed.mode !== current.mode)
    fail('PERSISTENCE_REVIEW_STALE');
  if (kind === 'open' && current.canOpen && displayed.canOpen) return { type: 'persistence.load' };
  if (kind === 'connections' && current.canConnections && displayed.canConnections) return { type: 'connections.load' };
  if (kind === 'feedback' && current.canFeedback && displayed.canFeedback) return { type: 'feedback.restore',
    workspaceId: displayed.workspaceId, expectedWorkspaceIdentityId: displayed.identityId };
  if (kind === 'feedback' && current.dirtyFeedback) fail('PERSISTENCE_FEEDBACK_DIRTY');
  fail(current.phase === 'opening' || current.phase === 'draining' ? 'PERSISTENCE_BUSY' : 'PERSISTENCE_UNAVAILABLE');
}

/** The displayed durable CAS revision is distinct from an ephemeral agent-grant review. */
export function reviewedConnectionMutation(snapshot, displayed, { kind, workspaceId, operations } = {}) {
  const current = persistenceView(snapshot), review = snapshot?.services?.owner?.persistenceReview;
  const connection = review?.connections?.find(item => item.serviceConnectionId === displayed?.serviceConnectionId);
  if (!current.canConnections || !connection || review.revision !== displayed?.expectedRevision || connection.generation !== displayed.expectedGeneration)
    fail('PERSISTENCE_CONFLICT');
  const base = { serviceConnectionId: displayed.serviceConnectionId, expectedRevision: displayed.expectedRevision, expectedGeneration: displayed.expectedGeneration };
  if (kind === 'remove') return { type: 'connections.remove', ...base };
  if (kind === 'revoke') return { type: 'connections.revoke', ...base, workspaceId };
  const workspace = snapshot.metadata.workspaces.find(item => item.id === workspaceId);
  if (kind !== 'share' || !workspace || workspace.kind !== 'project' || workspace.lifecycle?.status === 'archived' ||
      workspace.identityId !== displayed.expectedWorkspaceIdentityId) fail('PERSISTENCE_IDENTITY_CHANGED');
  return { type: 'connections.share', ...base, workspaceId, operations, expectedWorkspaceIdentityId: displayed.expectedWorkspaceIdentityId };
}

export function createPersistenceControls({ getState, action, refreshState, hasUnsavedFeedback = () => false, toast = () => {} }) {
  const $ = id => document.getElementById(id), setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  let displayed = null, ownerKey = null, ownerEpoch = 0, notice = '', job = null, sequence = 0, disposed = false;
  const options = () => ({ dirtyFeedback: hasUnsavedFeedback() });
  function render() {
    if (disposed) return;
    const view = persistenceView(getState(), options());
    if (ownerKey !== view.scopeKey) { ownerKey = view.scopeKey; ownerEpoch++; notice = ''; }
    displayed = view;
    $('persistence-settings').hidden = view.privateWindow;
    setText('persistence-title', view.title); setText('persistence-description', view.description);
    setText('persistence-action-status', notice || view.lastError || view.blockedNote);
    $('persistence-open').hidden = !view.configured || view.phase === 'ready';
    $('persistence-open').disabled = !!job || !view.canOpen;
    $('persistence-open').textContent = view.phase === 'opening' ? 'Opening…' : view.phase === 'draining' ? 'Finishing…' : view.retryable ? 'Retry opening storage' : 'Open protected storage';
    setText('connections-persistence-note', view.connectionsDescription);
    $('connections-load').hidden = !view.configured;
    $('connections-load').disabled = !!job || !(view.ready ? view.canConnections : view.canOpen);
    $('connections-load').textContent = !view.ready ? 'Open protected storage' : view.connectionsLoaded ? 'Reload saved connections' : 'Load saved connections';
    setText('feedback-persistence-note', view.feedbackDescription);
    setText('feedback-storage-note', view.configured ? 'Encrypted local draft.' : 'Temporary draft · this app session.');
    setText('feedback-load-status', view.dirtyFeedback ? persistenceMessages.PERSISTENCE_FEEDBACK_DIRTY : view.blockedNote);
    $('feedback-restore').hidden = !view.configured;
    $('feedback-restore').disabled = !!job || view.dirtyFeedback || !(view.ready ? view.canFeedback : view.canOpen);
    $('feedback-restore').textContent = view.ready ? 'Load saved drafts' : 'Open protected storage';
    setText('connection-qualification-note', view.configured && getState()?.persistence?.testOnly ?
      'This proof uses synthetic keys and synthetic account data. Signed native protection and real accounts remain unqualified.' :
      'Live credentials require a qualified signed build. Agent grants expire with their session.');
  }
  async function run(kind) {
    if (disposed || job) return;
    const captured = displayed, capturedEpoch = ownerEpoch, token = ++sequence;
    let request;
    try { request = reviewedPersistenceAction(getState(), captured, kind, options()); }
    catch (error) { notice = persistenceMessages[error.code] ?? persistenceMessages.PERSISTENCE_UNAVAILABLE; render(); return; }
    job = { token }; notice = ''; render();
    try {
      await action(request, true); await refreshState();
      if (disposed || job?.token !== token || ownerEpoch !== capturedEpoch || persistenceView(getState(), options()).scopeKey !== captured.scopeKey) return;
      const current = persistenceView(getState(), options());
      if (kind === 'feedback' && current.phase === 'ready') $('feedback-history').open = true;
      if (current.phase === 'ready') notice = kind === 'open' ? 'Protected storage is open. Choose saved connections or drafts to load.' :
        kind === 'connections' && current.connectionsLoaded ? 'Saved connections loaded. Agents still need individual grants.' :
        kind === 'feedback' ? 'Saved drafts loaded. Choose a draft to review its earlier page context.' : '';
      if (notice) toast(notice);
    } catch (error) {
      if (disposed || job?.token !== token || ownerEpoch !== capturedEpoch || persistenceView(getState(), options()).scopeKey !== captured.scopeKey) return;
      notice = persistenceMessages[error.code] ?? persistenceMessages.PERSISTENCE_UNAVAILABLE; toast(notice);
      await refreshState().catch(() => {});
    } finally { if (job?.token === token) job = null; render(); }
  }
  $('persistence-open').addEventListener('click', () => { if (!$('persistence-open').disabled) void run('open'); });
  $('connections-load').addEventListener('click', () => { if (!$('connections-load').disabled) void run(displayed.ready ? 'connections' : 'open'); });
  $('feedback-restore').addEventListener('click', () => { if (!$('feedback-restore').disabled) void run(displayed.ready ? 'feedback' : 'open'); });
  window.addEventListener('pagehide', () => { disposed = true; job = null; sequence++; });
  return Object.freeze({ render });
}
