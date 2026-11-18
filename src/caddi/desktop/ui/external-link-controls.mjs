/** Owner-only external-link review. URL data arrives only from direct trusted actions. */
export function createExternalLinkControls({ getState, refreshState, action, openDialog, closeDialog, toast }) {
  const $ = id => document.getElementById(id);
  const dialog = $('external-links-dialog'), list = $('external-links-list'), status = $('external-links-status');
  let review = null, busy = false, sequence = 0, expiryTimer = null, ownerScope = null, reviewedRevision = null;
  const scope = () => {
    const state = getState(), id = state?.metadata?.activeWorkspaceId ?? '';
    return id + ':' + String(state?.privacy?.[id]?.capturePrivacyEpoch ?? '');
  };
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  function clearLocal() {
    sequence++; clearTimeout(expiryTimer); expiryTimer = null;
    review = null; ownerScope = null; reviewedRevision = null; list.replaceChildren();
  }
  function controls() {
    for (const control of list.querySelectorAll('button,select')) control.disabled = busy;
    for (const form of list.querySelectorAll('form')) {
      const select = form.querySelector('select'), open = form.querySelector('[data-external-open]');
      if (open) open.disabled = busy || !select?.value || !review;
    }
    $('refresh-external-links').disabled = busy;
    $('close-external-links').disabled = busy;
    dialog.setAttribute('aria-busy', String(busy));
  }
  async function release(old) {
    if (old) await action({ type: 'external-links.close', reviewId: old.reviewId }, true).catch(() => {});
  }
  function invalidate(message) {
    const old = review; clearLocal(); status.textContent = message; controls();
    void release(old);
  }
  function render() {
    const summary = getState()?.externalLinks ?? { pending: 0, revision: 0 };
    $('external-links').hidden = summary.pending === 0 && !dialog.open;
    $('external-links-count').textContent = String(summary.pending);
    $('external-links').setAttribute('aria-label', 'Review ' + summary.pending + ' link' + (summary.pending === 1 ? '' : 's') + ' from other apps');
    if (!dialog.open || busy || !review) return;
    if (scope() !== ownerScope) {
      invalidate('This workspace changed. Refresh to review the waiting links again.');
      return;
    }
    if (summary.revision !== reviewedRevision)
      status.textContent = 'The waiting links changed. Refresh to include the latest links.';
  }
  async function close() {
    if (busy) return;
    const old = review; clearLocal(); busy = true; controls();
    try { await release(old); await closeDialog('external-links-dialog'); }
    finally { busy = false; controls(); render(); }
  }
  async function run(kind, linkId, workspaceId) {
    if (busy || !review) return;
    const reviewed = review;
    if (scope() !== ownerScope || reviewed.expiresAt <= Date.now()) {
      invalidate('This review expired or the workspace changed. Refresh before opening a link.'); return;
    }
    busy = true; controls();
    status.textContent = kind === 'open' ? 'Opening privately in the workspace you chose…' : 'Dismissing link…';
    try {
      const result = await action(kind === 'open' ?
        { type: 'external-links.open', reviewId: reviewed.reviewId, linkId, workspaceId } :
        { type: 'external-links.dismiss', reviewId: reviewed.reviewId, linkId }, true);
      if (kind === 'open') {
        clearLocal();
        toast(result?.opened ? 'Link opened privately. Resume agents in that workspace when you are ready.' :
          'Review the selected workspace before trying this link again.');
        await release(reviewed); await closeDialog('external-links-dialog'); render(); return;
      }
      busy = false; await refresh(); return;
    } catch (error) {
      if (kind === 'open' && error.code === 'EXTERNAL_LINK_OUTCOME_UNKNOWN') {
        clearLocal();
        toast('The link may have opened. Check the selected workspace before opening it again.');
        await release(reviewed); await closeDialog('external-links-dialog'); render(); return;
      }
      status.textContent = error.message;
      if (['EXTERNAL_LINK_REVIEW_STALE', 'EXTERNAL_LINK_STALE', 'EXTERNAL_LINK_WORKSPACE_STALE', 'CLOSED'].includes(error.code)) {
        const old = review; clearLocal(); void release(old);
      }
    } finally { busy = false; controls(); render(); }
  }
  function paint() {
    list.replaceChildren();
    if (!review.links.length) {
      list.append(node('p', 'No links are waiting.', 'empty-note')); return;
    }
    for (const link of review.links) {
      const form = node('form', undefined, 'external-link-card');
      form.dataset.externalLinkId = link.id;
      const heading = node('h3', link.origin);
      const details = node('details'), summary = node('summary', 'Full address'), address = node('code', link.url, 'external-link-address');
      details.append(summary, address);
      const label = node('label', 'Open in workspace');
      const select = node('select'); select.name = 'workspaceId'; select.required = true;
      select.setAttribute('aria-label', 'Choose a workspace for ' + link.origin);
      const empty = node('option', 'Choose a workspace'); empty.value = ''; select.append(empty);
      for (const choice of review.workspaces) {
        const option = node('option', choice.name); option.value = choice.id; select.append(option);
      }
      label.append(select);
      const actions = node('div', undefined, 'dialog-actions');
      const dismiss = node('button', 'Dismiss', 'subtle'); dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss link from ' + link.origin);
      const open = node('button', 'Open privately', 'primary'); open.type = 'submit'; open.dataset.externalOpen = '';
      open.disabled = true;
      dismiss.addEventListener('click', () => void run('dismiss', link.id));
      select.addEventListener('change', controls);
      form.addEventListener('submit', event => { event.preventDefault(); if (select.value) void run('open', link.id, select.value); });
      actions.append(dismiss, open); form.append(heading, details, label, actions); list.append(form);
    }
  }
  async function refresh() {
    if (busy) return;
    const token = ++sequence, previous = review;
    clearTimeout(expiryTimer); expiryTimer = null; review = null; list.replaceChildren();
    busy = true; controls(); status.textContent = 'Loading waiting links…';
    try {
      await release(previous);
      // Host selection can finish before its coalesced state event reaches this
      // renderer. Bind review to a fresh owner snapshot, never that stale cache.
      await refreshState();
      const capturedScope = scope(), result = await action({ type: 'external-links.review' }, true);
      if (token !== sequence || capturedScope !== scope()) {
        await release(result);
        if (token === sequence) status.textContent = 'The workspace changed. Refresh to review the waiting links again.';
        return;
      }
      review = result; ownerScope = capturedScope;
      reviewedRevision = getState()?.externalLinks?.revision ?? 0;
      paint();
      status.textContent = result.workspaces.length ? 'Choose a workspace. No workspace is selected for you.' :
        'No workspace is available right now. Create or reopen one, then refresh this review.';
      expiryTimer = setTimeout(() => {
        if (!busy && review === result) invalidate('This review expired. Refresh to review the waiting links again.');
      }, Math.max(1, result.expiresAt - Date.now()));
    } catch (error) {
      if (token === sequence) status.textContent = error.message;
    } finally { busy = false; controls(); render(); }
  }
  async function show() {
    if (busy) return;
    if (document.querySelector('dialog[open]') && !dialog.open) return;
    if (!dialog.open) await openDialog('external-links-dialog');
    await refresh();
    (list.querySelector('select') ?? $('close-external-links')).focus();
  }
  $('external-links').addEventListener('click', () => void show().catch(error => toast(error.message)));
  $('close-external-links').addEventListener('click', () => void close().catch(() => {}));
  $('refresh-external-links').addEventListener('click', () => void refresh());
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close().catch(() => {}); });
  window.addEventListener('pagehide', clearLocal);
  return { render, show };
}
