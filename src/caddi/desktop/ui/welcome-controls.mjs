import { agentToolsView } from './agent-setup.mjs';

export const WELCOME_REPOSITORY = 'https://github.com/ethanplusai/caddi';
export const WELCOME_STEPS = Object.freeze(['welcome', 'workspace', 'agent', 'ready']);

/** Everything the welcome shows for one step, derived from the snapshot alone. */
export function welcomeView(snapshot, index = 0) {
  const last = WELCOME_STEPS.length - 1, at = Math.min(Math.max(Number.isInteger(index) ? index : 0, 0), last);
  const workspace = snapshot?.metadata?.workspaces?.find(item => item.id === snapshot.metadata.activeWorkspaceId) ?? null;
  const tools = agentToolsView(snapshot);
  const palette = snapshot?.shortcuts?.commands?.find(item => item.id === 'k')?.display || '⌘K';
  return { step: WELCOME_STEPS[at], index: at, count: WELCOME_STEPS.length, first: at === 0, last: at === last,
    progress: `Step ${at + 1} of ${WELCOME_STEPS.length}`, next: at === last ? 'Start browsing' : at === 0 ? 'Get started' : 'Next',
    firstRun: snapshot?.welcome?.show === true, workspaceId: workspace?.id ?? null, workspaceName: workspace?.name ?? '',
    tools, toolsMessage: tools.visible ? '' : 'No coding tools were found on this Mac yet. You can connect one any time from Agents in the sidebar.',
    shortcuts: { annotate: '⇧⌘A', palette } };
}

/** The first-run welcome. Shown once, and again whenever the owner asks for it. */
export function createWelcomeControls({ getState, action, refresh, openDialog, closeDialog, renderTools, ready = () => true, ownerDocument = document }) {
  const $ = id => ownerDocument.getElementById(id), dialog = $('welcome-dialog');
  let index = 0, offered = false, busy = false;
  function render(focus = false) {
    const view = welcomeView(getState(), index);
    for (const section of dialog.querySelectorAll('[data-welcome-step]')) section.hidden = section.dataset.welcomeStep !== view.step;
    dialog.dataset.step = view.step;
    $('welcome-progress').textContent = view.progress;
    for (const [at, dot] of [...dialog.querySelectorAll('.welcome-dots i')].entries()) dot.toggleAttribute('data-current', at === view.index);
    $('welcome-back').hidden = view.first; $('welcome-skip').hidden = view.last;
    $('welcome-next').textContent = view.next;
    renderTools(getState());
    $('welcome-agent-empty').textContent = view.toolsMessage; $('welcome-agent-empty').hidden = view.tools.visible;
    $('welcome-key-annotate').textContent = view.shortcuts.annotate; $('welcome-key-palette').textContent = view.shortcuts.palette;
    if (focus) {
      if (view.step === 'workspace') { $('welcome-workspace-name').focus(); $('welcome-workspace-name').select(); }
      else dialog.querySelector('[data-welcome-step="' + view.step + '"] h2')?.focus();
    }
    return view;
  }
  async function finish() {
    if (busy) return; busy = true;
    try { await action({ type: 'welcome.complete' }, true).catch(() => {}); await closeDialog('welcome-dialog'); }
    finally { busy = false; }
  }
  async function saveWorkspaceName() {
    const view = welcomeView(getState(), index), name = $('welcome-workspace-name').value.trim(), status = $('welcome-workspace-status');
    status.textContent = '';
    if (!view.workspaceId || !name || name === view.workspaceName) return true;
    try { await action({ type: 'workspace.rename', workspaceId: view.workspaceId, name }, true); await refresh(); return true; }
    catch { status.textContent = 'That name could not be saved. Try a shorter one, or keep the current name.'; return false; }
  }
  async function next() {
    if (busy) return;
    if (WELCOME_STEPS[index] === 'workspace') { busy = true; try { if (!await saveWorkspaceName()) return; } finally { busy = false; } }
    if (index >= WELCOME_STEPS.length - 1) return finish();
    index++; render(true);
  }
  async function show() {
    if (dialog.open) return true;
    index = 0;
    await openDialog('welcome-dialog');
    if (!dialog.open) return false;
    $('welcome-workspace-name').value = welcomeView(getState(), 0).workspaceName;
    $('welcome-workspace-status').textContent = ''; $('welcome-star-status').textContent = '';
    render(); $('welcome-next').focus();
    void action({ type: 'agent.tools.refresh' }, true).then(refresh).catch(() => {});
    return true;
  }
  $('welcome-next').addEventListener('click', () => void next().catch(() => {}));
  $('welcome-back').addEventListener('click', () => { if (!busy && index > 0) { index--; render(true); } });
  $('welcome-skip').addEventListener('click', () => void finish());
  dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
  $('welcome-workspace-name').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void next().catch(() => {}); } });
  $('welcome-star').addEventListener('click', async () => {
    const view = welcomeView(getState(), index), status = $('welcome-star-status');
    try {
      await action({ type: 'tab.create', workspaceId: view.workspaceId, input: WELCOME_REPOSITORY, activate: false }, true);
      status.textContent = 'Opened in a new tab. It will be waiting when you finish here.';
    } catch { status.textContent = 'Open ' + WELCOME_REPOSITORY.replace('https://', '') + ' in a tab when you are ready.'; }
  });
  return { show, render: () => { if (dialog.open) render(); },
    /** Offer the welcome once per window, the first time nothing else is open. */
    async firstRun() {
      // Wait quietly while the app is paused or busy with another dialog; a later render tries again.
      if (offered || getState()?.welcome?.show !== true || !ready() || ownerDocument.querySelector('dialog[open]')) return false;
      offered = true;
      if (!await show()) { offered = false; return false; }
      return true;
    } };
}
