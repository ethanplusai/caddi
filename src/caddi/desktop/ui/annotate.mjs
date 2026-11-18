// Chrome side of Annotate: the toolbar toggle, its shortcut and short status
// messages. The markers, note popover and bottom bar are drawn inside the page
// by the isolated page preload; this module never touches page content.
const button = document.getElementById('annotate');
const toastNode = document.getElementById('toast');
const messages = {
  ANNOTATE_NO_PAGE: 'Open a page first, then annotate it.',
  ANNOTATE_UNAVAILABLE: 'Annotate isn’t available here right now.',
  ANNOTATE_BUSY: 'Annotate is already open in another window.',
  ANNOTATE_INACTIVE: 'Annotate is not open on this page.',
  ANNOTATE_EMPTY: 'Add a note first.',
  ANNOTATE_SENDING: 'These notes are already being sent.',
  AGENT_CONTROL_ACTIVE: 'An agent is working in this tab. Annotate once it finishes.',
  LIVE_ACTIVE: 'Stop Live first, then annotate.',
  HUMAN_REVIEW_ACTIVE: 'Finish selecting on the page first.',
  SELECTION_BUSY: 'Finish selecting on the page first.',
  PRIVATE_CAPTURE_UNAVAILABLE: 'Annotate isn’t available in private windows.',
  PRIVACY_BLOCKED: 'Agents and capture are paused in this workspace.',
  PAGE_NOT_READY: 'This page is still loading. Try again in a moment.',
  RECIPIENT_UNAVAILABLE: 'That agent is no longer connected.',
  SYSTEM_PAUSED: 'Caddi is paused.',
};
let state = null, busy = false, seenEvent = 0, toastTimer = 0, badge = null;

function toast(message) {
  if (!toastNode) return;
  toastNode.textContent = message; toastNode.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastNode.hidden = true; }, 3200);
}
async function act(value) {
  const reply = await window.caddi.action(value);
  if (!reply?.ok) {
    const error = new Error(messages[reply?.code] ?? 'That didn’t work. Try again.');
    error.code = reply?.code; throw error;
  }
  return reply.result;
}
const view = () => state?.annotate ?? null;

function render() {
  if (!button) return;
  const annotate = view(), isPrivate = !!state?.privateBrowsing, on = !!annotate && (annotate.active || annotate.pending);
  button.hidden = isPrivate;
  button.disabled = isPrivate || busy;
  button.setAttribute('aria-pressed', String(on));
  button.classList.toggle('active', on);
  button.setAttribute('aria-busy', String(busy || !!annotate?.pending));
  const count = on ? annotate.count : 0;
  button.title = on ? 'Stop annotating (Esc)' : 'Annotate this page (⇧⌘A)';
  button.setAttribute('aria-label', on ? 'Stop annotating' + (count ? ', ' + count + (count === 1 ? ' note' : ' notes') : '') : 'Annotate this page');
  if (count && !badge) { badge = document.createElement('span'); badge.className = 'annotate-count'; badge.setAttribute('aria-hidden', 'true'); button.append(badge); }
  if (badge) { badge.hidden = !count; badge.textContent = count ? String(count) : ''; }
  // Outcomes of actions taken in the page's own bar ("Copied 3 notes", "Sent to Claude Code").
  const event = annotate?.event;
  if (event && event.id > seenEvent) { seenEvent = event.id; toast(event.message); }
}

async function toggle() {
  if (busy || !button || button.hidden) return;
  const annotate = view();
  busy = true; render();
  try { await act({ type: annotate?.active || annotate?.pending ? 'annotate.stop' : 'annotate.start' }); }
  catch (error) { toast(error.message); }
  finally { busy = false; render(); }
}

button?.addEventListener('click', () => { void toggle(); });
window.addEventListener('keydown', event => {
  // Escape while the chrome has focus (the page handles its own Escape).
  if (event.key !== 'Escape' || event.defaultPrevented || !view()?.active || document.querySelector('dialog[open]')) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  void act({ type: 'annotate.stop' }).catch(() => {});
});
window.caddi.onCommand(command => { if (command === 'annotate' && !document.querySelector('dialog[open]')) void toggle(); });
window.caddi.onState(value => { state = value; render(); });
void window.caddi.getState().then(value => {
  if (!state) state = value;
  // Do not replay an outcome from before this window loaded.
  seenEvent = Math.max(seenEvent, state?.annotate?.event?.id ?? 0);
  render();
}, () => {});
