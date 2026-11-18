/** Owner chrome only. Preview identifiers never become saved-tab or agent targets here. */
const messages = {
  PREVIEW_URL_INVALID: 'Enter a complete http:// or https:// address without an embedded username or password.',
  PREVIEW_BUSY: 'Close this preview or keep it as a tab before opening another page.',
  PREVIEW_STALE: 'This preview changed. Review its current state before trying again.',
  PREVIEW_REVISION_STALE: 'Your tabs changed. Review the current preview before keeping it.',
  PREVIEW_PRIVACY_BLOCKED: 'Previews are unavailable while agents are paused. You can still close an existing preview.',
  PREVIEW_BLOCKED: 'This preview is paused. Close it to return to the workspace.',
  PREVIEW_NOT_READY: 'The preview is not ready to keep. Wait for it to finish loading.',
  PREVIEW_OPEN_INCOMPLETE: 'The preview could not finish opening. Close it before trying again.',
  PREVIEW_CLOSE_UNCONFIRMED: 'The page has not confirmed that it closed. This preview is still retained.',
  PREVIEW_OUTCOME_UNKNOWN: 'The tab may already have been saved. Review the current state; do not repeat Keep as tab.',
  PAGE_CAPACITY: 'Close a loaded tab to make room for a preview.',
};
const fail = code => { throw Object.assign(new Error(messages[code] ?? 'Preview is unavailable.'), { code }); };
const currentWorkspace = snapshot => snapshot?.metadata?.workspaces?.find(item => item.id === snapshot.metadata.activeWorkspaceId);
export function previewContext(snapshot) {
  const workspace = currentWorkspace(snapshot);
  return workspace ? JSON.stringify([workspace.id, workspace.identityId, workspace.lifecycle?.generation ?? 0,
    snapshot.privateBrowsing?.scopeId ?? null, snapshot.privacy?.[workspace.id]?.epoch ?? null,
    snapshot.chromeRecovery?.generation ?? 0]) : null;
}
export function canOpenPagePreview(snapshot) {
  const workspace = currentWorkspace(snapshot), guard = workspace && snapshot?.privacy?.[workspace.id];
  return !!workspace && workspace.lifecycle?.status !== 'archived' && !snapshot.privateBrowsing && !snapshot.preview &&
    guard?.blocked === false && !guard.transitioning && !snapshot.reviewOpen && !snapshot.selecting && !snapshot.pagePrint?.busy &&
    (!snapshot.chromeRecovery || snapshot.chromeRecovery.phase === 'ready');
}
export function previewAddress(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) fail('PREVIEW_URL_INVALID');
  const value = raw.trim(); let url;
  if (!/^https?:\/\//i.test(value) || /[\\\s]/.test(value)) fail('PREVIEW_URL_INVALID');
  try { url = new URL(value); } catch { fail('PREVIEW_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('PREVIEW_URL_INVALID');
  return value;
}
/** This presentation fence complements the independently enforced host boundary. */
export function previewBlocksAction(type) {
  return /^(?:tab\.|group\.|folder\.|workspace\.(?:create|select|reopen)|navigate$|back$|forward$|reload$|zoom$|mute$|find(?:\.|$)|split\.|review\.|moments\.|popup\.|page\.|demo\.|history\.|privacy\.resume$|window\.open-workspace$)/.test(type ?? '');
}
export function reviewedPreviewAction(snapshot, displayed, kind) {
  const preview = snapshot?.preview;
  if (!displayed || !preview || preview.id !== displayed.id || preview.generation !== displayed.generation ||
      preview.workspaceId !== displayed.workspaceId || previewContext(snapshot) !== displayed.context) fail('PREVIEW_STALE');
  const result = { type: kind === 'keep' ? 'preview.promote' : 'preview.close', previewId: displayed.id, generation: displayed.generation };
  if (kind === 'keep') {
    if (preview.status === 'uncertain' || preview.metadataCommitted || preview.metadataOutcome === 'unknown') fail('PREVIEW_OUTCOME_UNKNOWN');
    if (snapshot.privateBrowsing || snapshot.privacy?.[preview.workspaceId]?.blocked !== false || preview.status === 'paused') fail('PREVIEW_BLOCKED');
    if (preview.status !== 'active') fail('PREVIEW_BUSY');
    if (!preview.canPromote) fail('PREVIEW_NOT_READY');
    if (!Number.isSafeInteger(displayed.revision) || snapshot.metadata.revision !== displayed.revision) fail('PREVIEW_REVISION_STALE');
    result.expectedRevision = displayed.revision;
  }
  return result;
}

export function createPagePreviewControls({ getState, refreshState, action, openDialog, closeDialog, toast, onChange = () => {}, onEnter = () => {} }) {
  const $ = id => document.getElementById(id), dialog = $('preview-address-dialog');
  let displayed = null, operation = null, notice = '', lastKey = null, lastNoticeKey = null, lastContext = null, contextGeneration = 0;
  let inputReview = null, returnFocus = null;
  const active = () => !!getState()?.preview || !!operation;
  function render() {
    const snapshot = getState(), preview = snapshot?.preview, context = previewContext(snapshot);
    if (context !== lastContext) { lastContext = context; contextGeneration++; inputReview = null; }
    const key = preview ? preview.id + ':' + preview.workspaceId : null;
    const noticeKey = preview ? JSON.stringify([preview.id,preview.generation,preview.status,preview.metadataOutcome,preview.metadataCommitted]) : null;
    if (noticeKey !== lastNoticeKey) { lastNoticeKey = noticeKey; notice = ''; }
    if (key !== lastKey) {
      if (key) { notice = ''; onEnter(); }
      lastKey = key;
    }
    displayed = preview ? Object.freeze({ id: preview.id, generation: preview.generation, workspaceId: preview.workspaceId,
      context, revision: snapshot.metadata.revision }) : null;
    $('page-preview-bar').hidden = !active();
    $('page-preview-bar').setAttribute('aria-busy', String(!!operation || ['promoting','closing'].includes(preview?.status)));
    $('preview-address-button').hidden = !!snapshot?.privateBrowsing;
    $('preview-address-button').disabled = !!operation || !canOpenPagePreview(snapshot);
    $('newtab-preview').hidden = !!snapshot?.privateBrowsing;
    $('newtab-preview').disabled = !!operation || !canOpenPagePreview(snapshot);
    if (!active()) return;
    const status = preview?.status ?? 'opening';
    $('page-preview-label').textContent = status === 'paused' ? 'Preview paused' : status === 'uncertain' ? 'Preview needs attention' : 'Preview';
    $('page-preview-title').textContent = preview?.title || (preview?.loading ? 'Loading page…' : 'Opening preview…');
    $('page-preview-url').textContent = preview?.url ?? '';
    $('page-preview-url').title = preview?.url ?? '';
    $('page-preview-close').disabled = !!operation || !preview || ['promoting','closing'].includes(status);
    $('page-preview-keep').disabled = !!operation || !preview?.canPromote || status !== 'active' || !!preview.metadataCommitted;
    $('page-preview-close').textContent = status === 'closing' || operation === 'close' ? 'Closing…' : status === 'close-pending' ? 'Retry close' : 'Close preview';
    $('page-preview-keep').textContent = status === 'promoting' || operation === 'keep' ? 'Keeping…' : 'Keep as tab';
    $('page-preview-state').textContent = notice || (preview?.metadataOutcome === 'committed' || preview?.metadataCommitted === true ? 'Tab metadata was saved. Live-page completion is unconfirmed; do not repeat Keep as tab.' :
      preview?.metadataOutcome === 'unknown' ? 'The tab save could not be confirmed. Do not repeat Keep as tab; review the current state.' :
      status === 'paused' ? 'This preview is paused. Close it to return to your workspace.' :
      messages[preview?.errorCode] || (status === 'close-pending' ? 'The page is still retained. Retry closing when you are ready.' :
      status === 'uncertain' ? 'The last action could not be confirmed. Review this preview before continuing.' :
      status === 'promoting' ? 'Keeping this same live page as a tab…' : status === 'closing' ? 'Waiting for the page to close…' :
      'Uses this workspace’s sign-ins and site storage. Keep it as a tab to save it.'));
  }
  function problem(error) {
    notice = messages[error?.code] ?? 'The preview action could not finish. Review its current state before trying again.';
    toast(notice); return false;
  }
  async function open(raw) {
    if (active()) return problem({ code: 'PREVIEW_BUSY' });
    let input;
    try { input = previewAddress(raw); if (!canOpenPagePreview(getState())) fail('PREVIEW_PRIVACY_BLOCKED'); }
    catch (error) { return problem(error); }
    returnFocus = document.activeElement; operation = 'open'; notice = ''; onChange();
    try { await action({ type: 'preview.open', input }, true); await refreshState(); return true; }
    catch (error) { await refreshState().catch(() => {}); return problem(error); }
    finally { operation = null; onChange(); }
  }
  async function show() {
    if (active()) { $('page-preview-close').focus(); return; }
    if (!canOpenPagePreview(getState())) { problem({ code: 'PREVIEW_PRIVACY_BLOCKED' }); return; }
    render(); inputReview = { context: previewContext(getState()), generation: contextGeneration };
    $('preview-address-input').value = '';
    $('preview-address-error').textContent = ''; $('preview-address-error').hidden = true;
    await openDialog('preview-address-dialog'); $('preview-address-input').focus();
  }
  async function submitAddress() {
    const reviewed = inputReview;
    let input;
    try { input = previewAddress($('preview-address-input').value); }
    catch (error) { $('preview-address-error').textContent = messages[error.code]; $('preview-address-error').hidden = false; return; }
    await closeDialog('preview-address-dialog');
    if (!reviewed || reviewed.context !== previewContext(getState()) || reviewed.generation !== contextGeneration) { problem({ code: 'PREVIEW_STALE' }); return; }
    await open(input);
  }
  async function finish(kind) {
    if (operation) return false;
    let request;
    try { request = reviewedPreviewAction(getState(), displayed, kind); }
    catch (error) { problem(error); await refreshState().catch(() => {}); return false; }
    operation = kind; notice = ''; onChange();
    try {
      const result = await action(request, true); await refreshState();
      if (kind === 'close' && result?.closed === false) notice = 'The page asked to stay open. Your preview is still here.';
      else if (kind === 'keep' && result?.promoted === true) toast('Preview kept as a tab.');
      if (!getState()?.preview && returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus();
      return result;
    } catch (error) { await refreshState().catch(() => {}); return problem(error); }
    finally { operation = null; onChange(); }
  }
  $('preview-address-button').addEventListener('click', () => { void open($('address').value); });
  $('newtab-preview').addEventListener('click', () => { void open($('newtab-address').value); });
  $('preview-address-form').addEventListener('submit', event => { event.preventDefault(); void submitAddress().catch(problem); });
  $('cancel-preview-address').addEventListener('click', () => { void closeDialog('preview-address-dialog').catch(() => {}); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); void closeDialog('preview-address-dialog').catch(() => {}); });
  dialog.addEventListener('close', () => { inputReview = null; });
  $('page-preview-close').addEventListener('click', () => { void finish('close'); });
  $('page-preview-keep').addEventListener('click', () => { void finish('keep'); });
  window.addEventListener('pagehide', () => { displayed = null; inputReview = null; returnFocus = null; contextGeneration++; });
  return Object.freeze({ render, active, show, open, close: () => finish('close'), keep: () => finish('keep'),
    command(value) {
      if (!active()) return false;
      if (value === 'w') void finish('close');
      else if (value === 'l') $('page-preview-url').focus();
      else { $('page-preview-close').focus(); toast('Close this preview or keep it as a tab to use browser page controls.'); }
      return true;
    } });
}
