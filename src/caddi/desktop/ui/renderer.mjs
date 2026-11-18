import { createRecorder } from './recorder.mjs';
import { createDailyControls, tabDisplayLabel } from './daily-controls.mjs';
import { createExternalLinkControls } from './external-link-controls.mjs';
import { createShortcutControls } from './shortcut-controls.mjs';
import { createStorageControls } from './storage-controls.mjs';
import { createLoginsControls } from './logins-controls.mjs';
import { createDefaultBrowserControls } from './default-browser-controls.mjs';
import { createOwnerCredentialControls } from './owner-credential-controls.mjs';
import { createPortabilityControls } from './portability-controls.mjs';
import { createMediaControls } from './media-controls.mjs';
import { createPagePreviewControls, previewBlocksAction } from './page-preview-controls.mjs';
import { createSystemLifecycleControls, systemLifecycleView, systemLifecycleBlocksAction, systemLifecycleMessages, restoreDialogFocus } from './system-lifecycle-controls.mjs';
import { createPersistenceControls, persistenceView, persistenceMessages, reviewedConnectionMutation } from './persistence-controls.mjs';
import { renderAgentSetup, renderAgentTools, agentToolMessage } from './agent-setup.mjs';
import { createWelcomeControls } from './welcome-controls.mjs';
import { serviceOperations, ownerServiceOperations, scopedServiceOperations, serviceConnectionDescription } from './service-catalog.mjs';
import { containedImageBounds } from './moment-geometry.mjs';
import { icon, installIcons } from './icons.mjs';
import { createSentControls } from './sent-controls.mjs';
installIcons();
document.addEventListener('pointerdown',()=>document.body.classList.add('pointer-input'),true);
document.addEventListener('keydown',()=>document.body.classList.remove('pointer-input'),true);
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
let state, toastTimer, currentEditor = null, recording = null, submitting = false, readingTimer = null;
const AGENT_READING_MS = 4000;
let previewKey = null, previewGeneration = 0;
let selectedMomentId = null, momentTool = 'rectangle', momentWrite = Promise.resolve(), momentPointer = null, momentEditsPending = 0;
let renderedMomentKey = null, preparedKey = null, preparedGeneration = 0;
let reviewEditVersion = 0;
let reviewCloseLocked = false;
let loginControls, signInSeen = new Set();
let sentControls, daily, externalLinks, shortcuts, welcome, storage, portability, siteMedia, pagePreview, systemLifecycle, persistence, defaultBrowser, credentialControls, permissionAutoRequest = null, agentsSection = 'setup', sidebarOpen = false, captureToolsDraft = null;
const buffers = new Map(), signatures = new Map();
const dialogFocus = new Map();
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
  const prior = dialogFocus.get(dialog.id); dialogFocus.delete(dialog.id);
  if (prior) queueMicrotask(() => restoreDialogFocus({ snapshot: state, target: prior, dialog }));
});
const cancelledCaptures = new Set();
const errorMessages = {
  ...systemLifecycleMessages,
  ...persistenceMessages,
  SECOND_TAB_REQUIRED: 'Open a second tab to use split view.',
  INVALID_URL: 'Caddi can open web addresses (http and https) up to 8,192 characters, or search for what you type.',
  LOCAL_SPEECH_UNAVAILABLE: 'Speech-to-text is unavailable. You can type instead.',
  PRIVACY_BLOCKED: 'Agents are paused in this workspace. Resume agents when you are ready.',
  STALE_TARGET: 'The page changed. Select the element again.',
  PAGE_NOT_READY: 'The page is still loading. Try again in a moment.',
  CAPTURE_UNAVAILABLE: 'This page could not be captured. No screenshot was saved.',
  CAPTURE_CHANGED: 'The page changed during capture. Start capturing again.',
  CAPTURE_INVALIDATED: 'The screenshot was cancelled because this page or workspace changed.',
  CAPTURE_SIZE: 'This page image is too large to keep as a screenshot.',
  PREPARE_CAPACITY: 'The originals and marked copies are over the 8 MB limit. Use fewer or smaller screenshots, then take them again.',
  PREPARE_SIZE: 'A marked image is too large to prepare. Use a smaller image or fewer marks and try again.',
  PREPARE_INVALIDATED: 'This draft changed while images were preparing. Open the current draft and try again.',
  PREPARE_BUSY: 'Marked copies are already being prepared.',
  PREPARE_TIMEOUT: 'Preparing the images took too long. The originals are unchanged. Try again.',
  PREPARE_SOURCE: 'An original image is unavailable. No marked copies were prepared.',
  PREPARE_UNAVAILABLE: 'These marked copies are out of date. Prepare the latest draft again.',
  PRINT_BUSY: 'Finish the current print or PDF dialog first.',
  PRINT_PROTECTED: 'Printing is unavailable while agents are paused or an agent controls this workspace.',
  PAGE_COPY_PROTECTED: 'Copying page content is unavailable while agents are paused in this workspace.',
  PAGE_CONTEXT_CHANGED: 'The page or window changed. Nothing was copied.',
  LOGIN_SECRET_EXPOSED: 'This page shows a saved password, so it was not copied. Reload the page and try again.',
  PRINT_PAGE_UNAVAILABLE: 'Open a loaded page in this tab before printing.',
  PRINT_CONTEXT_CHANGED: 'The page or workspace changed. PDF saving stopped; a confirmed system print job may still continue.',
  PRINT_FAILED: 'The system print dialog could not complete. No result was confirmed.',
  PDF_FAILED: 'The PDF could not be saved. No file was written.',
  PDF_INVALID: 'The PDF could not be created or is larger than 16 MB. No file was saved.',
  PDF_PATH_UNAVAILABLE: 'Choose a normal writable folder and a new .pdf filename.',
  PDF_EXISTS: 'A file already exists at that location. Choose a new .pdf filename.',
  FEEDBACK_EMPTY: 'Write the note before sending.',
  SENT_NOT_FOUND: 'That item is gone. The list has been updated.',
  SENT_UNAVAILABLE: 'That isn’t available for this item.',
  SENT_ITEM_RECEIVED: 'The agent already received this, so it can’t be deleted.',
  MOMENT_DELIVERY_UNAVAILABLE: 'Screenshot notes stay on this Mac. They can’t be sent to an agent yet.',
  RECIPIENT_UNAVAILABLE: 'Choose an agent that is connected to this workspace.',
  REVISION_CONFLICT: 'This note changed. Open it again from Sent.',
  REVIEW_UNAVAILABLE: 'That screenshot is no longer selected. Choose it again before editing.',
  CAPTURE_STOP_PENDING: 'Waiting for the microphone request to finish. Agents stay paused until then.',
  SELECTION_BUSY: 'Finish the selection in the other window before starting another.',
  PAGE_CAPACITY: 'This development build can keep 32 pages loaded. Close a loaded tab, then try again.',
  TAB_CAPACITY: 'This build has reached its saved-tab limit. Close some tabs before adding more.',
  WINDOW_CAPACITY: 'This development build supports up to 8 windows.',
  SERVICE_BACKEND_UNAVAILABLE: 'Secure storage for service keys is not available. Service connections are off.',
  SERVICE_DENIED: 'That service connection or grant is unavailable for this workspace and agent.',
  SERVICE_REVIEW_STALE: 'This access changed while you were reviewing it. Review the current workspace and recipient again.',
  ATTENTION_STALE: 'That help request changed or ended. Review the current requests.',
  WORKSPACE_CAPACITY: 'This development build has reached its saved-workspace limit. Your existing workspaces are unchanged.',
  WORKSPACE_ARCHIVED: 'This workspace is archived. Choose Reopen to return to it.',
  WORKSPACE_TRANSITION: 'The workspace changed during this action. Review its current state and try again.',
  WORKSPACE_MANAGEMENT_UNAVAILABLE: 'Agent workspace management is unavailable in this build.',
  WORKSPACE_MANAGEMENT_BUSY: 'A workspace operation is already in progress. Wait for its result.',
  WORKSPACE_MANAGEMENT_CAPACITY: 'This connection has reached its workspace-operation limit. Review a new pairing to continue.',
  WORKSPACE_ALREADY_CREATED: 'This connection already has its workspace. Reopen that workspace to continue.',
  WORKSPACE_LIFECYCLE_STALE: 'The workspace changed while this action was open. Review its current state and try again.',
  WORKSPACE_REOPEN_UNAVAILABLE: 'This workspace cannot be reopened by that connection. It remains available to its owner.',
  WORKSPACE_LIFECYCLE_UNCERTAIN: 'The workspace operation may have started, but its result is unconfirmed. Review the saved workspace before trying anything else.',
  WORKSPACE_LIFECYCLE_FAILED: 'The workspace operation could not finish. Existing saved state was retained.',
  EXTERNAL_LINK_REVIEW_BUSY: 'Link review is already open in another window, or a link is opening. Finish there first.',
  EXTERNAL_LINK_REVIEW_STALE: 'This link review changed or expired. Refresh to review the current links.',
  EXTERNAL_LINK_STALE: 'That link expired or was already handled. Refresh the waiting links.',
  EXTERNAL_LINK_WORKSPACE_STALE: 'The selected workspace changed. Refresh the review and choose its current state.',
  EXTERNAL_LINK_OPEN_FAILED: 'The link could not open. Review the selected workspace, then try again.',
  EXTERNAL_LINK_OUTCOME_UNKNOWN: 'The link may have opened. Check the selected workspace before opening it again.',
  EXTERNAL_LINK_CLOSED: 'Link review is unavailable while Caddi is closing.',
  UNDO_STALE: 'That folder undo is no longer available. Your current organization was kept.',
  UNDO_CONFLICT: 'This folder or its contents changed. Caddi kept the current organization.',
  UNDO_CAPACITY: 'There is no room to restore that folder. Your current organization was kept.',
  ORDER_STALE: 'The list changed. Review its current order and try again.',
  ORDER_SCOPE_MISMATCH: 'Reorder within the same list. Move tabs between folders from Organize.',
  PRIVATE_FEATURE_UNAVAILABLE: 'This feature is unavailable in a private window. Open a normal window to use it.',
  PRIVATE_SCOPE_STALE: 'This private window changed. Review its current state before trying again.',
  PRIVATE_SCOPE_RETIRED: 'This private session has ended. Open a new private window to continue.',
  PRIVATE_SCOPE_CLOSED: 'This private window is closing. You can open a normal window to continue.',
  PRIVATE_SCOPE_CAPACITY: 'The private-window limit has been reached. Close an existing private window first.',
  PRIVATE_STATE_CAPACITY: 'This private window has reached its tab or folder limit.',
  PRIVATE_QUEUE_CAPACITY: 'Another private-window action is still finishing. Try again in a moment.',
  PRIVATE_CLOSE_CANCELLED: 'A page asked to stay open. The private window is still available.',
  PREVIEW_BUSY: 'Close this preview or keep it as a tab before using browser page controls.',
  PREVIEW_STALE: 'This preview changed. Review its current state before trying again.',
  PREVIEW_REVISION_STALE: 'Your tabs changed. Review the current preview before keeping it.',
  PREVIEW_PRIVACY_BLOCKED: 'The preview is paused while agents are paused. Close it to return to the workspace.',
  PREVIEW_OUTCOME_UNKNOWN: 'The preview action could not be confirmed. Review its current state before continuing.',
};
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
async function action(value, quiet = false) {
  if (systemLifecycleBlocksAction(state, value)) {
    const error = Object.assign(new Error(systemLifecycleMessages.SYSTEM_PAUSED), { code: 'SYSTEM_PAUSED' });
    if (!quiet) toast(error.message); throw error;
  }
  if (pagePreview?.active() && previewBlocksAction(value?.type)) {
    const error = Object.assign(new Error('Close this preview or keep it as a tab before using browser page controls.'), { code: 'PREVIEW_BUSY' });
    if (!quiet) toast(error.message); throw error;
  }
  const reply = await window.caddi.action(value);
  if (!reply.ok) {
    const error = new Error(errorMessages[reply.code] ?? 'Could not complete this action. Check the current workspace and try again.');
    error.code = reply.code; if (!quiet) toast(error.message); throw error;
  }
  if (value?.type === 'overlay.set') showPageBackdrop(value.open, reply.result?.backdrop);
  return reply.result;
}
// While a dialog is open the native page is hidden; a still image of it stays in its place.
function showPageBackdrop(open, shots) {
  const holder = $('page-backdrop');
  if (!open) { holder.hidden = true; holder.replaceChildren(); return; }
  if (!Array.isArray(shots) || !shots.length) return;
  holder.replaceChildren(...shots.map(shot => {
    const image = document.createElement('img'); image.alt = ''; image.src = shot.src;
    for (const side of ['left', 'top', 'width', 'height']) image.style[side] = shot[side] * 100 + '%';
    return image;
  }));
  holder.hidden = false;
}
// A dialog closed by a click outside it or by Escape gives the window back to the page.
document.addEventListener('close', event => {
  if (!(event.target instanceof HTMLDialogElement) || document.querySelector('dialog[open]') || sidebarOpen) return;
  void action({ type: 'overlay.set', open: false }, true).catch(() => {});
}, true);
const click = (id, fn) => $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(() => {}));
const immediateClick = (id, fn) => $(id).addEventListener('click', () => {
  try { void Promise.resolve(fn()).catch(() => {}); } catch {}
});
function changed(key, value) {
  const signature = JSON.stringify(value);
  if (signatures.get(key) === signature) return false;
  signatures.set(key, signature); return true;
}
const workspace = () => state.metadata.workspaces.find(item => item.id === state.metadata.activeWorkspaceId);
const group = () => state.metadata.groups.find(item => item.id === workspace()?.activeGroupId);
const activeTab = () => state.metadata.tabs.find(item => item.id === group()?.activeTabId);
const activeDraft = () => state?.drafts?.find(item => item.feedbackId === state.activeDraftId);
const activeAgent = item => item.workspaceActive === true && item.connected === true;
const privateWindow = () => state?.privateBrowsing ?? null;
// Workspace badges take one of six quiet brand tones, stable for a given workspace.
const workspaceInitial = item => Array.from(String(item?.name ?? '').trim())[0]?.toUpperCase() ?? '';
const workspaceTone = item => { let sum = 0; for (const char of String(item?.identityId ?? item?.id ?? item?.name ?? '')) sum = (sum * 31 + char.codePointAt(0)) % 9973; return sum % 6; };
function renderWorkspaceBadge(item) {
  $('workspace-badge').textContent = workspaceInitial(item);
  if (item) $('workspace-badge').dataset.tone = String(workspaceTone(item)); else delete $('workspace-badge').dataset.tone;
}
const privateUnavailable = () => toast('This feature is unavailable in a private window. Open a normal window to use it.');
function renderShortcutLabels() {
  const commands = new Map((state.shortcuts?.commands ?? []).map(item => [item.id, item]));
  for (const node of document.querySelectorAll('[data-shortcut-label]')) {
    const command = commands.get(node.dataset.shortcutLabel);
    node.textContent = command?.binding ? command.display : ''; node.hidden = !command?.binding;
  }
  for (const node of document.querySelectorAll('[data-shortcut-title]')) {
    const command = commands.get(node.dataset.shortcutCommand);
    node.title = node.dataset.shortcutTitle + (command?.binding ? ' · ' + command.display : '');
    if (command?.binding) node.setAttribute('aria-keyshortcuts', command.binding.replace('Primary', 'Meta'));
    else node.removeAttribute('aria-keyshortcuts');
  }
}
function renderPrivateWindow() {
  const mode = privateWindow(), isPrivate = !!mode, active = !mode || mode.status === 'active';
  document.body.dataset.privateBrowsing = String(isPrivate);
  document.title = isPrivate ? 'Caddi · Private window' : 'Caddi';
  $('normal-workspace-controls').hidden = isPrivate;
  $('private-window-controls').hidden = !isPrivate; $('private-window-badge').hidden = !isPrivate;
  $('private-newtab-note').hidden = !isPrivate;
  $('open-storage').hidden = isPrivate; $('open-storage').disabled = isPrivate || !workspace();
  $('newtab-title').textContent = isPrivate ? 'Browse in a private window' : 'Search or enter an address';
  $('sidebar-search-label').textContent = isPrivate ? 'Search private tabs' : 'Search tabs';
  $('sidebar-command').setAttribute('aria-label', isPrivate ? 'Search private tabs and commands' : 'Search tabs and commands');
  $('command-query').placeholder = isPrivate ? 'Search private tabs and commands' : 'Search commands, tabs, and workspaces';
  $('command-query').setAttribute('aria-label', isPrivate ? 'Search private tabs and commands' : 'Search commands, tabs, and workspaces');
  $('command-title').textContent = isPrivate ? 'Commands and private tabs' : 'Commands, tabs and workspaces';
  $('about-session-note').textContent = isPrivate ?
    'This is a separate temporary browsing session. Its tabs and site sign-ins are not restored after closing. Keyboard and appearance settings apply to all Caddi windows.' :
    persistenceView(state).about;
  for (const id of ['show-history','show-downloads','connect-agent','show-agents','newtab-annotate','site-permissions','private','sent-button','try-example']) {
    $(id).hidden = isPrivate; if (isPrivate) $(id).disabled = true;
  }
  if (isPrivate) {
    setWorkspacePopover(false); setHTML('workspace-list', '');
    $('external-links').hidden = true; $('external-links').disabled = true;
    $('private-window-status').textContent = mode.status === 'cleanup-pending' ? 'Private cleanup pending' : mode.status === 'closing' ? 'Closing private window' : 'Private window';
    $('private-window-description').textContent = mode.status === 'cleanup-pending' ? 'Cleanup is not confirmed. Retry closing this window.' : mode.status === 'closing' ? 'Finishing private-session cleanup…' : 'This window only';
    $('close-private-window').textContent = mode.status === 'cleanup-pending' ? 'Retry closing private window' : 'Close private window';
    $('close-private-window').disabled = mode.status === 'closing';
    for (const id of ['mcp-config','pending-connections','connections-list','services-list','agent-list','attention-requests','admission-jobs']) setHTML(id, '');
    $('review-panel').hidden = true; $('history-panel').hidden = true; $('downloads-panel').hidden = true;
    if (!active) {
      for (const id of ['back','forward','reload','address','newtab-address','pin','split','page-tools','new-tab','new-group','new-folder','edit-group','group-trigger','command-button','sidebar-command']) $(id).disabled = true;
      document.querySelector('.sidebar-scroll').inert = true;
      $('newtab-form').querySelector('button').disabled = true;
      $('privacy-cover').hidden = false;
      $('privacy-cover').querySelector('h2').textContent = mode.status === 'cleanup-pending' ? 'Private cleanup is not confirmed' : 'Closing this private session…';
      $('privacy-cover').querySelector('p').textContent = 'Use the private-window controls to retry closing or open a normal window.';
    } else {
      document.querySelector('.sidebar-scroll').inert = false;
      $('newtab-address').disabled = !workspace(); $('group-trigger').disabled = !group();
      $('newtab-form').querySelector('button').disabled = false;
    }
  } else {
    $('external-links').disabled = false;
    document.querySelector('.sidebar-scroll').inert = false;
    $('newtab-form').querySelector('button').disabled = false;
  }
}
function renderPagePreview() {
  pagePreview?.render();
  const active = pagePreview?.active() === true, current = workspace(), mode = privateWindow();
  document.body.dataset.pagePreview = String(active);
  $('normal-workspace-controls').inert = active;
  $('workspace-switcher').disabled = active;
  $('add-workspace').disabled = active;
  $('newtab-address').disabled = active || !current || !!mode && mode.status !== 'active';
  $('address').setAttribute('aria-label', active ? 'Preview address' : 'Address or search');
  document.querySelector('.sidebar-scroll').inert = active || !!mode && mode.status !== 'active';
  if (!active) return;
  $('address').value = state.preview?.url ?? '';
  setWorkspacePopover(false);
  for (const id of ['back','forward','reload','address','pin','split','page-tools','new-tab','new-group','new-folder','edit-group','group-trigger',
    'command-button','sidebar-command','show-history','show-downloads','site-permissions','sent-button','open-workspace-window','open-storage',
    'page-find','page-split','page-mute','page-edit-tab','page-duplicate','page-print','page-save-pdf','page-copy-markdown','zoom-in','zoom-out','zoom-reset','zoom-status','external-links']) $(id).disabled = true;
  $('newtab-form').querySelector('button').disabled = true;
  $('newtab').hidden = true; $('empty-window').hidden = true;
  $('review-panel').hidden = true; $('history-panel').hidden = true; $('downloads-panel').hidden = true;
  $('page-status').textContent = 'Preview · close or keep this page to continue';
  if (current && state.privacy[current.id]?.blocked) $('private').disabled = true;
}
const systemAppearance=window.matchMedia('(prefers-color-scheme: dark)');
function applyAppearance(choice='system') {
  const theme=choice==='system' ? systemAppearance.matches?'dark':'light' : choice;
  if (document.body.dataset.theme!==theme) {
    document.documentElement.dataset.themeSwitching='true';
    document.body.dataset.theme=theme;
    void document.body.offsetHeight;
    requestAnimationFrame(()=>requestAnimationFrame(()=>delete document.documentElement.dataset.themeSwitching));
  }
  const selected=document.querySelector('#appearance-choice input[value="'+choice+'"]');
  if (selected) selected.checked=true;
}
systemAppearance.addEventListener('change',()=>{if((state?.appearance??'system')==='system')applyAppearance('system');});
const artifactName = kind => ({ screenshot:'Screenshot', audio:'Audio', transcript:'Transcript file', metadata:'Metadata' })[kind] ?? 'Attachment';
function clearEvidencePreview() {
  previewGeneration++; previewKey = null;
  $('evidence-preview').removeAttribute('src'); $('evidence-image').hidden = true;
  $('moment-overlay').replaceChildren(); $('moment-overlay').setAttribute('hidden', '');
  $('evidence-preview-status').hidden = false;
  $('evidence-preview-status').textContent = 'No image is attached to this draft.';
}
function selectedMoment(draft = activeDraft()) { return draft?.evidenceMoments?.find(item => item.momentId === selectedMomentId) ?? null; }
function placeMomentOverlay() {
  const image = $('evidence-preview'), overlay = $('moment-overlay');
  if (!selectedMoment() || !image.naturalWidth || !image.naturalHeight || $('evidence-image').hidden) { overlay.setAttribute('hidden', ''); return; }
  const stage = overlay.parentElement;
  const bounds = containedImageBounds({ stage: stage.getBoundingClientRect(), image: image.getBoundingClientRect(),
    naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
    borderLeft: stage.clientLeft, borderTop: stage.clientTop });
  if (!bounds) { overlay.setAttribute('hidden', ''); return; }
  overlay.style.left = bounds.left + 'px'; overlay.style.top = bounds.top + 'px';
  overlay.style.width = bounds.width + 'px'; overlay.style.height = bounds.height + 'px';
  overlay.setAttribute('viewBox', '0 0 '+image.naturalWidth+' '+image.naturalHeight);
  overlay.setAttribute('preserveAspectRatio', 'none'); overlay.removeAttribute('hidden');
}
function drawMomentMarks() {
  const overlay = $('moment-overlay'); overlay.replaceChildren();
  const image = $('evidence-preview'), width=image.naturalWidth, height=image.naturalHeight;
  if (!width || !height) { placeMomentOverlay(); return; }
  const weight=Math.max(3,Math.min(16,Math.round(Math.min(width,height)/180)));
  const colors = { teal:'#246b59', coral:'#b04f43', gold:'#95702a' };
  const make = (name, attrs) => { const node = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value)); overlay.append(node); };
  for (const mark of selectedMoment()?.marks ?? []) {
    const stroke = colors[mark.color] ?? colors.teal;
    if (mark.kind === 'rectangle') make('rect',{x:mark.x*width,y:mark.y*height,width:mark.width*width,height:mark.height*height,fill:'none',stroke,'stroke-width':weight});
    if (mark.kind === 'arrow') {
      const x=mark.x*width,y=mark.y*height,x2=mark.x2*width,y2=mark.y2*height;
      const angle=Math.atan2(y2-y,x2-x),head=Math.max(weight*3,Math.min(width,height)/28);
      make('line',{x1:x,y1:y,x2,y2,stroke,'stroke-width':weight,'stroke-linecap':'round'});
      for(const offset of [-0.55,0.55]) make('line',{x1:x2,y1:y2,x2:x2-head*Math.cos(angle+offset),y2:y2-head*Math.sin(angle+offset),stroke,'stroke-width':weight,'stroke-linecap':'round'});
    }
  }
  placeMomentOverlay();
}
function renderEvidencePreview(draft, guard) {
  const screenshots = (draft?.artifacts ?? []).filter(item => item.kind === 'screenshot');
  const image = screenshots.find(item => item.artifactId === selectedMoment(draft)?.artifactId) ??
    screenshots.find(item => item.artifactId === draft?.selection?.screenshotRef) ?? screenshots[0];
  const key = state.reviewOpen && draft && !guard.blocked && !guard.transitioning && image ?
    [draft.workspaceId,draft.feedbackId,draft.revision,image.artifactId,guard.capturePrivacyEpoch].join('/') : null;
  if (key === previewKey) return;
  clearEvidencePreview();
  if (!key) return;
  previewKey = key; const generation = previewGeneration;
  $('evidence-preview-status').textContent = 'Loading attached screenshot…';
  void window.caddi.artifactPreview({ workspaceId:draft.workspaceId, feedbackId:draft.feedbackId,
    revision:draft.revision, artifactId:image.artifactId }).then(reply => {
    if (generation !== previewGeneration || previewKey !== key || !state.reviewOpen ||
        state.privacy[draft.workspaceId]?.blocked || state.privacy[draft.workspaceId]?.transitioning) return;
    if (!reply?.ok || reply.result?.artifactId !== image.artifactId ||
        !['image/png','image/jpeg','image/webp'].includes(reply.result.mediaType) ||
        typeof reply.result.base64 !== 'string' || reply.result.base64.length > 1_400_000) {
      $('evidence-preview-status').textContent = 'This attached image cannot be previewed.'; return;
    }
    const node = $('evidence-preview');
    node.onload = () => { if (generation === previewGeneration) { $('evidence-image').hidden = false; $('evidence-preview-status').hidden = true; drawMomentMarks(); } };
    node.onerror = () => { if (generation === previewGeneration) { node.removeAttribute('src'); $('evidence-image').hidden = true; $('evidence-preview-status').textContent = 'This attached image cannot be previewed.'; } };
    node.src = 'data:' + reply.result.mediaType + ';base64,' + reply.result.base64;
  }).catch(() => { if (generation === previewGeneration) $('evidence-preview-status').textContent = 'This attached image cannot be previewed.'; });
}
function clearPreparedPreview() {
  preparedGeneration++; preparedKey=null;
  $('prepared-frame').removeAttribute('src'); $('prepared-contact').removeAttribute('src');
  $('prepared-results').hidden=true; $('prepared-summary').textContent='';
}
function unsavedLocalReview(draft) {
  if (!draft) return false;
  if (buffers.get(draft.feedbackId)?.dirty || momentEditsPending) return true;
  const moment = selectedMoment(draft);
  return !!moment && renderedMomentKey === [draft.workspaceId,draft.feedbackId,moment.momentId].join('/') &&
    $('moment-note').value !== moment.note;
}
// Main reads only this trusted chrome's dirty bit and version during a human window close.
// No draft text or page content crosses the boundary.
globalThis.__caddiReviewDirtySnapshot = () => {
  if (!state) return null;
  const draft=activeDraft();
  return { workspaceId:workspace()?.id??null, feedbackId:draft?.feedbackId??null,
    revision:draft?.revision??null, version:reviewEditVersion,
    dirty:!!state?.reviewOpen && unsavedLocalReview(draft) };
};
globalThis.__caddiReviewCloseGuard = operation => {
  if (operation !== 'lock' && operation !== 'unlock') return null;
  reviewCloseLocked = operation === 'lock';
  for (const id of ['draft-editor','capture-tools','feedback-history']) $(id).inert = reviewCloseLocked;
  return globalThis.__caddiReviewDirtySnapshot();
};
function localReviewChanged() {
  clearPreparedPreview();
  persistence?.render();
  const draft = activeDraft();
  if (draft?.evidenceMoments?.length) {
    $('prepare-evidence').disabled = true;
    $('prepared-status').textContent = 'Save your changes first, then prepare.';
    void action({type:'review.invalidate-local'}, true).catch(()=>{});
  }
}
function renderPreparedEvidence(draft,guard) {
  const section=$('prepared-evidence'), moments=draft?.evidenceMoments??[];
  section.hidden=!moments.length;
  if (!moments.length) { clearPreparedPreview(); return; }
  const dirty=unsavedLocalReview(draft);
  $('prepare-evidence').disabled=guard.blocked || guard.transitioning || !state.reviewOpen || dirty;
  const prepared=state.preparedEvidence;
  const current=prepared && prepared.feedbackId===draft.feedbackId && prepared.revision===draft.revision &&
    !guard.blocked && !guard.transitioning && state.reviewOpen && !dirty;
  if (!current) {
    clearPreparedPreview();
    $('prepared-status').textContent=dirty ? 'Save your changes first, then prepare.' :
      'Prepare this note to see your marks on each screenshot and an overview of all of them.';
    return;
  }
  const frame=prepared.derived.find(item=>item.role==='marked-frame'&&item.momentId===selectedMomentId);
  const sheet=prepared.derived.find(item=>item.role==='contact-sheet');
  if (!frame || !sheet) { clearPreparedPreview(); $('prepared-status').textContent='Prepared images are unavailable. Prepare again.'; return; }
  $('prepared-status').textContent='Prepared on this Mac · '+prepared.sources.length+' originals, '+prepared.derived.length+' marked images.';
  $('prepared-summary').textContent=prepared.summary;
  $('prepared-results').hidden=false;
  const key=[draft.workspaceId,draft.feedbackId,draft.revision,selectedMomentId,guard.capturePrivacyEpoch,frame.sha256,sheet.sha256].join('/');
  if (key===preparedKey) return;
  clearPreparedPreview(); $('prepared-results').hidden=false; $('prepared-summary').textContent=prepared.summary;
  preparedKey=key;const generation=preparedGeneration;
  for (const [role,momentId,node,expected] of [['marked-frame',selectedMomentId,$('prepared-frame'),frame],['contact-sheet',null,$('prepared-contact'),sheet]]) {
    void window.caddi.preparedPreview({workspaceId:draft.workspaceId,feedbackId:draft.feedbackId,revision:draft.revision,role,...(momentId?{momentId}:{})}).then(reply=>{
      if(generation!==preparedGeneration||preparedKey!==key||!state.reviewOpen||state.privacy[draft.workspaceId]?.blocked)return;
      if(!reply?.ok||reply.result?.sha256!==expected.sha256||reply.result.mediaType!=='image/png'||
         typeof reply.result.base64!=='string'||reply.result.base64.length>1_400_000) { $('prepared-status').textContent='A prepared image is unavailable. Prepare again.'; return; }
      node.src='data:image/png;base64,'+reply.result.base64;
    }).catch(()=>{if(generation===preparedGeneration)$('prepared-status').textContent='A prepared image is unavailable. Prepare again.';});
  }
}
function bufferFor(draft) {
  let buffer = buffers.get(draft.feedbackId);
  if (!buffer || (!buffer.dirty && buffer.revision !== draft.revision)) {
    buffer = { text: draft.text, revision: draft.revision, dirty: false }; buffers.set(draft.feedbackId, buffer);
  }
  return buffer;
}
async function syncLayout() {
  const rect = $('page-area').getBoundingClientRect();
  await window.caddi.layout({ x: Math.ceil(rect.x + 1), y: Math.ceil(rect.y + 1), width: Math.floor(rect.width - 2), height: Math.floor(rect.height - 2) });
}
new ResizeObserver(() => void syncLayout().catch(() => {})).observe($('page-area'));
async function refresh() { state = await window.caddi.getState(); render(); return state; }
function setHTML(id, html, signature) {
  if (!changed(id, signature ?? html)) return;
  const element=$(id), active=element.contains(document.activeElement)?document.activeElement:null;
  const key=active&&['data-sent-focus','data-workspace','data-workspace-reopen','data-draft','data-permission-id','data-revoke','data-service-revoke','data-service-remove','data-service-field','data-service-share-revoke','data-attention-accept','data-attention-dismiss','data-admission-cancel'].find(name=>active.hasAttribute(name));
  const value=key&&active.getAttribute(key), scroll=element.scrollTop;
  element.innerHTML=html; element.scrollTop=scroll;
  if (key) [...element.querySelectorAll('['+key+']')].find(node=>node.getAttribute(key)===value)?.focus();
}
function render() {
  if (!state) return;
  systemLifecycle?.beginRender();
  const priorFocus=document.activeElement;
  const focusKey=priorFocus&&['data-select','data-close','data-tab-menu','data-folder-toggle','data-folder-menu','data-workspace','data-workspace-reopen','data-draft'].find(name=>priorFocus.hasAttribute(name));
  const focusValue=focusKey&&priorFocus.getAttribute(focusKey);
  const keyStatus = state.development?.protectedKeys;
  $('protected-keys-status').textContent = keyStatus?.loaded ? 'Secure key storage is loaded but not yet verified' : 'Secure key storage unavailable';
  $('protected-keys-status').title = keyStatus?.loaded ?
    'The storage code loaded. Keychain access in a signed app has not been verified yet.' :
    'Storage code unavailable: ' + String(keyStatus?.reason ?? 'unknown');
  const current = workspace(), tab = activeTab(), page = tab && state.pages[tab.id];
  applyAppearance(state.appearance??'system');
  renderShortcutLabels(); shortcuts?.render(); storage?.render(); portability?.render(); siteMedia?.render(); loginControls?.render();
  renderAgentSetup(state);
  renderAgentTools(state); welcome?.render(); void welcome?.firstRun().catch(()=>{});
  externalLinks?.render();
  setHTML('workspace-list', privateWindow() ? '' : state.metadata.workspaces.map(item => {
    const archived=item.lifecycle?.status==='archived';
    return '<button class="workspace-row '+(item.id===current?.id?'active':'')+'" '+(archived?'data-workspace-reopen="'+escape(item.id)+'" data-workspace-generation="'+escape(item.lifecycle.generation)+'"':'data-workspace="'+escape(item.id)+'"')+' title="'+(archived?'Reopen ':'')+escape(item.name)+' · '+(archived?'Saved workspace':item.kind==='personal'?'Personal':'Project')+'" aria-label="'+(archived?'Reopen archived workspace ':'Switch to workspace ')+escape(item.name)+'"><span class="workspace-badge" data-tone="'+workspaceTone(item)+'">'+escape(workspaceInitial(item))+'</span><span class="workspace-name">'+escape(item.name)+'</span><small>'+(archived?'Reopen':item.kind==='personal'?'Personal':'Project')+'</small>'+(item.id===current?.id?icon('check','workspace-current'):'')+'</button>';
  }).join(''));
  // The rail mirrors the open workspaces so switching is one click. Archived ones stay in the menu.
  const railItems = privateWindow() ? [] : state.metadata.workspaces.filter(item => item.lifecycle?.status !== 'archived');
  $('workspace-rail').hidden = !railItems.length;
  setHTML('workspace-rail-list', railItems.map(item => '<button type="button" class="workspace-rail-item'+(item.id===current?.id?' active':'')+'" data-workspace="'+escape(item.id)+'"'+
    (item.id===current?.id?' aria-current="true"':'')+' title="'+escape(item.name)+' · '+(item.kind==='personal'?'Personal':'Project')+'" aria-label="'+
    (item.id===current?.id?'Current workspace ':'Switch to workspace ')+escape(item.name)+'"><span class="workspace-badge" data-tone="'+workspaceTone(item)+'">'+
    escape(workspaceInitial(item))+'</span></button>').join(''));
  $('empty-window').hidden = !!current;
  $('open-workspace-window').disabled = !current;
  $('new-tab').disabled = !current;
  $('new-group').disabled = !current;
  $('new-folder').disabled = !current;
  $('address').disabled = !current;
  $('command-button').disabled = !current;
  $('sidebar-command').disabled = !current;
  $('site-permissions').disabled = !current;
  $('page-tools').disabled = !current;
  $('private').disabled = !current;
  if (!current) {
    currentEditor = null; clearEvidencePreview();
    daily?.resetEmpty();
    setHTML('tab-list', ''); setHTML('pinned-list', ''); setHTML('favorite-list',''); setHTML('group-select', ''); setHTML('agent-list', '');
    $('workspace-title').textContent = 'No workspace'; renderWorkspaceBadge(null);
    $('workspace-kind').textContent = 'Choose a workspace';
    $('newtab-workspace').textContent = '';
    $('workspace-status').textContent = 'Choose a workspace to continue';
    $('newtab').hidden = true; $('review-panel').hidden = true; $('privacy-cover').hidden = true;
    $('undo-folder-removal').hidden = true;
    $('back').disabled = true; $('forward').disabled = true; $('reload').disabled = true;
    $('pin').disabled = true; $('split').disabled = true; $('sent-button').disabled = true;
    $('page-status').textContent = 'Choose a workspace';
    $('agent-driving').hidden = true;
    if (!privateWindow()) renderAgents();
    renderPrivateWindow();
    renderPagePreview();
    persistence?.render();
    systemLifecycle?.render();
    return;
  }
  const guard = state.privacy[current.id];
  const tabs = state.metadata.tabs.filter(item => item.workspaceId===current.id && (item.status==='open'||item.pinned||item.favorite));
  const agents = state.agents.filter(item=>item.workspaceActive===true && item.workspaceId===current.id && ['connected','approved'].includes(item.status));
  // A content read (caddi_read_page, caddi_extract) shows for a few seconds, here and in the toolbar, so reads are never invisible.
  const clock = Date.now(), reading = item => !!item.lastRead && clock - item.lastRead.at >= 0 && clock - item.lastRead.at < AGENT_READING_MS;
  setHTML('agent-list', agents.map(item=>'<div class="agent-mini"><span><i class="status-dot"></i>'+escape(item.clientName)+'</span><small>'+escape(guard.blocked?'Paused':reading(item)?'Reading a page':item.activeRequests?'Working':item.lease?'Controlling':item.connected?'Connected':'Connecting')+'</small></div>').join(''));
  $('agent-count').textContent = agents.length ? String(agents.length) : '';
  // Who holds control of this workspace right now, with a one-click way to take it back.
  const driver = privateWindow() || guard.blocked ? null : agents.find(item => item.lease);
  const reader = driver || privateWindow() || guard.blocked || !tab ? null : agents.find(item => reading(item) && item.lastRead.tabId === tab.id) ?? null;
  $('agent-driving').hidden = !driver && !reader;
  $('agent-take-over').hidden = !driver;
  if (driver) {
    $('agent-driving-text').textContent = driver.clientName + ' is driving';
    $('agent-take-over').setAttribute('aria-label', 'Take over from ' + driver.clientName);
  } else if (reader) $('agent-driving-text').textContent = reader.clientName + ' is reading this page';
  // Redraw when the most recent read stops showing.
  clearTimeout(readingTimer);
  const lastRead = Math.max(0, ...agents.filter(reading).map(item => item.lastRead.at));
  if (lastRead) readingTimer = setTimeout(() => { if (state) render(); }, AGENT_READING_MS - (clock - lastRead) + 50);
  $('workspace-title').textContent = current.name; renderWorkspaceBadge(current);
  $('workspace-title').title = current.name;
  $('workspace-kind').textContent = current.kind==='personal'?'Personal workspace':'Project workspace';
  $('workspace-switcher').title=current.name+' · '+$('workspace-kind').textContent;
  $('workspace-switcher').setAttribute('aria-label','Switch workspace · '+current.name+' · '+$('workspace-kind').textContent);
  $('newtab-workspace').textContent = current.name;
  $('workspace-status').textContent = privateWindow() ? 'Private window · no agents' : guard.blocked ? 'Agents paused' :
    state.selecting ? 'Selecting on page' : agents.length ? agents.length+(agents.length===1?' agent connected':' agents connected') :
    state.pending.length ? (state.pending.length===1?state.pending[0].clientName.slice(0,40)+' wants to connect':state.pending.length+' agents want to connect') : 'No agent connected';
  $('connect-agent').dataset.state = guard.blocked ? 'paused' : agents.length ? 'connected' : 'idle';
  $('agent-presence').classList.toggle('connected',!!agents.length&&!guard.blocked);
  $('agent-presence').classList.toggle('pending',!!state.pending.length);
  $('private').textContent = guard.blocked ? 'Resume agents' : 'Pause agents';
  $('private').dataset.paused = String(!!guard.blocked);
  $('private').title = guard.blocked ? 'Agents and page capture are paused in this workspace. Resume when you are ready.' : 'Pause agents and page capture in this workspace. Your tabs and sign-ins are not affected.';
  $('private').disabled = guard.transitioning;
  $('address-status').innerHTML = icon(privateWindow() || guard.blocked ? 'shield' : 'page');
  // Keep what the owner is typing; otherwise follow the page (redirects, links, in-page routes).
  if (document.activeElement !== $('address') || !document.hasFocus()) $('address').value = page?.url && page.url!=='about:blank' ? page.url : tab?.url!=='about:blank' ? tab?.url ?? '' : '';
  $('back').disabled = !page?.canGoBack; $('forward').disabled = !page?.canGoForward; $('reload').disabled = !tab;
  const stoppable = !!tab && !!page?.loading;
  if ($('reload').dataset.stop !== String(stoppable)) {
    $('reload').dataset.stop = String(stoppable); $('reload').innerHTML = icon(stoppable ? 'close' : 'reload');
    $('reload').setAttribute('aria-label', stoppable ? 'Stop loading' : 'Reload'); $('reload').title = stoppable ? 'Stop loading' : 'Reload';
  }
  $('pin').innerHTML = icon(tab?.pinned ? 'star' : 'pin'); $('pin').disabled = !tab;
  $('split').disabled = !tab; $('sent-button').disabled = false;
  $('newtab').hidden = !!state.board?.open || (!!tab && !!page?.url && page.url!=='about:blank');
  const favorites=tabs.filter(item=>item.favorite).slice(0,6);
  const favoritesHTML=favorites.map(item=>{const label=tabDisplayLabel(item,state.pages[item.id]);return '<button data-newtab-tab="'+escape(item.id)+'" title="'+escape(label)+'"><span class="tile-badge" aria-hidden="true">'+escape(Array.from(label.trim())[0]?.toUpperCase()??'')+'</span><span class="tile-label">'+escape(label)+'</span></button>';}).join('');
  setHTML('newtab-favorites',favoritesHTML);
  $('newtab-favorites').hidden=!favorites.length;
  $('privacy-cover').hidden = !guard.transitioning;
  $('picker-hint').hidden = true; // The native page has its own selection overlay.
  $('page-status').textContent = privateWindow() ? (page?.loading ? 'Private window · loading…' : page?.crashed ? 'Private page stopped · reload to continue' : 'Private window') : guard.blocked ? 'Agents paused' : page?.loading ? 'Loading…' : page?.crashed ? 'Page stopped · reload to continue' : page?.loadError ? 'Page could not load' : 'Ready';
  $('review-panel').hidden = !state.reviewOpen;
  daily?.render();
  if (!privateWindow()) {
    if (systemLifecycleView(state).ready) renderReview(guard);
    else { $('review-panel').hidden = true; clearEvidencePreview(); clearPreparedPreview(); }
    renderAgents(); renderPermissions();
  }
  renderPrivateWindow();
  renderPagePreview();
  persistence?.render();
  if (focusKey && !priorFocus.isConnected) {
    [...document.querySelectorAll('['+focusKey+']')].find(node=>node.getAttribute(focusKey)===focusValue)?.focus();
  }
  systemLifecycle?.render();
  defaultBrowser?.render();
  credentialControls?.render();
}
async function setSidebar(open, { restoreFocus = true } = {}) {
  if (sidebarOpen === open) return;
  const generation = systemLifecycleView(state).generation;
  await action({type:'overlay.set',open});
  if (generation !== systemLifecycleView(state).generation) return;
  sidebarOpen=open;
  $('shell').classList.toggle('sidebar-open',open);
  $('sidebar-toggle').setAttribute('aria-expanded',String(open));
  $('sidebar-toggle').setAttribute('aria-label',open?'Hide workspaces and tabs':'Show workspaces and tabs');
  $('main').inert=open;
  if (open) $('sidebar-close').focus();
  else if (restoreFocus) $('sidebar-toggle').focus();
  syncSidebarToggle();
}
function setWorkspacePopover(open, restoreFocus = false) {
  if (privateWindow() || pagePreview?.active() || !systemLifecycleView(state).ready) open = false;
  $('workspace-popover').hidden = !open;
  $('workspace-switcher').setAttribute('aria-expanded',String(open));
  if (open) $('workspace-list').querySelector('.active')?.focus();
  else if (restoreFocus) $('workspace-switcher').focus();
}
click('workspace-switcher',()=>setWorkspacePopover($('workspace-popover').hidden,!$('workspace-popover').hidden));
click('sidebar-command',()=>$('command-button').click());
// Plain navigation buttons retain normal Tab/Enter behavior; no animated tab swaps.
document.querySelector('.settings-navigation').addEventListener('click', event => {
  const button = event.target.closest('[data-settings-section]');
  if (!button) return;
  for (const item of document.querySelectorAll('[data-settings-section]')) {
    const active = item === button;
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    $('settings-' + item.dataset.settingsSection).hidden = !active;
  }
});
click('about-app',async()=>{await openDialog('about-dialog');await defaultBrowser.open();});
click('close-about',()=>closeDialog('about-dialog'));
click('open-shortcuts',async()=>{await closeDialog('about-dialog');await shortcuts.show();});
click('open-storage',async()=>{await closeDialog('about-dialog');await storage.show();});
click('open-portability',async()=>{await closeDialog('about-dialog');await portability.show();});
for (const id of ['open-private-window','about-private-window']) click(id,async()=>{
  if ($('about-dialog').open) await closeDialog('about-dialog'); setWorkspacePopover(false);
  await action({type:'window.private.open'});
});
for (const id of ['open-normal-window','about-normal-window']) click(id,async()=>{
  if ($('about-dialog').open) await closeDialog('about-dialog');
  await action({type:'window.normal.open'});
});
click('close-private-window',async()=>{
  const result = await action({type:'window.close'});
  if (result?.closed === false) toast('The private window stayed open. A page may need your attention.');
});
$('appearance-choice').addEventListener('change',event=>{if(event.target.name!=='appearance')return;void action({type:'appearance.set',choice:event.target.value}).catch(error=>toast(error.message));});
document.addEventListener('pointerdown',event=>{
  if (!$('workspace-popover').hidden && !event.target.closest('.workspace-switcher-wrap')) setWorkspacePopover(false);
});
const wideWindow=window.matchMedia('(min-width: 761px)');
function setSidebarCollapsed(collapsed) {
  $('shell').classList.toggle('sidebar-collapsed',collapsed);
  $('sidebar').inert=collapsed;
  $('sidebar-toggle').setAttribute('aria-expanded',String(!collapsed));
  $('sidebar-toggle').setAttribute('aria-label',collapsed?'Show workspaces and tabs':'Hide workspaces and tabs');
}
click('sidebar-toggle',()=>{
  if(wideWindow.matches&&!sidebarOpen){setWorkspacePopover(false);setSidebarCollapsed(!$('shell').classList.contains('sidebar-collapsed'));return;}
  return setSidebar(!sidebarOpen);
});
// Narrow windows always start with the sidebar off-canvas; wide windows show it unless collapsed.
function syncSidebarToggle() {
  if(!wideWindow.matches&&$('shell').classList.contains('sidebar-collapsed'))setSidebarCollapsed(false);
  const shown=wideWindow.matches?!$('shell').classList.contains('sidebar-collapsed'):sidebarOpen;
  $('sidebar-toggle').setAttribute('aria-expanded',String(shown));
  $('sidebar-toggle').setAttribute('aria-label',shown?'Hide workspaces and tabs':'Show workspaces and tabs');
}
wideWindow.addEventListener('change',syncSidebarToggle);
syncSidebarToggle();
click('sidebar-close',()=>setSidebar(false));
window.matchMedia('(min-width: 761px)').addEventListener('change',event=>{if(event.matches&&sidebarOpen)void setSidebar(false,{restoreFocus:false}).then(()=>$('workspace-switcher').focus()).catch(()=>{});});
function renderPermissions() {
  const info = state.sitePermissions ?? { pending: [], recent: [], blockedPopups: [] };
  const tab=activeTab(), guard=state.privacy?.[workspace()?.id], popups=info.popups??{grants:[],children:[]};
  setHTML('popup-controls',tab&&!guard?.blocked ? '<button id="allow-one-popup" class="subtle">Allow one pop-up for this page</button>' : '<p class="helper permission-empty">Choose an active page to allow one pop-up.</p>');
  setHTML('popup-grants',popups.grants.map(item=>'<div class="permission-card"><strong>'+escape(item.origin)+'</strong><p>One pop-up is allowed for this page until '+escape(new Date(item.expiresAt).toLocaleTimeString())+'. Return to the page and retry.</p><button class="subtle" data-popup-cancel="'+escape(item.tabId)+'">Cancel allowance</button></div>').join(''));
  setHTML('popup-children',popups.children.map(item=>'<div class="permission-card"><strong>'+escape(item.origin)+'</strong><p>Open pop-up for this workspace.</p><button class="subtle" data-popup-close="'+escape(item.popupId)+'">Close pop-up</button></div>').join(''));
  const activity = [...info.recent.map(item => ({ at:item.at, text:(item.origin ?? 'A site')+' · '+item.permission+' · '+item.reason })),
    ...info.blockedPopups.map(item => ({ at:item.at, text:item.reason }))].sort((a,b)=>b.at-a.at).slice(0,12);
  setHTML('permission-activity',activity.length ? activity.map(item => '<p class="permission-activity">'+escape(item.text)+'</p>').join('') : '<p class="helper permission-empty">No recent site requests or blocked windows.</p>');
  if (systemLifecycleView(state).ready && info.pending.length && permissionAutoRequest !== info.pending[0].id) {
    permissionAutoRequest = info.pending[0].id;
    if (!document.querySelector('dialog[open]')) queueMicrotask(() => void openDialog('permissions-dialog').then(()=>$('permission-pending').querySelector('button')?.focus()).catch(()=>{}));
    else toast('A site permission request is waiting. Open Site permissions to review it.');
  }
  if (!info.pending.length) permissionAutoRequest = null;
}
function renderMomentEditor(draft) {
  const moments = draft?.evidenceMoments ?? [];
  $('moment-editor').hidden = !moments.length;
  $('evidence-image').classList.toggle('moment-image', !!moments.length);
  if (!moments.length) { selectedMomentId = null; renderedMomentKey = null; $('moment-overlay').setAttribute('hidden', ''); return; }
  if (!moments.some(item => item.momentId === selectedMomentId)) selectedMomentId = moments[0].momentId;
  const moment = selectedMoment(draft);
  const momentKey = [draft.workspaceId,draft.feedbackId,moment.momentId].join('/');
  if (renderedMomentKey !== momentKey) $('moment-edit-status').textContent = '';
  setHTML('moment-select', moments.map((item,index) => '<option value="'+escape(item.momentId)+'">Screenshot '+(index+1)+' · '+(item.atMs/1000).toFixed(1)+' s</option>').join(''));
  $('moment-select').value = moment.momentId;
  setHTML('moment-strip',moments.map((item,index)=>'<button type="button" data-moment-id="'+escape(item.momentId)+'" aria-pressed="'+(item.momentId===moment.momentId)+'"><strong>'+(index+1)+'</strong><span>'+(item.atMs/1000).toFixed(1)+' s</span></button>').join(''));
  if (renderedMomentKey !== momentKey) $('moment-note').value = moment.note;
  renderedMomentKey = momentKey;
  $('moment-rectangle').setAttribute('aria-pressed', String(momentTool === 'rectangle'));
  $('moment-arrow').setAttribute('aria-pressed', String(momentTool === 'arrow'));
  $('moment-undo').disabled = !moment.marks.length;
  $('moment-clear').disabled = !moment.marks.length;
  drawMomentMarks();
}
function renderReview(guard) {
  const draft = activeDraft(), tab = activeTab();
  const collecting = !!state.moments;
  if (captureToolsDraft !== (draft?.feedbackId ?? null)) {
    captureToolsDraft = draft?.feedbackId ?? null;
    $('capture-tools').open = !draft;
  }
  if (collecting) $('capture-tools').open = true;
  $('moments-start').hidden = collecting; $('moments-start').disabled = !tab || guard.blocked || !!state.voice || !!state.selecting;
  for (const id of ['moments-add','moments-stop','moments-cancel']) $(id).hidden = !collecting;
  $('moments-add').disabled = !collecting || state.moments.busy || state.moments.count >= 6;
  $('moments-stop').disabled = !collecting || state.moments.busy || !state.moments.count;
  $('moments-status').textContent = collecting ? state.moments.stopping ?
    'Finishing up. If capture has not finished after 60 seconds, unsaved images are discarded.' :
    'Taking screenshots of this page · '+state.moments.count+' of 6'+(state.moments.busy?' · capturing…':'')+'. This ends after 60 seconds and unsaved images are discarded.' : '';
  $('pick-element').disabled = !tab || guard.blocked || !!state.voice;
  $('pick-page').disabled = !tab || guard.blocked || !!state.voice;
  $('pick-element').textContent = state.selecting ? 'Cancel selection' : 'Select an element';
  // The list is the front page; a draft opens in place of it, with Back to return.
  $('sent-view').hidden = !!draft;
  $('draft-editor').hidden = !draft;
  sentControls?.render();
  if (draft) {
    const buffer = bufferFor(draft);
    if (currentEditor !== draft.feedbackId || document.activeElement !== $('feedback-text')) $('feedback-text').value = buffer.text;
    if (currentEditor !== draft.feedbackId) $('stale-confirm').checked = false;
    currentEditor = draft.feedbackId;
    $('target-label').textContent = draft.label || (draft.selection.kind==='page'?'Entire page':'Selected element');
    $('target-origin').textContent = draft.capturedTarget.origin ?? 'This page';
    $('stale-note').hidden = !draft.stale;
    $('stale-confirm-label').hidden = !draft.stale;
    $('evidence-revision').textContent = 'Revision ' + draft.revision;
    const captureTab = state.metadata.tabs.find(item => item.id === draft.capturedTarget.tabId);
    const livePage = state.pages[draft.capturedTarget.tabId];
    $('current-target').textContent = livePage?.title ?? captureTab?.title ?? 'Page unavailable';
    $('current-target-note').textContent = draft.stale ?
      'The page has changed since this was captured.' : 'The capture still matches this page.';
    const artifacts = draft.artifacts ?? [];
    $('attachment-count').textContent = String(artifacts.length);
    setHTML('artifact-list', artifacts.length ? artifacts.map(item => '<li>'+escape(artifactName(item.kind))+
      '<span>'+escape(item.mediaType)+' · '+escape(Math.ceil(item.size/1024))+' KiB</span></li>').join('') :
      '<li>No file attachments<span>Selection and text only</span></li>');
    renderMomentEditor(draft);
    renderEvidencePreview(draft, guard);
    renderPreparedEvidence(draft, guard);
    document.querySelector('.evidence-original').textContent=draft.evidenceMoments ? 'Your marks over the original' : 'Original screenshot';
    const recipients = state.agents.filter(item=>activeAgent(item)&&item.workspaceId===draft.workspaceId);
    const previous = $('recipient').value;
    setHTML('recipient', '<option value="">Choose a connected agent</option>'+recipients.map(item=>'<option value="'+escape(item.agentSessionId)+'">'+escape(item.clientName)+'</option>').join(''));
    if (recipients.some(item=>item.agentSessionId===previous)) $('recipient').value=previous;
    $('recipient-field').hidden=!!draft.evidenceMoments;
    $('send-feedback').hidden=!!draft.evidenceMoments;
    $('stale-confirm-label').hidden=!!draft.evidenceMoments || !draft.stale;
    $('send-feedback').disabled = submitting || !recipients.length || guard.blocked || !!draft.evidenceMoments;
    $('moment-send-note').hidden = !draft.evidenceMoments;
    $('save-draft').disabled = submitting || !buffer.dirty;
    $('draft-save-status').textContent = buffer.dirty ? 'Unsaved changes' : draft.sessionOnly===false ? 'Saved and encrypted on this Mac' : 'Saved for this app session';
    const sentItem = state.sent?.items?.find(item => item.kind === 'note' && item.id === draft.feedbackId);
    $('send-feedback').textContent = sentItem && sentItem.status !== 'draft' ? 'Send again' : 'Send';
    $('record').disabled = !state.speech.available || !state.speech.microphoneAvailable || (state.voice?.status==='transcribing') || guard.blocked;
    const isRecording = recording && state.voice?.captureId===recording.captureId;
    $('record').textContent = isRecording ? 'Stop recording' : 'Record a voice note';
    $('record').classList.toggle('recording', !!isRecording);
    $('speech-note').textContent = !state.speech.microphoneAvailable ? 'Voice unavailable here. You can type instead.' :
      state.speech.available ? 'Recordings stay on this Mac. Check the transcript before sending.' : 'Speech-to-text is unavailable. You can type instead.';
    $('voice-status').textContent = state.voice?.status==='transcribing'?'Transcribing…':isRecording?'Recording…':'';
  } else { currentEditor = null; $('moment-editor').hidden = true; $('moment-send-note').hidden = true; clearEvidencePreview(); clearPreparedPreview(); $('prepared-evidence').hidden=true; }
}
function renderAdmission() {
  const admission=state.admission,jobs=admission?.jobs??[],requests=admission?.requests;
  const behind=requests?.waitingForWorkspace??0,waiting=requests?behind+requests.awaitingAdmission:admission?.queued??0;
  const running=requests?.nativeInFlight??admission?.active??0;
  $('admission-panel').hidden=!admission||(!jobs.length&&!requests?.outstanding&&admission.available!==false);
  $('admission-status').textContent=running+' running · '+waiting+' waiting'+
    (admission?.available===false?'. New work is waiting for available browser capacity.':'')+
    (behind?' '+behind+' requests are waiting for earlier work in their workspace. Disconnect an agent to cancel all of its requests.':'');
  setHTML('admission-jobs',jobs.map(job=>{
    const agent=state.agents.find(item=>item.agentSessionId===job.agentSessionId)?.clientName??'Coding agent';
    const name=state.metadata.workspaces.find(item=>item.id===job.workspaceId)?.name??'Unavailable workspace';
    const queued=job.state==='queued',uncertain=job.state==='uncertain',stopping=uncertain||['cancelling','canceling','stopping','stop-requested'].includes(job.state);
    return '<article class="admission-job"><div><strong>'+escape(agent)+'</strong><small>'+escape(name)+' · '+(queued?'Waiting':uncertain?'Stop unconfirmed':stopping?'Stopping':'Running')+'</small></div><button type="button" class="subtle" data-admission-cancel="'+escape(job.jobId)+'" '+(stopping?'disabled':'')+'>'+(uncertain?'Stop requested':stopping?'Stopping…':'Cancel')+'</button></article>';
  }).join(''));
}
function renderAgents() {
  const attention=state.attention?.requests??[];
  $('attention-panel').hidden=!attention.length;
  setHTML('attention-requests',attention.map(request=>{
    const name=state.metadata.workspaces.find(item=>item.id===request.workspaceId)?.name??'Unavailable workspace';
    if (request.kind==='site') {
      // The site is the one the agent tried to open; the agent's name is the one it sent, unverified.
      let site=request.site; try { site=new URL(request.site).host; } catch {}
      const id=escape(request.attentionId);
      return '<article class="attention-card sign-in-card" aria-labelledby="site-'+id+'"><header><div><h4 id="site-'+id+'">'+escape(request.clientName)+' wants to open '+escape(site)+'</h4><small>'+escape(name)+' · name sent by the agent</small></div></header>'+
        '<p class="helper">Allowing lets it view and act on '+escape(site)+' in this workspace until it disconnects.</p>'+
        '<div class="actions"><button type="button" class="primary" data-site="'+id+'" data-decision="allow">Allow</button>'+
        '<button type="button" class="subtle" data-site="'+id+'" data-decision="deny">Don’t allow</button></div></article>';
    }
    if (request.kind==='sign-in') {
      // The site and username come from the owner's saved login; the agent's name is the one it sent, unverified.
      let site=request.site; try { site=new URL(request.site).host; } catch {}
      const id=escape(request.attentionId);
      return '<article class="attention-card sign-in-card" aria-labelledby="sign-in-'+id+'"><header><div><h4 id="sign-in-'+id+'">'+escape(request.clientName)+' wants to sign in to '+escape(site)+(request.username?' as '+escape(request.username):'')+'</h4><small>'+escape(name)+' · name sent by the agent</small></div></header>'+
        '<p class="helper">Caddi fills your saved login on that page. The agent never sees the password. This request ends in about 2 minutes.</p>'+
        '<div class="actions"><button type="button" class="primary" data-sign-in="'+id+'" data-decision="once">Allow once</button>'+
        '<button type="button" class="subtle" data-sign-in="'+id+'" data-decision="session">Allow for this session</button>'+
        '<button type="button" class="subtle" data-sign-in="'+id+'" data-decision="deny">Don’t allow</button></div></article>';
    }
    const reason={login:'Login help',help:'Help requested',blocked:'Agent blocked'}[request.kind]??'Help requested';
    const status=request.status==='taking-over'?'Pausing agents and capture…':request.status==='active'?'Agents are paused there. Choose Resume agents in that workspace when you are finished.':'';
    return '<article class="attention-card"><header><div><h4>'+escape(name)+' · '+reason+'</h4><small>'+escape(request.clientName)+' · message written by the agent</small></div></header>'+
      (request.message?'<p class="attention-message">'+escape(request.message)+'</p>':'')+
      (status?'<p class="helper" role="status">'+status+'</p>':'<p class="helper">Open this workspace with agents paused so you can help. Agents and page capture stop before it comes forward.</p>')+
      '<div class="actions">'+(request.status==='pending'?'<button type="button" class="primary" data-attention-accept="'+escape(request.attentionId)+'">Pause agents and open</button>':'')+
      '<button type="button" class="subtle" data-attention-dismiss="'+escape(request.attentionId)+'" '+(request.status==='taking-over'?'disabled':'')+'>Dismiss request</button></div></article>';
  }).join(''));
  renderAdmission();
  const signature = { pending:state.pending,workspaces:state.metadata.workspaces.map(w=>[w.id,w.name,w.kind,w.lifecycle?.status]) };
  if (changed('pending-connections', signature)) {
    const focused=document.activeElement,focusedApproval=focused?.closest('[data-approval]')?.dataset.approval,focusedName=focused?.name;
    const focusedRange=focused&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    const prior = new Map([...document.querySelectorAll('[data-approval]')].map(form=>[form.dataset.approval,Object.fromEntries(new FormData(form))]));
    $('pending-connections').innerHTML = state.pending.map(request=>{
      const id=request.requestId, previous=prior.get(id), ws=state.metadata.workspaces.filter(w=>w.kind==='project'&&w.lifecycle?.status!=='archived');
      const managed=previous?.workspaceMode==='managed';
      const selectedWorkspace=previous ? ws.find(w=>w.id===previous.workspaceId)?.id??'' : ws.find(w=>w.id===workspace()?.id)?.id??'';
      // Default access: the sites already open in that workspace. A site the agent opens later is asked for, one at a time.
      const chosenId=selectedWorkspace||'', openSites=[];
      for(const tab of state.metadata.tabs.filter(item=>item.workspaceId===chosenId&&item.status==='open')){
        try { const parsed=new URL(state.pages[tab.id]?.url ?? tab.url); if(['http:','https:'].includes(parsed.protocol)&&!openSites.includes(parsed.origin))openSites.push(parsed.origin); } catch {}
      }
      const sites=previous?.origins??openSites.slice(0,16).join('\n');
      // Screenshots stay off unless the owner ticks them (docs/SECURITY-MODEL.md); one click gives view and control only.
      const control=previous?previous.mode==='control':true, screenshots=previous?.screenshots==='on';
      const chosenName=ws.find(w=>w.id===chosenId)?.name;
      // Without a project workspace to default to, the choices are shown at once rather than hidden behind a button that cannot work.
      const open=managed||!chosenName||previous?.details==='open';
      const summary=chosenName?'Can view and control pages in '+escape(chosenName)+'. New sites are asked for one at a time; screenshots stay off unless you turn them on.':'Choose where this agent may work.';
      return '<form class="connection-card" data-approval="'+escape(id)+'"><h3>'+escape(request.clientName)+' wants to connect</h3>'+
        '<small>Check that this code matches the one your coding tool shows. The name comes from the tool asking to connect.</small><div class="code">'+escape(request.comparisonCode)+'</div><input type="hidden" name="comparisonCode" value="'+escape(request.comparisonCode)+'">'+
        '<p class="helper" data-approval-summary>'+summary+'</p>'+
        '<div class="actions"><button type="button" class="subtle" data-reject="'+escape(id)+'">Reject</button><button class="primary" data-approve-submit>'+(managed?'Allow one workspace':'Allow')+'</button></div>'+
        '<details class="approval-details" '+(open?'open':'')+'><summary>Change access</summary><input type="hidden" name="details" value="'+(open?'open':'')+'">'+
        '<label>Workspace access<select name="workspaceMode" data-workspace-mode><option value="existing">Use an existing workspace</option><option value="managed" '+(managed?'selected':'')+'>Create its own workspace</option></select></label>'+
        '<label data-existing-workspace '+(managed?'hidden':'')+'>Workspace<select name="workspaceId" required '+(managed?'disabled':'')+'><option value="">Choose a workspace</option>'+ws.map(w=>'<option value="'+escape(w.id)+'" '+(w.id===selectedWorkspace?'selected':'')+'>'+escape(w.name)+'</option>').join('')+'</select></label>'+
        '<p class="helper" data-managed-workspace '+(!managed?'hidden':'')+'>This agent may create one separate workspace and reopen it while it stays connected. Site sign-ins stay with that workspace. Service access is given separately.</p>'+
        '<label>Sites it may use now (one per line)<textarea name="origins" rows="2" '+(managed?'required':'')+' placeholder="https://example.com">'+escape(sites)+'</textarea></label>'+
        '<p class="helper">Leave this empty to be asked the first time the agent opens each site.</p>'+
        '<label>Access<select name="mode"><option value="observe">View pages</option><option value="control" '+(control?'selected':'')+'>View and control pages</option></select></label>'+
        '<label class="approval-option"><input type="checkbox" name="screenshots" aria-describedby="screenshots-help-'+escape(id)+'" '+(screenshots?'checked':'')+'> Can see the page (screenshots)</label>'+
        '<p class="helper" id="screenshots-help-'+escape(id)+'">A screenshot shows anything visible on the page. Caddi blanks sensitive fields and embedded frames first.</p>'+
        '<label class="approval-option"><input type="checkbox" name="logins" aria-describedby="logins-help-'+escape(id)+'" '+(previous?.logins==='on'?'checked':'')+'> Can use saved logins for this workspace</label>'+
        '<p class="helper" id="logins-help-'+escape(id)+'">Only logins you mark “Agents may use this login”, on the sites above, with control access. You confirm the first use of each. The agent never sees a password.</p></details></form>';
    }).join('');
    const restored=focusedApproval&&[...document.querySelectorAll('[data-approval]')].find(form=>form.dataset.approval===focusedApproval)?.elements.namedItem(focusedName);
    if(restored&&!restored.disabled){restored.focus();if(focusedRange&&restored.setSelectionRange)restored.setSelectionRange(...focusedRange);}
  }
  setHTML('connections-list', state.agents.filter(item=>!['revoked','disconnected','expired'].includes(item.status)).map(item=>{
    const name=state.metadata.workspaces.find(w=>w.id===item.workspaceId)?.name??'Workspace not created yet';
    const pageAccess=item.workspaceActive?(item.mode==='control'?'Can view and control pages':'Can view pages')+(item.screenshots?' · Can see the page':'')+(item.logins?' · Can use saved logins':''):'No page access';
    const lifecycle={ 'awaiting-creation':'Ready to create its workspace',creating:'Creating workspace',active:'Workspace active',retiring:'Ending agent control',retired:'Agent control ended · pages kept',archived:'Workspace archived · site data saved',reopening:'Reopening workspace',unavailable:'Workspace access unavailable' }[item.workspaceState];
    return '<div class="connection-card"><header><div><h3>'+escape(item.clientName)+'</h3><small>'+escape(name)+' · '+escape(pageAccess)+' · '+escape(item.status)+'</small></div><button class="subtle" data-revoke="'+escape(item.agentSessionId)+'">Disconnect</button></header><small>'+escape(item.origins.join(', '))+'</small>'+
      (item.managed?'<p class="helper">'+escape(lifecycle??'Workspace created by this agent')+'</p>':'')+'</div>';
  }).join(''));
  renderServices();
  const attentionCount=attention.filter(item=>item.status==='pending').length;
  // A new sign-in request is announced once, without taking focus from the page.
  for(const request of attention.filter(item=>item.kind==='sign-in'&&item.status==='pending'&&!signInSeen.has(item.attentionId))){
    signInSeen.add(request.attentionId);
    toast(request.clientName+' wants to sign in. Open Agents to answer.');
  }
  // New site and connection requests are announced the same way: once each, without taking focus.
  for(const request of attention.filter(item=>item.kind==='site'&&item.status==='pending'&&!signInSeen.has(item.attentionId))){
    signInSeen.add(request.attentionId);
    let site=request.site; try { site=new URL(request.site).host; } catch {}
    toast(request.clientName+' wants to open '+site+'. Open Agents to answer.');
  }
  for(const request of state.pending.filter(item=>!signInSeen.has(item.requestId))){
    signInSeen.add(request.requestId);
    toast(request.clientName+' wants to connect. Open Agents to allow it.');
  }
  const pendingCount=state.pending.length+attentionCount;
  $('pending-count').textContent=pendingCount ? String(pendingCount) : '';
  $('attention-count').textContent=attentionCount?String(attentionCount):'';
  $('attention-count').hidden=!attentionCount;
  $('agent-presence').classList.toggle('pending',!!pendingCount);
  $('connect-agent').setAttribute('aria-label',pendingCount?'Agents · '+pendingCount+' request'+(pendingCount===1?'':'s')+' to review':'Agents · '+$('workspace-status').textContent);
  $('connect-agent').title=attentionCount?attentionCount+' agent'+(attentionCount===1?' needs':'s need')+' your help':'Agents';
  $('agents-empty').hidden=!!(attention.length || pendingCount || state.agents.some(item=>!['revoked','disconnected','expired'].includes(item.status)));
  $('agent-launch-title').textContent=pendingCount?'Review '+pendingCount:state.agents.some(item=>activeAgent(item)&&item.workspaceId===workspace()?.id)?'Manage':'Connect';
}
function selectedServiceOperations(form) {
  return serviceOperations.filter(operation=>form.elements.namedItem(operation.name)?.checked).map(operation=>operation.id);
}
function serviceOperationInputs(prefix, allowed, selected) {
  return serviceOperations.filter(operation=>allowed.includes(operation.id)).map(operation=>
    '<label class="service-operation"><input type="checkbox" name="'+operation.name+'" data-service-field="'+escape(prefix+'-'+operation.name)+'" '+(selected.includes(operation.id)?'checked':'')+'> '+operation.label+'</label>').join('');
}
function renderServiceCreation(canCreate) {
  const form=$('service-create-form'),provider=form.elements.namedItem('provider').value;
  const allowed=serviceOperations.filter(operation=>operation.provider===provider).map(operation=>operation.id);
  if(form.dataset.provider!==provider){
    form.dataset.provider=provider;
    $('service-create-operations').innerHTML=serviceOperationInputs('create',allowed,[]);
  }
  for(const input of form.querySelectorAll('input,select'))input.disabled=!canCreate;
  for(const group of form.querySelectorAll('[data-service-provider-fields]')){
    const selected=group.dataset.serviceProviderFields===provider;group.hidden=!selected;
    for(const input of group.querySelectorAll('input'))input.disabled=!canCreate||!selected;
  }
  $('create-service').disabled=!canCreate||!allowed.length;
}
function serviceReviewBinding(connectionId,workspaceId) {
  const binding=state.services?.owner?.reviewBindings?.find(item=>item.serviceConnectionId===connectionId&&item.workspaceId===workspaceId);
  return binding?{expectedRevision:binding.revision,expectedConnectionGeneration:binding.connectionGeneration,expectedWorkspaceIdentityId:binding.workspaceIdentityId}:null;
}
const serviceBindingKey=binding=>binding?JSON.stringify(binding):'';
function renderServices() {
  const services=state.services ?? {available:false,qualification:'protected-storage-pending',connections:[],grants:[]};
  const durable=persistenceView(state).configured;
  $('services-status').textContent=durable ? 'Saved connections are encrypted'+(state.persistence.testOnly?' · test keys and sample data':'')+'.' : services.qualification==='synthetic-test'?
    'Test connections only. They cannot reach a real account and end with this session.':
    'Service connections are unavailable in this development build.';
  const current=workspace(), owner=services.owner??{connections:services.connections,shares:[]};
  const protectedEntry=durable&&owner.acquisition?.available===true;
  $('service-create-form').hidden=durable?!protectedEntry:!services.available;
  const workspaces=state.metadata.workspaces.filter(item=>item.kind==='project'&&!item.humanOnly&&!item.personal&&item.lifecycle?.status!=='archived');
  const creation=$('service-create-form'),canCreate=(!durable?services.available:protectedEntry)&&!credentialControls?.busy()&&workspaces.some(item=>item.id===current?.id);
  if(creation.dataset.workspaceId!==current?.id||creation.dataset.workspaceIdentityId!==current?.identityId){
    for(const input of creation.querySelectorAll('input[type=checkbox]'))input.checked=false;
  }
  creation.dataset.workspaceId=current?.id??'';creation.dataset.workspaceIdentityId=current?.identityId??'';
  creation.dataset.persistenceRevision=String(owner.persistenceReview?.revision??'');
  $('create-service').textContent=durable?'Review connection':'Add connection';
  $('service-create-scope').textContent='Starts with access for '+(current?.name??'this workspace')+'. Choose what it may read. Agents are given access separately.';
  renderServiceCreation(canCreate);
  const agents=state.agents.filter(item=>activeAgent(item)&&item.workspaceId===current?.id);
  const previous=new Map([...$('services-list').querySelectorAll('form[data-service-workspace-share],form[data-service-grant]')].map(form=>[
    form.dataset.serviceWorkspaceShare?'share:'+form.dataset.serviceWorkspaceShare:'grant:'+form.dataset.serviceGrant,
    {workspaceId:form.elements.namedItem('workspaceId')?.value??form.dataset.workspaceId,
      shareGeneration:form.dataset.shareGeneration,binding:form.dataset.reviewBinding,operations:selectedServiceOperations(form),
      agentSessionId:form.elements.namedItem('agentSessionId')?.value,expiresInMs:form.elements.namedItem('expiresInMs')?.value,
      expanded:form.closest('details')?.open},
  ]));
  setHTML('services-list',owner.connections.length?owner.connections.map(item=>{
    const saved=owner.persistenceReview?.connections.find(value=>value.serviceConnectionId===item.id);
    const savedAttributes=item.sessionOnly===false?' data-persistence-revision="'+escape(saved?owner.persistenceReview.revision:'')+'" data-persistence-generation="'+escape(saved?.generation??'')+'"':'';
    const shares=(owner.shares??[]).filter(value=>value.serviceConnectionId===item.id);
    const scoped=current?services.connections.find(value=>value.id===item.id):null;
    const before=previous.get('share:'+item.id);
    const target=before?workspaces.find(value=>value.id===before.workspaceId):workspaces.find(value=>value.id===current?.id);
    const share=shares.find(value=>value.workspaceId===target?.id);
    const shareBinding=serviceReviewBinding(item.id,target?.id);
    const shareGeneration=String(share?.generation??0);
    const selected=shareBinding&&before?.workspaceId===target?.id&&before.binding===serviceBindingKey(shareBinding)?before.operations:share?.valid!==false?share?.operations??[]:[];
    const grantBefore=previous.get('grant:'+item.id);
    const grantGeneration=String(scoped?.workspaceShareGeneration??0);
    const grantBinding=serviceReviewBinding(item.id,current?.id);
    const recipient=grantBinding&&grantBefore?.binding===serviceBindingKey(grantBinding)?agents.find(value=>value.agentSessionId===grantBefore?.agentSessionId)?.agentSessionId??'':'';
    const grantSelected=recipient&&grantBefore?.workspaceId===current?.id&&grantBefore.shareGeneration===grantGeneration?grantBefore.operations:[];
    const grants=services.grants.filter(value=>value.serviceConnectionId===item.id);
    return '<section class="connection-card"><header><div><h3>'+escape(item.label)+'</h3><small>'+escape(serviceConnectionDescription(item))+' · read-only · '+(item.sessionOnly===false?'saved':'this session only')+'</small></div><button class="subtle" data-service-remove="'+escape(item.id)+'"'+savedAttributes+'>Remove connection</button></header>'+
      (item.sessionOnly===false&&protectedEntry?'<div class="actions"><button type="button" class="subtle" data-service-rotate="'+escape(item.id)+'"'+savedAttributes+' '+(credentialControls?.busy()?'disabled':'')+'>Replace credential…</button></div>':'')+
      '<details class="service-sharing" '+(before?.expanded?'open':'')+'><summary>Workspace access · '+shares.length+' shared</summary><p class="helper">Choose a workspace and what it may read. Agents in that workspace are given access separately.</p>'+
      (shares.length?'<ul class="service-shares">'+shares.map(value=>'<li><div><strong>'+escape(state.metadata.workspaces.find(w=>w.id===value.workspaceId)?.name??'Unavailable workspace')+'</strong><small>'+escape(serviceOperations.filter(operation=>value.operations.includes(operation.id)).map(operation=>operation.label).join(' · '))+'</small></div><button type="button" class="subtle" data-service-share-revoke="'+escape(item.id+':'+value.workspaceId)+'" data-service-connection="'+escape(item.id)+'" data-workspace-id="'+escape(value.workspaceId)+'"'+savedAttributes+'>Revoke workspace</button></li>').join('')+'</ul>':'<p class="helper">No workspace has access.</p>')+
      '<form data-service-workspace-share="'+escape(item.id)+'" data-workspace-identity-id="'+escape(target?.identityId??'')+'" data-share-generation="'+escape(shareGeneration)+'" data-review-binding="'+escape(serviceBindingKey(shareBinding))+'"'+savedAttributes+'><label>Workspace<select name="workspaceId" data-service-workspace-picker data-service-field="'+escape(item.id+'-workspace')+'" required><option value="">Choose a workspace</option>'+workspaces.map(value=>'<option value="'+escape(value.id)+'" '+(value.id===target?.id?'selected':'')+'>'+escape(value.name)+'</option>').join('')+'</select></label>'+
      serviceOperationInputs(item.id+'-share',ownerServiceOperations(item),selected)+
      '<div class="actions"><button class="primary" data-service-field="'+escape(item.id+'-share-submit')+'" '+(!services.available||!workspaces.length||!ownerServiceOperations(item).length?'disabled':'')+'>Apply workspace access</button></div></form></details>'+
      (scoped?'<form class="service-agent-grant" data-service-grant="'+escape(item.id)+'" data-workspace-id="'+escape(current.id)+'" data-share-generation="'+escape(grantGeneration)+'" data-review-binding="'+escape(serviceBindingKey(grantBinding))+'"><h4>Agent access in '+escape(current.name)+'</h4><label>Recipient<select name="agentSessionId" data-service-recipient data-service-field="'+escape(item.id+'-recipient')+'" required><option value="">Choose a connected agent</option>'+agents.map(agent=>'<option value="'+escape(agent.agentSessionId)+'" '+(agent.agentSessionId===recipient?'selected':'')+'>'+escape(agent.clientName)+' · '+escape(agent.agentSessionId.slice(0,8))+'</option>').join('')+'</select></label>'+
      serviceOperationInputs(item.id+'-grant',scopedServiceOperations(item,scoped.operations),grantSelected)+
      '<label>Expires<select name="expiresInMs" data-service-field="'+escape(item.id+'-expiry')+'"><option value="900000">In 15 minutes</option><option value="3600000" '+(grantBefore?.expiresInMs==='3600000'?'selected':'')+'>In 1 hour</option></select></label><div class="actions"><button class="primary" data-service-field="'+escape(item.id+'-grant-submit')+'" '+(!services.available||!agents.length?'disabled':'')+'>Give read access</button></div>'+(!agents.length?'<p class="helper">Connect an agent to this workspace first.</p>':'')+'</form>':'<p class="helper">'+escape(current?.name??'This workspace')+' has no access to this connection.</p>')+
      grants.map(grant=>'<div class="connection-card"><small>'+escape(grant.recipientLabel)+' · '+escape(serviceOperations.filter(operation=>grant.operations.includes(operation.id)).map(operation=>operation.label).join(' · '))+' · expires '+escape(new Date(grant.expiresAt).toLocaleString())+'</small><button class="subtle" data-service-revoke="'+escape(grant.id)+'">Revoke agent access</button></div>').join('')+'</section>';
  }).join(''):'<p class="helper">No service connections yet.</p>');
}
async function openDialog(id) {
  const lifecycle = systemLifecycleView(state);
  if (!lifecycle.ready && !['permissions-dialog','agents-dialog','about-dialog'].includes(id)) { systemLifecycle?.focus(); toast(systemLifecycleMessages.SYSTEM_PAUSED); return; }
  if (pagePreview?.active() && !['about-dialog','shortcuts-dialog',...(!lifecycle.ready?['agents-dialog']:[])].includes(id)) { toast('Close this preview or keep it as a tab before opening page controls.'); return; }
  if (privateWindow() && ['agents-dialog','workspace-dialog','permissions-dialog','external-links-dialog','confirm-history-dialog','storage-dialog','portability-dialog','logins-dialog','login-fill-dialog'].includes(id)) { privateUnavailable(); return; }
  if ($(id).open) return;
  setWorkspacePopover(false);
  const prior = sidebarOpen ? $('sidebar-toggle') : document.activeElement;
  await action({type:'overlay.set',open:true});
  if (lifecycle.generation !== systemLifecycleView(state).generation) return;
  if (sidebarOpen) {
    sidebarOpen=false;
    $('shell').classList.remove('sidebar-open');
    $('sidebar-toggle').setAttribute('aria-expanded','false');
    $('sidebar-toggle').setAttribute('aria-label','Show workspaces and tabs');
    $('main').inert=false;
  }
  dialogFocus.set(id, prior);
  $(id).showModal();
  const preferred = { 'workspace-dialog':'workspace-name', 'command-dialog':'command-query', 'agents-dialog':'close-agents',
    'organize-dialog':'close-organize', 'page-dialog':'close-page', 'permissions-dialog':'close-permissions',
    'confirm-history-dialog':'cancel-clear-history', 'external-links-dialog':'close-external-links', 'shortcuts-dialog':'close-shortcuts', 'storage-dialog':'close-storage', 'portability-dialog':'portability-import-mode', 'preview-address-dialog':'preview-address-input' }[id];
  (preferred && $(preferred))?.focus();
}
async function closeDialog(id) { if ($(id).open) $(id).close(); await action({type:'overlay.set',open:false}); }
daily = createDailyControls({ getState:()=>state, action, refresh, openDialog, closeDialog, toast, escape, showShortcuts:()=>shortcuts.show(), showWelcome:()=>welcome.show(), showStorage:()=>storage.show(), showPreview:()=>pagePreview.show(), showSent:()=>showSent() });
externalLinks = createExternalLinkControls({ getState:()=>state, refreshState:refresh, action, openDialog, closeDialog, toast });
shortcuts = createShortcutControls({ getState:()=>state, refreshState:refresh, action, openDialog, closeDialog, toast });
storage = createStorageControls({ getState:()=>state, refreshState:refresh, action, openDialog, closeDialog });
loginControls = createLoginsControls({ getState:()=>state, refreshState:refresh, action, openDialog, closeDialog, toast });
portability = createPortabilityControls({ getState:()=>state, refreshState:refresh, action, openDialog, closeDialog, toast });
siteMedia = createMediaControls({ getState:()=>state, refreshState:refresh, action, openDialog, toast });
persistence = createPersistenceControls({ getState:()=>state, refreshState:refresh, action, toast, hasUnsavedFeedback:()=>unsavedLocalReview(activeDraft()) });
defaultBrowser = createDefaultBrowserControls({ getState:()=>state, action });
credentialControls = createOwnerCredentialControls({ getState:()=>state, action, refresh });
pagePreview = createPagePreviewControls({ getState:()=>state, refreshState:refresh, action, openDialog, closeDialog, toast,
  onChange:()=>render(), onEnter:()=>daily.resetEmpty() });
systemLifecycle = createSystemLifecycleControls({ getState:()=>state, refreshState:refresh, action, toast, onChange:()=>render(),
  onPause() {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    setWorkspacePopover(false); daily.pauseForSystem();
    sidebarOpen = false; $('shell').classList.remove('sidebar-open'); $('main').inert = false;
    $('sidebar-toggle').setAttribute('aria-expanded','false'); $('sidebar-toggle').setAttribute('aria-label','Show workspaces and tabs');
    clearEvidencePreview(); clearPreparedPreview(); $('review-panel').hidden = true;
    void action({type:'overlay.set',open:false}, true).catch(()=>{});
  } });
for(const id of ['agents-dialog','workspace-dialog','about-dialog']) $(id).addEventListener('cancel',()=>void action({type:'overlay.set',open:false}).catch(()=>{}));
click('site-permissions',()=>openDialog('permissions-dialog'));
click('close-permissions',()=>closeDialog('permissions-dialog'));
$('permissions-dialog').addEventListener('cancel',()=>void action({type:'overlay.set',open:false}).catch(()=>{}));
$('popup-controls').addEventListener('click',event=>{if(!event.target.closest('#allow-one-popup'))return;const tab=activeTab();if(!tab)return;void closeDialog('permissions-dialog').then(()=>action({type:'popup.allow-once',tabId:tab.id})).then(()=>{toast('One pop-up allowed for 30 seconds. Retry on the page.');return refresh();}).catch(()=>{});});
$('popup-grants').addEventListener('click',event=>{const button=event.target.closest('[data-popup-cancel]');if(button)void action({type:'popup.cancel',tabId:button.dataset.popupCancel}).then(refresh).catch(()=>{});});
$('popup-children').addEventListener('click',event=>{const button=event.target.closest('[data-popup-close]');if(button)void action({type:'popup.close',popupId:button.dataset.popupClose}).then(refresh).catch(()=>{});});
async function newTab() { await action({type:'tab.create',workspaceId:workspace().id,input:''}); await refresh(); $('address').focus(); }
async function navigate(input) {
  if (!activeTab()) await action({type:'tab.create',workspaceId:workspace().id,input});
  else await action({type:'navigate',tabId:activeTab().id,input});
}
click('add-workspace',()=>openDialog('workspace-dialog').then(()=>$('workspace-name').focus()));
click('cancel-workspace',()=>closeDialog('workspace-dialog'));
$('workspace-form').addEventListener('submit',event=>{event.preventDefault();void (async()=>{
  await action({type:'workspace.create',name:$('workspace-name').value.trim(),kind:$('workspace-create-kind').value});
  $('workspace-name').value='';await closeDialog('workspace-dialog');
})().catch(()=>{});});
const chooseWorkspace=event=>{const button=event.target.closest('[data-workspace],[data-workspace-reopen]');if(!button)return;
  const workspaceId=button.dataset.workspace??button.dataset.workspaceReopen;
  if(workspaceId!==workspace()?.id && unsavedLocalReview(activeDraft())) {
    toast('Save your changes before switching workspaces.');return;
  }
  setWorkspacePopover(false);
  const request=button.dataset.workspaceReopen ? {type:'workspace.reopen',workspaceId,expectedGeneration:Number(button.dataset.workspaceGeneration)} : {type:'workspace.select',workspaceId};
  void action(request).then(()=>sidebarOpen&&setSidebar(false)).catch(()=>{});
};
$('workspace-list').addEventListener('click',chooseWorkspace);
$('workspace-rail-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-workspace]'); if(!button||button.dataset.workspace===workspace()?.id)return;
  const id=button.dataset.workspace; chooseWorkspace(event);
  // Rendering replaces the buttons, so put focus back on the one that was chosen.
  requestAnimationFrame(()=>$('workspace-rail-list').querySelector('[data-workspace="'+CSS.escape(id)+'"]')?.focus());
});
// Up and Down move along the rail, like a toolbar.
$('workspace-rail').addEventListener('keydown',event=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const items=[...$('workspace-rail').querySelectorAll('button')], index=items.indexOf(document.activeElement); if(index<0)return;
  event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
  items[next].focus();
});
click('workspace-rail-add',()=>openDialog('workspace-dialog').then(()=>$('workspace-name').focus()));
$('newtab-favorites').addEventListener('click',event=>{
  const button=event.target.closest('[data-newtab-tab]');if(!button)return;
  const tab=state.metadata.tabs.find(item=>item.id===button.dataset.newtabTab);if(!tab)return;
  void action({type:tab.status!=='open'||tab.dormant?'tab.reopen':'tab.select',tabId:tab.id}).catch(()=>{});
});
for(const id of ['favorite-list','pinned-list','tab-list'])$(id).addEventListener('click',event=>{
  const close=event.target.closest('[data-close]'),select=event.target.closest('[data-select]');
  if(close)void action({type:'tab.close',tabId:close.dataset.close}).catch(()=>{});
  else if(select){const tab=state.metadata.tabs.find(t=>t.id===select.dataset.select);void action({type:tab.status!=='open'||tab.dormant?'tab.reopen':'tab.select',tabId:tab.id}).then(()=>sidebarOpen&&setSidebar(false)).catch(()=>{});}
});
click('new-tab',newTab);
click('open-workspace-window',()=>action({type:'window.open-workspace'}));
for(const id of ['back','forward','reload'])click(id,()=>activeTab()&&action({type:id==='reload'&&$('reload').dataset.stop==='true'?'stop':id,tabId:activeTab().id}));
click('pin',()=>activeTab()&&action({type:'tab.pin',tabId:activeTab().id,pinned:!activeTab().pinned}));
click('split',()=>activeTab()&&action({type:'split.toggle',tabId:activeTab().id}));
$('address-form').addEventListener('submit',event=>{event.preventDefault();const value=$('address').value;$('address').blur();void navigate(value).catch(()=>{});});
$('newtab-form').addEventListener('submit',event=>{event.preventDefault();void navigate($('newtab-address').value).catch(()=>{});});
click('try-example',()=>action({type:'demo.open',workspaceId:workspace().id}));
click('newtab-annotate',()=>{const target=$('annotate');if(target&&!target.disabled)target.click();});
click('private',()=>action({type:state.privacy[workspace().id].blocked?'privacy.resume':'privacy.enter',workspaceId:workspace().id}));
async function showSent() {
  if (!workspace() || privateWindow()) return;
  if (state.reviewOpen) { if (!activeDraft()) return; if (unsavedLocalReview(activeDraft())) { toast('Save your changes first.'); return; } await action({type:'review.deselect'}); await refresh(); return; }
  await action({type:'review.open'}); await refresh(); await syncLayout();
  ($('sent-list').querySelector('[data-sent-focus]') ?? $('close-review')).focus({preventScroll:true});
}
click('sent-button',async()=>{
  if(state.reviewOpen){
    if(unsavedLocalReview(activeDraft())) { toast('Save your changes before closing Sent.');return; }
    await action({type:'review.close'}); return;
  }
  await showSent();
});
click('close-review',()=>{
  if(unsavedLocalReview(activeDraft())) { toast('Save your changes before closing Sent.');return; }
  return action({type:'review.close'});
});
click('draft-back',async()=>{
  if(unsavedLocalReview(activeDraft())) { toast('Save your changes first.');return; }
  const id=activeDraft()?.feedbackId;
  await action({type:'review.deselect'});await refresh();
  ($('sent-list').querySelector('[data-sent-focus="edit:note:'+CSS.escape(id??'')+'"]') ?? $('sent-list').querySelector('[data-sent-focus]') ?? $('close-review')).focus({preventScroll:true});
});
sentControls = createSentControls({ getState:()=>state, action, refresh, toast, escape, setHTML,
  onEdit(item) {
    if(item.id!==state.activeDraftId && unsavedLocalReview(activeDraft())) { toast('Save your changes before switching notes.');return; }
    void action({type:'review.select',workspaceId:item.workspaceId,feedbackId:item.id}).then(refresh).then(()=>$('draft-back').focus({preventScroll:true})).catch(()=>{});
  },
  onAnnotate() { const target=$('annotate'); if(target&&!target.disabled&&!target.hidden) target.click(); else toast('Open a page first, then annotate it.'); },
  onLive() { const target=$('live'); if(target&&!target.disabled&&!target.hidden) target.click(); else toast('Open a page first, then go Live.'); } });
click('pick-element',async()=>{
  if(state.selecting)return action({type:'review.cancel-pick'});
  await syncLayout();await action({type:'review.pick',tabId:activeTab().id});
});
click('cancel-pick',()=>action({type:'review.cancel-pick'}));
click('pick-page',()=>action({type:'review.page',tabId:activeTab().id}));
click('moments-start',async()=>{await syncLayout();await action({type:'moments.start',tabId:activeTab().id});await refresh();});
click('moments-add',async()=>{await action({type:'moments.add'});await refresh();});
click('moments-stop',async()=>{const draft=await action({type:'moments.stop'});selectedMomentId=draft.evidenceMoments?.[0]?.momentId??null;await refresh();$('moment-strip').querySelector('button')?.focus();});
click('moments-cancel',async()=>{await action({type:'moments.cancel'});toast('Snapshot capture cancelled.');});
click('prepare-evidence',async()=>{const draft=activeDraft();if(!draft?.evidenceMoments || unsavedLocalReview(draft)) {
  if(draft?.evidenceMoments) renderPreparedEvidence(draft,state.privacy[draft.workspaceId]);
  return;
}
  $('prepare-evidence').disabled=true;$('prepared-status').textContent='Preparing marked images locally…';
  try { await action({type:'review.prepare-local',workspaceId:draft.workspaceId,feedbackId:draft.feedbackId,revision:draft.revision});await refresh();$('prepared-contact-details').querySelector('summary').focus(); }
  catch { await refresh(); }
});
function momentEditContext() {
  const draft = activeDraft(), moment = selectedMoment(draft);
  if (!draft || !moment) return null;
  return { workspaceId: draft.workspaceId, feedbackId: draft.feedbackId,
    revision: draft.revision, momentId: moment.momentId, note: $('moment-note').value };
}
function queueMomentEdit(context, patch) {
  reviewEditVersion++;
  momentEditsPending++;
  localReviewChanged();
  const work = momentWrite.catch(()=>{}).then(async()=>{
    const draft=activeDraft();
    if(!context || !state.reviewOpen || state.metadata.activeWorkspaceId!==context.workspaceId ||
       state.activeDraftId!==context.feedbackId || state.privacy[context.workspaceId]?.blocked ||
       state.privacy[context.workspaceId]?.transitioning || draft?.revision!==context.revision) {
      toast('That change was not saved. Check the current draft and try again.'); return;
    }
    const moment=draft.evidenceMoments?.find(item=>item.momentId===context.momentId);
    if(!moment) { toast('That change was not saved. Select the screenshot again.'); return; }
    const change=patch(moment,context);
    if(!change)return;
    await action({type:'review.edit-moment',workspaceId:draft.workspaceId,feedbackId:draft.feedbackId,
      baseRevision:context.revision,momentId:context.momentId,
      note:Object.hasOwn(change,'note')?change.note:moment.note,
      marks:Object.hasOwn(change,'marks')?change.marks:moment.marks});
    await refresh();
    if(state.activeDraftId===context.feedbackId && selectedMomentId===context.momentId)
      $('moment-edit-status').textContent=$('moment-note').value===context.note ?
        'Saved.' : 'The note has unsaved text. Save it before leaving this screenshot.';
    else toast('Screenshot saved.');
  }).finally(()=>{
    momentEditsPending--;
    const draft=activeDraft();
    if(draft?.evidenceMoments?.length && state.reviewOpen) renderPreparedEvidence(draft,state.privacy[draft.workspaceId]);
  });
  momentWrite=work;return work;
}
function switchMoment(id) {
  const previous=selectedMoment();
  if(momentEditsPending || (previous && $('moment-note').value!==previous.note)) {
    $('moment-select').value=previous.momentId;
    $('moment-note').focus();
    toast('Wait for the save to finish, then switch screenshots.');
    return;
  }
  selectedMomentId=id;renderReview(state.privacy[workspace().id]);
}
$('moment-select').addEventListener('change',()=>switchMoment($('moment-select').value));
$('moment-strip').addEventListener('click',event=>{
  const button=event.target.closest('[data-moment-id]');if(!button)return;
  switchMoment(button.dataset.momentId);
  if (selectedMomentId===button.dataset.momentId) $('moment-strip').querySelector('[data-moment-id="'+CSS.escape(selectedMomentId)+'"]')?.focus();
});
for(const tool of ['rectangle','arrow'])immediateClick('moment-'+tool,()=>{momentTool=tool;renderReview(state.privacy[workspace().id]);});
$('moment-note').addEventListener('input',()=>{reviewEditVersion++;$('moment-edit-status').textContent='Unsaved. Save it before leaving this screenshot.';localReviewChanged();});
immediateClick('moment-save-note',()=>{const context=momentEditContext(),moment=selectedMoment();if(!context || context.note===moment.note)return;return queueMomentEdit(context,(_latest,saved)=>({note:saved.note}));});
immediateClick('moment-undo',()=>{const context=momentEditContext();if(context)return queueMomentEdit(context,(latest,saved)=>({note:saved.note,marks:latest.marks.slice(0,-1)}));});
immediateClick('moment-clear',()=>{const context=momentEditContext();if(context)return queueMomentEdit(context,(_latest,saved)=>({note:saved.note,marks:[]}));});
const momentPoint = event => { const rect=$('moment-overlay').getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}; };
$('moment-overlay').addEventListener('pointerdown',event=>{
  const context=momentEditContext();if(!context || event.button!==0)return;
  momentPointer={context,start:momentPoint(event),tool:momentTool,color:$('moment-color').value};
  try { $('moment-overlay').setPointerCapture(event.pointerId); } catch {} event.preventDefault();
});
$('moment-overlay').addEventListener('pointerup',event=>{
  const pending=momentPointer;momentPointer=null;
  if(!pending || !selectedMoment() || pending.context.momentId!==selectedMoment().momentId ||
     pending.context.feedbackId!==activeDraft()?.feedbackId)return;
  const end=momentPoint(event),start=pending.start;
  if(Math.hypot(end.x-start.x,end.y-start.y)<0.01)return;
  const mark=pending.tool==='rectangle' ? {kind:'rectangle',x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),
    width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y),color:pending.color} :
    {kind:'arrow',x:start.x,y:start.y,x2:end.x,y2:end.y,color:pending.color};
  void queueMomentEdit(pending.context,(latest,saved)=>({note:saved.note,marks:[...latest.marks,mark]})).catch(()=>{});
});
$('moment-overlay').addEventListener('pointercancel',()=>{momentPointer=null;});
new ResizeObserver(placeMomentOverlay).observe($('evidence-preview'));
new ResizeObserver(placeMomentOverlay).observe($('evidence-preview').parentElement);
$('feedback-text').addEventListener('input',()=>{const draft=activeDraft();if(!draft)return;reviewEditVersion++;const buffer=bufferFor(draft);buffer.text=$('feedback-text').value;buffer.dirty=true;$('save-draft').disabled=false;$('draft-save-status').textContent='Unsaved changes';localReviewChanged();});
async function saveDraft() {
  const draft=activeDraft();if(!draft)throw new Error('Choose a target first');
  const buffer=bufferFor(draft);
  if(!buffer.dirty)return draft;
  const saved=await action({type:'review.edit',workspaceId:draft.workspaceId,feedbackId:draft.feedbackId,baseRevision:buffer.revision,text:buffer.text});
  buffers.set(draft.feedbackId,{text:saved.text,revision:saved.revision,dirty:false});await refresh();return saved;
}
click('save-draft',async()=>{const saved=await saveDraft();toast(saved.sessionOnly===false?'Note saved and encrypted on this Mac.':'Note saved for this app session.');});
click('send-feedback',async()=>{
  if(submitting)return;
  submitting=true;
  const recipient=$('recipient').value, confirmStale=$('stale-confirm').checked;
  try{const draft=await saveDraft();await action({type:'review.send',workspaceId:draft.workspaceId,feedbackId:draft.feedbackId,revision:draft.revision,agentSessionId:recipient,confirmStale});
    toast('Sent to '+(state.agents.find(item=>item.agentSessionId===recipient)?.clientName??'the agent')+'. Its status is in Sent.');}
  finally{submitting=false;await refresh();}
});
function showAgentsSection(section, focus = false) {
  agentsSection = section;
  $('agents-dialog').dataset.section=section;
  for (const name of ['setup','agents','services']) {
    $('agents-'+name).hidden = name !== section;
    const button = document.querySelector('[data-agents-section="'+name+'"]');
    if (name === section) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
  document.querySelector('.agents-scroll')?.scrollTo(0,0);
  if (focus) document.querySelector('[data-agents-section="'+section+'"]')?.focus();
}
// The sidebar request count opens the relevant section; otherwise setup stays easy to find.
for(const id of ['connect-agent','show-agents'])click(id,async()=>{
  showAgentsSection(id==='connect-agent' && (state.pending.length || state.attention?.requests.length) ? 'agents' : 'setup');
  await openDialog('agents-dialog');
  void action({type:'agent.tools.refresh'},true).then(refresh).catch(()=>{});
});
$('agents-dialog').querySelector('.agents-nav').addEventListener('click',event=>{
  const button=event.target.closest('[data-agents-section]');
  if (button) showAgentsSection(button.dataset.agentsSection,true);
});
click('close-agents',()=>closeDialog('agents-dialog'));
click('copy-config',async()=>{await action({type:'agent.copy-config'});toast('Configuration copied.');});
// One-click setup: the main process changes only Caddi's own entry in the tool's settings.
for(const [listId,statusId] of [['agent-tools','agent-tools-status'],['welcome-agent-tools','welcome-agent-status']])$(listId).addEventListener('click',async event=>{
  const button=event.target.closest('button[data-agent-tool]'); if(!button||button.disabled)return;
  const connect=button.dataset.agentToolAction==='connect', status=$(statusId);
  button.disabled=true; status.textContent='';
  try{
    const tool=await action({type:connect?'agent.tool.connect':'agent.tool.disconnect',toolId:button.dataset.agentTool},true);
    status.textContent=connect?tool.name+' is set up. Start or restart it, then approve its request on the Agents tab.':'Caddi was removed from '+tool.name+'.';
  }catch(error){status.textContent=agentToolMessage(error?.code);}
  finally{await refresh();$(listId).querySelector('button[data-agent-tool="'+button.dataset.agentTool+'"]')?.focus();}
});
welcome = createWelcomeControls({ getState:()=>state, action, refresh, openDialog, closeDialog, ready:()=>systemLifecycleView(state).ready&&!privateWindow()&&!pagePreview?.active(),
  renderTools:snapshot=>renderAgentTools(snapshot,document,{panelId:'welcome-agent-panel',listId:'welcome-agent-tools'}) });
if (state) void welcome.firstRun().catch(()=>{});
$('attention-requests').addEventListener('click',event=>{
  const accept=event.target.closest('[data-attention-accept]');
  if(accept){
    accept.disabled=true;
    void action({type:'attention.accept',attentionId:accept.dataset.attentionAccept}).then(async()=>{
      await closeDialog('agents-dialog');await refresh();toast('Workspace opened with agents paused. Resume agents when you are finished.');
    }).catch(()=>{if(accept.isConnected)accept.disabled=false;});return;
  }
  const dismiss=event.target.closest('[data-attention-dismiss]');
  if(dismiss)void action({type:'attention.dismiss',attentionId:dismiss.dataset.attentionDismiss}).then(()=>refresh()).catch(()=>{});
  const site=event.target.closest('[data-site]');
  if(site){
    for(const button of site.parentElement.querySelectorAll('button'))button.disabled=true;
    const decision=site.dataset.decision;
    void action({type:'attention.site',attentionId:site.dataset.site,decision},true).then(()=>{
      toast(decision==='deny'?'The agent can’t open that site in this session.':'Allowed. The agent can open that site now.');
      return refresh();
    }).catch(()=>{toast('That request has ended. The agent can ask again.');void refresh();});
  }
  const signIn=event.target.closest('[data-sign-in]');
  if(signIn){
    for(const button of signIn.parentElement.querySelectorAll('button'))button.disabled=true;
    const decision=signIn.dataset.decision;
    void action({type:'attention.sign-in',attentionId:signIn.dataset.signIn,decision},true).then(()=>{
      toast(decision==='deny'?'The agent can’t use that login in this session.':decision==='session'?'Allowed for this session. The agent can now sign in.':'Allowed once. The agent can now sign in.');
      return refresh();
    }).catch(()=>{toast('That request has ended. The agent can ask again.');void refresh();});
  }
});
$('admission-jobs').addEventListener('click',event=>{
  const button=event.target.closest('[data-admission-cancel]');if(!button)return;
  button.disabled=true;
  void action({type:'admission.cancel',jobId:button.dataset.admissionCancel}).then(result=>{
    toast(result.status==='stop-requested'?'Stopping this operation. Capacity stays reserved until it has stopped.':result.status==='not-found'?'That operation has already ended.':'Queued operation cancelled.');
    return refresh();
  }).catch(()=>{if(button.isConnected)button.disabled=false;});
});
// Keep "Change access" open or closed across redraws.
$('pending-connections').addEventListener('toggle',event=>{
  const details=event.target.closest?.('.approval-details');if(!details)return;
  details.querySelector('[name="details"]').value=details.open?'open':'';
},true);
$('pending-connections').addEventListener('change',event=>{
  if(!event.target.matches('[data-workspace-mode]'))return;
  const form=event.target.closest('[data-approval]'),managed=event.target.value==='managed';
  form.querySelector('[data-existing-workspace]').hidden=managed;
  form.elements.namedItem('workspaceId').disabled=managed;
  form.querySelector('[data-managed-workspace]').hidden=!managed;
  form.elements.namedItem('origins').required=managed;
  form.querySelector('[data-approve-submit]').textContent=managed?'Allow one workspace':'Allow';
});
$('pending-connections').addEventListener('submit',event=>{
  const form=event.target.closest('[data-approval]');if(!form)return;event.preventDefault();
  const values=Object.fromEntries(new FormData(form));
  const managed=values.workspaceMode==='managed';
  const request={type:managed?'agent.approve-managed':'agent.approve',requestId:form.dataset.approval,comparisonCode:values.comparisonCode.trim(),origins:values.origins.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean),mode:values.mode,screenshots:values.screenshots==='on',logins:values.logins==='on'};
  if(!managed)request.workspaceId=values.workspaceId;
  void action(request).then(()=>toast(managed?'Agent may create one workspace with the site access you chose.':'Agent connected. Caddi will ask you before it opens a new site.')).catch(()=>{});
});
$('pending-connections').addEventListener('click',event=>{const button=event.target.closest('[data-reject]');if(button)void action({type:'agent.reject',requestId:button.dataset.reject}).catch(()=>{});});
$('connections-list').addEventListener('click',event=>{const button=event.target.closest('[data-revoke]');if(button)void action({type:'agent.revoke',agentSessionId:button.dataset.revoke}).catch(()=>{});});
$('agent-take-over').addEventListener('click',()=>{
  const current=workspace(); if(!current)return;
  void action({type:'agent.take-over',workspaceId:current.id}).then(()=>toast('You have control. The agent has to ask again before it acts.')).catch(()=>{});
});
$('service-create-provider').addEventListener('change',()=>renderServices());
$('service-create-form').addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget,values=Object.fromEntries(new FormData(form)),operations=selectedServiceOperations(form);
  if(!operations.length){toast('Choose at least one thing this connection may read.');return;}
  const provider=values.provider,fields=provider==='github'?{owner:values.owner.trim(),repository:values.repository.trim()}:
    provider==='vercel'?{teamId:values.teamId.trim(),projectId:values.projectId.trim()}:provider==='resend'?{}:null;
  if(!fields){toast('Choose a supported service.');return;}
  if(persistenceView(state).configured){
    void credentialControls.reviewCreate({workspaceId:form.dataset.workspaceId,expectedWorkspaceIdentityId:form.dataset.workspaceIdentityId,
      expectedRevision:Number(form.dataset.persistenceRevision),provider,label:values.label.trim(),...fields,operations});return;
  }
  void action({type:'service.connection.create',workspaceId:form.dataset.workspaceId,expectedWorkspaceIdentityId:form.dataset.workspaceIdentityId,
    provider,label:values.label.trim(),...fields,operations}).then(()=>refresh()).catch(()=>{});
});
$('services-list').addEventListener('change',event=>{
  const recipient=event.target.closest('[data-service-recipient]');
  if(recipient){const form=recipient.closest('[data-service-grant]');for(const operation of serviceOperations){const input=form.elements.namedItem(operation.name);if(input)input.checked=false;}return;}
  const picker=event.target.closest('[data-service-workspace-picker]');if(!picker)return;
  const form=picker.closest('[data-service-workspace-share]');
  form.dataset.workspaceIdentityId=state.metadata.workspaces.find(item=>item.id===picker.value)?.identityId??'';
  const share=state.services?.owner?.shares.find(item=>item.serviceConnectionId===form.dataset.serviceWorkspaceShare&&item.workspaceId===picker.value);
  form.dataset.shareGeneration=String(share?.generation??0);
  form.dataset.reviewBinding=serviceBindingKey(serviceReviewBinding(form.dataset.serviceWorkspaceShare,picker.value));
  for(const operation of serviceOperations){const input=form.elements.namedItem(operation.name);if(input)input.checked=share?.valid!==false&&!!share?.operations.includes(operation.id);}
});
$('services-list').addEventListener('submit',event=>{
  const form=event.target.closest('[data-service-workspace-share],[data-service-grant]');if(!form)return;event.preventDefault();
  const values=Object.fromEntries(new FormData(form)),operations=selectedServiceOperations(form);
  if(!operations.length){toast('Choose at least one thing to share.');return;}
  const binding=form.dataset.reviewBinding?JSON.parse(form.dataset.reviewBinding):null;
  if(!binding){toast('Choose the current workspace and review its access.');return;}
  let request;
  try { request=form.dataset.serviceWorkspaceShare?
    form.hasAttribute('data-persistence-revision')?reviewedConnectionMutation(state,{serviceConnectionId:form.dataset.serviceWorkspaceShare,
      expectedRevision:Number(form.dataset.persistenceRevision),expectedGeneration:Number(form.dataset.persistenceGeneration),expectedWorkspaceIdentityId:form.dataset.workspaceIdentityId},
      {kind:'share',workspaceId:values.workspaceId,operations}):
      {type:'service.workspace.share',serviceConnectionId:form.dataset.serviceWorkspaceShare,workspaceId:values.workspaceId,operations,...binding}:
    {type:'service.grant.create',serviceConnectionId:form.dataset.serviceGrant,workspaceId:form.dataset.workspaceId,agentSessionId:values.agentSessionId,operations,expiresInMs:Number(values.expiresInMs),...binding}; }
  catch(error){toast(persistenceMessages[error.code]??'Saved access changed. Reload and review its current settings.');void refresh();return;}
  void action(request).then(()=>refresh()).catch(()=>void refresh());
});
$('services-list').addEventListener('click',event=>{
  const rotate=event.target.closest('[data-service-rotate]');
  if(rotate){const current=workspace();void credentialControls.reviewRotate({workspaceId:current?.id,expectedWorkspaceIdentityId:current?.identityId,
    serviceConnectionId:rotate.dataset.serviceRotate,expectedRevision:Number(rotate.dataset.persistenceRevision),expectedGeneration:Number(rotate.dataset.persistenceGeneration)});return;}
  const savedRequest=(button,kind,serviceConnectionId,workspaceId)=>reviewedConnectionMutation(state,{serviceConnectionId,
    expectedRevision:Number(button.dataset.persistenceRevision),expectedGeneration:Number(button.dataset.persistenceGeneration)},{kind,workspaceId});
  const share=event.target.closest('[data-service-share-revoke]');
  if(share){let request;try{request=share.hasAttribute('data-persistence-revision')?savedRequest(share,'revoke',share.dataset.serviceConnection,share.dataset.workspaceId):{type:'service.workspace.revoke',serviceConnectionId:share.dataset.serviceConnection,workspaceId:share.dataset.workspaceId};}
    catch(error){toast(persistenceMessages[error.code]??'Saved access changed. Reload and review its current settings.');void refresh();return;}
    void action(request).then(()=>refresh()).catch(()=>void refresh());return;}
  const revoke=event.target.closest('[data-service-revoke]');if(revoke){void action({type:'service.grant.revoke',serviceGrantId:revoke.dataset.serviceRevoke}).then(()=>refresh()).catch(()=>{});return;}
  const remove=event.target.closest('[data-service-remove]');if(remove){let request;try{request=remove.hasAttribute('data-persistence-revision')?savedRequest(remove,'remove',remove.dataset.serviceRemove):{type:'service.connection.remove',serviceConnectionId:remove.dataset.serviceRemove};}
    catch(error){toast(persistenceMessages[error.code]??'Saved access changed. Reload and review its current settings.');void refresh();return;}
    void action(request).then(()=>refresh()).catch(()=>void refresh());}
});
const recorder=createRecorder({
  onStopped: value=>window.caddi.voiceStopped(value),
  onStatus(status){
    if(status==='limit'||status==='device-ended')void stopRecording().catch(()=>{});
    else if(status==='permission')$('voice-status').textContent='Waiting for microphone…';
  },
});
async function stopRecording(){
  const item=recording;if(!item)return;
  recording=null;
  const pcm16=await recorder.stop(item.captureId);
  if(!pcm16.length){await action({type:'voice.cancel',captureId:item.captureId},true).catch(()=>{});return;}
  $('voice-status').textContent='Transcribing…';
  try{const result=await window.caddi.voiceAudio({captureId:item.captureId,pcm16});if(!result.ok)toast(errorMessages[result.code]??'Transcription stopped. Anything you typed is still here.');}
  finally{pcm16.fill(0);await refresh();}
}
click('record',async()=>{
  if(recording)return stopRecording();
  const draft=await saveDraft();
  const capture=await action({type:'voice.begin',workspaceId:draft.workspaceId,feedbackId:draft.feedbackId,revision:draft.revision});
  if(cancelledCaptures.has(capture.captureId)){await window.caddi.voiceStopped({captureId:capture.captureId});return;}
  recording=capture;renderReview(state.privacy[workspace().id]);
  try{await recorder.start(capture);}catch(error){recording=null;await action({type:'voice.cancel',captureId:capture.captureId},true).catch(()=>{});toast(error.message);await refresh();}
});
window.caddi.onVoiceStop(async({captureId})=>{
  cancelledCaptures.add(captureId);
  if(cancelledCaptures.size>128)cancelledCaptures.delete(cancelledCaptures.values().next().value);
  if(recording?.captureId===captureId)recording=null;
  await recorder.cancel(captureId);await window.caddi.voiceStopped({captureId});
});
function command(value){
  if (!systemLifecycleView(state).ready && !['w','permissions'].includes(value)) {
    if (typeof value === 'string') { systemLifecycle?.focus(); toast(systemLifecycleMessages.SYSTEM_PAUSED); }
    return;
  }
  if(typeof value==='object'&&value?.type==='transcript'){
    if (privateWindow()) return;
    const buffer=buffers.get(value.feedbackId);
    if(!buffer){toast('Transcript returned to its original draft. Reopen that draft to review it.');return;}
    reviewEditVersion++;
    buffer.text=(buffer.text.trim()?buffer.text.trim()+'\n':'')+value.text;buffer.dirty=true;
    if(currentEditor===value.feedbackId){$('feedback-text').value=buffer.text;$('save-draft').disabled=false;}
    if(activeDraft()?.feedbackId===value.feedbackId)localReviewChanged();
    toast('Transcript added. Review it before sending.');return;
  }
  if (document.querySelector('dialog[open]')) return;
  if(value==='normal-window'){void action({type:'window.normal.open'}).catch(()=>{});return;}
  if(value==='private-window'){void action({type:'window.private.open'}).catch(()=>{});return;}
  if(value==='shortcuts'){void shortcuts.show().catch(()=>{});return;}
  if(value==='welcome'){if(privateWindow())privateUnavailable();else void welcome.show().catch(()=>{});return;}
  if(pagePreview?.command(value))return;
  if(value==='preview'){void pagePreview.show().catch(()=>{});return;}
  if(value==='storage'){if(privateWindow())privateUnavailable();else void storage.show().catch(()=>{});return;}
  if(privateWindow() && (privateWindow().status!=='active' || ['history','downloads','print','save-pdf','permissions','external-links','new-window'].includes(value))) { privateUnavailable(); return; }
  if(value==='external-links'){void externalLinks.show().catch(()=>{});return;}
  if(value==='l'){$('address').focus();$('address').select();}
  if(value==='new-window')void action({type:'window.open-workspace'}).catch(()=>{});
  if(!workspace())return;
  if(value==='t')void newTab().catch(()=>{});
  if(value==='w'&&activeTab())void action({type:'tab.close',tabId:activeTab().id}).catch(()=>{});
  if(value==='f')void daily.showFind().catch(()=>{});
  if(value==='history')void daily.showHistory().catch(()=>{});
  if(value==='downloads')void daily.showDownloads().catch(()=>{});
  if(value==='print')void daily.printPage().catch(()=>{});
  if(value==='save-pdf')void daily.savePdf().catch(()=>{});
  if(value==='permissions')void openDialog('permissions-dialog').catch(()=>{});
  if(value==='vault')void loginControls.command().catch(()=>{});
  if(value==='k')void daily.showPalette().catch(()=>{});
  if(value==='reopen')void action({type:'tab.reopen-last'}).catch(()=>{});
  if(['back','forward','reload'].includes(value)&&activeTab())void action({type:value,tabId:activeTab().id}).catch(()=>{});
}
window.caddi.onCommand(command);
window.caddi.onState(value=>{state=value;render();});
window.caddi.onNotice(toast);
window.addEventListener('pagehide', clearEvidencePreview);
window.addEventListener('pagehide', () => defaultBrowser.dispose());
window.addEventListener('pagehide', () => credentialControls.dispose());
window.addEventListener('keydown',event=>{
  if (document.querySelector('dialog[open]')) return;
  if (event.key==='Escape' && pagePreview?.active()) { event.preventDefault(); void pagePreview.close(); return; }
  if (event.key==='Escape'&&!$('workspace-popover').hidden){event.preventDefault();setWorkspacePopover(false,true);return;}
  if (sidebarOpen && event.key==='Tab') {
    const focusable=[...$('sidebar').querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]')]
      .filter(node=>node.getClientRects().length && getComputedStyle(node).visibility!=='hidden');
    if (focusable.length) {
      const index=focusable.indexOf(document.activeElement);
      const next=event.shiftKey ? (index<=0?focusable.length-1:index-1) : (index<0||index===focusable.length-1?0:index+1);
      event.preventDefault();focusable[next].focus();return;
    }
  }
  if (event.key==='Escape'&&sidebarOpen){event.preventDefault();void setSidebar(false).catch(()=>{});return;}
  if(event.key==='Escape'&&!$('find-bar').hidden){event.preventDefault();daily.hideFind();}
  if(event.key==='Escape'&&state?.selecting)void action({type:'review.cancel-pick'}).catch(()=>{});
});
setInterval(()=>void refresh().catch(()=>{}),5000);
await refresh();await syncLayout();
