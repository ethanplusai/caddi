import { app as electronApp, BrowserWindow, Menu, ipcMain, session, clipboard, shell, dialog, screen, systemPreferences, powerMonitor, nativeTheme, nativeImage } from 'electron';
import { evenLevels } from './speech-levels.mjs';
import { createBoardStore, BOARD_LIMITS } from './board.mjs';
import fs from 'node:fs/promises';
import { attachWindowMaterial } from './window-material.mjs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { CaddiError, assertKeys, assertId, assertInteger, cloneData } from '../contracts.mjs';
import { createProductStore, stateDigest } from '../state/store.mjs';
import { applyProductCommand } from '../state/model.mjs';
import { createAccessPolicy } from '../access/policy.mjs';
import { createControlCoordinator } from '../access/control.mjs';
import { createElectronEngine } from './engine.mjs';
import { createDesktopAccess } from './access.mjs';
import { createLoginStore, usableLoginOrigin } from './logins.mjs';
import { createVaultActivity, activityOutcome } from './vault-activity.mjs';
import { createNeverSaveList, createOfferHolder, offerDecision, samePassword } from './vault-offer.mjs';
import { readImportFile, prepareImport, reviewImport, wipeCandidates, IMPORT_SKIP_REASONS } from './vault-import.mjs';
import { agentAccessForLogin } from './vault.mjs';
import { createLocalSpeechBridge, createBundledSpeechBridge } from './speech.mjs';
import { createDocumentPersistenceGate, createDownloadHistoryGuard } from './document-persistence.mjs';
import { createDesktopHistoryRecorder } from './history-recorder.mjs';
import { createDesktopWorkspaceLifecycle } from './workspace-host.mjs';
import { workspaceReleaseDecision } from './workspace-retirement.mjs';
import { createWorkspaceSelectionGuard } from './workspace-selection.mjs';
import { createChromeRecovery } from './chrome-recovery.mjs';
import { chromeWorkspaceMetadata } from './chrome-scope.mjs';
import { createFolderRemovalUndo } from './organization-undo.mjs';
import { createPrivateScopeRegistry } from './private-scope-registry.mjs';
import { createPrivateWindowHost, privateOpenAdditions } from './private-window-host.mjs';
import { createWindowSessionStore } from './window-session-store.mjs';
import { createWindowSessionHost } from './window-session-host.mjs';
import { parkNormalWindow } from './normal-window-parking.mjs';
import { createShortcutPreferences } from './shortcut-preferences.mjs';
import { shortcutForInput, shortcutAccelerator } from './shortcuts.mjs';
import { createShortcutRecording } from './shortcut-recording.mjs';
import { formatNotes, normalizeNotes, countLabel, pageAddress, DETAIL_LEVELS } from './annotation-format.mjs';
import { createPreviewHost, previewURL } from './preview-host.mjs';
import { createPortabilityHost } from './portability-host.mjs';
import { createPortabilityPublication, reserveDurableStatePublication } from './portability-publication.mjs';
import { capturePortabilitySource, savePortabilityExportExclusive } from './portability-files.mjs';
import { previewPortabilityImport, createPortabilityExport } from '../state/portability.mjs';
import { affectedVisiblePages, commitVisiblePages, commitClosedPage } from './page-residency.mjs';
import { createDesktopAdmission } from './admission.mjs';
import { createDesktopResourceMonitor } from './resources.mjs';
import { createMomentCaptureController } from './moments.mjs';
import { createPreparedEvidence } from './prepared-evidence.mjs';
import { createEvidenceRasterizer } from './evidence-rasterizer.mjs';
import { createPagePrintController } from './page-print.mjs';
import { createHistoryStore } from '../history/store.mjs';
import { createPersistentDownloadManager } from '../downloads/manager.mjs';
import { createProfilePaths } from './profile-paths.mjs';
import { createAppearancePreference } from './appearance.mjs';
import { createWelcomePreference } from './welcome.mjs';
import { createSitePermissions } from './site-permissions.mjs';
import { createSiteMediaAccess } from './site-media-access.mjs';
import { createDefaultBrowserController, createMacDefaultBrowserAdapter } from './default-browser.mjs';
import { createMediaHost } from './media-host.mjs';
import { createSystemLifecycle, assertSystemLifecycle } from './system-lifecycle.mjs';
import { assertOwnedSystemProof } from './owned-system-proof.mjs';
import { systemCleanupAction } from './system-actions.mjs';
import { assertDesktopPersistenceConfiguration } from '../persistence/configuration.mjs';
import { createDesktopConnectionConfig } from './connection-config.mjs';
import { createAgentTools } from './agent-tools.mjs';
import { validateLiveAction, validateLiveAudio, LIVE_AGENT_PROMPT } from './live.mjs';
import { buildSentItems, annotateBarStatus, agentFor, validateSentAction } from './sent.mjs';
import { startQualificationFixtures } from '../qualification/server.mjs';
import { capturePageBackdrop } from './page-backdrop.mjs';
import { DESKTOP_URL, navigationInput, desktopPageBounds, visibleTabIds, cleanPageTitle } from './presentation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = code => { throw new CaddiError(code, 'This action is unavailable'); };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const shapes = {
  'system.continue': ['expectedGeneration'], 'system.retry-stop': ['expectedGeneration'],
  'persistence.load': [], 'connections.load': [], 'feedback.restore': ['workspaceId', 'expectedWorkspaceIdentityId'],
  'connections.share': ['serviceConnectionId', 'workspaceId', 'operations', 'expectedRevision', 'expectedGeneration', 'expectedWorkspaceIdentityId'],
  'connections.revoke': ['serviceConnectionId', 'workspaceId', 'expectedRevision', 'expectedGeneration'],
  'connections.remove': ['serviceConnectionId', 'expectedRevision', 'expectedGeneration'],
  'connections.create.review': ['workspaceId', 'expectedWorkspaceIdentityId', 'expectedRevision', 'provider', 'label', 'owner', 'repository', 'teamId', 'projectId', 'operations'],
  'connections.rotate.review': ['workspaceId', 'expectedWorkspaceIdentityId', 'expectedRevision', 'serviceConnectionId', 'expectedGeneration'],
  'connections.acquire': ['reviewId'], 'connections.acquire.cancel': ['reviewId'],
  'appearance.set': ['choice'], 'welcome.complete': [],
  'default-browser.status': [], 'default-browser.request': ['expectedRevision'],
  'shortcuts.save': ['expectedRevision', 'bindings'],
  'shortcuts.recording': ['active'],
  'preview.open': ['input'], 'preview.close': ['previewId', 'generation'],
  'preview.promote': ['previewId', 'generation', 'expectedRevision'],
  'portability.import.choose': ['format'], 'portability.import.apply': ['reviewId', 'generation', 'expectedRevision'],
  'portability.export.review': ['format', 'workspaceIds'], 'portability.export.save': ['reviewId', 'generation'],
  'portability.cancel': ['reviewId', 'generation'], 'portability.review.page': ['reviewId', 'generation', 'section', 'offset'],
  'storage.usage': ['workspaceId'],
  'workspace.create': ['name', 'kind'], 'workspace.select': ['workspaceId'], 'workspace.rename': ['workspaceId', 'name'],
  'workspace.reopen': ['workspaceId', 'expectedGeneration'],
  'tab.create': ['workspaceId', 'input', 'activate'], 'tab.select': ['tabId'], 'tab.close': ['tabId'], 'tab.reopen': ['tabId'], 'tab.reopen-last': [],
  'tab.pin': ['tabId', 'pinned'], 'tab.favorite': ['tabId', 'favorite'],
  'tab.rename': ['tabId', 'label'], 'tab.move': ['tabId', 'groupId', 'folderId'], 'tab.duplicate': ['tabId'],
  'group.create': ['workspaceId', 'name'], 'group.rename': ['groupId', 'name', 'color'], 'group.select': ['groupId'],
  'folder.create': ['groupId', 'name', 'parentId'], 'folder.rename': ['folderId', 'name'],
  'folder.collapse': ['folderId', 'collapsed'], 'folder.move': ['folderId', 'parentId'], 'folder.remove': ['folderId'],
  'folder.undo': ['undoId'],
  'group.reorder': ['groupId', 'beforeId', 'expectedRevision'], 'folder.reorder': ['folderId', 'beforeId', 'expectedRevision'],
  'tab.reorder': ['tabId', 'beforeId', 'expectedRevision'],
  'external-links.review': [], 'external-links.dismiss': ['reviewId', 'linkId'],
  'external-links.open': ['reviewId', 'linkId', 'workspaceId'], 'external-links.close': ['reviewId'],
  'history.list': ['workspaceId', 'query'], 'history.remove': ['workspaceId', 'visitId'], 'history.clear': ['workspaceId'],
  'download.control': ['workspaceId', 'downloadId', 'operation'], 'download.reveal': ['workspaceId', 'downloadId'],
  'page.print': ['tabId'], 'page.save-pdf': ['tabId'], 'page.copy-markdown': ['tabId'],
  'permission.respond': ['workspaceId', 'requestId', 'expectedRevision', 'allow'],
  'permission.media.revoke': ['workspaceId', 'mediaRecordId', 'expectedRevision', 'mediaTypes'],
  'permission.media.end': ['workspaceId', 'mediaRecordId', 'expectedRevision'],
  'popup.allow-once': ['tabId'], 'popup.cancel': ['tabId'], 'popup.close': ['popupId'],
  'window.open-workspace': [], 'window.private.open': [], 'window.normal.open': [], 'window.close': [],
  'find': ['tabId', 'text', 'forward', 'findNext', 'matchCase'], 'find.stop': ['tabId'],
  'zoom.set': ['tabId', 'factor'], 'mute.set': ['tabId', 'muted'],
  'navigate': ['tabId', 'input'], 'back': ['tabId'], 'forward': ['tabId'], 'reload': ['tabId'], 'stop': ['tabId'],
  'split.toggle': ['tabId'], 'review.open': [], 'review.close': [], 'review.pick': ['tabId'], 'review.cancel-pick': [],
  'overlay.set': ['open'],
  'annotate.start': [], 'annotate.stop': [], 'annotate.copy': [], 'annotate.clear': [],
  'annotate.send': ['agentSessionId'], 'annotate.detail': ['level'],
  'board.open': [], 'board.close': [], 'board.add-note': ['text', 'color', 'x', 'y'], 'board.add-link': ['url', 'title', 'x', 'y'],
  'board.pin-page': [], 'board.snap-page': [], 'board.update': ['itemId', 'patch'], 'board.remove': ['itemId'], 'board.image': ['itemId'],
  'board.pointer': ['itemId', 'kind', 'point'],
  'live.start': ['agentSessionId'], 'live.stop': [], 'live.say': ['text'], 'live.remove': ['instructionId'], 'live.copy-prompt': [],
  'moments.start': ['tabId'], 'moments.add': [], 'moments.stop': [], 'moments.cancel': [],
  'review.page': ['tabId'], 'review.select': ['workspaceId', 'feedbackId'],
  'review.edit': ['workspaceId', 'feedbackId', 'baseRevision', 'text'],
  'review.edit-moment': ['workspaceId', 'feedbackId', 'baseRevision', 'momentId', 'note', 'marks'],
  'review.prepare-local': ['workspaceId', 'feedbackId', 'revision'],
  'review.invalidate-local': [],
  'review.send': ['workspaceId', 'feedbackId', 'revision', 'agentSessionId', 'confirmStale'],
  'review.cancel': ['workspaceId', 'deliveryId'], 'review.deselect': [],
  'sent.open': ['kind', 'id'], 'sent.copy': ['kind', 'id'], 'sent.delete': ['kind', 'id'], 'sent.send': ['kind', 'id', 'agentSessionId', 'confirmStale'],
  'privacy.enter': ['workspaceId'], 'privacy.resume': ['workspaceId'],
  'attention.accept': ['attentionId'], 'attention.dismiss': ['attentionId'],
  'agent.approve': ['requestId', 'comparisonCode', 'workspaceId', 'origins', 'mode', 'screenshots', 'logins'],
  'agent.approve-managed': ['requestId', 'comparisonCode', 'origins', 'mode', 'screenshots', 'logins'],
  'attention.sign-in': ['attentionId', 'decision'],
  'attention.site': ['attentionId', 'decision'],
  'logins.refresh': [], 'logins.add': ['workspaceId', 'origin', 'username', 'label', 'password'],
  'logins.edit': ['loginId', 'workspaceId', 'origin', 'username', 'label', 'password'], 'logins.delete': ['loginId', 'workspaceId'],
  'logins.share': ['loginId', 'workspaceId', 'toWorkspaceId'], 'logins.unshare': ['loginId', 'workspaceId', 'confirmDelete'],
  'logins.agent-use': ['loginId', 'workspaceId', 'allowed'], 'logins.copy': ['loginId', 'workspaceId'], 'logins.show': ['loginId', 'workspaceId'],
  'logins.fill': ['tabId', 'loginId'],
  // The Vault: save offers, the never-save list, the access log and import. The password of an offer or an import never crosses here.
  'vault.offer.save': ['offerId', 'scope'], 'vault.offer.never': ['offerId'], 'vault.offer.dismiss': ['offerId'],
  'vault.never.remove': ['workspaceId', 'origin'],
  'vault.activity.list': ['workspaceId', 'loginId'], 'vault.activity.clear': ['workspaceId'],
  'vault.import.choose': [], 'vault.import.review': ['importId', 'toWorkspaceId'], 'vault.import.confirm': ['importId', 'toWorkspaceId'],
  'vault.import.cancel': ['importId'],
  'agent.take-over': ['workspaceId'],
  'admission.cancel': ['jobId'],
  'agent.reject': ['requestId'], 'agent.revoke': ['agentSessionId'],
  'service.connection.create': ['workspaceId', 'expectedWorkspaceIdentityId', 'provider', 'label', 'owner', 'repository', 'teamId', 'projectId', 'operations'], 'service.connection.remove': ['serviceConnectionId'],
  'service.workspace.share': ['serviceConnectionId', 'workspaceId', 'operations', 'expectedRevision', 'expectedConnectionGeneration', 'expectedWorkspaceIdentityId'],
  'service.workspace.revoke': ['serviceConnectionId', 'workspaceId'],
  'service.grant.create': ['serviceConnectionId', 'workspaceId', 'agentSessionId', 'operations', 'expiresInMs', 'expectedRevision', 'expectedConnectionGeneration', 'expectedWorkspaceIdentityId'],
  'service.grant.revoke': ['serviceGrantId'],
  'agent.copy-config': [], 'agent.tools.refresh': [], 'agent.tool.connect': ['toolId'], 'agent.tool.disconnect': ['toolId'],
  'demo.open': ['workspaceId'],
  'voice.begin': ['workspaceId', 'feedbackId', 'revision'], 'voice.cancel': ['captureId'],
};
// Arguments an action may leave out. Every other listed key is required.
const optionalKeys = { 'logins.add': ['label'], 'logins.edit': ['origin', 'username', 'label', 'password'], 'logins.unshare': ['confirmDelete'],
  'vault.activity.list': ['loginId'], 'board.pointer': ['itemId', 'point'], 'board.add-note': ['text', 'color', 'x', 'y'], 'board.add-link': ['title', 'x', 'y'] };

/** Explicit development composition. Durable feedback/services require an issued
 * main-only configuration; transport sessions and agent authority stay volatile. */
export async function createDesktopApp({ projectRoot, dataRoot, runRoot, show = true, enableMicrophone = true, persistentProfiles = false,
  speechResourceRoot = null,
  nativeKeyStatus = { loaded: false, productionQualified: false, reason: 'native-addon-unavailable' },
  testDownloadSavePath = null, testRevealFile = null, testClipboardWrite = null, testPdfSavePath = null, testPrintPage = null, testServiceBackend = null,
  testCloseDecision = null, testRecoveryDecision = null, testPreviewMenu = null, externalLinks = null, agentToolsHome = null, agentRuntime = null, firstRunWelcome = false,
  testPortabilityDialogs = null, testSiteMediaAccess = null, systemLifecycle = null, ownedSystemProof = null,
  persistenceConfiguration = null, serviceTransport = null, testDefaultBrowser = null, testOwnerCredentialAcquirer = null, testLiveAudio = false,
  loginSecrets = null } = {}) {
  systemLifecycle ??= createSystemLifecycle({ monitor: powerMonitor });
  if (ownedSystemProof) assertOwnedSystemProof(ownedSystemProof, systemLifecycle, {
    dataRoot, runRoot, sessionDataRoot: electronApp.getPath('sessionData'), show, enableMicrophone, nativeKeyStatus, persistence: persistenceConfiguration,
  });
  else assertSystemLifecycle(systemLifecycle, { monitor: powerMonitor, source: 'power-monitor' });
  const persistenceMetadata = persistenceConfiguration ? assertDesktopPersistenceConfiguration(persistenceConfiguration,
    { allowTest: !!ownedSystemProof, expectedDirectory: path.join(dataRoot, 'protected') }) : null;
  systemLifecycle.start();
  if (externalLinks && !['summary', 'subscribe', 'beginReview', 'dismiss', 'open', 'closeReview', 'invalidateOwner'].every(key => typeof externalLinks[key] === 'function')) fail('INVALID_ARGUMENT');
  if (testServiceBackend && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  if ((testPdfSavePath || testPrintPage) && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  if (testCloseDecision && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  if (testRecoveryDecision && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  if (testPreviewMenu && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  // Lets an automated run hand Live synthetic utterances through the trusted chrome IPC. It never grants the microphone.
  if (testLiveAudio !== false && (testLiveAudio !== true || show || persistentProfiles || enableMicrophone)) fail('TEST_BACKEND_DENIED');
  if ((testPortabilityDialogs || testSiteMediaAccess) && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  // An in-memory stand-in for the keychain is for automated runs only.
  if (loginSecrets && loginSecrets.testOnly !== false && (show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  if (testDefaultBrowser && (!ownedSystemProof || show || persistentProfiles)) fail('TEST_BACKEND_DENIED');
  if (testOwnerCredentialAcquirer && (!ownedSystemProof || show || persistentProfiles || persistenceMetadata?.testOnly !== true ||
      typeof testOwnerCredentialAcquirer !== 'function')) fail('TEST_BACKEND_DENIED');
  if ((testPdfSavePath && typeof testPdfSavePath !== 'function') || (testPrintPage && typeof testPrintPage !== 'function')) fail('INVALID_ARGUMENT');
  if (testCloseDecision !== null && typeof testCloseDecision !== 'function') fail('INVALID_ARGUMENT');
  if (testRecoveryDecision !== null && typeof testRecoveryDecision !== 'function') fail('INVALID_ARGUMENT');
  if (testPreviewMenu !== null && typeof testPreviewMenu !== 'function') fail('INVALID_ARGUMENT');
  const validatePortabilityDialogs = value => {
    if (!value || typeof value.chooseImportFile !== 'function' || typeof value.chooseExportFile !== 'function') fail('INVALID_ARGUMENT');
    return value;
  };
  if (testPortabilityDialogs) validatePortabilityDialogs(testPortabilityDialogs);
  if (testSiteMediaAccess && typeof testSiteMediaAccess.authorize !== 'function') fail('INVALID_ARGUMENT');
  let portabilityDialogsForTest = testPortabilityDialogs;
  let capturedPreviewMenu = null;
  let closeDecisionForTest = testCloseDecision;
  let recoveryDecisionForTest = testRecoveryDecision;
  const store = createProductStore({ directory: path.join(dataRoot, 'metadata') });
  let state = await store.load(), tail = Promise.resolve(), actionTail = Promise.resolve(), windowCloseTail = Promise.resolve(), queuedActions = 0, closing = false, closed = false, closeTask;
  const appearance = await createAppearancePreference(dataRoot);
  const welcome = await createWelcomePreference(dataRoot);
  const shortcuts = await createShortcutPreferences(dataRoot);
  const privateScopes = createPrivateScopeRegistry({ getDurableState: () => state });
  const profilePaths = persistentProfiles ? createProfilePaths(dataRoot) : null;
  const recentlyClosed = [], pendingTabCloses = new Map();
  const organizationUndo = createFolderRemovalUndo(), externalReviewBindings = new WeakMap();
  const serviceShareRevisions = new Map();
  let logins = null, loginsError = null, loginClipboardTimer = null, vaultActivity = null, neverSave = null, board = null;
  // Save offers (at most one per tab, held two minutes) and imports under review. Memory only. Their passwords are Buffers, wiped on every end.
  const vaultOffers = createOfferHolder({ onChange: () => emit() }), vaultImports = new Map(), agentActivityAt = new Map();
  let window, engine, access, speech, fixtures, downloads, moments, prepared, prints, workspaceLifecycle, admission, resources, chromeRecovery, privateWindows, windowSessions, previews, shortcutRecording, portability,
    voice = null, liveVoice = null, emitTimer, metadataTimer, history = null, historyError = null, startupRestoring = true;
  const blockedPopups = [];
  const windows = new Map(), workspaceOwners = new Map(), retiringChromeIds = new Set();
  const chromeActions = new AsyncLocalStorage();
  const defaultBrowser = createDefaultBrowserController({ native: testDefaultBrowser ?? createMacDefaultBrowserAdapter(electronApp), onChange: () => emit() });
  const assertChromeActionCurrent = () => {
    const intent = chromeActions.getStore();
    if (intent) return intent.assertCurrent();
    // First-use empty metadata has no native pages or authority. Saved pages are
    // never hydrated until the system boundary is attached and ready.
    if (!engine && startupRestoring) return true;
    return systemLifecycle.capture({ purpose: 'background-work' }).assertCurrent();
  };
  function captureChromeIntent(context, cleanup = false) {
    const chrome = chromeRecovery.capture(context);
    const system = cleanup ? systemLifecycle.captureCleanup() : systemLifecycle.capture({ purpose: 'owner-action' });
    return Object.freeze({ ...chrome, systemEpoch: system.epoch, assertCurrent() {
      chrome.assertCurrent(); system.assertCurrent(); return true;
    } });
  }
  let primaryContext, selecting = null, connectionConfiguration = null, agentTools = null;
  // One on-page note session at a time, owned by one window (like `selecting`).
  let annotating = null, annotateDetail = 'standard', annotateEvent = null, annotateEventId = 0, annotateAgentsKey = '';
  // Notes of a session that was closed for its owner (agent control, a page that
  // interferes with the note layer). Per tab, for the same document only.
  const annotateKept = new Map();
  const loaded = new Set(), activeDrafts = new Map(), metadataChanges = new Map(), blockingWorkspaces = new Set();
  const systemPrivateBarriers = new Map();
  const privacy = createControlCoordinator();
  const documents = createDocumentPersistenceGate({ privacy });
  const siteMediaAccess = testSiteMediaAccess ?? createSiteMediaAccess({
    getStatus: device => systemPreferences.getMediaAccessStatus(device),
    requestAccess: device => systemPreferences.askForMediaAccess(device),
  });
  const sitePermissions = createSitePermissions({ current: webContentsId => {
    if (systemLifecycle.status().locked) return null;
    const binding = engine?.permissionBinding(webContentsId);
    if (privateWindows?.ownsWorkspace(binding?.workspaceId)) return null;
    const owner = workspaceOwners.get(binding?.workspaceId);
    if (!binding || !owner || owner.privateScopeId || owner.closing || owner.workspaceId !== binding.workspaceId ||
        windows.get(owner.id) !== owner || owner.window.isDestroyed() || !chromeRecovery?.ready(owner) || blockingWorkspaces.has(binding.workspaceId) ||
        privacy.getPrivacyState(binding.workspaceId).blocked || !visibleTabIds({ ...state, activeWorkspaceId: owner.workspaceId }).includes(binding.tabId)) return null;
    const workspace = state.workspaces.find(item => item.id === binding.workspaceId);
    const mediaEligible = workspace?.kind === 'personal' && workspace.lifecycle?.status !== 'archived' &&
      workspace.identityId === binding.identityId && engine.getWorkspaceOwnerWindow(workspace.id) === owner.window &&
      !previews?.has(owner) && !privacy.hasActiveLease(workspace.id) &&
      !(access?.connections() ?? []).some(item => item.workspaceId === workspace.id &&
        (item.workspaceActive || ['approved', 'connected'].includes(item.status)));
    return { ...binding, mediaEligible, chromeGeneration: chromeRecovery.snapshot(owner).generation };
  }, mediaAccess: siteMediaAccess, currentMediaDocument: webContentsId => engine?.mediaDocumentBinding(webContentsId) ?? null,
  onChange: () => emit() });
  const mediaHost = createMediaHost({ permissions: sitePermissions, captureOwner: capturePermissionOwner,
    closeNative: (context, { binding, assertCurrent }) => engine.humanEndMediaPage(binding, {
      expectedOwnerWindow: context.window, beforeClose: assertCurrent, decideClose: () => decideClose('tab', context),
    }), closeMetadata: closeMediaMetadata, onChange: () => emit() });
  try { history = await createHistoryStore({ directory: path.join(dataRoot, 'history'), canRecord: workspaceId => !systemLifecycle.status().locked && !privacy.getPrivacyState(workspaceId).blocked }); }
  catch (error) { historyError = error.code ?? 'HISTORY_UNAVAILABLE'; }
  const policy = createAccessPolicy({ workspaceLookup: id => state.workspaces.find(item => item.id === id) });
  const channels = ['state', 'action', 'layout', 'audio', 'audio-stopped', 'live-audio', 'live-audio-stopped', 'artifact-preview', 'prepared-preview'].map(name => 'caddi-desktop:' + name);
  const send = (channel, value, context = null) => {
    const targets = context ? [context] : [...windows.values()];
    for (const item of targets) if (!item.window.isDestroyed() && !item.window.webContents.isDestroyed() && (!chromeRecovery || chromeRecovery.ready(item) ||
        (channel === 'state' && item.privateScopeId && item.closing && item.window.webContents.getURL() === DESKTOP_URL && chromeRecovery.snapshot(item).phase === 'ready')))
      try { item.window.webContents.send('caddi-desktop:' + channel, value); } catch {}
  };
  const notice = message => send('notice', String(message).slice(0, 240));
  const tabFor = id => { const tab = state.tabs.find(item => item.id === assertId(id)); if (!tab) fail('TAB_NOT_FOUND'); return tab; };
  const workspaceFor = id => { const workspace = state.workspaces.find(item => item.id === assertId(id)); if (!workspace) fail('WORKSPACE_NOT_FOUND'); return workspace; };
  const workspaceSelection = createWorkspaceSelectionGuard({ workspaceFor, ownerFor: id => workspaceOwners.get(id),
    isBusy: id => workspaceLifecycle?.isBusy(id) === true,
    contextCurrent: context => !closing && !closed && !context.closing && windows.get(context.id) === context && !context.window.isDestroyed() &&
      (!chromeRecovery || chromeRecovery.ready(context)) });
  const query = tab => ({ workspaceId: tab.workspaceId, tabId: tab.id });
  async function decideClose(kind, context, allowClosing = false) {
    if (closed || (closing && !allowClosing) || !context || (context.closing && !allowClosing) || windows.get(context.id) !== context || context.window.isDestroyed()) return false;
    if (closeDecisionForTest) return (await closeDecisionForTest({ kind, windowId: context.id, workspaceId: context.workspaceId })) === true;
    const leave = kind === 'leave', tab = kind === 'tab' || leave;
    const reviewTransfer = kind === 'review-transfer';
    const answer = await dialog.showMessageBox(context.window, { type: 'warning',
      title: leave ? 'Leave this page?' : tab ? 'Close this page?' : reviewTransfer ? 'Discard unsaved notes?' : 'Close Caddi?',
      message: leave ? 'This page has asked you to stay.' : tab ? 'This page has asked to stay open.' : reviewTransfer ?
        'Unsaved notes in this window will be lost.' : 'Closing Caddi will close open pages and notes from this session.',
      detail: tab ? 'You may have unsaved changes on this site. Leave this page only if you are ready to lose them.' :
        reviewTransfer ? 'Open pages will move to the other window. Save your note and screenshot notes before closing if you want to keep those edits.' :
        'Unsaved changes on websites and notes from this session may be lost. Website profiles are kept separately.',
      buttons: [leave ? 'Stay' : 'Keep Open', tab ? 'Leave Page' : reviewTransfer ? 'Discard & Close Window' : 'Close Caddi'],
      defaultId: 0, cancelId: 0, noLink: true });
    return answer.response === 1 && windows.get(context.id) === context && !context.window.isDestroyed() && (!context.closing || allowClosing);
  }
  function bulkCloseNeedsConfirmation() {
    if (state.workspaces.some(item => { try { return access?.drafts(item.id).length > 0; } catch { return true; } })) return true;
    for (const tab of state.tabs) if (tab.status === 'open' && loaded.has(tab.id)) {
      try { if (engine.navigation(query(tab)).url !== 'about:blank') return true; } catch { return true; }
    }
    return false;
  }
  function closeNativeTab(tab, context, allowClosing = false) {
    if (!systemLifecycle.status().locked || context.privateScopeId)
      return engine.humanCloseTab(query(tab), () => decideClose('tab', context, allowClosing));
    const cleanup = systemLifecycle.captureCleanup(), identityId = workspaceFor(tab.workspaceId).identityId;
    const chromeGeneration = chromeRecovery.snapshot(context).generation, intentGeneration = context.intentGeneration;
    const frame = context.window.webContents.mainFrame, processId = frame.processId, routingId = frame.routingId;
    const beforeClose = () => {
      cleanup.assertCurrent();
      const current = context.window.webContents.mainFrame;
      if (closed || windows.get(context.id) !== context || context.window.isDestroyed() || context.window.webContents.isDestroyed() ||
          context.intentGeneration !== intentGeneration || chromeRecovery.snapshot(context).generation !== chromeGeneration ||
          current.isDestroyed() || current.processId !== processId || current.routingId !== routingId || current.url !== DESKTOP_URL ||
          workspaceFor(tab.workspaceId).identityId !== identityId || engine.getWorkspaceOwnerWindow(tab.workspaceId) !== context.window) fail('SYSTEM_CLOSE_STALE');
      return true;
    };
    return engine.humanCloseTab(query(tab), () => decideClose('tab', context, allowClosing), { cleanup, expectedOwnerWindow: context.window, beforeClose });
  }
  async function requestQuit() {
    if (closed) return true;
    if (closing) return false;
    engine?.cancelHumanClose();
    if (!bulkCloseNeedsConfirmation()) return true;
    const context = [...windows.values()].find(item => !item.closing && !item.window.isDestroyed());
    if (!context) return false;
    return decideClose('bulk', context);
  }
  const emit = () => {
    if (closed || emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; if (!closed) { syncAnnotateAgents(); syncAnnotateStatus(); syncLive(); for (const context of windows.values()) send('state', snapshot(context), context); } }, 25);
  };
  const unsubscribeExternalLinks = externalLinks?.subscribe(emit);
  const historyRecorder = history ? createDesktopHistoryRecorder({ record: (...args) => history.record(...args),
    canCommit: token => documents.canCommit(token), onChange: emit,
    onError: error => {
      if (error.code === 'HISTORY_BUSY') return;
      historyError = error.code ?? 'HISTORY_UNAVAILABLE'; notice('History is unavailable. Saved history was left untouched.'); emit();
    } }) : null;
  function serviceOwnerInventory() {
    const owner = access?.services.ownerInventory() ?? { available: false, qualification: 'protected-storage-pending', connections: [], shares: [] };
    const eligible = state.workspaces.filter(item => item.kind !== 'personal' && !item.personal && !item.humanOnly && item.lifecycle?.status !== 'archived');
    return { ...owner, acquisition: access?.persistence?.acquisition?.status() ?? { available: false, qualification: 'protected-owner-acquisition-pending', testOnly: false },
      persistenceReview: access?.persistence?.ownerReview() ?? null, reviewBindings: owner.connections.flatMap(connection => eligible.map(workspace =>
      access.services.reviewBinding({ serviceConnectionId: connection.id, workspaceId: workspace.id }))) };
  }
  function assertServiceReview(args) {
    assertInteger(args.expectedRevision, 'service review revision', { min: 0 });
    assertInteger(args.expectedConnectionGeneration, 'service connection generation', { min: 1 });
    assertId(args.expectedWorkspaceIdentityId);
    const current = access.services.reviewBinding({ serviceConnectionId: args.serviceConnectionId, workspaceId: args.workspaceId });
    if (args.expectedRevision !== current.revision || args.expectedConnectionGeneration !== current.connectionGeneration ||
        args.expectedWorkspaceIdentityId !== current.workspaceIdentityId) fail('SERVICE_REVIEW_STALE');
  }
  function capturePersistenceOwner(context, expectedWorkspaceId = context?.workspaceId, expectedIdentityId = null) {
    if (!context || context.privateScopeId || !expectedWorkspaceId || context.workspaceId !== expectedWorkspaceId || previews?.has(context)) fail('PERSISTENCE_REVIEW_REQUIRED');
    const chrome = chromeActions.getStore() ?? captureChromeIntent(context), workspace = workspaceFor(expectedWorkspaceId);
    const identityId = workspace.identityId, workspaceGeneration = workspace.lifecycle?.generation ?? 0;
    if (expectedIdentityId !== null && expectedIdentityId !== identityId) fail('PERSISTENCE_IDENTITY_CHANGED');
    const intentGeneration = context.intentGeneration, epoch = privacy.getPrivacyState(expectedWorkspaceId).capturePrivacyEpoch;
    const assertCurrent = () => {
      chrome.assertCurrent();
      const current = workspaceFor(expectedWorkspaceId);
      if (closed || closing || context.closing || windows.get(context.id) !== context || context.window.isDestroyed() ||
          context.privateScopeId || context.workspaceId !== expectedWorkspaceId || context.workspaceIdentityId !== identityId ||
          context.intentGeneration !== intentGeneration || workspaceOwners.get(expectedWorkspaceId) !== context ||
          engine.getWorkspaceOwnerWindow(expectedWorkspaceId) !== context.window || current.identityId !== identityId ||
          current.lifecycle?.status === 'archived' || (current.lifecycle?.generation ?? 0) !== workspaceGeneration ||
          privacy.getPrivacyState(expectedWorkspaceId).capturePrivacyEpoch !== epoch || privacy.getPrivacyState(expectedWorkspaceId).blocked ||
          blockingWorkspaces.has(expectedWorkspaceId) || previews?.has(context)) fail('PERSISTENCE_REVIEW_REQUIRED');
      return true;
    };
    assertCurrent(); return { assertCurrent, workspaceId: expectedWorkspaceId, identityId };
  }
  function captureDefaultBrowserOwner(context) {
    const chrome = chromeActions.getStore() ?? captureChromeIntent(context);
    const system = systemLifecycle.capture({ purpose: 'default-browser-request' });
    const generation = context.intentGeneration, nativeWindow = context.window;
    const assertCurrent = () => {
      chrome.assertCurrent(); system.assertCurrent();
      if (closed || closing || context.closing || context.privateScopeId || windows.get(context.id) !== context ||
          context.window !== nativeWindow || nativeWindow.isDestroyed() || !context.chromeOverlay ||
          context.intentGeneration !== generation || previews?.has(context)) fail('DEFAULT_BROWSER_REVIEW_REQUIRED');
      return true;
    };
    assertCurrent(); return Object.freeze({ signal: system.signal, assertCurrent });
  }
  function captureServiceCredentialOwner(context, { workspaceId, identityId }) {
    const owner = capturePersistenceOwner(context, workspaceId, identityId);
    const system = systemLifecycle.capture({ purpose: 'owner-credential-acquisition', workspaceId, identityId });
    const epoch = context.intentGeneration, nativeIdentity = context.window.webContents;
    const assertCurrent = () => {
      owner.assertCurrent(); system.assertCurrent();
      if (!context.chromeOverlay || context.window.webContents !== nativeIdentity || nativeIdentity.isDestroyed()) fail('PERSISTENCE_REVIEW_REQUIRED');
      return true;
    };
    assertCurrent(); return Object.freeze({ epoch, signal: system.signal, nativeIdentity, assertCurrent });
  }
  function mediaActivity(context) {
    if (!context || context.privateScopeId || context.window.isDestroyed()) return { possiblePages: 0, workspaces: [] };
    const workspaces = state.workspaces.filter(workspace => engine?.getWorkspaceOwnerWindow(workspace.id) === context.window)
      .map(workspace => ({ workspaceId: workspace.id, name: workspace.name, count: sitePermissions.list(workspace.id).media.length }))
      .filter(item => item.count > 0);
    return { possiblePages: workspaces.reduce((sum, item) => sum + item.count, 0), workspaces };
  }
  function snapshot(context = primaryContext) {
    const workspaceId = context?.workspaceId ?? null;
    if (context?.privateScopeId) {
      const local = privateWindows.snapshot(context);
      return { ...local, systemLifecycle: systemLifecycle.snapshot(), persistence: { mode: 'unavailable', phase: 'unavailable', testOnly: false, feedbackAvailable: false, connectionsLoaded: false, lastError: 'PRIVATE_FEATURE_UNAVAILABLE' }, appearance: appearance.get(), shortcuts: shortcuts.snapshot(), shortcutRecording: shortcutRecording?.snapshot(context) ?? { active: false, expiresAt: null }, preview: null, windowSession: windowSessions?.snapshot() ?? null,
        privacy: { [workspaceId]: { ...privacy.getPrivacyState(workspaceId), transitioning: local.privateBrowsing.status !== 'active' } },
        agents: [], pending: [], admission: null, workspaceManagement: { available: false }, chromeRecovery: chromeRecovery?.snapshot(context) ?? null,
        externalLinks: { pending: 0, revision: 0 }, portability: { available: false, importAvailable: false, active: false, phase: 'idle' },
        mediaActivity: { possiblePages: 0, workspaces: [] }, attention: { sessionOnly: true, requests: [] }, logins: null, board: null, drafts: [], deliveries: [],
        activeDraftId: null, reviewOpen: false, sent: null, selecting: null, annotate: null, moments: null, preparedEvidence: null, pagePrint: { busy: false, kind: null },
        speech: { available: false, microphoneAvailable: false, reason: 'private-browsing' }, voice: null, live: null,
        development: { sessions: 'private-ephemeral', feedback: 'unavailable', productionQualified: false,
          protectedKeys: { loaded: nativeKeyStatus.loaded === true, productionQualified: false, reason: nativeKeyStatus.reason } },
        services: { available: false, qualification: 'private-browsing', connections: [], grants: [], audit: [], owner: { available: false, connections: [], shares: [], reviewBindings: [] } },
        history: { available: false, code: 'PRIVATE_FEATURE_UNAVAILABLE' }, downloads: [],
        downloadHistory: { available: false, persistent: false, errorCode: 'PRIVATE_FEATURE_UNAVAILABLE' },
        sitePermissions: { pending: [], decisions: [], blockedPopups: [], popups: { grants: [], children: [] } }, connectionConfig: null, connectionSetup: null, agentTools: [] };
    }
    const metadata = chromeWorkspaceMetadata(state, workspaceId);
    const pages = {};
    for (const tab of state.tabs) if (tab.workspaceId === workspaceId && loaded.has(tab.id)) {
      try { pages[tab.id] = { ...engine.navigation(query(tab)), target: engine.getTarget(query(tab)) }; } catch {}
    }
    const guards = Object.fromEntries(state.workspaces.map(item => [item.id, { ...privacy.getPrivacyState(item.id), transitioning: blockingWorkspaces.has(item.id) }]));
    let drafts = [], deliveries = [];
    if (access && workspaceId && !guards[workspaceId]?.blocked) {
      try { drafts = access.drafts(workspaceId); deliveries = access.deliveries(workspaceId); } catch {}
    }
    return { metadata, systemLifecycle: systemLifecycle.snapshot(), persistence: access?.persistenceStatus() ?? { mode: persistenceMetadata ? 'encrypted-durable' : 'session-only', phase: persistenceMetadata ? 'unopened' : 'session-only', testOnly: persistenceMetadata?.testOnly ?? true, feedbackAvailable: persistenceMetadata?.feedbackAvailable ?? true, connectionsLoaded: false, lastError: null }, appearance: appearance.get(), shortcuts: shortcuts.snapshot(), shortcutRecording: shortcutRecording?.snapshot(context) ?? { active: false, expiresAt: null },
      preview: previews?.snapshot(context) ?? null, privateBrowsing: null, windowSession: windowSessions?.snapshot() ?? null,
      pages, privacy: guards, agents: access?.connections() ?? [], pending: access?.pendingConnections() ?? [],
      admission: admission ? { ...admission.snapshot(), requests: access?.queueStats?.() ?? null } : null,
      workspaceManagement: { available: access?.lifecycle.available === true }, chromeRecovery: chromeRecovery?.snapshot(context) ?? null,
      externalLinks: externalLinks?.summary() ?? { pending: 0, revision: 0 },
      portability: portability?.summary(context) ?? { available: false, importAvailable: false, active: false, phase: 'idle' },
      mediaActivity: mediaActivity(context),
      organizationUndo: workspaceId ? organizationUndo.snapshot(state, workspaceId) : { available: false },
      attention: access?.attention.humanView() ?? { sessionOnly: true, requests: [] },
      logins: loginsView(context), vault: vaultView(context), board: boardView(context),
      drafts, deliveries, activeDraftId: activeDrafts.get(workspaceId) ?? null, reviewOpen: !!context?.reviewOpen,
      sent: sentView(context, drafts, deliveries, guards[workspaceId]),
      selecting: selecting?.ownerWindowId === context?.id ? selecting : null,
      annotate: annotateView(context),
      moments: moments?.view(context) ?? null,
      preparedEvidence: prepared?.view(context && activeDrafts.get(workspaceId) ? {ownerWindowId:context.id,workspaceId,feedbackId:activeDrafts.get(workspaceId),revision:drafts.find(item=>item.feedbackId===activeDrafts.get(workspaceId))?.revision} : null) ?? null,
      pagePrint: prints?.status(context?.id) ?? { busy:false, kind:null },
      speech: { ...(speech?.status() ?? { available: false, reason: 'checking' }), microphoneAvailable: !!enableMicrophone },
      voice: voice?.ownerWindowId === context?.id ? { captureId: voice.captureId, workspaceId: voice.workspaceId, feedbackId: voice.feedbackId, status: voice.status } : null,
      live: liveView(context),
      development: { sessions: persistentProfiles ? 'persistent-isolated' : 'temporary', feedback: persistenceMetadata ? 'encrypted-durable' : 'session-only',
        protectedKeys: { loaded: nativeKeyStatus.loaded === true, productionQualified: false, reason: nativeKeyStatus.reason },
        productionQualified: false },
      services: { ...(workspaceId ? access?.services.humanView(workspaceId) ?? { available: false, qualification: 'protected-storage-pending', connections: [], grants: [], audit: [] } :
        { available: false, qualification: 'no-workspace', connections: [], grants: [], audit: [] }),
        owner: serviceOwnerInventory() },
      history: { available: !!history && !historyError, code: historyError },
      downloads: workspaceId ? downloads?.list(workspaceId) ?? [] : [],
      downloadHistory: workspaceId ? downloads?.historyStatus() ?? { available: false, persistent: false, errorCode: null } :
        { available: false, persistent: false, errorCode: 'WORKSPACE_UNAVAILABLE' },
      sitePermissions: { ...sitePermissions.list(workspaceId), blockedPopups: blockedPopups.filter(item => item.workspaceId === workspaceId),
        popups: workspaceId ? engine.popupState(workspaceId, context.id) : { grants: [], children: [] } },
      ...(connectionConfiguration?.snapshot() ?? { connectionConfig: null, connectionSetup: null }),
      agentTools: agentTools?.list() ?? [],
      // The first-run welcome is offered once per installation, and never in automated runs.
      welcome: { show: firstRunWelcome && !welcome.seen() } };
  }
  function serial(operation) {
    const result = tail.then(operation);
    tail = result.catch(error => { notice('Workspace update failed: ' + (error.code ?? 'SAVE_FAILED')); });
    return result;
  }
  const visibleCommands = new Set(['workspace.select', 'group.select', 'tab.select', 'tab.reopen', 'tab.create', 'tab.duplicate',
    'tab.move', 'tab.pin', 'tab.favorite', 'layout.set', 'layout.clear']);
  const transact = (command, beforeCommit, { selection = null, onPublished = null, acknowledgedClose = false, deferNative = false } = {}) => serial(async () => {
    const next = applyProductCommand(state, command);
    const metadataReservation = reserveDurableStatePublication({ previous: state, next, registry: privateScopes });
    let retainReservation = false;
    const fence = () => {
      if (!(acknowledgedClose && command.type === 'tab.close')) assertChromeActionCurrent();
      metadataReservation?.assertCurrent();
      return beforeCommit ? beforeCommit() : true;
    };
    try {
    fence();
    const commit = async fence => {
      state = (await store.transact({ expectedRevision: state.revision, command }, { beforeCommit: fence })).state;
      if (['workspace.lifecycle', 'workspace.reopen'].includes(command.type)) organizationUndo.forgetWorkspace(command.workspaceId);
      onPublished?.(); windowSessions?.changed(); return state;
    };
    if (engine && !deferNative && visibleCommands.has(command.type) && !(command.type === 'tab.create' && command.activate === false)) {
      const targets = affectedVisiblePages({ before: state, after: next, command, selection,
        contexts: [...windows.values()].filter(context => !context.privateScopeId && !context.closing && !context.window.isDestroyed()) });
      await commitVisiblePages({ reserve: engine.reservePages, targets, commit, beforeCommit: fence,
        load: (target, reservation) => ensureTab(tabFor(target.tabId), reservation) });
    } else await commit(fence);
    emit(); return state;
    } catch (error) {
      if (error?.code === 'COMMIT_OUTCOME_UNKNOWN' && metadataReservation) {
        // Retain capacity in the cached inventory when a rename happened but its
        // durability acknowledgment failed. Do not replay the user mutation.
        retainReservation = true;
        try { const observed = await store.load(); if (stateDigest(observed) === stateDigest(next)) {
          state = observed; retainReservation = false; windowSessions?.changed(); emit();
        } } catch {}
      }
      throw error;
    } finally { if (!retainReservation) metadataReservation?.release(); }
  });
  function capturePortabilityOwner(context, { workspaceIds = [] } = {}) {
    if (!context || context.privateScopeId) fail('PORTABILITY_UNAVAILABLE');
    const chrome = captureChromeIntent(context), selected = context.workspaceId, intentGeneration = context.intentGeneration;
    const scopeIds = [...new Set([selected, ...workspaceIds].filter(Boolean))];
    const scopes = scopeIds.map(workspaceId => {
      const workspace = workspaceFor(workspaceId);
      return { workspaceId, identityId: workspace.identityId, generation: workspace.lifecycle?.generation ?? 0,
        privacyEpoch: privacy.getPrivacyState(workspaceId).capturePrivacyEpoch };
    });
    const assertCurrent = () => {
      chrome.assertCurrent();
      if (closing || closed || context.closing || context.privateScopeId || windows.get(context.id) !== context || context.window.isDestroyed() ||
          context.workspaceId !== selected || context.intentGeneration !== intentGeneration || previews?.has(context) ||
          context.reviewOpen || selecting?.ownerWindowId === context.id || voice?.ownerWindowId === context.id ||
          moments?.view(context) || prints?.status(context.id).busy) fail('PORTABILITY_REVIEW_STALE');
      if (selected && (workspaceOwners.get(selected) !== context || engine.getWorkspaceOwnerWindow(selected) !== context.window)) fail('PORTABILITY_REVIEW_STALE');
      for (const binding of scopes) {
        const workspace = workspaceFor(binding.workspaceId), guard = privacy.getPrivacyState(workspace.id);
        if (workspace.identityId !== binding.identityId || (workspace.lifecycle?.generation ?? 0) !== binding.generation ||
            workspace.lifecycle?.status === 'archived' || workspaceLifecycle?.isBusy(workspace.id) ||
            guard.blocked || guard.capturePrivacyEpoch !== binding.privacyEpoch || blockingWorkspaces.has(workspace.id)) fail('PORTABILITY_REVIEW_STALE');
      }
      return true;
    };
    assertCurrent(); return { assertCurrent };
  }
  const portabilityPublication = createPortabilityPublication({ getState: () => state, setState: next => { state = next; },
    serialize: serial, store, registry: privateScopes, onPublished: () => { windowSessions?.changed(); emit(); } });
  portability = createPortabilityHost({ getState: () => state, captureOwner: capturePortabilityOwner,
    chooseImportFile: async (context, { format, assertCurrent }) => {
      assertCurrent();
      if (portabilityDialogsForTest) return portabilityDialogsForTest.chooseImportFile({ windowId: context.id, format, assertCurrent });
      const result = await dialog.showOpenDialog(context.window, { title: 'Review an organization import', buttonLabel: 'Review import',
        properties: ['openFile'], filters: [{ name: format === 'caddi' ? 'Caddi organization' : 'Browser bookmarks', extensions: format === 'caddi' ? ['json'] : ['html', 'htm'] }] });
      assertCurrent(); return result.canceled ? null : result.filePaths.length === 1 ? result.filePaths[0] : null;
    },
    chooseExportFile: async (context, { format, suggestedName, extension, assertCurrent }) => {
      assertCurrent();
      if (portabilityDialogsForTest) return portabilityDialogsForTest.chooseExportFile({ windowId: context.id, format, suggestedName, extension, assertCurrent });
      const result = await dialog.showSaveDialog(context.window, { title: 'Save reviewed organization', buttonLabel: 'Save new file', defaultPath: suggestedName,
        filters: [{ name: format === 'caddi' ? 'Caddi organization' : 'Browser bookmarks', extensions: [extension] }] });
      assertCurrent(); return result.canceled ? null : result.filePath ?? null;
    },
    captureSource: capturePortabilitySource, prepareImport: previewPortabilityImport, prepareExport: createPortabilityExport,
    inspectCapacity: portabilityPublication.capacity, publishImport: portabilityPublication.publish,
    saveExport: savePortabilityExportExclusive, onChange: emit });
  function capturePermissionOwner(context, { workspaceId, tabId }) {
    if (!context || context.privateScopeId || context.workspaceId !== workspaceId) fail('PERMISSION_REQUEST_STALE');
    const chrome = chromeActions.getStore() ?? captureChromeIntent(context), workspace = workspaceFor(workspaceId), tab = tabFor(tabId);
    const identityId = workspace.identityId, generation = workspace.lifecycle?.generation ?? 0, createdAt = tab.createdAt;
    const epoch = privacy.getPrivacyState(workspaceId).capturePrivacyEpoch, intentGeneration = context.intentGeneration;
    const assertCurrent = () => {
      chrome.assertCurrent();
      const currentWorkspace = workspaceFor(workspaceId), currentTab = state.tabs.find(item => item.id === tabId);
      if (closing || closed || context.closing || context.privateScopeId || windows.get(context.id) !== context || context.window.isDestroyed() ||
          context.workspaceId !== workspaceId || context.workspaceIdentityId !== identityId || context.intentGeneration !== intentGeneration ||
          workspaceOwners.get(workspaceId) !== context || engine.getWorkspaceOwnerWindow(workspaceId) !== context.window ||
          currentWorkspace.identityId !== identityId || (currentWorkspace.lifecycle?.generation ?? 0) !== generation ||
          currentWorkspace.lifecycle?.status === 'archived' || privacy.getPrivacyState(workspaceId).capturePrivacyEpoch !== epoch ||
          !currentTab || currentTab.workspaceId !== workspaceId || currentTab.createdAt !== createdAt || currentTab.status !== 'open') fail('MEDIA_REVIEW_STALE');
      return true;
    };
    assertCurrent(); return { assertCurrent };
  }
  async function closeMediaMetadata(context, { workspaceId, tabId, assertClosed }) {
    assertClosed(); const tab = tabFor(tabId);
    loaded.delete(tabId); metadataChanges.delete(tabId); documents.forget(tabId); historyRecorder?.forget(tabId);
    if (context.finding?.tabId === tabId) stopFinding(context);
    return commitClosedPage({ commit: () => transact({ type: 'tab.close', tabId }, assertClosed, { acknowledgedClose: true }),
      display: async () => {
        recentlyClosed.push(tabId); if (recentlyClosed.length > 128) recentlyClosed.shift();
        engine.invalidatePopups({ workspaceId, tabId }); privacy.revoke({ workspaceId, reason: 'TAB_CLOSED' });
        if (voice?.ownerWindowId === context.id) await stopVoice(); await cancelPicker(context);
        if (closing || closed || context.closing || context.window.isDestroyed()) fail('CLOSED');
        if (privacy.getPrivacyState(workspaceId).blocked) fail('PRIVACY_BLOCKED');
        if (context.workspaceId !== workspaceId || workspaceOwners.get(workspaceId) !== context) fail('WORKSPACE_CHANGED');
        const next = state.tabs.find(value => value.workspaceId === workspaceId && value.groupId === tab.groupId && value.status === 'open' && !value.dormant);
        if (next) await transact({ type: 'tab.select', tabId: next.id, now: Date.now() });
        await displayCurrent(context);
      }, onDisplayUnavailable: () => { layout(context); emit(); } });
  }
  const downloadWorkspaceIdentity = id => state.workspaces.find(workspace => workspace.id === id)?.identityId ?? null;
  downloads = await createPersistentDownloadManager({ directory: path.join(dataRoot, 'downloads'), workspaceIdentity: downloadWorkspaceIdentity,
    onChange: emit, onNotice: notice,
    revealFile: testRevealFile ?? (file => shell.showItemInFolder(file)), testSavePath: testDownloadSavePath });
  async function flushMetadata() {
    clearTimeout(metadataTimer); metadataTimer = null;
    const changes = [...metadataChanges.values()]; metadataChanges.clear();
    for (const change of changes) {
      const tab = state.tabs.find(value => value.id === change.tabId);
      if (!tab || tab.status !== 'open' || tab.dormant || privacy.getPrivacyState(tab.workspaceId).blocked) continue;
      if (!documents.canCommit(change.token)) continue;
      if (tab.url !== change.url || tab.title !== change.title) await transact({ type: 'tab.update', tabId: change.tabId, url: change.url, title: change.title }, () => documents.canCommit(change.token));
    }
  }
  async function ensureTab(tab, reservation = null) {
    systemLifecycle.capture({ purpose: 'page-hydration' }).assertCurrent();
    assertChromeActionCurrent();
    if (previews?.hasWorkspace(tab.workspaceId)) fail('PREVIEW_BUSY');
    if (tab.status !== 'open' || tab.dormant) return;
    if (workspaceFor(tab.workspaceId).lifecycle?.status === 'archived') fail('WORKSPACE_ARCHIVED');
    try { if (!engine.getView(query(tab)).webContents.isDestroyed()) { loaded.add(tab.id); return; } await engine.closeTab(query(tab)); } catch {}
    assertChromeActionCurrent();
    loaded.delete(tab.id);
    if (loaded.size >= 32) fail('PAGE_CAPACITY');
    engine.createTab({ ...query(tab), url: tab.url }, { reservation }); loaded.add(tab.id);
    bindShortcuts(engine.getView(query(tab)).webContents, () => workspaceOwners.get(tab.workspaceId));
  }
  function assertPageCapacity(tabIds, workspaceId = null) {
    const reservation = engine.reservePages([...new Set(tabIds)].map(id => {
      const tab = state.tabs.find(item => item.id === id);
      return { workspaceId: tab?.workspaceId ?? workspaceId, tabId: id };
    }));
    reservation.release();
  }
  function layout(context = primaryContext) {
    if (!engine || !context || context.window.isDestroyed() || context.layingOut) return;
    if (context.privateScopeId) { privateWindows?.layout(context); return; }
    context.layingOut = true;
    const ids = context.workspaceId ? visibleTabIds({ ...state, activeWorkspaceId: context.workspaceId }) : [];
    const group = state.groups.find(item => item.id === state.workspaces.find(workspace => workspace.id === context.workspaceId)?.activeGroupId);
    const split = state.layouts.find(item => item.id === group?.activeLayoutId);
    const blocked = systemLifecycle.status().locked || blockingWorkspaces.has(context.workspaceId) || (chromeRecovery && !chromeRecovery.ready(context));
    for (const tab of state.tabs) if (loaded.has(tab.id)) {
      try {
        if (engine.getOwnerWindow(query(tab)) !== context.window) continue;
        const index = ids.indexOf(tab.id);
        const visible = index !== -1 && !previews?.has(context) && !blocked && !context.chromeOverlay && !context.boardOpen && context.pageRect.width > 1 && context.pageRect.height > 1 && engine.navigation(query(tab)).url !== 'about:blank';
        if (visible) {
          let bounds = { ...context.pageRect };
          if (ids.length === 2) {
            const horizontal = split?.orientation !== 'vertical', dimension = horizontal ? 'width' : 'height', axis = horizontal ? 'x' : 'y';
            const first = Math.floor((bounds[dimension] - 8) * (split?.ratio ?? 0.5));
            if (index === 0) bounds[dimension] = first;
            else { bounds[axis] += first + 8; bounds[dimension] -= first + 8; }
          }
          engine.setBounds({ ...query(tab), bounds });
        }
        engine.setVisible({ ...query(tab), visible });
      } catch {}
    }
    try { previews?.present(context, { bounds: context.pageRect, visible: !blocked && !context.closing && !context.chromeOverlay &&
      !privacy.getPrivacyState(context.workspaceId).blocked && context.pageRect.width > 1 && context.pageRect.height > 1 }); } catch {}
    context.layingOut = false;
  }
  async function displayCurrent(context = primaryContext, heldReservation = null) {
    systemLifecycle.capture({ purpose: 'page-presentation' }).assertCurrent();
    if (context?.privateScopeId) return privateWindows.display(context, heldReservation);
    if (previews?.has(context)) { layout(context); emit(); return; }
    assertChromeActionCurrent();
    const targets = context.workspaceId ? visibleTabIds({ ...state, activeWorkspaceId: context.workspaceId }).map(id => query(tabFor(id))) : [];
    const reservation = heldReservation ?? engine.reservePages(targets);
    try {
      reservation.assertCurrent();
      for (const target of targets) { await ensureTab(tabFor(target.tabId), reservation); engine.markHumanTouched(target); }
      context.needsHydration = false;
      layout(context); emit();
    } finally { if (!heldReservation) reservation.release(); }
  }
  async function enterPrivateWorkspace(workspaceId, attentionTicket = null) {
    workspaceFor(workspaceId);
    const portabilityOwner = workspaceOwners.get(workspaceId); if (portabilityOwner) portability?.invalidate(portabilityOwner);
    previews?.invalidateWorkspace(workspaceId);
    admission?.cancelScope({ workspaceId, reason: 'PRIVACY_BLOCKED' });
    prints?.invalidate({ workspaceId }); sitePermissions.invalidate({ workspaceId });
    engine.invalidatePopups({ workspaceId }); documents.blockWorkspace(workspaceId);
    historyRecorder?.cancelWorkspace(workspaceId);
    const owner = workspaceOwners.get(workspaceId);
    if (owner?.finding?.workspaceId === workspaceId) stopFinding(owner);
    access.attention.invalidateWorkspace(workspaceId, attentionTicket?.attentionId);
    access.services.revokeWorkspace(workspaceId);
    access.persistence?.acquisition?.invalidateWorkspace(workspaceId);
    prepared?.invalidate({ workspaceId });
    // Privacy blocks synchronously. Binding precedes observer-stop microtasks;
    // the human's accepted request alone may survive this exact barrier epoch.
    const barrier = privacy.beginPrivacyBarrier({ workspaceId, timeoutMs: 5000 });
    if (attentionTicket) attentionTicket.bindBarrier(privacy.getPrivacyState(workspaceId).capturePrivacyEpoch);
    blockingWorkspaces.add(workspaceId); if (selecting?.workspaceId === workspaceId) selecting = null;
    if (annotating?.workspaceId === workspaceId) stopAnnotating();
    for (const [id] of metadataChanges) if (state.tabs.find(tab => tab.id === id)?.workspaceId === workspaceId) metadataChanges.delete(id);
    layout(owner); emit();
    try { await barrier; blockingWorkspaces.delete(workspaceId); layout(workspaceOwners.get(workspaceId)); emit(); }
    catch (error) { notice('Private takeover is waiting for capture to stop. This workspace stays hidden.'); emit(); throw error; }
  }
  function protectSystem({ assertCurrent, reportPendingScopes }) {
    // Close every authority boundary synchronously, before observing any native
    // promise. A retry rejoins the coordinator's original observer-stop work;
    // neither cancellation nor this timeout can release its native slots.
    access?.pauseForSystem();
    portability?.invalidateAll(); capturedPreviewMenu = null;
    engine?.cancelHumanClose();
    clearTimeout(metadataTimer); metadataTimer = null; metadataChanges.clear();
    for (const context of windows.values()) {
      context.intentGeneration++; context.chromeOverlay = false;
      shortcutRecording?.stop(context); externalLinks?.invalidateOwner(context); externalReviewBindings.delete(context);
      previews?.invalidate(context, 'SYSTEM_PAUSED'); prints?.invalidate({ ownerWindowId: context.id });
      moments?.cancel({ ownerWindowId: context.id }); prepared?.invalidate({ ownerWindowId: context.id });
      stopFinding(context);
      // Keep reviewOpen and draft buffers: native window-close review must still
      // protect unsaved owner feedback while the visible editing UI is paused.
    }
    selecting = null; stopAnnotating();
    const scopes = state.workspaces.map(workspace => ({ workspaceId: workspace.id, stop: () => enterPrivateWorkspace(workspace.id) }));
    for (const context of windows.values()) if (context.privateScopeId && !context.window.isDestroyed()) {
      let scope; try { scope = privateScopes.forContext(context); } catch { continue; }
      if (!scope || scope.inspect().status !== 'active') continue;
      if (!systemPrivateBarriers.has(context)) systemPrivateBarriers.set(context, {
        scopeId: context.privateScopeId, workspaceId: context.workspaceId, wasBlocked: privacy.getPrivacyState(context.workspaceId).blocked,
        chromeGeneration: chromeRecovery.snapshot(context).generation, privacyEpoch: null,
      });
      scopes.push({ workspaceId: context.workspaceId, stop: () => {
        const task = privateWindows.protect(context);
        systemPrivateBarriers.get(context).privacyEpoch = privacy.getPrivacyState(context.workspaceId).capturePrivacyEpoch;
        return task;
      } });
    }
    let pending = scopes.length;
    reportPendingScopes(pending);
    const work = scopes.map(scope => {
      admission?.cancelScope({ workspaceId: scope.workspaceId, reason: 'SYSTEM_PAUSED' });
      let result;
      try { result = scope.stop(); } catch (error) { result = Promise.reject(error); }
      return Promise.resolve(result).then(() => { pending--; reportPendingScopes(pending); });
    });
    for (const context of windows.values()) layout(context);
    emit();
    return Promise.allSettled(work).then(results => {
      assertCurrent();
      if (results.some(item => item.status === 'rejected')) fail('SYSTEM_STOP_PENDING');
      return { stopped: true };
    });
  }
  async function continueSystem(context, { expectedGeneration }) {
    const owner = chromeActions.getStore();
    systemLifecycle.continue({ expectedGeneration, assertOwner: owner.assertCurrent });
    // The old cleanup epoch ended above. Only fresh human presentation work may
    // now run; normal agent/privacy barriers and service revocations remain.
    const fresh = captureChromeIntent(context);
    return chromeActions.run(fresh, async () => {
      for (const [privateContext, binding] of systemPrivateBarriers) {
        const guard = privacy.getPrivacyState(binding.workspaceId);
        if (!binding.wasBlocked && windows.get(privateContext.id) === privateContext && !privateContext.closing &&
            privateContext.privateScopeId === binding.scopeId && privateContext.workspaceId === binding.workspaceId &&
            chromeRecovery.ready(privateContext) && chromeRecovery.snapshot(privateContext).generation === binding.chromeGeneration &&
            guard.blocked && guard.barrierReady && guard.capturePrivacyEpoch === binding.privacyEpoch) {
          fresh.assertCurrent(); privacy.resumePrivacy({ workspaceId: binding.workspaceId });
        }
      }
      systemPrivateBarriers.clear();
      for (const item of windows.values()) layout(item);
      if (context.needsHydration && !context.privateScopeId) {
        try { await hydrateWindow(context); }
        catch { send('notice', 'Caddi is available. Select a tab to load this workspace; agents remain paused.', context); }
      }
      emit(); return systemLifecycle.snapshot();
    });
  }
  async function acceptAttention(attentionId, context) {
    const ticket = access.attention.beginTakeover(attentionId);
    try {
      await enterPrivateWorkspace(ticket.workspaceId, ticket);
      ticket.assertReady();
      const destination = workspaceOwners.get(ticket.workspaceId) ?? context;
      if (destination.closing || windows.get(destination.id) !== destination || destination.window.isDestroyed()) fail('ATTENTION_STALE');
      if (destination.workspaceId !== ticket.workspaceId) await switchWorkspace(ticket.workspaceId, destination);
      const assertDestination = () => {
        ticket.assertReady();
        if (closing || closed || destination.closing || windows.get(destination.id) !== destination || destination.window.isDestroyed() ||
            destination.workspaceId !== ticket.workspaceId || workspaceOwners.get(ticket.workspaceId) !== destination) fail('ATTENTION_STALE');
      };
      assertDestination();
      if (ticket.tabId) {
        const tab = tabFor(ticket.tabId);
        if (tab.workspaceId !== ticket.workspaceId || tab.status !== 'open') fail('ATTENTION_STALE');
        await prepareSelectionChange(destination); assertDestination();
        await transact({ type: 'tab.select', tabId: ticket.tabId, now: Date.now() });
        await displayCurrent(destination);
      }
      assertDestination();
      const result = ticket.activate();
      destination.window.show(); destination.window.focus(); emit(); return result;
    } catch (error) { ticket.fail(); emit(); throw error; }
  }
  function beginExternalReview(context) {
    if (!externalLinks) fail('EXTERNAL_LINK_CLOSED');
    const intent = captureChromeIntent(context);
    const binding = { intent, reviewId: null, expectations: new Map([[context.workspaceId,
      context.workspaceId ? privacy.getPrivacyState(context.workspaceId).capturePrivacyEpoch : null]]) };
    binding.assertCurrent = () => {
      intent.assertCurrent();
      if (!binding.expectations.has(context.workspaceId) || (context.workspaceId &&
          (workspaceOwners.get(context.workspaceId) !== context || blockingWorkspaces.has(context.workspaceId) ||
          privacy.getPrivacyState(context.workspaceId).capturePrivacyEpoch !== binding.expectations.get(context.workspaceId)))) fail('EXTERNAL_LINK_REVIEW_STALE');
      return true;
    };
    const workspaces = state.workspaces.filter(item => item.lifecycle?.status !== 'archived' && !workspaceLifecycle.isBusy(item.id))
      .map(item => ({ id: item.id, name: item.name, identityId: item.identityId, generation: item.lifecycle?.generation ?? 0 }));
    const review = externalLinks.beginReview({ owner: context, workspaces, assertCurrent: binding.assertCurrent });
    binding.reviewId = review.reviewId; externalReviewBindings.set(context, binding); return review;
  }
  async function openExternalLink(context, args) {
    if (!externalLinks) fail('EXTERNAL_LINK_CLOSED');
    const binding = externalReviewBindings.get(context);
    if (!binding || binding.reviewId !== args.reviewId) fail('EXTERNAL_LINK_REVIEW_STALE');
    return externalLinks.open({ owner: context, ...args, navigate: async ({ url, workspace: reviewed, assertCurrent, markDispatched }) => {
      const destination = workspaceOwners.get(reviewed.id) ?? context, destinationIntent = captureChromeIntent(destination);
      const assertTarget = () => {
        assertChromeActionCurrent(); assertCurrent(); destinationIntent.assertCurrent();
        const current = workspaceFor(reviewed.id), owner = workspaceOwners.get(reviewed.id);
        if (current.identityId !== reviewed.identityId || (current.lifecycle?.generation ?? 0) !== reviewed.generation ||
            current.lifecycle?.status === 'archived') fail('EXTERNAL_LINK_WORKSPACE_STALE');
        if (workspaceLifecycle.isBusy(reviewed.id) || (owner && owner !== destination)) fail('WORKSPACE_TRANSITION');
        return current;
      };
      let reservation;
      try {
        assertTarget();
        const barrier = enterPrivateWorkspace(reviewed.id);
        // This host-owned transition alone may advance the review's privacy
        // epoch. Any unrelated selection or later transition still invalidates it.
        if (context.workspaceId === reviewed.id) binding.expectations.set(reviewed.id, privacy.getPrivacyState(reviewed.id).capturePrivacyEpoch);
        try { await barrier; } catch (error) { if (error.code === 'BARRIER_TIMEOUT') fail('CAPTURE_STOP_PENDING'); throw error; }
        assertTarget();
        if (destination === context) binding.expectations.set(reviewed.id, privacy.getPrivacyState(reviewed.id).capturePrivacyEpoch);
        await switchWorkspace(reviewed.id, destination); assertTarget();
        await prepareSelectionChange(destination); const workspace = assertTarget();
        if (blockingWorkspaces.has(workspace.id) || !privacy.getPrivacyState(workspace.id).blocked ||
            !privacy.getPrivacyState(workspace.id).barrierReady || workspaceOwners.get(workspace.id) !== destination) fail('PRIVACY_BLOCKED');
        if (state.tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
        const tabId = 'tab-' + randomUUID(), target = { workspaceId: workspace.id, tabId };
        reservation = engine.reservePages([target]);
        const group = state.groups.find(item => item.id === workspace.activeGroupId && item.workspaceId === workspace.id);
        if (!group) fail('EXTERNAL_LINK_WORKSPACE_STALE');
        if (group.activeLayoutId) await transact({ type: 'layout.clear', groupId: group.id }, () => { assertTarget(); return true; });
        let dispatched = false;
        await transact({ type: 'tab.create', id: tabId, workspaceId: workspace.id, groupId: group.id,
          url: 'about:blank', title: 'New tab', now: Date.now(), activate: true }, () => {
          assertTarget(); reservation.assertCurrent();
          if (state.tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
          if (!dispatched) { markDispatched(); dispatched = true; }
          return true;
        });
        assertTarget(); await ensureTab(tabFor(tabId), reservation); assertTarget();
        // Imported authentication/query URLs remain live page data during private
        // takeover; ordinary metadata/history must not store the explicit input.
        await engine.humanNavigate({ ...target, url }); assertTarget();
        await displayCurrent(destination, reservation); assertTarget();
        binding.expectations = new Map([[context.workspaceId, context.workspaceId ? privacy.getPrivacyState(context.workspaceId).capturePrivacyEpoch : null]]);
        if (show && destination !== context) { destination.window.show(); destination.window.focus(); }
        emit();
      } catch (error) {
        externalLinks.invalidateOwner(context); externalReviewBindings.delete(context); throw error;
      } finally { reservation?.release(); }
    } });
  }
  function offerExternalLinks() {
    if (!externalLinks?.summary().pending || closed || closing) return false;
    const context = windows.get(BrowserWindow.getFocusedWindow()?.id);
    if (!context || context.privateScopeId || !chromeRecovery.ready(context) || !context.window.isVisible() || context.chromeOverlay || context.reviewOpen) return false;
    send('command', 'external-links', context); return true;
  }
  const annotateAgents = workspaceId => (access?.connections() ?? [])
    .filter(item => item.workspaceId === workspaceId && item.workspaceActive === true && item.connected === true)
    .map(item => ({ id: item.agentSessionId, label: String(item.clientName ?? 'agent').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 48) || 'agent' }));
  const annotateQuery = item => ({ workspaceId: item.workspaceId, tabId: item.tabId });
  function annotateView(context) {
    const item = annotating?.ownerWindowId === context?.id ? annotating : null;
    const event = annotateEvent?.ownerWindowId === context?.id ? { id: annotateEvent.id, kind: annotateEvent.kind, message: annotateEvent.message } : null;
    if (!item) return { active: false, pending: false, tabId: null, count: 0, notes: [], detail: annotateDetail, agents: [], event };
    return { active: item.phase === 'active', pending: item.phase === 'pending', tabId: item.tabId, count: item.notes.length,
      notes: item.notes.map(note => ({ n: note.n, name: note.name, note: note.note.slice(0, 240), detached: note.detached })),
      detail: annotateDetail, agents: annotateAgents(item.workspaceId), event };
  }
  function annotateNotify(context, kind, message, inPage = true) {
    annotateEvent = { id: ++annotateEventId, ownerWindowId: context.id, kind, message: String(message).slice(0, 120) };
    const item = annotating;
    if (inPage && item?.ownerWindowId === context.id && item.phase === 'active')
      void engine.annotationCommand(annotateQuery(item), 'config', { flash: annotateEvent.message }).catch(() => {});
    emit();
  }
  function annotateStatus(item) {
    if (!item.lastSent || !access) return '';
    let delivery = null;
    try { delivery = access.deliveries(item.workspaceId).find(value => value.deliveryId === item.lastSent.deliveryId) ?? null; } catch { return item.statusText ?? ''; }
    return annotateBarStatus({ delivery, agent: agentFor(access.connections(), item.lastSent.agentSessionId), listening: access.live.listening(item.lastSent.agentSessionId) });
  }
  function syncAnnotateStatus() {
    const item = annotating;
    if (!item || item.phase !== 'active' || !item.lastSent) return;
    const text = annotateStatus(item);
    if (text === item.statusText) return;
    item.statusText = text;
    void engine.annotationCommand(annotateQuery(item), 'config', { status: text }).catch(() => {});
  }
  // ── Sent ──────────────────────────────────────────────────────────────
  // One list of what the owner sent from this workspace. The statuses come from delivery records and Live rows only.
  function sentView(context, drafts = null, deliveries = null, guard = null) {
    const workspaceId = context?.workspaceId ?? null;
    if (!access || !workspaceId || context.privateScopeId) return null;
    if ((guard ?? privacy.getPrivacyState(workspaceId)).blocked) return { available: false, paused: true, items: [], waiting: 0, agents: [] };
    try {
      drafts ??= access.drafts(workspaceId); deliveries ??= access.deliveries(workspaceId);
      const items = buildSentItems({ drafts, deliveries, liveSessions: access.live.history(workspaceId), connections: access.connections(),
        listening: id => access.live.listening(id), now: Date.now() });
      return { available: true, paused: false, items, waiting: items.filter(item => item.status === 'waiting').length, agents: annotateAgents(workspaceId) };
    } catch { return { available: false, paused: false, items: [], waiting: 0, agents: [] }; }
  }
  async function sentAction(context, type, args) {
    const workspaceId = context.workspaceId;
    if (!workspaceId || workspaceOwners.get(workspaceId) !== context) fail('SENT_UNAVAILABLE');
    if (blockingWorkspaces.has(workspaceId) || privacy.getPrivacyState(workspaceId).blocked) fail('PRIVACY_BLOCKED');
    const item = sentView(context)?.items.find(value => value.kind === args.kind && value.id === args.id);
    if (!item) fail('SENT_NOT_FOUND');
    if (type === 'sent.copy') {
      const draft = item.kind === 'note' ? access.drafts(workspaceId).find(value => value.feedbackId === item.id) : null;
      if (!item.canCopy || !draft?.text.trim()) fail('SENT_UNAVAILABLE');
      clipboard.writeText(draft.text); testClipboardWrite?.(draft.text);
      return { copied: true };
    }
    if (type === 'sent.open') {
      if (!item.canOpen) fail('SENT_UNAVAILABLE');
      const tab = state.tabs.find(value => value.id === item.page.tabId && value.workspaceId === workspaceId && value.status === 'open');
      let current = '';
      try { if (tab && loaded.has(tab.id)) current = pageAddress(engine.navigation(query(tab)).url); } catch {}
      if (tab && (!item.page.url || current === item.page.url || !loaded.has(tab.id))) return perform({ type: 'tab.select', tabId: tab.id }, context);
      if (!item.page.url) fail('SENT_UNAVAILABLE');
      return perform({ type: 'tab.create', workspaceId, input: item.page.url, activate: true }, context);
    }
    if (type === 'sent.delete') {
      if (item.kind !== 'note' || !item.canDelete) fail('SENT_ITEM_RECEIVED');
      access.removeDraft({ workspaceId, feedbackId: item.id });
      if (activeDrafts.get(workspaceId) === item.id) { prepared?.invalidate({ ownerWindowId: context.id }); activeDrafts.delete(workspaceId); }
      emit(); return true;
    }
    // Send again: a new delivery to an agent connected to this workspace right now.
    if (item.kind !== 'note' || !item.canSend) fail('SENT_UNAVAILABLE');
    const recipient = annotateAgents(workspaceId).find(agent => agent.id === args.agentSessionId);
    if (!recipient) fail('RECIPIENT_UNAVAILABLE');
    const delivery = access.resendFeedback({ workspaceId, feedbackId: item.id, agentSessionId: recipient.id, confirmStale: args.confirmStale });
    emit(); return { deliveryId: delivery.deliveryId, agentSessionId: recipient.id, revision: delivery.revision };
  }
  function syncAnnotateAgents() {
    const item = annotating;
    if (!item || item.phase !== 'active') { annotateAgentsKey = ''; return; }
    const agents = annotateAgents(item.workspaceId), key = item.sessionId + JSON.stringify(agents);
    if (key === annotateAgentsKey) return;
    annotateAgentsKey = key;
    void engine.annotationCommand(annotateQuery(item), 'config', { agents }).catch(() => {});
  }
  /** `keep` is for a close the owner did not ask for: the notes wait for Annotate to be reopened on the same document. */
  function stopAnnotating(context = null, { keep = false } = {}) {
    const item = annotating;
    if (!item || (context && item.ownerWindowId !== context.id)) return false;
    annotating = null;
    if (keep && item.raw.length) annotateKept.set(item.tabId, { raw: item.raw }); else annotateKept.delete(item.tabId);
    try { engine?.endAnnotation(annotateQuery(item)); } catch {}
    emit(); return true;
  }
  const annotateKeptText = item => !item.raw.length ? '' : (item.raw.length === 1 ? ' Your note was kept.' : ' Your ' + item.raw.length + ' notes were kept.') +
    ' Reopen Annotate on this page to continue.';
  function annotateSession(context) {
    const item = annotating;
    if (!item || item.ownerWindowId !== context.id || item.phase !== 'active' || windows.get(context.id) !== context || context.closing ||
        workspaceOwners.get(item.workspaceId) !== context) fail('ANNOTATE_INACTIVE');
    if (blockingWorkspaces.has(item.workspaceId) || privacy.getPrivacyState(item.workspaceId).blocked) fail('PRIVACY_BLOCKED');
    return item;
  }
  function annotatePage(item) {
    const navigation = engine.navigation(annotateQuery(item));
    // An address can carry session tokens. Only origin and path leave the browser,
    // whether the notes go to the clipboard or to an agent.
    return { title: cleanPageTitle(navigation.title), url: pageAddress(navigation.url), viewport: item.raw[0]?.viewport ?? null };
  }
  function annotateCopy(context) {
    const item = annotateSession(context);
    if (!item.notes.length) fail('ANNOTATE_EMPTY');
    const text = formatNotes(annotatePage(item), item.raw, annotateDetail, { maxLength: 60000 });
    clipboard.writeText(text);
    testClipboardWrite?.(text); // Smoke-only observer; the system clipboard is unreadable on a locked display.
    annotateNotify(context, 'copied', 'Copied ' + countLabel(item.notes.length));
    return { copied: item.notes.length, detail: annotateDetail };
  }
  /**
   * Copy page as Markdown: the owner's own read of a tab's main content, by the same page-layer extractor agents
   * use, so form values, sensitive fields and hidden text never come along. Allowed in personal workspaces; like
   * printing and Annotate, not in a private window and not while agents and page capture are paused.
   */
  async function copyPageMarkdown(context, tabId) {
    if (context.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
    const tab = tabFor(tabId);
    if (tab.workspaceId !== context.workspaceId || workspaceOwners.get(tab.workspaceId) !== context || tab.status !== 'open' || !loaded.has(tab.id)) fail('PAGE_NOT_READY');
    if (blockingWorkspaces.has(tab.workspaceId) || privacy.getPrivacyState(tab.workspaceId).blocked) fail('PAGE_COPY_PROTECTED');
    if (engine.navigation(query(tab)).url === 'about:blank') fail('PAGE_NOT_READY');
    const value = await engine.ownerReadPage(query(tab));
    if (context.closing || context.workspaceId !== tab.workspaceId) fail('PAGE_CONTEXT_CHANGED');
    clipboard.writeText(value.markdown);
    testClipboardWrite?.(value.markdown); // Smoke-only observer; the system clipboard is unreadable on a locked display.
    return { copied: true, characters: value.markdown.length, truncated: value.truncated };
  }
  /** Notes become one ordinary feedback draft and go out through the existing reviewed-delivery path. */
  async function annotateSend(context, agentSessionId) {
    const item = annotateSession(context);
    if (!item.notes.length) fail('ANNOTATE_EMPTY');
    const recipients = annotateAgents(item.workspaceId);
    const recipient = agentSessionId === null ? (recipients.length === 1 ? recipients[0] : null) : recipients.find(agent => agent.id === agentSessionId);
    if (!recipient) fail('RECIPIENT_UNAVAILABLE');
    if (item.sending) fail('ANNOTATE_SENDING');
    const query = annotateQuery(item), still = () => { if (annotating !== item) fail('ANNOTATE_INACTIVE'); annotateSession(context); return true; };
    const config = payload => annotating === item ? engine.annotationCommand(query, 'config', payload).catch(() => {}) : Promise.resolve();
    item.sending = true; void config({ sending: true });
    try { return await annotateDeliver(context, item, recipient, query, still, config); }
    finally { item.sending = false; void config({ sending: false }); }
  }
  async function annotateDeliver(context, item, recipient, query, still, config) {
    const artifacts = [], crops = {};
    let screenshotId = null;
    try {
      // Best effort. The text is complete on its own. An image leaves only when
      // the note layer confirms, before and after the screenshot, that every
      // sensitive element in the viewport was covered by an opaque box. Images are
      // also refused by the engine whenever capture is not allowed or the page is too large.
      const geometry = await engine.annotationCommand(query, 'capture', { on: true });
      let bytes = null, released = false;
      try {
        if (geometry?.masked === true && typeof geometry.token === 'string') {
          await new Promise(resolve => setTimeout(resolve, 120)); still();
          bytes = await engine.capturePageScreenshot(query, engine.getPageInfo(query).target);
          still();
          released = true;
          const after = await engine.annotationCommand(query, 'capture', { on: false, token: geometry.token });
          if (after?.intact !== true) { bytes.fill?.(0); bytes = null; }
        }
      } finally { if (!released) await engine.annotationCommand(query, 'capture', { on: false }).catch(() => {}); }
      if (bytes) {
        screenshotId = randomUUID(); artifacts.push({ artifactId: screenshotId, kind: 'screenshot', mediaType: 'image/png', data: bytes });
        const image = nativeImage.createFromBuffer(Buffer.from(bytes)), size = image.getSize();
        const scale = geometry?.viewport?.width > 0 ? size.width / geometry.viewport.width : 0;
        let budget = 2 * 1024 * 1024;
        for (const note of item.notes) {
          const box = geometry?.rects?.[note.id];
          if (artifacts.length >= 7 || !scale || !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
          const left = Math.max(0, Math.floor((box.x - 16) * scale)), top = Math.max(0, Math.floor((box.y - 16) * scale));
          const right = Math.min(size.width, Math.ceil((box.x + box.width + 16) * scale)), bottom = Math.min(size.height, Math.ceil((box.y + box.height + 16) * scale));
          if (right - left < 24 || bottom - top < 24 || (right - left >= size.width && bottom - top >= size.height)) continue;
          const crop = image.crop({ x: left, y: top, width: right - left, height: bottom - top }).toPNG();
          if (!crop.length || crop.length > 512 * 1024 || crop.length > budget) continue;
          budget -= crop.length;
          const artifactId = randomUUID(); crops[note.id] = artifactId;
          artifacts.push({ artifactId, kind: 'screenshot', mediaType: 'image/png', data: crop });
        }
      }
    } catch (error) {
      if (['ANNOTATE_INACTIVE', 'PRIVACY_BLOCKED'].includes(error?.code)) throw error;
      for (const artifact of artifacts.splice(0)) artifact.data.fill?.(0);
      for (const key of Object.keys(crops)) delete crops[key];
      screenshotId = null;
    }
    still();
    const page = annotatePage(item), sent = item.notes.map(note => note.id);
    const text = formatNotes({ ...page, screenshot: !!screenshotId, screenshotId }, item.raw, annotateDetail, { crops, maxLength: 15000 });
    const info = engine.getPageInfo(query), workspace = workspaceFor(item.workspaceId);
    const draft = await access.createDraft({ target: { ...info.target, origin: info.origin },
      selection: { kind: 'page', label: page.title || 'Page notes' }, text, projectId: workspace.projectId, artifacts, assertCurrent: still,
      meta: { source: 'annotate', notes: sent.length, page: { title: page.title.slice(0, 200), url: page.url.slice(0, 500) } } });
    let delivery;
    try { delivery = access.sendFeedback({ workspaceId: item.workspaceId, feedbackId: draft.feedbackId, revision: draft.revision, agentSessionId: recipient.id }); }
    catch (error) {
      // Nothing was delivered. The draft stays in Sent, where it can be reviewed and sent.
      activeDrafts.set(item.workspaceId, draft.feedbackId); emit(); throw error;
    }
    // Delivered. The sent notes leave the page so a second press cannot deliver them again.
    annotateNotify(context, 'sent', 'Sent to ' + recipient.label, false);
    if (annotating === item) { item.notes = item.notes.filter(note => !sent.includes(note.id)); item.raw = item.raw.filter(note => !sent.includes(note?.id)); }
    // After the flash, the bar keeps saying where these notes are: waiting, then Received once the agent fetched them.
    item.lastSent = { deliveryId: delivery.deliveryId, agentSessionId: recipient.id }; item.statusText = annotateStatus(item);
    await config({ sent, sending: false, flash: 'Sent to ' + recipient.label, status: item.statusText });
    emit();
    return { deliveryId: delivery.deliveryId, feedbackId: draft.feedbackId, revision: draft.revision, agentSessionId: recipient.id,
      notes: sent.length, attachments: artifacts.length };
  }
  const annotateMessages = { ANNOTATE_EMPTY: 'Add a note first', RECIPIENT_UNAVAILABLE: 'That agent is no longer connected', ANNOTATE_SENDING: 'Already sending',
    PRIVACY_BLOCKED: 'Paused by private takeover', FEEDBACK_CAPACITY: 'Too many notes saved. Delete old ones in Sent first.' };
  // ── Live mode ────────────────────────────────────────────────────────────
  // The session, its pointer trail and the agent queue live in access.live.
  // This part owns the page layer, the microphone and the stop conditions.
  const liveEndMessages = { paused: 'Live stopped because agents were paused.', revoked: 'Live stopped because the agent’s access was revoked.',
    disconnected: 'Live stopped because the agent disconnected.', expired: 'Live stopped because the agent’s session ended.',
    navigated: 'Live stopped because the page left the sites this agent can use.', workspace: 'Live stopped because you switched workspace.',
    tab: 'Live stopped because you switched tabs.', 'system-paused': 'Live stopped because Caddi paused.' };
  const liveVoiceStatus = () => !enableMicrophone && !testLiveAudio ? { available: false, reason: 'MICROPHONE_DISABLED' } :
    speech?.status().available ? { available: true, reason: null } : { available: false, reason: speech?.status().reason ?? 'LOCAL_SPEECH_UNAVAILABLE' };
  const liveOrigins = agentSessionId => (access?.connections() ?? []).find(item => item.agentSessionId === agentSessionId && item.workspaceActive)?.origins ?? [];
  const liveOriginGranted = current => liveOrigins(current.agentSessionId).includes(engine.getPageInfo({ workspaceId: current.workspaceId, tabId: current.tabId }).origin);
  function livePage(current) {
    const navigation = engine.navigation({ workspaceId: current.workspaceId, tabId: current.tabId });
    // As for notes: only origin and path of the address leave the browser.
    return { title: cleanPageTitle(navigation.title), url: pageAddress(navigation.url) };
  }
  /** Saved logins for the shell: metadata only, never a password. Nothing at all in a private window. */
  function loginsView(context) {
    if (!logins) return { available: false, keychain: 'unavailable', reason: loginsError ?? 'KEYCHAIN_UNAVAILABLE', logins: [], site: null };
    const workspaceId = context?.workspaceId ?? null, workspace = workspaceId ? state.workspaces.find(item => item.id === workspaceId) : null;
    const view = logins.view(workspaceId);
    let site = null;
    const group = workspace ? state.groups.find(item => item.id === workspace.activeGroupId) : null;
    const tab = group ? state.tabs.find(item => item.id === group.activeTabId && item.workspaceId === workspaceId && item.status === 'open') : null;
    if (tab && loaded.has(tab.id)) {
      try {
        const origin = engine.getPageInfo(query(tab)).origin;
        if (origin) site = { tabId: tab.id, origin, usable: usableLoginOrigin(origin), matches: logins.matching(workspaceId, origin) };
      } catch {}
    }
    if (workspace && view.logins?.length) {
      const connections = access?.connections() ?? [], paused = privacy.getPrivacyState(workspaceId).blocked;
      const recent = vaultActivity ? vaultActivity.recentByLogin(workspaceId) : new Map();
      view.logins = view.logins.map(login => ({ ...login, recent: recent.get(login.loginId) ?? [],
        access: agentAccessForLogin(login, { workspace, connections, paused,
          signInStatus: (agentSessionId, loginId) => access?.attention.signInStatus?.(agentSessionId, loginId) ?? null }) }));
    }
    return { ...view, site };
  }
  /** The other workspaces a login saved from an offer may also go to: every one that can hold logins. */
  const offerOtherWorkspaces = workspaceId => state.workspaces.filter(item => item.id !== workspaceId && ['project', 'personal'].includes(item.kind) && !!loginWorkspace(item.id));
  /** The Vault around the logins: this window's save offer, the never-save list, whether the log is readable, an import under review. */
  function vaultView(context) {
    if (!context || context.privateScopeId || !logins) return { offer: null, never: [], activityDamaged: false, imports: false };
    const workspaceId = context.workspaceId;
    // An offer follows its tab across page loads, and ends with the tab or the workspace.
    vaultOffers.sweep(item => !!loginWorkspace(item.workspaceId) && state.tabs.some(tab => tab.id === item.tabId && tab.workspaceId === item.workspaceId));
    const held = vaultOffers.view(workspaceId);
    const offer = held ? { ...held, workspaceName: state.workspaces.find(value => value.id === workspaceId)?.name ?? '', otherWorkspaces: offerOtherWorkspaces(workspaceId).length } : null;
    return { offer, never: workspaceId && neverSave ? neverSave.list(workspaceId) : [], activityDamaged: !!(workspaceId && vaultActivity?.damaged(workspaceId)), imports: true };
  }
  /** One line in the Vault's access log. Never throws into the flow it describes. */
  function logLoginUse({ workspaceId, login, actor, action, code }) {
    if (!vaultActivity || !login) return;
    const { outcome, reason } = activityOutcome(action, code ?? null);
    vaultActivity.record({ workspaceId, loginId: login.loginId, origin: login.origin, label: login.label, username: login.username, actor, action, outcome, reason });
  }
  async function ownerLoginUse(action, loginId, workspaceId, work) {
    const login = logins.describe(loginId, workspaceId);
    try { const result = await work(); logLoginUse({ workspaceId, login, actor: { kind: 'owner' }, action, code: null }); return result; }
    catch (error) { logLoginUse({ workspaceId, login, actor: { kind: 'owner' }, action, code: error?.code ?? 'FAILED' }); throw error; }
  }
  /**
   * The page layer reports that the owner submitted a sign-in form. Every fact that decides the offer is checked
   * here, by the main process: a private window never gets one; an agent holding control, acting on the page, or
   * active in the workspace in the last few seconds stops it; the owner's own input must have just happened.
   */
  async function handleLoginOffer({ workspaceId, tabId, pageOrigin, report, humanActivationAt, lastAgentActivityAt, agentRequestActive }) {
    // The typed password is in `report.password` (a Buffer). It is either handed to the holder or wiped before this returns.
    let kept = false;
    try {
      if (!logins || closed) return;
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      const owner = workspaceOwners.get(workspaceId);
      const privateWindow = !owner || !!owner.privateScopeId || !!privateWindows?.ownsWorkspace(workspaceId);
      const matches = workspace ? logins.matching(workspaceId, report.origin) : [];
      const saved = matches.find(item => item.username === report.username);
      let same = null;
      if (saved) { try { same = await logins.withSecret(saved.loginId, workspaceId, async secret => samePassword(report.password, secret.password)); } catch { same = null; } }
      const now = Date.now();
      const decision = offerDecision({ privateWindow, workspace, storeAvailable: logins.status().available, leaseActive: privacy.hasActiveLease(workspaceId),
        agentRequestActive, lastAgentActivityAt: Math.max(lastAgentActivityAt ?? 0, agentActivityAt.get(workspaceId) ?? 0), humanActivationAt, now,
        pageOrigin, origin: report.origin, username: report.username, neverSites: neverSave?.list(workspaceId) ?? [], matches, capacityLeft: logins.capacityLeft(), samePassword: same });
      if (!decision.offer || closed) return;
      kept = true; // hold() owns the Buffer from here, and wipes it itself if it cannot keep the offer.
      if (vaultOffers.hold({ offerId: report.offerId, workspaceId, tabId, origin: report.origin, username: report.username, kind: decision.offer, loginId: decision.loginId, password: report.password })) emit();
    } finally { if (!kept) report.password.fill(0); }
  }
  /** Owner actions on the Vault around the logins themselves. */
  async function vaultAction(type, args, context) {
    if (!logins) fail(loginsError ?? 'LOGINS_UNAVAILABLE');
    if (context.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
    const intent = chromeActions.getStore() ?? captureChromeIntent(context);
    const done = value => { emit(); return value; };
    switch (type) {
      case 'vault.offer.save': {
        const scope = args.scope ?? 'workspace';
        if (!['workspace', 'all'].includes(scope)) fail('INVALID_ARGUMENT');
        // While an agent holds control the offer stays, unanswered, for the owner to come back to.
        if (privacy.hasActiveLease(context.workspaceId)) fail('LEASE_BUSY');
        intent.assertCurrent();
        const offer = vaultOffers.take(args.offerId, context.workspaceId);
        let result, alsoIn = 0;
        try {
          const password = offer.password.toString('utf8');
          result = offer.kind === 'update' && logins.describe(offer.loginId, offer.workspaceId)
            ? logins.edit({ loginId: offer.loginId, workspaceId: offer.workspaceId, password })
            : logins.add({ workspaceId: offer.workspaceId, origin: offer.origin, username: offer.username, password });
        } finally { offer.password.fill(0); }
        // "All workspaces": the same login, shared with every other workspace that can hold logins today. One that
        // already has its own login for this site and username keeps it.
        if (scope === 'all' && offer.kind === 'save') for (const other of offerOtherWorkspaces(offer.workspaceId)) {
          try { logins.share({ loginId: result.loginId, workspaceId: offer.workspaceId, toWorkspaceId: other.id }); alsoIn += 1; } catch {}
        }
        return done({ ...result, kind: offer.kind, alsoIn });
      }
      case 'vault.offer.never': {
        const offer = vaultOffers.drop(args.offerId, context.workspaceId);
        if (!neverSave) fail('NEVER_LIST_DAMAGED');
        return done(neverSave.add(offer.workspaceId, offer.origin));
      }
      case 'vault.offer.dismiss': vaultOffers.drop(args.offerId, context.workspaceId); return done({ dismissed: true });
      case 'vault.never.remove': if (!neverSave) fail('NEVER_LIST_DAMAGED'); return done(neverSave.remove(args.workspaceId, args.origin));
      case 'vault.activity.list': {
        if (!vaultActivity) fail('ACTIVITY_UNAVAILABLE');
        return vaultActivity.list(args.workspaceId, { loginId: args.loginId ?? null, limit: 1000 });
      }
      case 'vault.activity.clear': if (!vaultActivity) fail('ACTIVITY_UNAVAILABLE'); return done(vaultActivity.clear(args.workspaceId));
      case 'vault.import.choose': {
        // Read once, here, through the native open dialog. Nothing is copied; the file is closed before parsing.
        for (const [id, item] of vaultImports) if (item.windowId === context.id || item.expiresAt <= Date.now()) { wipeCandidates(item.candidates); vaultImports.delete(id); }
        const file = portabilityDialogsForTest ? await portabilityDialogsForTest.chooseImportFile({ windowId: context.id, format: 'vault-csv', assertCurrent: intent.assertCurrent })
          : await dialog.showOpenDialog(context.window, { title: 'Import logins', buttonLabel: 'Review import', properties: ['openFile'],
            filters: [{ name: 'Password export (CSV)', extensions: ['csv'] }] }).then(result => result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]);
        intent.assertCurrent();
        if (!file) return { cancelled: true };
        const { format, candidates } = prepareImport(readImportFile(file));
        const importId = 'import-' + randomUUID();
        vaultImports.set(importId, { importId, windowId: context.id, candidates, format, fileName: path.basename(file).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 120),
          expiresAt: Date.now() + 15 * 60_000 });
        return importReview(importId, context.workspaceId, context);
      }
      case 'vault.import.review': return importReview(args.importId, args.toWorkspaceId, context);
      case 'vault.import.cancel': {
        const item = vaultImports.get(args.importId);
        if (item && item.windowId === context.id) { wipeCandidates(item.candidates); vaultImports.delete(args.importId); }
        return { cancelled: true };
      }
      case 'vault.import.confirm': {
        const item = vaultImports.get(args.importId);
        if (!item || item.windowId !== context.id || item.expiresAt <= Date.now()) fail('IMPORT_EXPIRED');
        vaultImports.delete(args.importId);
        try {
          if (!loginWorkspace(args.toWorkspaceId)) fail('WORKSPACE_UNAVAILABLE');
          const review = reviewImport(item.candidates, { existing: logins.existing(args.toWorkspaceId), capacity: logins.capacityLeft() });
          let imported = 0, failed = 0;
          for (const row of review.rows) {
            if (row.status !== 'ready') continue;
            const candidate = item.candidates.find(value => value.rowId === row.rowId);
            intent.assertCurrent();
            try {
              // New logins start with "Agents may use this login" off, as every new login does.
              logins.add({ workspaceId: args.toWorkspaceId, origin: candidate.origin, username: candidate.username,
                ...(candidate.title ? { label: candidate.title.slice(0, 120) } : {}), password: candidate.password.toString('utf8') });
              imported++;
            } catch (error) { if (['KEYCHAIN_LOCKED', 'KEYCHAIN_UNAVAILABLE'].includes(error.code)) throw error; failed++; }
          }
          return done({ imported, skipped: review.skipped, failed, fileName: item.fileName });
        } finally { wipeCandidates(item.candidates); }
      }
    }
    fail('UNKNOWN_ACTION');
  }
  function importReview(importId, toWorkspaceId, context) {
    const item = vaultImports.get(importId);
    if (!item || item.windowId !== context.id || item.expiresAt <= Date.now()) fail('IMPORT_EXPIRED');
    if (!loginWorkspace(toWorkspaceId)) fail('WORKSPACE_UNAVAILABLE');
    const review = reviewImport(item.candidates, { existing: logins.existing(toWorkspaceId), capacity: logins.capacityLeft() });
    return { importId, toWorkspaceId, format: { id: item.format.id, label: item.format.label, verified: item.format.verified }, fileName: item.fileName,
      ...review, reasons: IMPORT_SKIP_REASONS };
  }
  /** Owner actions on saved logins. The password reaches this process only from the owner's own form, or from the keychain. */
  async function loginAction(type, args, context) {
    if (!logins) fail(loginsError ?? 'LOGINS_UNAVAILABLE');
    if (context.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
    const intent = chromeActions.getStore() ?? captureChromeIntent(context);
    const done = value => { emit(); return value; };
    switch (type) {
      case 'logins.refresh': return done(logins.refresh());
      case 'logins.add': return done(logins.add(args));
      case 'logins.edit': return done(logins.edit(args));
      case 'logins.delete': return done(logins.remove(args));
      case 'logins.share': return done(logins.share(args));
      case 'logins.unshare': return done(logins.unshare(args));
      case 'logins.agent-use': return done(logins.setAgentUse(args));
      case 'logins.copy': case 'logins.show': {
        // A fresh check that the owner is at the Mac, by macOS itself, every time.
        return ownerLoginUse(type === 'logins.copy' ? 'copy' : 'reveal', args.loginId, args.workspaceId, async () => {
        if (!await logins.confirmPresence(type === 'logins.copy' ? 'copy a saved password' : 'show a saved password')) fail('PRESENCE_NOT_CONFIRMED');
        intent.assertCurrent();
        return logins.withSecret(args.loginId, args.workspaceId, async secret => {
          const text = secret.password.toString('utf8');
          if (type === 'logins.copy') {
            clipboard.writeText(text);
            // Cleared after a minute, unless something else was copied since. Only a digest is kept to compare.
            const digest = createHash('sha256').update(text).digest('hex');
            clearTimeout(loginClipboardTimer);
            loginClipboardTimer = setTimeout(() => { try { if (createHash('sha256').update(clipboard.readText()).digest('hex') === digest) clipboard.clear(); } catch {} }, 60_000);
            loginClipboardTimer.unref?.();
            return { copied: true, clearsAfterMs: 60_000 };
          }
          // Shown by the main process in a native sheet, never handed to the shell's web page.
          await dialog.showMessageBox(context.window, { type: 'info', title: 'Saved password', message: secret.username ? 'Password for ' + secret.username : 'Saved password',
            detail: text, buttons: ['Done'], defaultId: 0, cancelId: 0, noLink: true });
          return { shown: true };
        });
        });
      }
      case 'logins.fill': {
        const tab = tabFor(args.tabId);
        if (tab.status !== 'open' || !loaded.has(tab.id)) fail('TAB_NOT_FOUND');
        const origin = engine.getPageInfo(query(tab)).origin;
        if (!logins.matching(tab.workspaceId, origin).some(item => item.loginId === args.loginId)) fail('LOGIN_SITE_MISMATCH');
        // The owner signing in takes the page back from any agent first.
        if (privacy.hasActiveLease(tab.workspaceId)) privacy.revoke({ workspaceId: tab.workspaceId, reason: 'HUMAN_TAKEOVER' });
        const result = await ownerLoginUse('fill', args.loginId, tab.workspaceId, () => logins.withSecret(args.loginId, tab.workspaceId, secret => engine.ownerFillLogin(query(tab),
          { origin: secret.origin, username: secret.username, password: secret.password.toString('utf8') },
          { beforeDispatch: () => { intent.assertCurrent(); if (privacy.hasActiveLease(tab.workspaceId)) fail('LEASE_BUSY'); return true; } })));
        logins.touch(args.loginId);
        return done(result);
      }
    }
    fail('UNKNOWN_ACTION');
  }
  /** This window's board: its workspace's cards, and whether the board is what the window shows. */
  function boardView(context) {
    if (!board || !context || context.privateScopeId || !context.workspaceId) return null;
    try { return { open: !!context.boardOpen, ...board.view(context.workspaceId) }; } catch { return null; }
  }
  /** The tab this window shows in its workspace (the board covers it while open). */
  function shownTab(context) {
    const workspace = workspaceFor(context.workspaceId), group = state.groups.find(item => item.id === workspace?.activeGroupId);
    return state.tabs.find(item => item.id === group?.activeTabId && item.workspaceId === context.workspaceId && item.status === 'open') ?? null;
  }
  const BOARD_ACTIONS = new Set(['board.open', 'board.close', 'board.add-note', 'board.add-link', 'board.pin-page', 'board.snap-page', 'board.update', 'board.remove', 'board.image', 'board.pointer']);
  // A board card's key in the Live trail: "pb" and the start of its id, so an agent's reply can be traced back to the card.
  const boardKey = itemId => 'pb' + String(itemId).replace(/^board-/, '').replace(/-/g, '').slice(0, 12);
  /** What Live tells the agent about a board card it was pointed at: a plain name from the card's own words. */
  function boardTarget(item) {
    const words = (item.kind === 'note' ? item.text : item.kind === 'link' ? item.title || item.url : item.caption || (item.url ? 'picture of ' + item.url : 'image')) ?? '';
    const label = 'Board ' + (item.kind === 'image' ? 'image' : item.kind) + ': ' + String(words).replace(/\s+/g, ' ').trim().slice(0, 60);
    return { tag: item.kind === 'image' ? 'img' : item.kind === 'link' ? 'a' : 'article', role: item.kind === 'image' ? 'img' : '', ariaLabel: label };
  }
  function setBoardOpen(context, open) {
    if (!!context.boardOpen === open) return;
    context.boardOpen = open; layout(context); emit();
  }
  async function boardAction(type, args, context) {
    if (!board) fail('BOARD_UNAVAILABLE');
    if (context.privateScopeId || !context.workspaceId) fail('BOARD_UNAVAILABLE');
    const workspaceId = context.workspaceId, owner = { kind: 'owner' };
    switch (type) {
      case 'board.open': board.view(workspaceId); setBoardOpen(context, true); return true;
      case 'board.close': setBoardOpen(context, false); return true;
      case 'board.add-note': return board.addNote(workspaceId, { text: args.text ?? '', color: args.color, x: args.x, y: args.y, by: owner });
      case 'board.add-link': return board.addLink(workspaceId, { url: args.url, title: args.title ?? '', x: args.x, y: args.y, by: owner });
      case 'board.pin-page': {
        const tab = shownTab(context), page = tab && loaded.has(tab.id) ? engine.navigation(query(tab)) : null;
        const url = page?.url ?? tab?.url;
        if (!url || !/^https?:/.test(url)) fail('BOARD_NO_PAGE');
        return board.addLink(workspaceId, { url, title: tab.title ?? '', by: owner });
      }
      case 'board.snap-page': {
        // The page under the board is hidden, so the picture is taken with the board briefly out of the way.
        const tab = shownTab(context);
        if (!tab || !loaded.has(tab.id) || !/^https?:/.test(engine.navigation(query(tab)).url ?? '')) fail('BOARD_NO_PAGE');
        const wasOpen = !!context.boardOpen;
        if (wasOpen) { context.boardOpen = false; layout(context); await new Promise(resolve => setTimeout(resolve, 120)); }
        let bytes;
        try { bytes = await engine.capturePageScreenshot(query(tab), engine.getTarget(query(tab))); }
        finally { if (wasOpen) { context.boardOpen = true; layout(context); } }
        try {
          const size = nativeImage.createFromBuffer(bytes).getSize();
          return board.addImage(workspaceId, { bytes: Buffer.from(bytes), width: size.width, height: size.height, caption: tab.title ?? '',
            url: engine.navigation(query(tab)).url, by: owner });
        } finally { bytes.fill(0); }
      }
      case 'board.update': return board.update(workspaceId, assertId(args.itemId), args.patch ?? {});
      case 'board.remove': return board.remove(workspaceId, assertId(args.itemId));
      case 'board.pointer': {
        // While Live is on and the board is open, pointing at a card goes into the same trail as pointing at a page.
        const current = access?.live.current();
        if (!current || current.ownerWindowId !== context.id || !context.boardOpen) return false;
        const item = board.view(workspaceId).items.find(value => value.id === assertId(args.itemId));
        if (!item) return false;
        const point = args.point && Number.isFinite(args.point.x) && Number.isFinite(args.point.y) && item.kind === 'image' ?
          { x: Math.max(0, Math.min(1, args.point.x)), y: Math.max(0, Math.min(1, args.point.y)) } : undefined;
        return access.live.pointer(current.sessionId, { kind: args.kind === 'click' ? 'click' : 'hover', key: boardKey(item.id), ageMs: 0,
          target: boardTarget(item), path: [], ...(point ? { point } : {}) });
      }
      case 'board.image': {
        // A display copy for the chrome: never larger than the board needs.
        const image = board.image(workspaceId, assertId(args.itemId));
        let picture = nativeImage.createFromBuffer(image.bytes);
        const { width, height } = picture.getSize();
        if (!width || !height) fail('BOARD_FILE_DAMAGED');
        if (width > 1600) picture = picture.resize({ width: 1600, quality: 'good' });
        return { src: 'data:image/jpeg;base64,' + picture.toJPEG(85).toString('base64'), width, height };
      }
    }
    fail('UNKNOWN_ACTION');
  }
  /** A pasted or dropped image from the owner: its own channel, as actions are capped well below an image's size. */
  async function receiveBoardImage(event, raw) {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    try {
      if (!board || context.privateScopeId || !context.workspaceId) fail('BOARD_UNAVAILABLE');
      if (!raw || typeof raw !== 'object' || !(raw.bytes instanceof Uint8Array) || raw.bytes.length > BOARD_LIMITS.imageBytes) fail('BOARD_IMAGE_TOO_LARGE');
      const bytes = Buffer.from(raw.bytes), size = nativeImage.createFromBuffer(bytes).getSize();
      if (!size.width || !size.height) fail('BOARD_INVALID');
      const caption = typeof raw.caption === 'string' ? raw.caption.slice(0, BOARD_LIMITS.caption) : '';
      const at = value => Number.isFinite(value) ? value : undefined;
      const item = board.addImage(context.workspaceId, { bytes, width: size.width, height: size.height, caption, x: at(raw.x), y: at(raw.y), by: { kind: 'owner' } });
      return { ok: true, result: item };
    } catch (error) { return { ok: false, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'BOARD_INVALID' }; }
  }
  function liveView(context) {
    if (!context || context.privateScopeId || !access) return null;
    const view = access.live.view(context.id), voiceStatus = liveVoiceStatus();
    return { ...view, agents: context.workspaceId ? annotateAgents(context.workspaceId) : [],
      voiceAvailable: voiceStatus.available, voiceReason: voiceStatus.reason,
      voiceListening: view.active && liveVoice?.sessionId === view.sessionId && !liveVoice.controller.signal.aborted,
      finishing: view.active && liveVoice?.sessionId === view.sessionId && !!liveVoice.finishing,
      // After Live ends: how many of the owner's instructions are still on their way to the agent.
      waitingAfterEnd: !view.active && context.workspaceId ? annotateAgents(context.workspaceId).reduce((sum, agent) => sum + access.live.waitingAfterEnd(agent.id), 0) : 0,
      prompt: LIVE_AGENT_PROMPT };
  }
  function stopLive(context = null, reason = 'stopped') {
    const current = access?.live.current();
    if (!current || (context && current.ownerWindowId !== context.id)) return false;
    return access.live.stop(reason);
  }
  /** Stop conditions that follow from ordinary state changes: the owner left the tab, the workspace or the window, or the page left the granted sites. */
  function syncLive() {
    const current = access?.live.current();
    if (!current) return;
    const context = windows.get(current.ownerWindowId);
    let reason = null;
    if (!context || context.closing || context.window.isDestroyed()) reason = 'window';
    else if (context.workspaceId !== current.workspaceId) reason = 'workspace';
    else {
      const workspace = state.workspaces.find(item => item.id === current.workspaceId);
      const group = state.groups.find(item => item.id === workspace?.activeGroupId);
      const tab = state.tabs.find(item => item.id === group?.activeTabId && item.workspaceId === current.workspaceId);
      if (!tab || tab.id !== current.tabId || tab.status !== 'open' || !loaded.has(tab.id)) reason = 'tab';
      else { try { if (!liveOriginGranted(current)) reason = 'navigated'; } catch { reason = 'tab'; } }
    }
    if (reason) access.live.stop(reason);
  }
  function liveEnded(event) {
    try { engine?.endLivePointer({ workspaceId: event.workspaceId, tabId: event.tabId }); } catch {}
    const owner = windows.get(event.ownerWindowId), message = liveEndMessages[event.reason];
    const kept = event.kept ? (event.kept === 1 ? '1 instruction' : event.kept + ' instructions') + ' will reach ' + event.label + ' when it next checks in.' : '';
    const text = [message, event.pending ? (event.pending === 1 ? '1 instruction the agent hadn’t received was discarded.' :
      event.pending + ' instructions the agent hadn’t received were discarded.') : '', kept].filter(Boolean).join(' ');
    if (owner && text) send('notice', text, owner);
    emit();
    const item = liveVoice?.sessionId === event.sessionId ? liveVoice : null;
    return item ? stopLiveVoice(item) : undefined;
  }
  function createLiveVoice(session, workspaceId, context) {
    let resolveStopped;
    const stopped = new Promise(resolve => { resolveStopped = resolve; });
    return { sessionId: session.sessionId, ownerWindowId: context.id, workspaceId, capturePrivacyEpoch: privacy.getPrivacyState(workspaceId).capturePrivacyEpoch,
      controller: new AbortController(), queue: [], running: false, stopped, resolveStopped };
  }
  /**
   * The owner's Stop: the phrase being said is finished and sent, then everything heard is transcribed, before Live ends.
   * The microphone is off once the renderer confirms; only audio already captured is used. Bounded, so Stop always ends Live.
   */
  async function finishLiveVoice(context) {
    const current = access?.live.current(), item = liveVoice;
    if (!current || current.ownerWindowId !== context.id || item?.sessionId !== current.sessionId || item.controller.signal.aborted || item.finishing) return;
    item.finishing = true; emit();
    const owner = windows.get(item.ownerWindowId);
    const bounded = (promise, ms) => { let timer; return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer)); };
    if (owner) { send('command', { type: 'live-voice-finish', sessionId: item.sessionId }, owner); await bounded(item.stopped, 4000); }
    const drained = async () => { while ((item.queue.length || item.running) && !item.controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 50)); };
    await bounded(drained(), 15000);
  }
  /** Ends listening: no new audio is accepted, queued audio is wiped, and the renderer confirms its microphone tracks stopped (bounded). */
  async function stopLiveVoice(item) {
    item.controller.abort();
    for (const job of item.queue.splice(0)) job.pcm16.fill(0);
    const owner = windows.get(item.ownerWindowId);
    if (owner) send('command', { type: 'live-voice-stop', sessionId: item.sessionId }, owner); else item.resolveStopped();
    let timer;
    await Promise.race([item.stopped, new Promise(resolve => { timer = setTimeout(resolve, 4000); })]).finally(() => clearTimeout(timer));
    if (liveVoice === item) liveVoice = null;
    emit();
  }
  async function receiveLiveAudio(event, raw) {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    try {
      const audio = validateLiveAudio(raw), item = liveVoice, current = access.live.current();
      if (!item || !current || item.sessionId !== audio.sessionId || current.sessionId !== audio.sessionId || item.ownerWindowId !== context.id ||
          item.controller.signal.aborted) fail('LIVE_INACTIVE');
      systemLifecycle.capture({ purpose: 'voice-capture' }).assertCurrent();
      privacy.assertCapture({ workspaceId: item.workspaceId, capturePrivacyEpoch: item.capturePrivacyEpoch });
      // Main's own clock places the utterance against the pointer trail: it ended now, minus the silence it still holds.
      const receivedAt = Date.now();
      const rowId = access.live.heard(item.sessionId, { startAt: receivedAt - audio.durationMs, endAt: receivedAt - audio.trailingMs });
      if (!rowId) { audio.pcm16.fill(0); return { ok: true, skipped: true }; }
      let page = { title: '', url: '' };
      try { page = livePage(current); } catch {}
      item.queue.push({ rowId, pcm16: Buffer.from(audio.pcm16), page });
      audio.pcm16.fill(0);
      void drainLiveVoice(item);
      return { ok: true };
    } catch (error) {
      try { if (raw?.pcm16 instanceof Uint8Array) raw.pcm16.fill(0); } catch {}
      return { ok: false, code: error.code ?? 'LIVE_AUDIO_FAILED' };
    }
  }
  /** One utterance at a time through the pinned local transcriber, with word timings. */
  async function drainLiveVoice(item) {
    if (item.running) return;
    item.running = true;
    try {
      while (item.queue.length && liveVoice === item && !item.controller.signal.aborted) {
        const job = item.queue.shift();
        let leveled = null;
        try {
          // Quiet stretches are evened out (the small model skips them), and the page's own words are the model's starting context.
          let vocabulary = job.page?.title ?? '';
          try { vocabulary = access.live.vocabulary(item.sessionId) || vocabulary; } catch {}
          leveled = evenLevels(job.pcm16);
          const result = await speech.transcribe({ workspaceId: item.workspaceId, captureId: job.rowId, capturePrivacyEpoch: item.capturePrivacyEpoch, pcm16: leveled },
            { signal: item.controller.signal, words: true, prompt: vocabulary, assertCurrent: () => {
              if (liveVoice !== item || item.controller.signal.aborted || access.live.current()?.sessionId !== item.sessionId) fail('CAPTURE_INVALIDATED');
              return true;
            } });
          if (liveVoice === item) access.live.transcribed(job.rowId, { text: result.text, words: result.words ?? [], page: job.page });
        } catch { if (liveVoice === item) access.live.failed(job.rowId); }
        finally { job.pcm16.fill(0); leveled?.fill(0); }
      }
    } finally { item.running = false; }
  }
  function liveSession(context) {
    const current = access.live.current();
    if (!current || current.ownerWindowId !== context.id || context.privateScopeId) fail('LIVE_INACTIVE');
    if (blockingWorkspaces.has(current.workspaceId) || privacy.getPrivacyState(current.workspaceId).blocked) fail('PRIVACY_BLOCKED');
    return current;
  }
  async function startLive(context, { agentSessionId }) {
    const current = access.live.current();
    if (current) { if (current.ownerWindowId === context.id) return liveView(context); fail('LIVE_BUSY'); }
    if (context.privateScopeId || !context.workspaceId || workspaceOwners.get(context.workspaceId) !== context ||
        blockingWorkspaces.has(context.workspaceId) || privacy.getPrivacyState(context.workspaceId).blocked) fail('LIVE_UNAVAILABLE');
    const workspace = workspaceFor(context.workspaceId);
    if (workspace.kind === 'personal' || workspace.personal || workspace.humanOnly) fail('LIVE_UNAVAILABLE');
    const group = state.groups.find(item => item.id === workspace.activeGroupId);
    const tab = state.tabs.find(item => item.id === group?.activeTabId && item.workspaceId === workspace.id && item.status === 'open');
    if (!tab || !loaded.has(tab.id) || engine.navigation(query(tab)).url === 'about:blank') fail('LIVE_NO_PAGE');
    if (annotating?.ownerWindowId === context.id) fail('ANNOTATE_ACTIVE');
    if (voice || moments?.view(context) || previews?.has(context) || selecting?.ownerWindowId === context.id) fail('LIVE_UNAVAILABLE');
    const agents = annotateAgents(workspace.id);
    if (!agents.length) fail('LIVE_NO_AGENT');
    if (agentSessionId === null && agents.length > 1) fail('LIVE_CHOOSE_AGENT');
    const chosen = agentSessionId === null ? agents[0] : agents.find(agent => agent.id === agentSessionId);
    if (!chosen) fail('RECIPIENT_UNAVAILABLE');
    if (!liveOrigins(chosen.id).includes(engine.getPageInfo(query(tab)).origin)) fail('LIVE_ORIGIN_NOT_GRANTED');
    const voiceStatus = liveVoiceStatus();
    let page = null;
    try { page = livePage({ workspaceId: workspace.id, tabId: tab.id }); } catch {}
    const session = access.live.start({ workspaceId: workspace.id, tabId: tab.id, agentSessionId: chosen.id, ownerWindowId: context.id, voice: voiceStatus.available, page });
    try {
      if (voiceStatus.available) liveVoice = createLiveVoice(session, workspace.id, context);
      await engine.beginLivePointer({ ...query(tab), sessionId: session.sessionId });
      if (access.live.current()?.sessionId !== session.sessionId) fail('CANCELLED');
    } catch (error) { if (access.live.current()?.sessionId === session.sessionId) access.live.stop('failed'); throw error; }
    emit(); return liveView(context);
  }
  async function cancelPicker(context = primaryContext) {
    if (selecting && context && selecting.ownerWindowId !== context.id) return;
    const previous = selecting; selecting = null;
    if (previous) await engine.cancelSelection({ workspaceId: previous.workspaceId, tabId: previous.tabId }).catch(() => {});
    assertChromeActionCurrent(); emit();
  }
  function momentPage(context, tabId) {
    if (!context || context.closing || !context.reviewOpen || context.workspaceId !== tabFor(tabId).workspaceId ||
        workspaceOwners.get(context.workspaceId) !== context || blockingWorkspaces.has(context.workspaceId) ||
        privacy.getPrivacyState(context.workspaceId).blocked || voice || selecting) fail('CAPTURE_UNAVAILABLE');
    const workspace = workspaceFor(context.workspaceId);
    const group = state.groups.find(item => item.id === workspace.activeGroupId);
    if (group?.activeTabId !== tabId || !visibleTabIds({ ...state, activeWorkspaceId: context.workspaceId }).includes(tabId) || !loaded.has(tabId)) fail('CAPTURE_UNAVAILABLE');
    const view = engine.getView({ workspaceId: context.workspaceId, tabId });
    if (!view.getVisible() || engine.getOwnerWindow({ workspaceId: context.workspaceId, tabId }) !== context.window || !context.window.isVisible()) fail('CAPTURE_UNAVAILABLE');
    return engine.getPageInfo({ workspaceId: context.workspaceId, tabId });
  }
  function stopFinding(context = primaryContext) {
    const previous = context?.finding; if (context) context.finding = null;
    if (previous) try { engine.stopFind(previous); } catch {}
  }
  function capturePreviewOwner(context) {
    if (!context || context.privateScopeId || !context.workspaceId) fail('PREVIEW_UNAVAILABLE');
    const workspace = workspaceFor(context.workspaceId), group = state.groups.find(item => item.id === workspace.activeGroupId);
    if (!group || context.reviewOpen || selecting?.ownerWindowId === context.id || voice?.ownerWindowId === context.id ||
        moments?.view(context) || prints?.status(context.id).busy) fail('PREVIEW_BUSY');
    const chrome = captureChromeIntent(context), epoch = privacy.getPrivacyState(workspace.id).capturePrivacyEpoch;
    const intent = { workspaceId: workspace.id, identityId: workspace.identityId, workspaceGeneration: workspace.lifecycle?.generation ?? 0,
      groupId: group.id, sourceTabId: group.activeTabId ?? null,
      assertCurrent() {
        chrome.assertCurrent(); const current = workspaceFor(workspace.id), guard = privacy.getPrivacyState(workspace.id);
        if (closed || closing || context.closing || windows.get(context.id) !== context || context.window.isDestroyed() || context.privateScopeId ||
            context.workspaceId !== workspace.id || context.workspaceIdentityId !== workspace.identityId || workspaceOwners.get(workspace.id) !== context ||
            engine.getWorkspaceOwnerWindow(workspace.id) !== context.window || current.identityId !== workspace.identityId ||
            (current.lifecycle?.generation ?? 0) !== intent.workspaceGeneration || current.lifecycle?.status === 'archived' || current.activeGroupId !== group.id ||
            workspaceLifecycle?.isBusy(workspace.id)) fail('PREVIEW_STALE');
        if (guard.blocked || guard.capturePrivacyEpoch !== epoch || blockingWorkspaces.has(workspace.id)) fail('PREVIEW_PRIVACY_BLOCKED');
        return true;
      } };
    intent.assertCurrent(); return intent;
  }
  function showPreviewLinkMenu(info, asItem = false) {
    const context = windows.get(info.expectedOwnerWindow?.id);
    if (!context || context.privateScopeId || previews?.has(context) || context.chromeOverlay || context.reviewOpen) return null;
    let chrome, url;
    try { chrome = captureChromeIntent(context); url = previewURL(info.url); } catch { return null; }
    const intentGeneration = context.intentGeneration, expiresAt = Date.now() + 30000;
    const assertCurrent = () => {
      chrome.assertCurrent(); info.assertCurrent();
      if (Date.now() >= expiresAt || context.intentGeneration !== intentGeneration || context.closing || context.chromeOverlay ||
          context.workspaceId !== info.workspaceId || workspaceOwners.get(info.workspaceId) !== context || context.window !== info.expectedOwnerWindow ||
          !visibleTabIds({ ...state, activeWorkspaceId: info.workspaceId }).includes(info.tabId)) fail('PREVIEW_STALE');
      return true;
    };
    try { assertCurrent(); } catch { return null; }
    let used = false;
    const open = () => {
      if (used) return Promise.reject(new CaddiError('PREVIEW_STALE', 'That link menu has already been used'));
      used = true;
      if (queuedActions >= 32 || closing || closed) return Promise.reject(new CaddiError('ACTION_CAPACITY', 'Action queue is unavailable'));
      queuedActions++;
      const result = actionTail.then(() => chromeActions.run(chrome, async () => {
        assertCurrent(); portability.invalidate(context); await prepareSelectionChange(context); assertCurrent();
        return previews.open(context, { input: url, sourceTarget: info.sourceTarget, sourceAssertCurrent: assertCurrent });
      }));
      actionTail = result.catch(() => {});
      return result.finally(() => { queuedActions--; emit(); });
    };
    if (testPreviewMenu) {
      capturedPreviewMenu = Object.freeze({ open, windowId: context.id, workspaceId: info.workspaceId, sourceTabId: info.tabId });
      testPreviewMenu(capturedPreviewMenu); return null;
    }
    const item = { label: 'Open Link in Preview', click: () => { void open().catch(error => send('notice',
      error.code === 'PREVIEW_BUSY' ? 'Close the current preview before opening another link.' : 'That link changed. Open its menu again.', context)); } };
    if (asItem) return item;
    Menu.buildFromTemplate([item]).popup({ window: context.window });
  }
  function showPageContextMenu(info) {
    const context = [...windows.values()].find(item => item.window === info.ownerWindow);
    if (!context || closed || closing || context.closing || context.chromeOverlay || context.window.isDestroyed()) return;
    if (info.preview && testPreviewMenu) return showPreviewLinkMenu(info.preview);
    const wc = info.webContents, items = [], gap = () => { if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' }); };
    const run = method => () => { if (!wc.isDestroyed()) wc[method](); };
    if (info.link) {
      if (!info.privateScope) items.push({ label: 'Open Link in New Tab', click: () => void act({ type: 'tab.create', workspaceId: info.workspaceId, input: info.link, activate: false }, context)
        .catch(() => send('notice', 'The link could not open in a new tab.', context)) });
      const preview = info.preview ? showPreviewLinkMenu(info.preview, true) : null;
      if (preview) items.push(preview);
      items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(info.link) });
    }
    if (info.image) { gap(); items.push({ label: 'Copy Image Address', click: () => clipboard.writeText(info.image) }); }
    if (info.editable) {
      gap(); items.push({ label: 'Undo', enabled: info.editFlags.canUndo, click: run('undo') }, { label: 'Redo', enabled: info.editFlags.canRedo, click: run('redo') }, { type: 'separator' },
        { label: 'Cut', enabled: info.editFlags.canCut, click: run('cut') }, { label: 'Copy', enabled: info.editFlags.canCopy, click: run('copy') },
        { label: 'Paste', enabled: info.editFlags.canPaste, click: run('paste') }, { label: 'Select All', enabled: info.editFlags.canSelectAll, click: run('selectAll') });
    } else if (info.selection) { gap(); items.push({ label: 'Copy', click: run('copy') }); }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: context.window });
  }
  async function prepareSelectionChange(context) {
    assertChromeActionCurrent();
    if (previews?.has(context)) fail('PREVIEW_BUSY');
    if (!chromeRecovery.ready(context)) fail('CHROME_RECOVERY_REQUIRED');
    const workspaceId = context.workspaceId;
    prints?.invalidate({ ownerWindowId: context.id });
    prepared?.invalidate({ ownerWindowId: context.id });
    if (workspaceId) {
      sitePermissions.invalidate({ workspaceId });
      engine.invalidatePopups({ workspaceId });
    }
    stopFinding(context);
    if (voice?.ownerWindowId === context.id) await stopVoice();
    await cancelPicker(context); stopAnnotating(context);
    if (closing || closed || context.closing || windows.get(context.id) !== context || context.window.isDestroyed()) fail('CLOSED');
    if (context.workspaceId !== workspaceId || workspaceOwners.get(workspaceId) !== context) fail('WORKSPACE_CHANGED');
    assertChromeActionCurrent();
  }
  async function switchWorkspace(workspaceId, context = primaryContext) {
    if (context?.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
    if (previews?.has(context)) fail('PREVIEW_BUSY');
    assertChromeActionCurrent();
    if (!chromeRecovery.ready(context)) fail('CHROME_RECOVERY_REQUIRED');
    if (workspaceFor(workspaceId).lifecycle?.status === 'archived') fail('WORKSPACE_ARCHIVED');
    if (workspaceLifecycle?.isBusy(workspaceId)) fail('WORKSPACE_TRANSITION');
    const owner = workspaceOwners.get(workspaceId);
    if (owner && owner !== context) {
      if (owner.closing || windows.get(owner.id) !== owner || owner.window.isDestroyed()) fail('WORKSPACE_TRANSITION');
      if (!chromeRecovery.ready(owner)) fail('CHROME_RECOVERY_REQUIRED');
      owner.window.show(); owner.window.focus(); return { focusedExisting: true };
    }
    assertPageCapacity(visibleTabIds({ ...state, activeWorkspaceId: workspaceId }));
    const intent = workspaceSelection.begin(workspaceId, context), previousWorkspaceId = intent.previousWorkspaceId;
    const previousWindow = engine?.getWorkspaceOwnerWindow(workspaceId);
    let transferred = false, committed = false, published = false;
    try {
      prints?.invalidate({ownerWindowId:context.id});
      if (previousWorkspaceId) { prepared?.invalidate({ownerWindowId:context.id}); sitePermissions.invalidate({ workspaceId: previousWorkspaceId }); engine?.invalidatePopups({ workspaceId: previousWorkspaceId }); }
      stopFinding(context);
      if (voice?.ownerWindowId === context.id) await stopVoice('workspace-switch');
      if (selecting?.ownerWindowId === context.id) await cancelPicker(context);
      stopAnnotating(context); stopLive(context, 'workspace');
      intent.assertCurrent(); assertPageCapacity(visibleTabIds({ ...state, activeWorkspaceId: workspaceId }));
      if (engine) {
        // A managed publication whose activation was fenced may have metadata
        // without an engine record. Explicit owner selection can safely bind it.
        engine.createWorkspace({ workspaceId, identityId: workspaceFor(workspaceId).identityId });
        if (engine.getWorkspaceOwnerWindow(workspaceId) !== context.window) { engine.transferWorkspace(workspaceId, context.window); transferred = true; }
      }
      await transact({ type: 'workspace.select', workspaceId }, intent.assertCurrent,
        { selection: { context, workspaceId }, onPublished: () => { committed = true; } });
      assertChromeActionCurrent(); intent.assertCurrent();
      if (previousWorkspaceId && workspaceOwners.get(previousWorkspaceId) === context) workspaceOwners.delete(previousWorkspaceId);
      context.workspaceId = workspaceId; context.workspaceIdentityId = workspaceFor(workspaceId).identityId; context.needsHydration = false;
      workspaceOwners.set(workspaceId, context); published = true; windowSessions?.changed();
      layout(context); await displayCurrent(context);
      return { focusedExisting: false };
    } catch (error) {
      if (!published && transferred && previousWindow && previousWindow !== context.window) {
        try { engine.transferWorkspace(workspaceId, previousWindow); } catch { intent.hold(); }
      }
      // A transition can begin after the metadata rename but before its async
      // durability acknowledgment. Restore only this still-unpublished selection.
      if (!published && committed && previousWorkspaceId && context.workspaceId === previousWorkspaceId && state.activeWorkspaceId === workspaceId) {
        try { await transact({ type: 'workspace.select', workspaceId: previousWorkspaceId }, () => {
          if (context.workspaceId !== previousWorkspaceId || state.activeWorkspaceId !== workspaceId) fail('WORKSPACE_TRANSITION');
          return true;
        }); } catch { intent.hold(); }
      }
      if (error.code === 'COMMIT_OUTCOME_UNKNOWN') intent.hold();
      throw error;
    } finally { intent.release(); }
  }
  async function addWorkspace(name, kind = 'project') {
    if (state.workspaces.length >= 32) fail('WORKSPACE_CAPACITY');
    if (!['project', 'personal'].includes(kind)) fail('INVALID_ARGUMENT');
    const suffix = randomUUID(), workspaceId = 'workspace-' + suffix;
    let projectId = null;
    if (kind === 'project') { projectId = 'project-' + suffix; await transact({ type: 'project.create', id: projectId, name }); }
    await transact({ type: 'workspace.create', id: workspaceId, identityId: 'identity-' + suffix, name, projectId, kind });
    const groupId = 'group-' + suffix;
    await transact({ type: 'group.create', id: groupId, workspaceId, name: 'Tabs', color: '#337765' });
    engine?.createWorkspace({ workspaceId, identityId: 'identity-' + suffix });
    await transact({ type: 'tab.create', id: 'tab-' + suffix, workspaceId, groupId, url: 'about:blank', title: 'New tab', now: Date.now() });
    return workspaceId;
  }
  if (!state.workspaces.length) {
    await addWorkspace('Personal', 'personal');
    const work = await addWorkspace('My project');
    await transact({ type: 'workspace.select', workspaceId: work });
  }

  const chromeSession = session.fromPartition('caddi-desktop-chrome-' + randomUUID());
  const routes = new Map([
    ['/index.html', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']],
    ['/brand/caddi-mark.svg', ['brand/caddi-mark.svg', 'image/svg+xml']],
    ['/annotate.mjs', ['annotate.mjs', 'text/javascript']], ['/annotate.css', ['annotate.css', 'text/css']],
    ['/live.mjs', ['live.mjs', 'text/javascript']], ['/board.mjs', ['board.mjs', 'text/javascript']], ['/live-segmenter.mjs', ['live-segmenter.mjs', 'text/javascript']],
    ['/renderer.mjs', ['renderer.mjs', 'text/javascript']], ['/sent-controls.mjs', ['sent-controls.mjs', 'text/javascript']], ['/daily-controls.mjs', ['daily-controls.mjs', 'text/javascript']], ['/external-link-controls.mjs', ['external-link-controls.mjs', 'text/javascript']], ['/icons.mjs', ['icons.mjs', 'text/javascript']], ['/moment-geometry.mjs', ['moment-geometry.mjs', 'text/javascript']], ['/recorder.mjs', ['recorder.mjs', 'text/javascript']],
    ['/shortcuts.mjs', ['../shortcuts.mjs', 'text/javascript']], ['/shortcut-controls.mjs', ['shortcut-controls.mjs', 'text/javascript']],
    ['/shortcut-recording.mjs', ['shortcut-recording.mjs', 'text/javascript']], ['/page-preview-controls.mjs', ['page-preview-controls.mjs', 'text/javascript']],
    ['/storage-controls.mjs', ['storage-controls.mjs', 'text/javascript']],
    ['/logins-controls.mjs', ['logins-controls.mjs', 'text/javascript']], ['/vault.mjs', ['../vault.mjs', 'text/javascript']],
    ['/portability-controls.mjs', ['portability-controls.mjs', 'text/javascript']], ['/media-controls.mjs', ['media-controls.mjs', 'text/javascript']],
    ['/system-lifecycle-controls.mjs', ['system-lifecycle-controls.mjs', 'text/javascript']], ['/system-actions.mjs', ['../system-actions.mjs', 'text/javascript']],
    ['/persistence-controls.mjs', ['persistence-controls.mjs', 'text/javascript']],
    ['/service-catalog.mjs', ['service-catalog.mjs', 'text/javascript']],
    ['/command-palette.mjs', ['command-palette.mjs', 'text/javascript']], ['/default-browser-controls.mjs', ['default-browser-controls.mjs', 'text/javascript']],
    ['/owner-credential-controls.mjs', ['owner-credential-controls.mjs', 'text/javascript']],
    ['/agent-setup.mjs', ['agent-setup.mjs', 'text/javascript']], ['/welcome-controls.mjs', ['welcome-controls.mjs', 'text/javascript']],
    ['/brand/caddi-icon.svg', ['brand/caddi-icon.svg', 'image/svg+xml']],
    ['/organization-order.mjs', ['organization-order.mjs', 'text/javascript']],
    ['/audio-worklet.mjs', ['audio-worklet.mjs', 'text/javascript']],
    ['/brand/caddi-wordmark-ink.svg', ['brand/caddi-wordmark-ink.svg', 'image/svg+xml']],
    ['/brand/caddi-mark-ink.svg', ['brand/caddi-mark-ink.svg', 'image/svg+xml']],
  ]);
  chromeSession.protocol.handle('caddi', async request => {
    const url = new URL(request.url), asset = routes.get(url.pathname);
    if (request.method !== 'GET' || url.host !== 'app' || url.username || url.password || url.search || !asset) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(here, 'ui', asset[0])), { headers: {
      'content-type': asset[1] + '; charset=utf-8', 'content-security-policy': CSP,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    } });
  });
  chromeSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { const url = new URL(details.url); allowed = url.protocol === 'caddi:' && url.host === 'app' && routes.has(url.pathname) && !url.username && !url.password && !url.search; } catch {}
    callback({ cancel: !allowed });
  });
  const newChromeWindow = (restored = null) => {
    const nativeWindow = new BrowserWindow({ width: 1440, height: 940, minWidth: restored?.minimumSize.width ?? 1040, minHeight: restored?.minimumSize.height ?? 660,
    ...(restored?.bounds ?? {}), title: 'Caddi', show: false,
    backgroundColor: '#f1f1f1', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 18 }, visualEffectState: 'followWindow' } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      session: chromeSession, preload: path.join(here, 'preload.cjs'), spellcheck: true } });
    attachWindowMaterial(nativeWindow, nativeTheme);
    return nativeWindow;
  };
  const makeContext = (nativeWindow, workspaceId) => ({ id: nativeWindow.id, window: nativeWindow, workspaceId,
    workspaceIdentityId: state.workspaces.find(item => item.id === workspaceId)?.identityId ?? null, windowKey: 'window-' + randomUUID(), needsHydration: false, intentGeneration: 0,
    chromeOverlay: false, layingOut: false, pageRect: { x: 254, y: 92, width: 800, height: 650 }, reviewOpen: false, finding: null });
  const durableWorkspaceLookup = id => { const workspace = state.workspaces.find(item => item.id === id); return workspace ? { ...workspace, persistence: 'durable' } : null; };
  const primaryDisplay = screen.getPrimaryDisplay();
  windowSessions = await createWindowSessionHost({
    store: createWindowSessionStore({ directory: path.join(dataRoot, 'window-session'), durableWorkspaceLookup }), durableWorkspaceLookup,
    displays: [primaryDisplay, ...screen.getAllDisplays().filter(item => item.id !== primaryDisplay.id)].map(item => ({ id: item.id, workArea: item.workArea })),
    contexts: () => [...windows.values()], onChange: emit,
  });
  const initialRestore = windowSessions.plan.windows.find(item => item.windowKey === windowSessions.plan.focusedWindowKey) ?? null;
  window = newChromeWindow(initialRestore);
  const startupWorkspace = state.workspaces.find(item => item.id === initialRestore?.workspaceId && item.identityId === initialRestore.identityId && item.lifecycle?.status !== 'archived') ??
    state.workspaces.find(item => item.id === state.activeWorkspaceId && item.lifecycle?.status !== 'archived') ??
    state.workspaces.find(item => item.lifecycle?.status !== 'archived');
  primaryContext = makeContext(window, startupWorkspace?.id ?? null);
  if (initialRestore) primaryContext.windowKey = initialRestore.windowKey;
  windows.set(window.id, primaryContext); workspaceOwners.set(primaryContext.workspaceId, primaryContext);
  chromeRecovery = createChromeRecovery({
    current: context => !closed && !closing && !!context && !context.closing && windows.get(context.id) === context &&
      !context.window.isDestroyed() && !context.window.webContents.isDestroyed(),
    protect(context, _status, binding) {
      binding.assertCurrent();
      shortcutRecording?.stop(context); previews?.invalidate(context, 'CHROME_RECOVERY_REQUIRED'); portability?.invalidate(context);
      access?.persistence?.acquisition?.invalidateOwner(context);
      if (context.privateScopeId) return privateWindows.protect(context);
      externalLinks?.invalidateOwner(context); externalReviewBindings.delete(context);
      prints?.invalidate({ ownerWindowId: context.id }); moments?.cancel({ ownerWindowId: context.id });
      prepared?.invalidate({ ownerWindowId: context.id }); stopFinding(context);
      engine?.cancelHumanClose({ workspaceId: context.workspaceId });
      if (selecting?.ownerWindowId === context.id) selecting = null;
      stopAnnotating(context); stopLive(context, 'window');
      if (liveVoice?.ownerWindowId === context.id) liveVoice.resolveStopped(); // The recorder's process is gone.
      if (voice?.ownerWindowId === context.id) {
        // render-process-gone acknowledges destruction of this recorder process,
        // including an unresolved permission prompt. Native workers still settle.
        voice.audioAcknowledged = true; voice.resolveAudio(); voice.controller.abort(); speech?.cancel(voice.captureId);
      }
      const workspaceIds = state.workspaces.filter(item => item.id === context.workspaceId ||
        (engine && engine.getWorkspaceOwnerWindow(item.id) === context.window)).map(item => item.id);
      const barriers = workspaceIds.map(workspaceId => enterPrivateWorkspace(workspaceId));
      layout(context); emit();
      return Promise.all(barriers).then(() => { binding.assertCurrent(); return true; });
    },
    async choose(context, status, binding) {
      binding.assertCurrent();
      if (recoveryDecisionForTest) return recoveryDecisionForTest({ windowId: context.id, ...status, signal: binding.signal });
      const retry = status.attempts < status.maxAttempts;
      const answer = await dialog.showMessageBox(context.window, { type: 'warning', title: 'Recover Caddi controls',
        message: status.code === 'CHROME_STOP_PENDING' ? 'Caddi is waiting for capture to stop safely.' :
          status.attempts ? 'Caddi controls could not finish recovering.' : 'The controls in this Caddi window stopped.',
        detail: 'Your website pages remain open. Agent control and capture are paused for this window’s workspaces. ' +
          (status.reviewUncertain ? 'Unsaved text in the controls may have been lost; saved feedback is retained. ' : '') +
          (retry ? 'Recovery reloads only the browser controls. Agents stay paused until you explicitly resume them.' : 'The retry limit was reached. Keep the workspaces paused or quit Caddi.'),
        buttons: retry ? [status.attempts || status.code ? 'Retry Recovery' : 'Recover Controls', 'Keep Paused', 'Quit Caddi'] : ['Keep Paused', 'Quit Caddi'],
        defaultId: 0, cancelId: retry ? 1 : 0, noLink: true, signal: binding.signal });
      binding.assertCurrent();
      return retry ? ['recover', 'keep-paused', 'quit'][answer.response] : ['keep-paused', 'quit'][answer.response];
    },
    async reload(context, _status, binding) {
      // Never reload synchronously within render-process-gone's native stack.
      await new Promise(resolve => setTimeout(resolve, 0)); binding.assertCurrent();
      const wc = context.window.webContents;
      const stop = () => { if (!wc.isDestroyed()) wc.stop(); };
      binding.signal.addEventListener('abort', stop, { once: true });
      try {
        await context.window.loadURL(DESKTOP_URL); binding.assertCurrent();
        const frame = wc.mainFrame;
        if (wc.getURL() !== DESKTOP_URL || !frame || frame.isDestroyed() || frame.url !== DESKTOP_URL || frame.processId <= 0) fail('CHROME_RELOAD_FAILED');
      } finally { binding.signal.removeEventListener('abort', stop); }
    },
    restore(context, _status, binding) {
      binding.assertCurrent();
      if (context.workspaceId && workspaceOwners.get(context.workspaceId) !== context) fail('WORKSPACE_CHANGED');
      // Drafts in the host survive. Unconfirmed renderer edits, recorders, pickers,
      // dialogs and control leases are never reconstructed from a lost process.
      context.chromeOverlay = false; context.reviewOpen = false; context.finding = null;
      context.recoveredNotice = true;
    },
    async quit(_context, _status, binding) {
      if (!(await requestQuit())) return false;
      binding.assertCurrent(); await close(); electronApp.quit(); return true;
    },
    onChange(context) {
      layout(context); emit();
      if (context.recoveredNotice && chromeRecovery?.ready(context)) {
        context.recoveredNotice = false;
        send('notice', 'Caddi controls recovered. Your pages are still open; agents stay paused until you choose Resume.', context);
      }
    },
  });
  shortcutRecording = createShortcutRecording({ capture: context => captureChromeIntent(context),
    setIgnored: (context, active) => { if (!context.window.isDestroyed() && !context.window.webContents.isDestroyed()) context.window.webContents.setIgnoreMenuShortcuts(active); },
    onChange: emit });
  const previousMenu = Menu.getApplicationMenu();
  // Commands that put the caret in the browser controls must also move keyboard focus there from the page view;
  // focusing an element in the controls alone leaves keystrokes going to the page.
  const shellFocusCommands = new Set(['l', 'k', 'f', 't', 'history', 'downloads', 'shortcuts', 'permissions', 'welcome', 'storage', 'external-links', 'vault']);
  const sendCommand = (value, context) => {
    if (shellFocusCommands.has(value) && !context.window.webContents.isFocused()) try { context.window.webContents.focus(); } catch {}
    send('command', value, context);
  };
  const menuCommand = (value, nativeWindow) => {
    const context = windows.get(nativeWindow?.id ?? BrowserWindow.getFocusedWindow()?.id);
    if (context && !closed && !context.closing && !context.window.isDestroyed() && chromeRecovery.ready(context)) sendCommand(value, context);
  };
  function bindShortcuts(wc, owner) {
    wc.on('before-input-event', (event, input) => {
      const context = typeof owner === 'function' ? owner() : owner;
      if (!context || context.closing || windows.get(context.id) !== context || !chromeRecovery.ready(context)) return;
      if (wc === context.window.webContents && shortcutRecording.active(context)) return;
      const command = shortcutForInput(input, shortcuts.snapshot().bindings, process.platform);
      if (command) { event.preventDefault(); sendCommand(command, context); return; }
      // Fixed Annotate toggle. A customized binding on the same keys wins above.
      if (input.type === 'keyDown' && !input.isAutoRepeat && input.shift && !input.alt && (input.key === 'A' || input.key === 'a') &&
          (process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)) {
        event.preventDefault(); send('command', 'annotate', context);
      }
      // Fixed Live toggle, registered the same way.
      if (input.type === 'keyDown' && !input.isAutoRepeat && input.shift && !input.alt && (input.key === 'L' || input.key === 'l') &&
          (process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)) {
        event.preventDefault(); send('command', 'live', context);
      }
    });
  }
  const accelerator = command => shortcutAccelerator(shortcuts.snapshot().bindings[command]);
  function installMenu() { Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: accelerator('t'), click: (_item, focusedWindow) => menuCommand('t', focusedWindow) },
      { label: 'Close Tab', accelerator: accelerator('w'), click: (_item, focusedWindow) => menuCommand('w', focusedWindow) },
      { label: 'Reopen Closed Tab', accelerator: accelerator('reopen'), click: (_item, focusedWindow) => menuCommand('reopen', focusedWindow) },
      { label: 'Open Workspace in New Window', accelerator: accelerator('new-window'), click: (_item, focusedWindow) => menuCommand('new-window', focusedWindow) },
      { label: 'New Normal Window', accelerator: accelerator('normal-window'), click: (_item, focusedWindow) => menuCommand('normal-window', focusedWindow) },
      { label: 'New Private Window', accelerator: accelerator('private-window'), click: (_item, focusedWindow) => menuCommand('private-window', focusedWindow) },
      { label: 'Print Page…', accelerator: accelerator('print'), click: (_item, focusedWindow) => menuCommand('print', focusedWindow) },
      { label: 'Save Page as PDF…', click: (_item, focusedWindow) => menuCommand('save-pdf', focusedWindow) },
      { type: 'separator' }, { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
    ] },
    { label: 'Edit', submenu: ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'].map(role => ({ role })) },
    { label: 'View', submenu: [
      { label: 'Address or Search', accelerator: accelerator('l'), click: (_item, focusedWindow) => menuCommand('l', focusedWindow) },
      { label: 'Commands and Tab Search', accelerator: accelerator('k'), click: (_item, focusedWindow) => menuCommand('k', focusedWindow) },
      { label: 'Find in Page', accelerator: accelerator('f'), click: (_item, focusedWindow) => menuCommand('f', focusedWindow) },
      { label: 'Workspace History', accelerator: accelerator('history'), click: (_item, focusedWindow) => menuCommand('history', focusedWindow) },
      { label: 'Workspace Downloads', accelerator: accelerator('downloads'), click: (_item, focusedWindow) => menuCommand('downloads', focusedWindow) },
      { label: 'Vault', accelerator: accelerator('vault'), click: (_item, focusedWindow) => menuCommand('vault', focusedWindow) },
      { label: 'Keyboard Shortcuts…', click: (_item, focusedWindow) => menuCommand('shortcuts', focusedWindow) },
      { label: 'Site Permissions', click: (_item, focusedWindow) => menuCommand('permissions', focusedWindow) },
      { label: 'Recover Browser Controls…', click: (_item, focusedWindow) => {
        const context = windows.get(focusedWindow?.id ?? BrowserWindow.getFocusedWindow()?.id);
        if (context) void chromeActions.exit(() => chromeRecovery.offer(context));
      } },
      { type: 'separator' },
      { label: 'Back', accelerator: accelerator('back'), click: (_item, focusedWindow) => menuCommand('back', focusedWindow) },
      { label: 'Forward', accelerator: accelerator('forward'), click: (_item, focusedWindow) => menuCommand('forward', focusedWindow) },
      { label: 'Reload Page', accelerator: accelerator('reload'), click: (_item, focusedWindow) => menuCommand('reload', focusedWindow) },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Welcome to Caddi', click: (_item, focusedWindow) => menuCommand('welcome', focusedWindow) }] },
  ])); }
  installMenu();
  const trusted = event => {
    const context = windows.get(BrowserWindow.fromWebContents(event.sender)?.id);
    if (closed || !context || context.window.isDestroyed() || event.sender !== context.window.webContents || event.sender.isDestroyed()) return null;
    try {
      const frame = event.senderFrame, main = context.window.webContents.mainFrame;
      return !!frame && !frame.isDestroyed() && frame.processId === main.processId &&
        frame.routingId === main.routingId && frame.url === DESKTOP_URL && main.url === DESKTOP_URL ? context : null;
    } catch { return null; }
  };
  // The chrome may use the microphone only while a voice note records, or while Live listens, and only in the owning window.
  const microphoneOwner = () => voice ? (voice.status === 'recording' && !voice.controller.signal.aborted ? voice.ownerWindowId : null) :
    liveVoice && !liveVoice.controller.signal.aborted && access?.live.current()?.sessionId === liveVoice.sessionId ? liveVoice.ownerWindowId : null;
  const microphoneAllowed = (wc, permission, origin, details = {}) => !systemLifecycle.status().locked && enableMicrophone && microphoneOwner() !== null &&
    windows.get(BrowserWindow.fromWebContents(wc)?.id)?.id === microphoneOwner() &&
    wc === windows.get(microphoneOwner())?.window.webContents && wc.getURL() === DESKTOP_URL &&
    permission === 'media' && (!origin || origin === 'caddi://app' || origin === 'caddi://app/') &&
    details.mediaType !== 'video' && (!details.mediaTypes || (details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio')));
  chromeSession.setPermissionCheckHandler((wc, permission, origin, details) => microphoneAllowed(wc, permission, origin, details));
  chromeSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(microphoneAllowed(wc, permission, details?.requestingOrigin, details)));
  chromeSession.setDevicePermissionHandler(() => false);
  chromeSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  function configureChrome(context) {
    const nativeWindow = context.window;
    nativeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    nativeWindow.webContents.on('will-navigate', event => event.preventDefault());
    nativeWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    bindShortcuts(nativeWindow.webContents, context);
    nativeWindow.webContents.on('render-process-gone', (_event, details) => {
      if (context.destroying || closing || closed) return;
      shortcutRecording.stop(context); previews?.invalidate(context, 'CHROME_RECOVERY_REQUIRED');
      const reviewUncertain = context.reviewOpen || voice?.ownerWindowId === context.id || !!moments?.view(context);
      void chromeActions.exit(() => chromeRecovery.crash(context, { reason: details?.reason, reviewUncertain })).catch(() => {});
    });
    nativeWindow.on('resize', () => { layout(context); windowSessions.changed(); });
    nativeWindow.on('move', () => windowSessions.changed());
    nativeWindow.on('maximize', () => windowSessions.changed());
    nativeWindow.on('unmaximize', () => windowSessions.changed());
    nativeWindow.on('focus', () => { windowSessions.focus(context); if (!systemLifecycle.status().locked && !startupRestoring && nativeWindow.isFocused() && context.needsHydration) void hydrateWindow(context).catch(error => send('notice',
      error.code === 'PAGE_CAPACITY' ? 'This saved workspace is waiting for a page slot. Close another loaded page, then select its tab.' : 'Select a tab to load this saved workspace.', context)); });
    nativeWindow.on('blur', () => shortcutRecording.stop(context));
    nativeWindow.on('closed', () => { shortcutRecording.stop(context); portability.invalidate(context); externalLinks?.invalidateOwner(context); externalReviewBindings.delete(context); chromeRecovery.retire(context); });
    nativeWindow.on('close', event => { if (!context.destroying) { event.preventDefault(); if (!closing && !closed) {
      if (context.closing && (context.privateScopeId || context.parkingPending)) void requestWindowClose(context).catch(() => notice('Window storage cleanup is still pending.'));
      else if (!chromeRecovery.ready(context)) void chromeActions.exit(() => chromeRecovery.offer(context));
      else void requestWindowClose(context).catch(() => notice('Close is waiting for workspace storage.'));
    } } });
    nativeWindow.webContents.on('did-finish-load', () => { emit(); layout(context); });
  }
  configureChrome(primaryContext);
  engine = createElectronEngine({
    window, privacy, profilePaths, sitePermissions,
    onLoginOffer: report => { void handleLoginOffer(report).catch(() => {}); },
    onPreviewLinkMenu: showPreviewLinkMenu,
    onContextMenu: showPageContextMenu,
    onOpenTab(item) {
      const owner = workspaceOwners.get(item.workspaceId);
      if (!owner || owner.closing || owner.privateScopeId || owner.workspaceId !== item.workspaceId) return;
      void act({ type: 'tab.create', workspaceId: item.workspaceId, input: item.url, activate: !item.background }, owner).catch(error =>
        send('notice', error.code === 'PAGE_CAPACITY' ? 'The link could not open: 32 pages are loaded. Close a tab and try again.' : 'The link could not open in a new tab.', owner));
    },
    onLeaveRequest(item) {
      const owner = workspaceOwners.get(item.workspaceId);
      return owner ? decideClose('leave', owner) : false;
    },
    onPopupChange: emit,
    isPopupOpenerActive(binding) {
      const owner = workspaceOwners.get(binding.workspaceId);
      return !systemLifecycle.status().locked && !!owner && owner.id === binding.ownerWindowId && !owner.closing && !owner.chromeOverlay &&
        !blockingWorkspaces.has(binding.workspaceId) && owner.workspaceId === binding.workspaceId &&
        visibleTabIds({ ...state, activeWorkspaceId: owner.workspaceId }).includes(binding.tabId);
    },
    onNotice: item => notice(item.message ?? 'Page operation stopped'),
    onLivePointer(event) {
      const current = access?.live.current();
      if (!current || current.sessionId !== event.sessionId || current.workspaceId !== event.workspaceId || current.tabId !== event.tabId) return;
      try { access.live.pointer(event.sessionId, event.event); } catch {}
    },
    onPopupBlocked(item) {
      blockedPopups.unshift({ workspaceId: item.workspaceId, tabId: item.tabId, reason: item.reason, at: Date.now() });
      blockedPopups.length = Math.min(blockedPopups.length, 12);
      emit();
      // Say so where the owner is looking; the list in Site permissions alone made a blocked sign-in window look like nothing happened.
      const owner = workspaceOwners.get(item.workspaceId);
      if (owner && owner.workspaceId === item.workspaceId) send('notice', 'Pop-up blocked. To allow one, open Site permissions and choose Allow one pop-up, then try again.', owner);
    },
    onDownload: input => {
      if (systemLifecycle.status().locked || privateWindows?.ownsWorkspace(input.workspaceId)) { try { input.item.cancel(); } catch {} return; }
      let provenance = null;
      try { provenance = documents.captureDownloadEligibility(engine.getTarget({ workspaceId: input.workspaceId, tabId: input.tabId })); } catch {}
      const historyGuard = createDownloadHistoryGuard({ provenance, identityId: downloadWorkspaceIdentity(input.workspaceId),
        getIdentityId: downloadWorkspaceIdentity, getRuntimeIncarnation: () => engine.runtimeIncarnation,
        getPrivacyState: id => privacy.getPrivacyState(id) });
      privacy.revoke({ workspaceId: input.workspaceId, reason: 'DOWNLOAD_REQUEST' });
      downloads.accept({ ...input, historyGuard });
      emit();
    },
    onChange(event) {
      if (event.preview) { previews?.consume(event); return; }
      if (privateWindows?.observe(event)) return;
      if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'viewport', 'resize', 'zoom', 'window-transfer',
        'page-crashed', 'page-closed', 'privacy'].includes(event.reason)) prints?.invalidate({workspaceId:event.workspaceId,tabId:event.tabId});
      if (closing || closed) return;
      if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'page-crashed', 'page-closed'].includes(event.reason))
        access?.attention.invalidateTab(event.workspaceId, event.tabId);
      if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'page-crashed', 'page-closed', 'window-transfer', 'privacy', 'access-runtime'].includes(event.reason))
        moments?.cancel({ workspaceId: event.workspaceId });
      if (['navigation-start','navigation-commit','navigation-in-page','page-crashed','page-closed','window-transfer','privacy','access-runtime','viewport','zoom'].includes(event.reason))
        prepared?.invalidate({workspaceId:event.workspaceId});
      if (event.reason === 'human-input') privacy.revoke({ workspaceId: event.workspaceId, reason: 'HUMAN_INPUT' });
      const owner = workspaceOwners.get(event.workspaceId);
      // A fresh picker may be settling its viewport while an older picker is
      // stopped. That old cancellation cannot revoke the new pending request.
      if (event.reason === 'review-cancelled' && selecting?.tabId === event.tabId && selecting.phase !== 'pending') selecting = null;
      const tab = state.tabs.find(value => value.id === event.tabId);
      if (['navigation-start', 'navigation-commit', 'navigation-in-page', 'privacy', 'page-crashed', 'page-closed'].includes(event.reason) && owner?.finding?.tabId === event.tabId) owner.finding = null;
      const token = documents.observe(event);
      const liveNow = access?.live.current();
      if (liveNow && liveNow.tabId === event.tabId && liveNow.workspaceId === event.workspaceId) {
        // A reload or route change within the granted sites keeps Live: the new document gets the pointer layer again.
        let granted = false;
        try { granted = liveOriginGranted(liveNow); } catch {}
        if (event.reason === 'navigation-commit' && !granted) access.live.stop('navigated');
        else if (event.reason === 'ready' && granted)
          void engine.beginLivePointer({ workspaceId: liveNow.workspaceId, tabId: liveNow.tabId, sessionId: liveNow.sessionId }).catch(() => {});
      }
      // Kept notes belong to one document and never outlive it or a private takeover.
      if (['navigation-start', 'navigation-commit', 'privacy', 'page-crashed', 'page-closed'].includes(event.reason)) annotateKept.delete(event.tabId);
      if (annotating && (annotating.tabId === event.tabId || (event.reason === 'window-transfer' && annotating.workspaceId === event.workspaceId)) &&
          ['navigation-start', 'navigation-commit', 'privacy', 'page-crashed', 'page-closed', 'access-runtime', 'window-transfer', 'annotation-ended'].includes(event.reason)) {
        const ended = annotating, endedOwner = windows.get(ended.ownerWindowId);
        // The owner did not close it: unsent notes wait for Annotate to be reopened on this document.
        const keep = ['annotation-ended', 'access-runtime', 'window-transfer'].includes(event.reason);
        stopAnnotating(null, { keep });
        if (event.reason === 'annotation-ended' && endedOwner) send('notice', 'Annotate closed because an agent started working in this tab.' + annotateKeptText(ended), endedOwner);
        else if (keep && endedOwner && ended.raw.length) send('notice', 'Annotate closed.' + annotateKeptText(ended), endedOwner);
      }
      if (selecting?.tabId === event.tabId && ['navigation-start', 'navigation-commit', 'navigation-in-page', 'viewport', 'resize', 'find', 'zoom', 'page-crashed', 'page-closed'].includes(event.reason) &&
          !(selecting.phase === 'pending' && ['viewport', 'resize'].includes(event.reason))) {
        selecting = null;
        notice('The page changed during selection. Select the element again.');
      }
      if (tab && token && ['navigation-commit', 'navigation-in-page', 'page-title-updated', 'ready', 'did-stop-loading'].includes(event.reason)) {
        try {
          const url = navigationInput(event.navigation.url);
          const title = url === 'about:blank' ? 'New tab' : cleanPageTitle(event.navigation.title);
          metadataChanges.set(tab.id, { tabId: tab.id, url, title, token });
          // Page lifecycle events are background work. Their document/privacy
          // token, not an inherited renderer action epoch, governs persistence.
          clearTimeout(metadataTimer); metadataTimer = setTimeout(() => void chromeActions.exit(flushMetadata).catch(() => {}), 200);
          if (!historyError) historyRecorder?.accept({ reason: event.reason, token, url, title });
        } catch {}
      }
      if (event.reason === 'page-closed' || event.reason === 'page-crashed') {
        documents.forget(event.tabId); historyRecorder?.forget(event.tabId); metadataChanges.delete(event.tabId);
        if (event.reason === 'page-closed') loaded.delete(event.tabId);
      }
      if (owner) layout(owner); emit();
    },
    onAnnotation(event) {
      const item = annotating;
      if (!item || item.sessionId !== event.sessionId || item.workspaceId !== event.workspaceId || item.tabId !== event.tabId) return;
      const context = windows.get(item.ownerWindowId);
      if (!context) { stopAnnotating(); return; }
      if (event.type === 'ended') {
        // The note layer closed itself: the page interfered with it, or kept removing it.
        const forced = ['tampered', 'host-lost'].includes(event.value);
        stopAnnotating(null, { keep: forced });
        if (forced) send('notice', (event.value === 'tampered' ? 'Annotate closed because this page interfered with the notes bar.'
          : 'Annotate closed because this page kept removing the notes bar.') + annotateKeptText(item), context);
        return;
      }
      if (event.type === 'update') { item.raw = event.notes; item.notes = normalizeNotes(event.notes).map((note, index) => ({ ...note, id: note.id || 'note-' + index })); emit(); return; }
      // A trusted click inside the page's note bar. It takes the same validated
      // action path as the toolbar, so ownership and privacy checks still apply.
      const action = event.type === 'done' ? { type: 'annotate.stop' } : event.type === 'copy' ? { type: 'annotate.copy' } :
        event.type === 'send' ? { type: 'annotate.send', agentSessionId: event.value } :
        event.type === 'detail' ? { type: 'annotate.detail', level: event.value } : null;
      if (action) void act(action, context).catch(error => {
        // The bar's Send shows a busy state from the moment it is pressed. Release it when nothing was sent.
        if (annotating === item && event.type === 'send' && !item.sending) void engine.annotationCommand(annotateQuery(item), 'config', { sending: false }).catch(() => {});
        if (annotating === item) annotateNotify(context, 'error', annotateMessages[error?.code] ??
          (event.type === 'send' ? 'Couldn’t send. If a draft was made, it is in Sent.' : 'That didn’t work. Try again.'));
      });
    },
    onSelection(selection) {
      if (privateWindows?.ownsWorkspace(selection.target?.workspaceId)) return;
      const active = selecting;
      if (!active || selection.captureId !== active.captureId || selection.target.workspaceId !== active.workspaceId || selection.target.tabId !== active.tabId) return;
      selecting = null;
      const workspace = workspaceFor(active.workspaceId);
      void access.createDraft({ target: selection.target, selection, projectId: workspace.projectId }).then(draft => {
        activeDrafts.set(draft.workspaceId, draft.feedbackId);
        const owner = workspaceOwners.get(draft.workspaceId); if (owner) owner.reviewOpen = true;
        emit();
      }, error => notice('Selection could not be saved: ' + (error.code ?? 'SELECTION_FAILED')));
    },
  });
  privateWindows = createPrivateWindowHost({ registry: privateScopes, engine, privacy,
    isCurrent: context => !closed && windows.get(context.id) === context && !context.window.isDestroyed(),
    isChromeReady: context => chromeRecovery.ready(context), assertActionCurrent: assertChromeActionCurrent,
    isSystemReady: () => !systemLifecycle.status().locked,
    bindInput: (wc, context) => bindShortcuts(wc, context), decideClose: context => decideClose('tab', context, true),
    onChange: emit, onNotice: (context, message) => send('notice', message, context), runBackground: work => chromeActions.exit(work) });
  const adoptedPreviews = new WeakMap();
  previews = createPreviewHost({ engine, getState: () => state, captureOwner: capturePreviewOwner,
    assertOwner: (context, intent, { allowClosing }) => {
      if (closed || (!allowClosing && (closing || context.closing)) || context.privateScopeId || windows.get(context.id) !== context ||
          context.window.isDestroyed() || context.workspaceId !== intent.workspaceId || context.workspaceIdentityId !== intent.identityId ||
          workspaceOwners.get(intent.workspaceId) !== context || engine.getWorkspaceOwnerWindow(intent.workspaceId) !== context.window) fail('PREVIEW_STALE');
      return true;
    },
    commit: (command, beforeCommit, onPublished) => transact(command, beforeCommit, { onPublished, deferNative: true }),
    adoptDocument: receipt => { adoptedPreviews.set(receipt, documents.adopt(receipt)); },
    discardAdoption: tabId => { documents.forget(tabId); historyRecorder?.forget(tabId); metadataChanges.delete(tabId); loaded.delete(tabId); },
    didPromote: (context, receipt) => {
      loaded.add(receipt.tabId);
      const token = adoptedPreviews.get(receipt); adoptedPreviews.delete(receipt);
      if (token && !historyError) historyRecorder?.accept({ reason: 'document-adopted', token, url: receipt.navigation.url, title: cleanPageTitle(receipt.navigation.title) });
      layout(context); emit();
    },
    bindInput: (wc, context) => bindShortcuts(wc, context), decideClose: context => decideClose('tab', context, true),
    onChange: context => { layout(context); emit(); } });
  prints = createPagePrintController({
    onChange: emit,
    registerPdfWork: (binding, stop) => privacy.registerObserver({
      workspaceIds:[binding.workspaceId],connectionId:'chrome-pdf-'+randomUUID(),stop,
    }),
    capture({ownerWindowId,tabId}) {
      const context=windows.get(ownerWindowId);
      if (!context || context.closing || context.window.isDestroyed() || !context.window.isVisible() ||
          workspaceOwners.get(context.workspaceId)!==context || blockingWorkspaces.has(context.workspaceId) ||
          context.chromeOverlay) fail('PRINT_CONTEXT_CHANGED');
      const tab=tabFor(tabId), workspace=workspaceFor(context.workspaceId);
      const group=state.groups.find(item=>item.id===workspace.activeGroupId);
      if (tab.workspaceId!==context.workspaceId || group?.activeTabId!==tabId ||
          !visibleTabIds({...state,activeWorkspaceId:context.workspaceId}).includes(tabId) || !loaded.has(tabId)) fail('PRINT_PAGE_UNAVAILABLE');
      const view=engine.getView(query(tab)), wc=view.webContents;
      if (!view.getVisible() || engine.getOwnerWindow(query(tab))!==context.window || wc.isDestroyed() ||
          wc.isLoading() || engine.navigation(query(tab)).crashed || engine.navigation(query(tab)).url==='about:blank') fail('PRINT_PAGE_UNAVAILABLE');
      if (privacy.getPrivacyState(context.workspaceId).blocked || privacy.hasActiveLease(context.workspaceId)) fail('PRINT_PROTECTED');
      privacy.revoke({workspaceId:context.workspaceId,reason:'HUMAN_PAGE_PRINT'});
      const target=engine.getTarget(query(tab));
      const binding={ownerWindowId,workspaceId:context.workspaceId,tabId,window:context.window,webContents:wc,
        title:engine.navigation(query(tab)).title};
      binding.assertCurrent=()=>{
        if (closed || closing || context.closing || windows.get(ownerWindowId)!==context ||
            context.workspaceId!==binding.workspaceId || workspaceOwners.get(binding.workspaceId)!==context ||
            context.window.isDestroyed() || !context.window.isVisible() || context.chromeOverlay ||
            blockingWorkspaces.has(binding.workspaceId) || privacy.getPrivacyState(binding.workspaceId).blocked ||
            privacy.hasActiveLease(binding.workspaceId) ||
            !visibleTabIds({...state,activeWorkspaceId:binding.workspaceId}).includes(tabId) ||
            state.groups.find(item=>item.id===workspace.activeGroupId)?.activeTabId!==tabId ||
            engine.getView(query(tab)).webContents!==wc || !view.getVisible() || wc.isDestroyed()) fail('PRINT_CONTEXT_CHANGED');
        engine.assertCurrentTarget(target);
      };
      return binding;
    },
    chooseSavePath: testPdfSavePath ? async ({name})=>({canceled:false,filePath:testPdfSavePath({name})}) :
      ({window,name})=>dialog.showSaveDialog(window,{title:'Save page as PDF',defaultPath:name,
        filters:[{name:'PDF document',extensions:['pdf']}],properties:['showOverwriteConfirmation']}),
    printPage: testPrintPage,
  });
  for (const workspace of state.workspaces) engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
  function workspaceFacts(workspaceId) {
    const owner = workspaceOwners.get(workspaceId);
    const pages = engine.workspaceActivity(workspaceId).pages;
    const activeConnections = access?.connections().filter(item => item.workspaceId === workspaceId && item.workspaceActive === true) ?? [];
    let feedbackActive = activeDrafts.has(workspaceId);
    if (!feedbackActive && access) { try { feedbackActive = access.drafts(workspaceId).length > 0; } catch { feedbackActive = true; } }
    return { pages, foreground: !!owner || workspaceSelection.reserved(workspaceId) || state.activeWorkspaceId === workspaceId,
      privateMode: privacy.getPrivacyState(workspaceId).blocked || blockingWorkspaces.has(workspaceId),
      downloads: downloads.list(workspaceId).filter(item => !item.canDismiss).length,
      captureActive: previews?.hasWorkspace(workspaceId) || voice?.workspaceId === workspaceId || selecting?.workspaceId === workspaceId ||
        [...windows.values()].some(context => context.workspaceId === workspaceId && !!moments?.view(context)),
      printActive: !!owner && prints?.status(owner.id).busy === true, feedbackActive,
      leaseActive: privacy.hasActiveLease(workspaceId), otherAgents: activeConnections.length,
      calls: activeConnections.reduce((count, item) => count + item.activeRequests, 0) };
  }
  resources = createDesktopResourceMonitor({ directory: dataRoot, getAppMetrics: () => electronApp.getAppMetrics(),
    getSystemMemoryInfo: () => process.getSystemMemoryInfo(), onChange: () => { admission?.tick(); emit(); } });
  admission = createDesktopAdmission({ onChange: emit, observeRuntime: () => {
    const resource = resources.snapshot();
    return { engineRuntimeIncarnation: engine.runtimeIncarnation, workspaces: state.workspaces.flatMap(workspace => {
      const facts = workspaceFacts(workspace.id);
      if (!facts.pages.length) return [];
      return [{ workspaceId: workspace.id, activity: { known: true, calls: facts.calls, downloads: facts.downloads,
        unsavedWork: facts.feedbackActive || facts.pages.some(page => !page.cleanBlank || page.humanTouched || page.busy),
        liveLeases: facts.leaseActive ? 1 : 0, foreground: facts.foreground, captureActive: facts.captureActive || facts.printActive } }];
    }), resources: { available: resource.available, healthy: resource.healthy, sampledAt: resource.sampledAt ?? 0,
      reason: resource.reason, level: resource.level } };
  } });
  workspaceLifecycle = createDesktopWorkspaceLifecycle({ getState: () => state, commit: transact, engine, ensureTab,
    canRelease: workspaceId => workspaceReleaseDecision(workspaceFacts(workspaceId)).release,
    preflight: () => resources.preflight(), captureOwner: captureManagedWorkspaceOwner,
    isOpen: () => !closing && !closed, onChange: emit });
  function captureManagedWorkspaceOwner(workspaceId) {
    const eligible = context => !!context && windows.get(context.id) === context && !context.privateScopeId && !!context.workspaceId &&
      !context.closing && !context.destroying && !context.window.isDestroyed() && !context.window.webContents.isDestroyed() &&
      context.window.webContents.getURL() === DESKTOP_URL && chromeRecovery.ready(context) && workspaceOwners.get(context.workspaceId) === context &&
      engine.getWorkspaceOwnerWindow(context.workspaceId) === context.window && state.workspaces.some(workspace =>
        workspace.id === context.workspaceId && workspace.identityId === context.workspaceIdentityId && workspace.lifecycle?.status !== 'archived');
    const existingWindow = engine.getWorkspaceOwnerWindow(workspaceId), existing = existingWindow && windows.get(existingWindow.id);
    const context = eligible(existing) ? existing : [...windows.values()].find(eligible);
    if (!context) fail('WORKSPACE_WINDOW_UNBOUND');
    const nativeWindow = context.window, sourceId = context.workspaceId, source = workspaceFor(sourceId),
      identityId = source.identityId, generation = source.lifecycle?.generation ?? 0, chrome = captureChromeIntent(context);
    const assertCurrent = () => {
      chrome.assertCurrent();
      const current = state.workspaces.find(workspace => workspace.id === sourceId);
      if (closing || closed || !eligible(context) || context.window !== nativeWindow || context.workspaceId !== sourceId ||
          current?.identityId !== identityId || (current.lifecycle?.generation ?? 0) !== generation) fail('WORKSPACE_OWNER_CHANGED');
      return true;
    };
    assertCurrent();
    return Object.freeze({ assertCurrent, attachWorkspace({ workspaceId: targetId, identityId: targetIdentity }) {
      assertCurrent();
      const target = workspaceFor(targetId), selectedOwner = workspaceOwners.get(targetId);
      if (target.identityId !== targetIdentity || target.lifecycle?.status === 'archived' || (selectedOwner && selectedOwner !== context)) fail('WORKSPACE_OWNER_CHANGED');
      engine.transferWorkspace(targetId, nativeWindow); assertCurrent(); return true;
    } });
  }
  resources.start();
  // A new connection or site request bounces the Dock icon once when Caddi is in the background, so it is not missed.
  const announcedRequests = new Set();
  function announceRequests() {
    if (!access) return;
    const ids = [...access.pendingConnections().map(item => item.requestId),
      ...(access.attention.humanView().requests ?? []).filter(item => item.status === 'pending' && ['site', 'sign-in'].includes(item.kind)).map(item => item.attentionId)];
    const fresh = ids.filter(id => !announcedRequests.has(id));
    for (const id of [...announcedRequests]) if (!ids.includes(id)) announcedRequests.delete(id);
    for (const id of fresh) announcedRequests.add(id);
    if (fresh.length && !BrowserWindow.getFocusedWindow()) { try { electronApp.dock?.bounce('informational'); } catch {} }
  }
  function accessChanged() {
    try { announceRequests(); } catch {}
    if (admission && access) {
      const current = new Map(access.connections().map(item => [item.agentSessionId, item]));
      for (const job of admission.snapshot().jobs) {
        const entry = current.get(job.agentSessionId);
        if (!entry?.workspaceActive || !entry.transportConnected || entry.workspaceId !== job.workspaceId)
          admission.cancelScope({ agentSessionId: job.agentSessionId, reason: 'ACCESS_DENIED' });
      }
    }
    emit();
  }
  // Saved logins: never a private window's workspace, never an archived one.
  const loginWorkspace = id => { const workspace = state.workspaces.find(item => item.id === id);
    return workspace && workspace.lifecycle?.status !== 'archived' && !privateWindows?.ownsWorkspace(id) ? workspace : null; };
  if (loginSecrets) {
    try { logins = createLoginStore({ directory: path.join(dataRoot, 'logins'), secrets: loginSecrets, workspaceFor: loginWorkspace, onChange: () => emit() }); logins.refresh(); }
    catch (error) { logins = null; loginsError = error.code ?? 'LOGINS_UNAVAILABLE'; }
    if (logins) {
      // The Vault's access log and never-save list sit beside the logins, per workspace, and go with a workspace that no longer exists.
      try { vaultActivity = createVaultActivity({ directory: path.join(dataRoot, 'logins', 'activity'), onChange: () => emit() }); vaultActivity.retain(state.workspaces.map(item => item.id)); }
      catch { vaultActivity = null; }
      try { neverSave = createNeverSaveList({ directory: path.join(dataRoot, 'logins'), onChange: () => emit() }); neverSave.retain(state.workspaces.map(item => item.id)); }
      catch { neverSave = null; }
    }
  }
  // The Board: one per project workspace, never a private window's.
  try { board = createBoardStore({ directory: path.join(dataRoot, 'boards'), workspaceFor: loginWorkspace, onChange: () => emit() }); }
  catch { board = null; }
  access = await createDesktopAccess({ directory: runRoot, engine, policy, privacy, listWorkspaces: () => state.workspaces, logins, board,
    // An agent's copy of a board image: JPEG, at most 1600 pixels wide, as the screenshot tool returns.
    boardImage: (workspaceId, itemId) => {
      const image = board.image(workspaceId, itemId);
      let picture = nativeImage.createFromBuffer(image.bytes);
      if (!picture.getSize().width) fail('BOARD_FILE_DAMAGED');
      if (picture.getSize().width > 1600) picture = picture.resize({ width: 1600, quality: 'good' });
      const size = picture.getSize();
      return { image: picture.toJPEG(82).toString('base64'), mimeType: 'image/jpeg', width: size.width, height: size.height };
    },
    onLoginAttempt: ({ workspaceId, login, actor, code }) => logLoginUse({ workspaceId, login, actor, action: 'fill', code }),
    onChange: accessChanged, onControlActivity: ({ workspaceId }) => { agentActivityAt.set(workspaceId, Date.now()); moments?.cancel({ workspaceId }); prints?.invalidate({ workspaceId }); },
    onLiveEnd: event => liveEnded(event),
    // The agent's reply during Live: a highlight on the element it means, drawn by the page layer (the text shows in the toolbar).
    onLiveReply: event => {
      if (!event.key) return;
      // A board card is outlined by the chrome that draws the board; a page element by the page layer.
      if (event.key.startsWith('pb')) {
        const owner = windows.get(access.live.current()?.ownerWindowId);
        const item = owner && board ? board.view(event.workspaceId).items.find(value => boardKey(value.id) === event.key) : null;
        if (item) send('command', { type: 'board-mark', itemId: item.id, label: event.label }, owner);
        return;
      }
      void engine?.liveMark({ workspaceId: event.workspaceId, tabId: event.tabId }, { key: event.key, label: event.label }).catch(() => {});
    },
    nativeKeyStatus, testServiceBackend, systemLifecycle, persistenceConfiguration, allowTestPersistence: !!ownedSystemProof,
    durableWorkspaceLookup: id => { const workspace = state.workspaces.find(item => item.id === id); return workspace ? { ...workspace, durable: true } : null; },
    serviceTransport, captureServiceCredentialOwner, testOwnerCredentialAcquirer, workspaceLifecycleHost: workspaceLifecycle, onQueueChange: emit,
    executePage: (meta, execute) => admission.run(meta, execute) });
  // The chrome shows who is driving; it redraws when control starts or ends, including on expiry.
  const stopLeaseChrome = privacy.onLeaseChange(() => emit());
  connectionConfiguration = createDesktopConnectionConfig({ projectRoot, descriptorPath: path.join(dataRoot, 'mcp', 'runtime.json'), access, runtime: agentRuntime, onChange: emit });
  // One-click setup only ever writes the stable address. A temporary socket path would break at the next restart.
  agentTools = createAgentTools({ ...(agentToolsHome ? { home: agentToolsHome } : {}), onChange: emit, entry: () => {
    const current = connectionConfiguration.snapshot();
    return current.connectionSetup?.mode === 'stable' && current.connectionSetup.status === 'ready' ? current.connectionConfig?.mcpServers?.caddi ?? null : null;
  } });
  prepared = createPreparedEvidence({ privacy, rasterize:createEvidenceRasterizer({BrowserWindow}), onChange:emit,
    current(binding) {
      const owner=windows.get(binding.ownerWindowId);
      if (!owner || owner.closing || owner.workspaceId!==binding.workspaceId || workspaceOwners.get(binding.workspaceId)!==owner ||
          !owner.reviewOpen || activeDrafts.get(binding.workspaceId)!==binding.feedbackId ||
          blockingWorkspaces.has(binding.workspaceId) || privacy.getPrivacyState(binding.workspaceId).blocked) fail('PREPARE_INVALIDATED');
      return currentDraft(binding.workspaceId,binding.feedbackId);
    },
    readSource(binding,artifactId) { return access.previewArtifact({workspaceId:binding.workspaceId,feedbackId:binding.feedbackId,revision:binding.revision,artifactId}); },
  });
  moments = createMomentCaptureController({ engine, privacy, current: momentPage, onChange: emit,
    onExpire: context => {
      if (windows.get(context.id) === context && !context.window.isDestroyed())
        context.window.webContents.send('caddi-desktop:notice', 'Page moment collection expired. Unsaved images were discarded.');
    },
    async commit({ context, info, moments: captured, artifacts, assertCurrent }) {
      const workspace = workspaceFor(context.workspaceId);
      const draft = await access.createDraft({ target: { ...info.target, origin: info.origin },
        selection: { kind: 'page', label: engine.navigation({ workspaceId: context.workspaceId, tabId: info.target.tabId }).title || 'Captured page' },
        projectId: workspace.projectId, evidenceMoments: captured, artifacts, assertCurrent });
      if (!context.closing && context.workspaceId === info.target.workspaceId &&
          workspaceOwners.get(context.workspaceId) === context && !privacy.getPrivacyState(context.workspaceId).blocked) {
        activeDrafts.set(context.workspaceId, draft.feedbackId); context.reviewOpen = true; emit();
      }
      return draft;
    },
  });
  speech = speechResourceRoot
    ? await createBundledSpeechBridge({ resourceRoot: speechResourceRoot, temporaryRoot: runRoot, privacy })
    : await createLocalSpeechBridge({ projectRoot, temporaryRoot: runRoot, privacy });

  async function hydrateWindow(context) {
    if (!context.needsHydration || context.privateScopeId || context.hydrationTask) return context.hydrationTask;
    const intent = captureChromeIntent(context), workspaceId = context.workspaceId, identityId = context.workspaceIdentityId;
    const generation = workspaceFor(workspaceId).lifecycle?.generation ?? null;
    const fence = () => {
      intent.assertCurrent();
      const workspace = workspaceFor(workspaceId);
      if (context.workspaceId !== workspaceId || context.workspaceIdentityId !== identityId || workspace.identityId !== identityId ||
          workspace.lifecycle?.status === 'archived' || (workspace.lifecycle?.generation ?? null) !== generation ||
          workspaceOwners.get(workspaceId) !== context || workspaceLifecycle.isBusy(workspaceId)) fail('WORKSPACE_CHANGED');
      return true;
    };
    context.hydrationTask = chromeActions.run({ assertCurrent: fence }, async () => {
      fence(); await displayCurrent(context); fence(); context.needsHydration = false; emit();
    }).finally(() => { context.hydrationTask = null; });
    return context.hydrationTask;
  }
  async function openPrivateWindow(source) {
    assertChromeActionCurrent();
    if (windows.size >= 8) fail('WINDOW_CAPACITY');
    const nextWindow = newChromeWindow(), next = makeContext(nextWindow, null);
    windows.set(next.id, next); engine.registerWindow(nextWindow, { kind: 'private' }); configureChrome(next);
    try {
      const created = privateWindows.create(next, state.settings);
      workspaceOwners.set(created.workspaceId, next);
      await nextWindow.loadURL(DESKTOP_URL); assertChromeActionCurrent();
      try { await privateWindows.display(next); }
      catch (error) { if (error.code !== 'PAGE_CAPACITY') throw error; send('notice', 'Private window opened. Close a loaded tab to make room for its first page.', next); }
      if (show) { nextWindow.show(); nextWindow.focus(); }
      emit(); return { windowId: next.id, workspaceId: next.workspaceId, privateBrowsing: true };
    } catch (error) {
      const attached = (() => { try { return privateScopes.forContext(next); } catch { return null; } })();
      if (attached) {
        try {
          const closedScope = await privateWindows.close(next);
          if (!closedScope.closed) { if (show) nextWindow.show(); send('notice', 'This private window stayed open because a page asked to remain. Review it before closing.', next); throw error; }
          workspaceOwners.delete(next.workspaceId);
        }
        catch { if (!nextWindow.isDestroyed()) { await nextWindow.loadURL(DESKTOP_URL).catch(() => {}); if (show) nextWindow.show(); } throw error; }
      }
      try { engine.unregisterWindow(nextWindow); }
      catch { next.closing = true; if (show) nextWindow.show(); emit(); throw error; }
      retiringChromeIds.add(nextWindow.webContents.id); windows.delete(next.id); next.destroying = true; nextWindow.destroy(); throw error;
    }
  }
  async function openNormalWindow(source) {
    assertChromeActionCurrent();
    if (windows.size >= 8) fail('WINDOW_CAPACITY');
    const available = state.workspaces.filter(item => item.lifecycle?.status !== 'archived' && !workspaceOwners.has(item.id) &&
      !workspaceLifecycle.isBusy(item.id) && !workspaceSelection.reserved(item.id));
    const nextWindow = newChromeWindow(), next = makeContext(nextWindow, null);
    windows.set(next.id, next); engine.registerWindow(nextWindow, { kind: 'normal' }); configureChrome(next);
    try {
      await nextWindow.loadURL(DESKTOP_URL); assertChromeActionCurrent();
      const workspaceId = (available.find(item => item.id === state.activeWorkspaceId) ?? available.find(item => item.kind === 'project') ?? available[0])?.id ?? await addWorkspace('Personal', 'personal');
      await switchWorkspace(workspaceId, next); assertChromeActionCurrent();
      if (!primaryContext || primaryContext.privateScopeId || primaryContext.window.isDestroyed()) primaryContext = next;
      windowSessions.changed(); if (show) { nextWindow.show(); nextWindow.focus(); }
      emit(); return { windowId: next.id, workspaceId, focusedExisting: false };
    } catch (error) {
      // A published native page stays owned by its normal window on a later
      // failure. It is never transferred into the initiating private context.
      if (next.workspaceId) { if (show) nextWindow.show(); emit(); throw error; }
      try { engine.unregisterWindow(nextWindow); }
      catch { if (show) nextWindow.show(); emit(); throw error; }
      retiringChromeIds.add(nextWindow.webContents.id); windows.delete(next.id); next.destroying = true; nextWindow.destroy(); throw error;
    }
  }
  async function openWorkspaceWindow(context) {
    if (context.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
    if (previews.has(context)) fail('PREVIEW_BUSY');
    if (!context.workspaceId || windows.size >= 8) fail('WINDOW_CAPACITY');
    prints?.invalidate({ownerWindowId:context.id});
    const workspaceId = context.workspaceId;
    const nextWindow = newChromeWindow();
    const next = makeContext(nextWindow, null);
    windows.set(next.id, next);
    engine.registerWindow(nextWindow);
    configureChrome(next);
    let pageReservation;
    try {
      await nextWindow.loadURL(DESKTOP_URL);
      assertChromeActionCurrent();
      if (closing || closed || context.closing) fail('CLOSED');
      if (voice?.ownerWindowId === context.id) await stopVoice();
      if (selecting?.ownerWindowId === context.id) await cancelPicker(context);
      stopAnnotating(context); stopLive(context, 'window');
      stopFinding(context);
      sitePermissions.invalidate({ workspaceId });
      const available = state.workspaces.filter(item => item.id !== workspaceId && item.lifecycle?.status !== 'archived' &&
        !workspaceOwners.has(item.id) && !workspaceLifecycle.isBusy(item.id) && !workspaceSelection.reserved(item.id));
      const fallback = (available.find(item => item.kind === 'project') ?? available[0])?.id ?? null;
      pageReservation = engine.reservePages([...new Set([workspaceId, fallback].filter(Boolean).flatMap(id =>
        visibleTabIds({ ...state, activeWorkspaceId: id })))].map(id => query(tabFor(id))));
      engine.transferWorkspace(workspaceId, nextWindow);
      if (fallback) engine.transferWorkspace(fallback, context.window);
      workspaceOwners.delete(workspaceId);
      context.workspaceId = fallback;
      context.workspaceIdentityId = fallback ? workspaceFor(fallback).identityId : null;
      if (fallback) workspaceOwners.set(fallback, context);
      next.workspaceId = workspaceId;
      next.workspaceIdentityId = workspaceFor(workspaceId).identityId;
      workspaceOwners.set(workspaceId, next);
      await displayCurrent(context, pageReservation);
      await displayCurrent(next, pageReservation);
      windowSessions.changed();
      if (show) { if (!context.window.isDestroyed()) context.window.focus(); nextWindow.show(); nextWindow.focus(); }
      return { windowId: next.id, workspaceId };
    } catch (error) {
      // Any failure before publication leaves the old workspace and its native views in place.
      if (engine.getWorkspaceOwnerWindow(workspaceId) === nextWindow) engine.transferWorkspace(workspaceId, context.window);
      if (context.workspaceId && context.workspaceId !== workspaceId && workspaceOwners.get(context.workspaceId) === context)
        workspaceOwners.delete(context.workspaceId);
      workspaceOwners.set(workspaceId, context);
      context.workspaceId = workspaceId;
      context.workspaceIdentityId = workspaceFor(workspaceId).identityId;
      if (next.workspaceId === workspaceId) next.workspaceId = null;
      try { engine.unregisterWindow(nextWindow); }
      catch { if (show) nextWindow.show(); emit(); throw error; }
      windows.delete(next.id);
      next.destroying = true; if (!nextWindow.isDestroyed()) nextWindow.destroy();
      await displayCurrent(context);
      throw error;
    } finally { pageReservation?.release(); }
  }
  function closeWindow(context, reviewBinding = null) {
    if (context.closeTask) return context.closeTask;
    context.intentGeneration++;
    context.closing = true;
    access?.persistence?.acquisition?.invalidateOwner(context);
    portability.invalidate(context);
    shortcutRecording.stop(context);
    // Capture the remaining normal topology now, before another close in the
    // same debounce interval removes the last normal owner.
    windowSessions.changed();
    externalLinks?.invalidateOwner(context); externalReviewBindings.delete(context);
    prints?.invalidate({ownerWindowId:context.id});
    moments?.cancel({ ownerWindowId: context.id });
    prepared?.invalidate({ownerWindowId:context.id});
    if (context.workspaceId) engine.invalidatePopups({ workspaceId: context.workspaceId });
    const work = async () => {
      if (closed || windows.get(context.id) !== context) return;
      await actionTail;
      if (previews.has(context)) {
        const result = await previews.closeOwner(context);
        if (!result.closed) { context.closing = false; context.closeTask = null; windowSessions.changed(); layout(context); emit(); return false; }
      }
      if (context.privateScopeId) {
        const result = await privateWindows.close(context);
        if (!result.closed) { context.closeTask = null; return false; }
        workspaceOwners.delete(context.workspaceId);
        engine.unregisterWindow(context.window); retiringChromeIds.add(context.window.webContents.id); windows.delete(context.id);
        const survivor = [...windows.values()].find(item => !item.privateScopeId && !item.closing && !item.window.isDestroyed()) ??
          [...windows.values()].find(item => !item.closing && !item.window.isDestroyed());
        if (primaryContext === context) primaryContext = survivor ?? null;
        context.destroying = true; if (!context.window.isDestroyed()) context.window.destroy();
        if (!windows.size && !closeTask) await close(true);
        emit(); return true;
      }
      await moments?.settle({ ownerWindowId: context.id });
      if (reviewBinding && !sameReviewSnapshot(await reviewDirtySnapshot(context), reviewBinding))
        fail('CLOSE_STALE');
      if (windows.size === 1) { if (!closeTask) await close(true); return; }
      if (voice?.ownerWindowId === context.id) await stopVoice();
      if (selecting?.ownerWindowId === context.id) await cancelPicker(context);
      stopAnnotating(context); stopLive(context, 'window');
      stopFinding(context);
      if (context.workspaceId) sitePermissions.invalidate({ workspaceId: context.workspaceId });
      const survivor = [...windows.values()].find(item => item !== context && !item.privateScopeId && !item.closing && !item.window.isDestroyed());
      if (!survivor) {
        // Only private windows remain. Keep normal identities and metadata, but
        // close their native pages with real beforeunload decisions before parking.
        const owned = state.workspaces.filter(workspace => engine.getWorkspaceOwnerWindow(workspace.id) === context.window);
        for (const workspace of owned) {
          for (const entry of access.connections().filter(item => item.workspaceId === workspace.id && !['revoked', 'disconnected'].includes(item.status))) await access.revokeConnection(entry.agentSessionId);
          documents.blockWorkspace(workspace.id); historyRecorder?.cancelWorkspace(workspace.id); admission.cancelScope({ workspaceId: workspace.id, reason: 'WINDOW_CLOSING' });
          for (const page of engine.workspaceAllocations(workspace.id).pages) {
            const result = await closeNativeTab({ workspaceId: workspace.id, id: page.tabId }, context, true);
            if (!result.closed) { context.closing = false; context.closeTask = null; windowSessions.changed(); await displayCurrent(context).catch(() => {}); emit(); return false; }
            loaded.delete(page.tabId); metadataChanges.delete(page.tabId); documents.forget(page.tabId); historyRecorder?.forget(page.tabId);
          }
        }
        parkNormalWindow({ engine, workspaces: owned, ownerWindow: context.window,
          assertCurrent: workspace => { if (windows.get(context.id) !== context || !context.closing || context.window.isDestroyed() ||
            workspaceFor(workspace.id).identityId !== workspace.identityId) fail('WORKSPACE_CHANGED'); return true; } });
        if (workspaceOwners.get(context.workspaceId) === context) workspaceOwners.delete(context.workspaceId);
        retiringChromeIds.add(context.window.webContents.id); windows.delete(context.id);
        if (primaryContext === context) primaryContext = [...windows.values()][0] ?? null;
        context.destroying = true; if (!context.window.isDestroyed()) context.window.destroy();
        windowSessions.changed(); emit(); return true;
      }
      const moved = [];
      try {
        for (const workspace of state.workspaces) if (engine.getWorkspaceOwnerWindow(workspace.id) === context.window) {
          engine.transferWorkspace(workspace.id, survivor.window);
          moved.push(workspace.id);
        }
      } catch (error) {
        for (const workspaceId of moved.reverse()) engine.transferWorkspace(workspaceId, context.window);
        throw error;
      }
      for (const workspaceId of new Set([...moved, context.workspaceId].filter(Boolean))) access.services.revokeWorkspace(workspaceId);
      if (context.workspaceId && workspaceOwners.get(context.workspaceId) === context) {
        workspaceOwners.delete(context.workspaceId);
        if (!survivor.workspaceId) { survivor.workspaceId = context.workspaceId; survivor.workspaceIdentityId = context.workspaceIdentityId; workspaceOwners.set(context.workspaceId, survivor); }
      }
      engine.unregisterWindow(context.window);
      retiringChromeIds.add(context.window.webContents.id);
      windows.delete(context.id);
      if (primaryContext === context) primaryContext = survivor;
      context.destroying = true;
      if (!context.window.isDestroyed()) context.window.destroy();
      if (systemLifecycle.status().locked) layout(survivor); else await displayCurrent(survivor);
      windowSessions.changed();
      if (show && !survivor.closing) { survivor.window.show(); survivor.window.focus(); }
    };
    const task = windowCloseTail.then(work);
    windowCloseTail = task.catch(() => {});
    context.closeTask = task.catch(async error => {
      context.parkingPending = error.code === 'WINDOW_PARK_ROLLBACK_PENDING';
      if (!context.privateScopeId && !context.parkingPending) {
        context.closing = false; windowSessions.changed();
        if (!context.window.isDestroyed() && chromeRecovery.ready(context)) await displayCurrent(context).catch(() => {});
      }
      if (context.parkingPending && !context.window.isDestroyed() && !context.window.webContents.isDestroyed() && context.window.webContents.getURL() === DESKTOP_URL)
        context.window.webContents.send('caddi-desktop:notice', 'This window stayed paused because its browser identities could not be rebound. Retry closing the window to finish safely.');
      context.closeTask = null; throw error;
    });
    return context.closeTask;
  }
  async function reviewDirtySnapshot(context) {
    if (!context.reviewOpen || context.window.isDestroyed() ||
        context.window.webContents.isDestroyed() || context.window.webContents.getURL() !== DESKTOP_URL) return null;
    let timer;
    try {
      const result=await Promise.race([
        context.window.webContents.executeJavaScript('globalThis.__caddiReviewDirtySnapshot?.()'),
        new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('DIRTY_REVIEW_TIMEOUT')),700);})
      ]);
      if (!result || typeof result.dirty!=='boolean' || !Number.isSafeInteger(result.version) || result.version<0 ||
          result.workspaceId!==context.workspaceId ||
          result.feedbackId!==(activeDrafts.get(context.workspaceId)??null) ||
          (result.feedbackId===null ? result.revision!==null :
            !Number.isSafeInteger(result.revision) || result.revision!==currentDraft(context.workspaceId,result.feedbackId).revision)) return null;
      return result;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  function sameReviewSnapshot(left,right) {
    return !!left && !!right && left.dirty===right.dirty && left.workspaceId===right.workspaceId &&
      left.feedbackId===right.feedbackId && left.revision===right.revision && left.version===right.version;
  }
  async function setReviewCloseLock(context, locked) {
    if (context.window.isDestroyed() || context.window.webContents.isDestroyed() ||
        context.window.webContents.getURL()!==DESKTOP_URL) return null;
    try {
      const snapshot=await context.window.webContents.executeJavaScript(
        'globalThis.__caddiReviewCloseGuard?.('+JSON.stringify(locked?'lock':'unlock')+')');
      return locked ? snapshot : true;
    } catch { return null; }
  }
  function requestWindowClose(context) {
    if (!chromeActions.getStore()) return chromeActions.run(systemLifecycle.captureCleanup(), () => requestWindowClose(context));
    if (context.humanCloseTask) return context.humanCloseTask;
    const task = (async () => {
      if (closed || closing || (context.closing && !context.privateScopeId && !context.parkingPending) || windows.get(context.id) !== context) return false;
      if (context.privateScopeId || context.parkingPending) return closeWindow(context);
      engine.cancelHumanClose({ workspaceId: context.workspaceId });
      const survivor = [...windows.values()].find(item => item !== context && !item.closing && !item.window.isDestroyed());
      let reviewBinding=null;
      if (survivor && context.reviewOpen) {
        const before=await reviewDirtySnapshot(context);
        if (!before) return false;
        if (before.dirty) {
          if (!(await decideClose('review-transfer',context))) return false;
          const after=await reviewDirtySnapshot(context);
          if (!sameReviewSnapshot(after,before)) return false;
        }
        const locked=await setReviewCloseLock(context,true);
        const valid=await reviewDirtySnapshot(context);
        if (!sameReviewSnapshot(locked,before) || !sameReviewSnapshot(valid,before)) {
          await setReviewCloseLock(context,false); return false;
        }
        reviewBinding=before;
      }
      try {
        if (!survivor && !(await requestQuit())) return false;
        if (closed || closing || context.closing || windows.get(context.id) !== context || context.window.isDestroyed()) return false;
        return (await closeWindow(context,reviewBinding)) !== false;
      } finally { if (reviewBinding && !context.window.isDestroyed()) await setReviewCloseLock(context,false); }
    })();
    context.humanCloseTask = task.finally(() => { context.humanCloseTask = null; });
    return context.humanCloseTask;
  }

  function currentDraft(workspaceId, feedbackId) {
    const draft = access.drafts(workspaceId).find(item => item.feedbackId === feedbackId);
    if (!draft) fail('FEEDBACK_NOT_FOUND');
    return draft;
  }
  async function beginVoice(input, context = primaryContext) {
    const system = systemLifecycle.capture({ purpose: 'voice-capture' });
    if (!enableMicrophone) fail('MICROPHONE_DISABLED');
    if (voice || liveVoice) fail('RECORDING_BUSY');
    if (!speech.status().available) fail('LOCAL_SPEECH_UNAVAILABLE');
    if (input.workspaceId !== context.workspaceId) fail('WORKSPACE_CHANGED');
    const draft = currentDraft(input.workspaceId, input.feedbackId);
    if (draft.revision !== input.revision) fail('REVISION_CONFLICT');
    const capturePrivacyEpoch = privacy.getPrivacyState(input.workspaceId).capturePrivacyEpoch;
    privacy.assertCapture({ workspaceId: input.workspaceId, capturePrivacyEpoch });
    let resolveAudio;
    const audioStopped = new Promise(resolve => { resolveAudio = resolve; });
    const item = { captureId: randomUUID(), workspaceId: input.workspaceId, ownerWindowId: context.id, feedbackId: input.feedbackId,
      revision: input.revision, capturePrivacyEpoch, controller: new AbortController(), status: 'recording',
      audioStopped, resolveAudio, audioAcknowledged: false, worker: null, system };
    const stop = async () => {
      item.controller.abort();
      const owner = windows.get(item.ownerWindowId);
      if (owner) send('voice-stop', { captureId: item.captureId }, owner);
      speech.cancel(item.captureId);
      await item.audioStopped;
      await item.worker?.catch(() => {});
      clearTimeout(item.timer);
      if (voice === item) voice = null;
      emit(); return { stopped: true };
    };
    item.stop = stop;
    item.observer = privacy.registerObserver({ workspaceIds: [item.workspaceId], connectionId: 'chrome-' + item.captureId, ambientAudio: true, stop });
    item.timer = setTimeout(() => { void stopVoice('duration-limit').catch(() => {}); }, 65_000);
    voice = item; emit();
    return { captureId: item.captureId, workspaceId: item.workspaceId, feedbackId: item.feedbackId, capturePrivacyEpoch, maxDurationMs: 60_000 };
  }
  async function stopVoice() {
    const item = voice; if (!item) return;
    let timer;
    try {
      await Promise.race([item.stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new CaddiError('CAPTURE_STOP_PENDING', 'Microphone stop is still pending')), 4500); })]);
      item.observer.unregister(); clearTimeout(item.timer);
    } finally { clearTimeout(timer); emit(); }
  }
  async function receiveAudio(event, raw) {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    const item = voice;
    if (!raw || !item || item.ownerWindowId !== context.id || item.status !== 'recording' || raw.captureId !== item.captureId || !(raw.pcm16 instanceof Uint8Array) || raw.pcm16.byteLength > 1_920_000 || raw.pcm16.byteLength % 2) fail('INVALID_AUDIO');
    const bytes = Buffer.from(raw.pcm16);
    try {
      item.system.assertCurrent();
      if (!item.audioAcknowledged || item.controller.signal.aborted) fail('CAPTURE_INVALIDATED');
      item.observer.assertCurrent();
      item.status = 'transcribing'; emit();
      item.worker = speech.transcribe({ workspaceId: item.workspaceId, captureId: item.captureId,
        capturePrivacyEpoch: item.capturePrivacyEpoch, pcm16: bytes }, { signal: item.controller.signal, assertCurrent: () => {
          item.system.assertCurrent();
          if (voice !== item || item.controller.signal.aborted || windows.get(item.ownerWindowId)?.workspaceId !== item.workspaceId) fail('CAPTURE_INVALIDATED');
          return item.observer.assertCurrent();
        } });
      const result = await item.worker;
      item.system.assertCurrent();
      item.observer.assertCurrent();
      if (voice !== item || item.controller.signal.aborted) fail('CAPTURE_INVALIDATED');
      // Return the transcript for editing; do not overwrite a draft edited during transcription.
      const owner = windows.get(item.ownerWindowId);
      if (owner) send('command', { type: 'transcript', workspaceId: item.workspaceId, feedbackId: item.feedbackId, revision: item.revision, text: result.text }, owner);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error.code ?? 'TRANSCRIPTION_FAILED' };
    } finally {
      bytes.fill(0); raw.pcm16.fill(0); clearTimeout(item.timer); item.observer.unregister();
      if (voice === item) voice = null; emit();
    }
  }
  function act(raw, context = primaryContext) {
    if (raw?.type !== 'shortcuts.recording') shortcutRecording?.stop(context);
    if (raw?.type === 'window.close') {
      try {
        assertKeys(raw, ['type'], ['type']);
        if (!context || closed || closing || windows.get(context.id) !== context || context.window.isDestroyed()) fail('CLOSED');
        if (!context.closing || (!context.privateScopeId && !context.parkingPending)) chromeRecovery.capture(context).assertCurrent();
        return chromeActions.run(systemLifecycle.captureCleanup(), () => requestWindowClose(context));
      } catch (error) { return Promise.reject(error); }
    }
    if (raw?.type === 'window.normal.open' && context?.privateScopeId && context.closing) {
      try {
        const system = systemLifecycle.capture({ purpose: 'owner-action' });
        assertKeys(raw, ['type'], ['type']);
        const frame = context.window.webContents.mainFrame, processId = frame.processId, routingId = frame.routingId;
        const assertCurrent = () => {
          system.assertCurrent();
          if (closing || closed || windows.get(context.id) !== context || context.window.isDestroyed() || context.window.webContents.isDestroyed()) fail('CLOSED');
          const current = context.window.webContents.mainFrame;
          if (current.isDestroyed() || current.processId !== processId || current.routingId !== routingId || current.url !== DESKTOP_URL) fail('CHROME_RECOVERY_REQUIRED');
          return true;
        };
        assertCurrent(); return chromeActions.run({ assertCurrent }, () => openNormalWindow(context));
      } catch (error) { return Promise.reject(error); }
    }
    let chromeIntent;
    try { chromeIntent = captureChromeIntent(context, systemCleanupAction(raw)); }
    catch (error) { return Promise.reject(error); }
    if (['workspace.create', 'workspace.select', 'workspace.rename', 'workspace.reopen', 'window.open-workspace',
      'group.create', 'group.select', 'tab.select', 'tab.reopen', 'tab.reopen-last', 'tab.close', 'tab.move', 'tab.duplicate',
      'tab.pin', 'tab.favorite', 'navigate', 'back', 'forward', 'reload', 'split.toggle', 'privacy.enter', 'privacy.resume', 'attention.accept', 'preview.open'].includes(raw?.type) ||
        (raw?.type === 'tab.create' && raw.activate !== false) || (raw?.type === 'overlay.set' && raw.open === false)) {
      // Revocation survives switch-away/switch-back. Only openExternalLink's exact
      // internal transition can keep its reviewed receipt alive during a switch.
      context.intentGeneration++;
      access?.persistence?.acquisition?.invalidateOwner(context);
      portability.invalidate(context);
      externalLinks?.invalidateOwner(context); externalReviewBindings.delete(context);
    }
    if (['workspace.select', 'tab.select', 'navigate', 'back', 'forward', 'reload', 'privacy.enter'].includes(raw?.type))
      engine.cancelHumanClose({ workspaceId: context?.workspaceId });
    if (raw?.type === 'tab.close' && typeof raw.tabId === 'string' && pendingTabCloses.has(raw.tabId))
      return pendingTabCloses.get(raw.tabId);
    // Sensitive takeover starts immediately; all other complete user workflows
    // serialize independently of the metadata transaction queue.
    if (['system.continue', 'system.retry-stop', 'default-browser.status', 'default-browser.request', 'connections.create.review', 'connections.rotate.review', 'connections.acquire', 'connections.acquire.cancel', 'persistence.load', 'connections.load', 'feedback.restore', 'connections.share', 'connections.revoke', 'connections.remove', 'privacy.enter', 'attention.dismiss', 'agent.revoke', 'agent.take-over', 'admission.cancel', 'service.grant.revoke', 'service.workspace.revoke', 'service.connection.remove', 'moments.start', 'moments.add', 'moments.cancel',
      'review.invalidate-local', 'review.cancel-pick', 'annotate.stop', 'annotate.copy', 'annotate.detail', 'live.stop', 'live.say', 'live.remove', 'live.copy-prompt', 'page.print', 'page.save-pdf', 'page.copy-markdown', 'portability.import.choose', 'portability.export.review',
      'portability.export.save', 'portability.cancel', 'portability.review.page', 'permission.media.revoke'].includes(raw?.type) ||
        raw?.type === 'permission.respond' && raw.allow === false) return chromeActions.run(chromeIntent, () => perform(raw, context));
    if (queuedActions >= 32 || closing || closed) return Promise.reject(new CaddiError('ACTION_CAPACITY', 'Action queue is unavailable'));
    let queued = raw, shareRevision = null;
    if (raw?.type === 'service.workspace.share') {
      queued = cloneData(raw, { maxBytes: 32768 });
      assertKeys(queued, ['type', ...shapes[queued.type]], ['type', ...shapes[queued.type]]);
      const key = assertId(queued.serviceConnectionId) + ':' + assertId(queued.workspaceId);
      shareRevision = { key, value: serviceShareRevisions.get(key) ?? 0 };
    }
    queuedActions++;
    const result = actionTail.then(() => {
      chromeIntent.assertCurrent();
      if (shareRevision && (serviceShareRevisions.get(shareRevision.key) ?? 0) !== shareRevision.value) fail('SERVICE_DENIED');
      return chromeActions.run(chromeIntent, () => perform(queued, context));
    });
    actionTail = result.catch(() => {}).finally(() => { queuedActions--; });
    if (raw?.type === 'tab.close' && typeof raw.tabId === 'string') {
      pendingTabCloses.set(raw.tabId, result);
      void result.finally(() => { if (pendingTabCloses.get(raw.tabId) === result) pendingTabCloses.delete(raw.tabId); }).catch(() => {});
    }
    return result;
  }
  async function perform(raw, context = primaryContext) {
    assertChromeActionCurrent();
    if (closing || closed || !context || context.closing || windows.get(context.id) !== context || context.window.isDestroyed()) fail('CLOSED');
    const input = cloneData(raw, { maxBytes: 32768 });
    if (!Object.hasOwn(shapes, input.type)) fail('UNKNOWN_ACTION');
    if (input.type === 'tab.create' && !Object.hasOwn(input, 'activate')) input.activate = true;
    if (input.type === 'permission.respond' && !Object.hasOwn(input, 'expectedRevision')) input.expectedRevision = null;
    // Screenshots are a separate owner choice and stay off unless the approval says otherwise.
    if (['agent.approve', 'agent.approve-managed'].includes(input.type) && !Object.hasOwn(input, 'screenshots')) input.screenshots = false;
    // So are saved logins.
    if (['agent.approve', 'agent.approve-managed'].includes(input.type) && !Object.hasOwn(input, 'logins')) input.logins = false;
    if (input.type === 'service.connection.create' && !Object.hasOwn(input, 'provider')) input.provider = 'github';
    const required = ['service.connection.create', 'connections.create.review'].includes(input.type) ?
      shapes[input.type].filter(key => !['owner', 'repository', 'teamId', 'projectId'].includes(key)) :
      shapes[input.type].filter(key => !(optionalKeys[input.type] ?? []).includes(key));
    assertKeys(input, ['type', ...shapes[input.type]], ['type', ...required]);
    const { type, ...args } = input;
    if (BOARD_ACTIONS.has(type)) return boardAction(type, args, context);
    // Going to a page (or starting Live on one) shows the page again.
    if (context.boardOpen && ['tab.select', 'tab.create', 'tab.reopen', 'navigate', 'workspace.select', 'annotate.start'].includes(type)) setBoardOpen(context, false);
    if (type === 'system.continue') return continueSystem(context, args);
    if (type === 'system.retry-stop') return systemLifecycle.retryStop({ ...args, assertOwner: chromeActions.getStore().assertCurrent });
    if (type === 'default-browser.status') {
      const reason = context.privateScopeId ? 'private-window' : systemLifecycle.status().locked ? 'system-paused' : null;
      return reason ? { available: false, revision: 0, http: null, https: null, pending: false, reason } : defaultBrowser.status();
    }
    if (type === 'default-browser.request') return defaultBrowser.request(args, captureDefaultBrowserOwner(context));
    if (['connections.create.review', 'connections.rotate.review', 'connections.acquire', 'connections.acquire.cancel'].includes(type)) {
      const acquisition = access.persistence?.acquisition;
      if (!acquisition) fail('PERSISTENCE_UNAVAILABLE');
      if (type === 'connections.acquire.cancel') return acquisition.cancel(context, args);
      captureServiceCredentialOwner(context, { workspaceId: context.workspaceId, identityId: context.workspaceIdentityId });
      return acquisition[type === 'connections.create.review' ? 'reviewCreate' : type === 'connections.rotate.review' ? 'reviewRotate' : 'acquire'](context, args);
    }
    if (['persistence.load', 'connections.load', 'feedback.restore', 'connections.share', 'connections.revoke', 'connections.remove'].includes(type)) {
      if (!access.persistence) fail('PERSISTENCE_UNAVAILABLE');
      const owner = capturePersistenceOwner(context, type === 'feedback.restore' ? args.workspaceId : context.workspaceId,
        type === 'feedback.restore' ? args.expectedWorkspaceIdentityId : null);
      if (type === 'persistence.load') return access.persistence.load(owner);
      if (type === 'connections.load') return access.persistence.loadConnections(owner);
      if (type === 'feedback.restore') return access.persistence.restoreFeedback({ workspaceId: args.workspaceId }, owner);
      if (type === 'connections.share') {
        const destination = workspaceFor(args.workspaceId), identityId = destination.identityId;
        if (identityId !== args.expectedWorkspaceIdentityId || destination.kind !== 'project' || destination.lifecycle?.status === 'archived') fail('PERSISTENCE_IDENTITY_CHANGED');
        const assertCurrent = () => { owner.assertCurrent(); const current = workspaceFor(args.workspaceId);
          if (current.identityId !== identityId || current.kind !== 'project' || current.lifecycle?.status === 'archived') fail('PERSISTENCE_IDENTITY_CHANGED'); return true; };
        const { expectedWorkspaceIdentityId: _identity, ...input } = args;
        return access.persistence.owner.shareConnection({ ...input, identityId }, { assertCurrent });
      }
      return access.persistence.owner[type === 'connections.revoke' ? 'revokeShare' : 'removeConnection'](args, owner);
    }
    if (type === 'window.private.open') return openPrivateWindow(context);
    if (type === 'window.normal.open') return openNormalWindow(context);
    if (type === 'shortcuts.save') {
      const intent = chromeActions.getStore() ?? captureChromeIntent(context);
      const result = await shortcuts.save(args, { beforeCommit: intent.assertCurrent }); installMenu(); emit(); return result;
    }
    if (type === 'shortcuts.recording') return shortcutRecording.set(context, args.active);
    if (type === 'welcome.complete') { await welcome.complete(); emit(); return true; }
    if (context.privateScopeId && type !== 'appearance.set') return privateWindows.act(context, input);
    if (type === 'preview.open') { await prepareSelectionChange(context); return previews.open(context, args); }
    if (type === 'preview.close') { const result = await previews.close(context, args); layout(context); emit(); return result; }
    if (type === 'preview.promote') return previews.promote(context, args);
    if (previews.has(context) && !['appearance.set', 'overlay.set', 'privacy.enter', 'privacy.resume', 'agent.revoke', 'agent.take-over', 'admission.cancel',
      'service.workspace.revoke', 'service.grant.revoke', 'service.connection.remove', 'attention.dismiss', 'external-links.dismiss', 'external-links.close', 'storage.usage', 'portability.cancel'].includes(type)) fail('PREVIEW_BUSY');
    if (moments && !type.startsWith('moments.') && type !== 'appearance.set' && !(type === 'tab.create' && args.activate === false)) moments.cancel({ ownerWindowId: context.id });
    if (args.tabId && tabFor(args.tabId).workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH');
    if (args.groupId && state.groups.find(group => group.id === args.groupId)?.workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH');
    if (args.folderId && state.folders.find(folder => folder.id === args.folderId)?.workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH');
    if (args.workspaceId && !['workspace.select', 'workspace.rename', 'workspace.reopen', 'agent.approve', 'service.workspace.share', 'service.workspace.revoke', 'external-links.open'].includes(type) &&
        !(type === 'tab.create' && args.activate === false) && args.workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH');
    const mutationWorkspace = args.workspaceId ?? (args.tabId ? tabFor(args.tabId).workspaceId : context.workspaceId);
    if (mutationWorkspace && workspaceLifecycle?.isBusy(mutationWorkspace) &&
        !['privacy.enter', 'agent.revoke', 'agent.take-over', 'admission.cancel', 'service.workspace.revoke', 'service.grant.revoke', 'service.connection.remove'].includes(type)) fail('WORKSPACE_TRANSITION');
    switch (type) {
      case 'portability.import.choose': return portability.chooseImport(context, args);
      case 'portability.import.apply': return portability.applyImport(context, args);
      case 'portability.export.review': return portability.reviewExport(context, args);
      case 'portability.export.save': return portability.exportSave(context, args);
      case 'portability.review.page': return portability.page(context, args);
      case 'portability.cancel': return portability.cancel(context, args);
      case 'appearance.set': {
        if (!['system', 'light', 'dark'].includes(args.choice)) fail('INVALID_ARGUMENT');
        await appearance.set(args.choice); emit(); return appearance.get();
      }
      case 'storage.usage': {
        const workspace = workspaceFor(args.workspaceId), chromeIntent = chromeActions.getStore() ?? chromeRecovery.capture(context);
        const identityId = workspace.identityId, generation = workspace.lifecycle?.generation ?? null;
        const privacyEpoch = privacy.getPrivacyState(workspace.id).capturePrivacyEpoch, intentGeneration = context.intentGeneration;
        const beforeRead = () => {
          chromeIntent.assertCurrent(); const current = workspaceFor(workspace.id);
          if (context.closing || context.privateScopeId || context.workspaceId !== workspace.id || context.workspaceIdentityId !== identityId ||
              context.intentGeneration !== intentGeneration || current.identityId !== identityId ||
              (current.lifecycle?.generation ?? null) !== generation || current.lifecycle?.status === 'archived' ||
              workspaceOwners.get(workspace.id) !== context || privacy.getPrivacyState(workspace.id).capturePrivacyEpoch !== privacyEpoch) fail('STORAGE_CONTEXT_CHANGED');
          return true;
        };
        beforeRead(); const result = await engine.humanStorageUsage({ workspaceId: workspace.id, identityId, expectedOwnerWindow: context.window, beforeRead });
        beforeRead(); return result;
      }
      case 'workspace.create': { const id = await addWorkspace(args.name, args.kind); await switchWorkspace(id, context); return id; }
      case 'workspace.select': return switchWorkspace(args.workspaceId, context);
      case 'workspace.reopen': {
        const workspace = workspaceFor(args.workspaceId);
        const chromeIntent = chromeActions.getStore() ?? chromeRecovery.capture(context);
        assertInteger(args.expectedGeneration, 'workspace generation', { min: 1 });
        if (workspace.lifecycle?.status !== 'archived' || workspace.lifecycle.generation !== args.expectedGeneration) fail('WORKSPACE_LIFECYCLE_STALE');
        access.invalidateManagedWorkspace(workspace.id);
        const result = await workspaceLifecycle.reopen({ workspaceId: workspace.id, identityId: workspace.identityId,
          generation: args.expectedGeneration, assertCurrent: () => {
            chromeIntent.assertCurrent();
            if (closed || closing || context.closing || windows.get(context.id) !== context || context.window.isDestroyed()) fail('CLOSED');
            return true;
          } });
        await switchWorkspace(workspace.id, context); return result;
      }
      case 'workspace.rename': if (args.workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH'); await transact({ type, ...args }); break;
      case 'window.open-workspace': return openWorkspaceWindow(context);
      case 'group.create': {
        if (args.workspaceId !== context.workspaceId) fail('WORKSPACE_CHANGED');
        await prepareSelectionChange(context);
        const id = 'group-' + randomUUID();
        await transact({ type, id, workspaceId: args.workspaceId, name: args.name, color: '#337765' });
        await transact({ type: 'group.select', groupId: id }); stopFinding(context); await displayCurrent(context); return id;
      }
      case 'group.rename': case 'folder.rename': case 'folder.collapse': case 'folder.move':
      case 'tab.rename': await transact(input); break;
      case 'group.reorder': case 'folder.reorder': case 'tab.reorder': {
        const { expectedRevision, ...command } = input; assertInteger(expectedRevision, 'reviewed order revision');
        if (state.revision !== expectedRevision) fail('ORDER_STALE');
        await transact(command, () => { if (state.revision !== expectedRevision) fail('ORDER_STALE'); return true; }); return true;
      }
      case 'folder.remove': {
        let before;
        const after = await transact(input, () => { before ??= state; return true; });
        let undoAvailable = false;
        try { undoAvailable = organizationUndo.record(before, after, args.folderId).available === true; }
        catch { send('notice', 'Folder removed. Undo is unavailable for this removal.', context); }
        emit(); return { removed: true, undoAvailable };
      }
      case 'folder.undo': {
        const command = organizationUndo.prepare(state, context.workspaceId, args.undoId);
        await transact(command, () => { organizationUndo.prepare(state, context.workspaceId, args.undoId); return true; });
        organizationUndo.complete(args.undoId); emit(); return { restored: true };
      }
      case 'external-links.review': return beginExternalReview(context);
      case 'external-links.dismiss': if (!externalLinks) fail('EXTERNAL_LINK_CLOSED'); return externalLinks.dismiss({ owner: context, ...args });
      case 'external-links.close': if (!externalLinks) fail('EXTERNAL_LINK_CLOSED'); if (externalReviewBindings.get(context)?.reviewId === args.reviewId) externalReviewBindings.delete(context); return externalLinks.closeReview({ owner: context, ...args });
      case 'external-links.open': return openExternalLink(context, args);
      case 'group.select': {
        const group = state.groups.find(item => item.id === args.groupId);
        if (!group || group.workspaceId !== context.workspaceId) fail('GROUP_MISMATCH');
        await prepareSelectionChange(context); await transact(input); await displayCurrent(context); break;
      }
      case 'folder.create': {
        const group = state.groups.find(item => item.id === args.groupId);
        if (!group || group.workspaceId !== context.workspaceId) fail('GROUP_MISMATCH');
        const id = 'folder-' + randomUUID();
        await transact({ type, id, workspaceId: group.workspaceId, groupId: group.id, name: args.name, parentId: args.parentId }); return id;
      }
      case 'tab.move': {
        const tab = tabFor(args.tabId), destination = state.groups.find(item => item.id === args.groupId);
        if (!destination || destination.workspaceId !== tab.workspaceId || tab.workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH');
        await prepareSelectionChange(context); await transact(input); await displayCurrent(context); break;
      }
      case 'tab.duplicate': {
        const tab = tabFor(args.tabId);
        if (tab.workspaceId !== context.workspaceId || state.tabs.filter(item => item.status === 'open').length >= 256) fail('TAB_CAPACITY');
        await prepareSelectionChange(context);
        const id = 'tab-' + randomUUID();
        await transact({ type, sourceTabId: tab.id, id, now: Date.now() });
        await displayCurrent(context); return id;
      }
      case 'history.list': {
        if (args.workspaceId !== context.workspaceId) fail('WORKSPACE_CHANGED');
        if (!history || historyError) fail('HISTORY_UNAVAILABLE');
        return history.list({ workspaceId: args.workspaceId, query: args.query });
      }
      case 'history.remove': case 'history.clear': {
        if (args.workspaceId !== context.workspaceId) fail('WORKSPACE_CHANGED');
        if (!history || historyError) fail('HISTORY_UNAVAILABLE');
        // Clearing drops earlier delayed visits. Removing one row first drains
        // accepted visits so unrelated pages in the same workspace are retained.
        if (type === 'history.clear') historyRecorder?.cancelWorkspace(args.workspaceId);
        else await historyRecorder?.flush();
        try { const result = await history[type === 'history.remove' ? 'remove' : 'clear'](args); emit(); return result; }
        catch (error) { if (error.code !== 'HISTORY_BUSY') historyError = error.code ?? 'HISTORY_UNAVAILABLE'; emit(); throw error; }
      }
      case 'download.control': case 'download.reveal': {
        if (args.workspaceId !== context.workspaceId) fail('WORKSPACE_CHANGED');
        if (type === 'download.control') return downloads.control(args);
        const workspace = workspaceFor(args.workspaceId), identityId = workspace.identityId, generation = workspace.lifecycle?.generation ?? 0;
        const privacyEpoch = privacy.getPrivacyState(workspace.id).capturePrivacyEpoch, intentGeneration = context.intentGeneration;
        const chromeIntent = chromeActions.getStore() ?? chromeRecovery.capture(context);
        const beforeReveal = () => {
          chromeIntent.assertCurrent(); const current = workspaceFor(workspace.id);
          if (closed || closing || context.closing || context.privateScopeId || windows.get(context.id) !== context || context.window.isDestroyed() ||
              context.workspaceId !== workspace.id || context.intentGeneration !== intentGeneration || workspaceOwners.get(workspace.id) !== context ||
              engine.getWorkspaceOwnerWindow(workspace.id) !== context.window || current.identityId !== identityId ||
              (current.lifecycle?.generation ?? 0) !== generation || current.lifecycle?.status === 'archived' ||
              privacy.getPrivacyState(workspace.id).capturePrivacyEpoch !== privacyEpoch) fail('DOWNLOAD_CONTEXT_CHANGED');
          return true;
        };
        return downloads.reveal(args, { beforeReveal });
      }
      case 'page.print': return prints.print({ownerWindowId:context.id,tabId:args.tabId});
      case 'page.save-pdf': return prints.savePdf({ownerWindowId:context.id,tabId:args.tabId});
      case 'page.copy-markdown': return copyPageMarkdown(context, args.tabId);
      case 'permission.respond': {
        if (args.workspaceId !== context.workspaceId) fail('WORKSPACE_CHANGED');
        return mediaHost.respond(context, args);
      }
      case 'permission.media.revoke': return mediaHost.revoke(context, args);
      case 'permission.media.end': return mediaHost.end(context, args);
      case 'popup.allow-once': {
        const tab = tabFor(args.tabId);
        if (tab.workspaceId !== context.workspaceId || !visibleTabIds({ ...state, activeWorkspaceId: context.workspaceId }).includes(tab.id)) fail('TAB_NOT_ACTIVE');
        return engine.allowPopupOnce({ ...query(tab), ownerWindowId: context.id });
      }
      case 'popup.cancel': return engine.cancelPopupGrant({ workspaceId: context.workspaceId, tabId: args.tabId, ownerWindowId: context.id });
      case 'popup.close': return engine.closePopup({ workspaceId: context.workspaceId, popupId: args.popupId, ownerWindowId: context.id });
      case 'find': case 'find.stop': case 'zoom.set': case 'mute.set': {
        const tab = tabFor(args.tabId);
        if (tab.workspaceId !== context.workspaceId || !visibleTabIds({ ...state, activeWorkspaceId: context.workspaceId }).includes(tab.id)) fail('TAB_NOT_ACTIVE');
        await ensureTab(tab);
        if (type === 'find') {
          if (context.finding && (context.finding.tabId !== tab.id || context.finding.workspaceId !== tab.workspaceId)) stopFinding(context);
          const result = engine.find({ ...query(tab), text: args.text, forward: args.forward, findNext: args.findNext, matchCase: args.matchCase });
          context.finding = query(tab); return result;
        }
        if (type === 'find.stop') { if (context.finding?.tabId === tab.id) stopFinding(context); else engine.stopFind(query(tab)); return true; }
        await cancelPicker(context);
        return type === 'zoom.set' ? engine.setZoom({ ...query(tab), factor: args.factor }) : engine.setMuted({ ...query(tab), muted: args.muted });
      }
      case 'tab.create': {
        const workspace = workspaceFor(args.workspaceId);
        if (typeof args.activate !== 'boolean') fail('INVALID_ARGUMENT');
        if (workspace.lifecycle?.status === 'archived') fail('WORKSPACE_ARCHIVED');
        if (state.tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
        if (args.activate) { if (loaded.size >= 32) fail('PAGE_CAPACITY'); await prepareSelectionChange(context); }
        const id = 'tab-' + randomUUID();
        await transact({ type, id, workspaceId: workspace.id, groupId: workspace.activeGroupId,
          url: navigationInput(args.input), title: 'New tab', now: Date.now(), activate: args.activate }, () => {
            if (state.tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
            if (workspaceLifecycle.isBusy(workspace.id) || workspaceFor(workspace.id).lifecycle?.status === 'archived') fail('WORKSPACE_TRANSITION');
            return true;
          });
        if (!args.activate) return id;
        await transact({ type: 'tab.select', tabId: id, now: Date.now() });
        await displayCurrent(context); return id;
      }
      case 'tab.select': case 'tab.reopen': {
        assertPageCapacity([args.tabId]);
        await prepareSelectionChange(context);
        await transact({ type, ...args, now: Date.now() }); await displayCurrent(context); break;
      }
      case 'tab.reopen-last': {
        const recent = [...recentlyClosed].reverse().find(id => state.tabs.some(item => item.id === id && item.workspaceId === context.workspaceId && item.status === 'closed'));
        const tab = recent ? state.tabs.find(item => item.id === recent) : state.tabs.filter(item => item.workspaceId === context.workspaceId && item.status === 'closed')
          .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
        if (!tab) fail('NO_CLOSED_TAB');
        return perform({ type:'tab.reopen', tabId:tab.id }, context);
      }
      case 'tab.pin': case 'tab.favorite': {
        // Removing a workspace favorite can repair cross-group selection/splits.
        // Apply the same teardown when that metadata change replaces visible pages.
        const next = applyProductCommand(state, input);
        const before = visibleTabIds({ ...state, activeWorkspaceId: context.workspaceId });
        const after = visibleTabIds({ ...next, activeWorkspaceId: context.workspaceId });
        if (JSON.stringify(before) !== JSON.stringify(after)) await prepareSelectionChange(context);
        await transact(input); await displayCurrent(context); break;
      }
      case 'tab.close': {
        const tab = tabFor(args.tabId);
        let assertClosed;
        if (loaded.has(tab.id)) {
          const owner = workspaceOwners.get(tab.workspaceId);
          if (owner !== context || engine.getWorkspaceOwnerWindow(tab.workspaceId) !== context.window) fail('WORKSPACE_CHANGED');
          const result = await closeNativeTab(tab, context);
          if (!result.closed) return { closed: false };
          assertClosed = result.assertClosed;
          loaded.delete(tab.id);
        }
        metadataChanges.delete(tab.id);
        return commitClosedPage({ commit: () => transact(input, assertClosed, { acknowledgedClose: true }), display: async () => {
          assertChromeActionCurrent();
          recentlyClosed.push(tab.id);
          if (recentlyClosed.length > 128) recentlyClosed.shift();
          engine.invalidatePopups({ workspaceId: tab.workspaceId, tabId: tab.id });
          if (context.finding?.tabId === tab.id) stopFinding(context); documents.forget(tab.id); historyRecorder?.forget(tab.id);
          privacy.revoke({ workspaceId: tab.workspaceId, reason: 'TAB_CLOSED' });
          if (voice?.ownerWindowId === context.id) await stopVoice(); await cancelPicker(context);
          if (closing || closed || context.closing || context.window.isDestroyed()) fail('CLOSED');
          if (privacy.getPrivacyState(tab.workspaceId).blocked) fail('PRIVACY_BLOCKED');
          if (workspaceOwners.get(tab.workspaceId) !== context || context.workspaceId !== tab.workspaceId) fail('WORKSPACE_CHANGED');
          // Closing a background tab keeps the page in view. Closing the shown tab shows its neighbour, as other browsers do,
          // not the first tab of the group.
          const group = state.groups.find(value => value.id === tab.groupId), index = state.tabs.findIndex(value => value.id === tab.id);
          const candidates = state.tabs.map((value, at) => ({ value, at })).filter(({ value }) => value.workspaceId === tab.workspaceId &&
            value.groupId === tab.groupId && value.status === 'open' && !value.dormant);
          const next = (candidates.find(item => item.at > index) ?? candidates.at(-1))?.value;
          if (next && !group?.activeTabId && !group?.activeLayoutId) await transact({ type: 'tab.select', tabId: next.id, now: Date.now() });
          await displayCurrent(context);
        }, onDisplayUnavailable: code => {
          layout(context); emit();
          send('notice', code === 'PAGE_CAPACITY' ? 'Tab closed. The next page could not load because 32 page slots are in use. Close another loaded tab, then select a tab to retry.' :
            'Tab closed. The next page could not be displayed. Review this workspace and select a tab to continue.', context);
        } });
      }
      case 'stop': { const tab = tabFor(args.tabId); if (tab.workspaceId !== context.workspaceId) fail('WORKSPACE_MISMATCH'); if (loaded.has(tab.id)) engine.stop(query(tab)); emit(); break; }
      case 'navigate': case 'back': case 'forward': case 'reload': {
        const tab = tabFor(args.tabId); await ensureTab(tab);
        sitePermissions.invalidate({ workspaceId: tab.workspaceId, tabId: tab.id });
        engine.invalidatePopups({ workspaceId: tab.workspaceId, tabId: tab.id });
        await cancelPicker(context); privacy.revoke({ workspaceId: tab.workspaceId, reason: 'HUMAN_NAVIGATION' });
        // Start the load and return: waiting here would hold every later tab, window and menu action until the page finished.
        if (type === 'navigate') engine.startHumanNavigation({ ...query(tab), url: navigationInput(args.input) });
        else await engine[type](query(tab));
        if (type === 'navigate') try { engine.getView(query(tab)).webContents.focus(); } catch {}
        layout(context); emit(); break;
      }
      case 'split.toggle': {
        await prepareSelectionChange(context);
        const tab = tabFor(args.tabId), group = state.groups.find(value => value.id === tab.groupId);
        if (group?.activeLayoutId) await transact({ type: 'layout.clear', groupId: group.id });
        else {
          const other = state.tabs.find(value => value.id !== tab.id && value.workspaceId === tab.workspaceId && value.groupId === tab.groupId && value.status === 'open' && !value.dormant);
          if (!other) fail('SECOND_TAB_REQUIRED');
          await transact({ type: 'layout.set', id: 'layout-' + randomUUID(), groupId: group.id, tabIds: [tab.id, other.id], orientation: 'horizontal', ratio: 0.5 });
        }
        await displayCurrent(context); break;
      }
      case 'review.open': context.reviewOpen = true; emit(); break;
      case 'moments.start': stopAnnotating(context); return moments.start(context, args.tabId);
      case 'moments.add': return moments.add(context);
      case 'moments.stop': return moments.stop(context);
      case 'moments.cancel': moments.cancel({ ownerWindowId: context.id }); break;
      case 'review.close': prepared?.invalidate({ownerWindowId:context.id}); if (voice?.ownerWindowId === context.id) await stopVoice(); await cancelPicker(context); context.reviewOpen = false; emit(); break;
      case 'review.cancel-pick': await cancelPicker(context); break;
      case 'overlay.set': {
        if (typeof args.open !== 'boolean') fail('INVALID_ARGUMENT');
        // Photograph the pages before hiding them, so the dialog opens over the page instead of a blank window.
        const backdrop = args.open && !context.chromeOverlay ? await capturePageBackdrop(state.tabs.filter(tab => loaded.has(tab.id)).flatMap(tab => {
          try { return engine.getOwnerWindow(query(tab)) === context.window ? [engine.getView(query(tab))] : []; } catch { return []; }
        }), context.pageRect) : [];
        context.chromeOverlay = args.open; layout(context); return { backdrop };
      }
      case 'annotate.start': {
        if (annotating && annotating.ownerWindowId !== context.id) fail('ANNOTATE_BUSY');
        if (annotating) return annotateView(context);
        if (context.privateScopeId || !context.workspaceId || workspaceOwners.get(context.workspaceId) !== context ||
            blockingWorkspaces.has(context.workspaceId) || privacy.getPrivacyState(context.workspaceId).blocked) fail('ANNOTATE_UNAVAILABLE');
        const workspace = workspaceFor(context.workspaceId), group = state.groups.find(item => item.id === workspace.activeGroupId);
        const tab = state.tabs.find(item => item.id === group?.activeTabId && item.workspaceId === workspace.id && item.status === 'open');
        if (!tab || !loaded.has(tab.id) || engine.navigation(query(tab)).url === 'about:blank') fail('ANNOTATE_NO_PAGE');
        if (voice?.ownerWindowId === context.id || moments?.view(context) || previews?.has(context)) fail('ANNOTATE_UNAVAILABLE');
        if (access.live.current()?.ownerWindowId === context.id) fail('LIVE_ACTIVE');
        await cancelPicker(context);
        if (selecting) fail('SELECTION_BUSY');
        // An agent that holds control keeps it. Notes start once it lets go.
        if (privacy.hasActiveLease(tab.workspaceId)) fail('AGENT_CONTROL_ACTIVE');
        const request = { ...query(tab), ownerWindowId: context.id, sessionId: randomUUID(), phase: 'pending', notes: [], raw: [], sending: false };
        const kept = annotateKept.get(tab.id);
        annotating = request; emit();
        try {
          await engine.beginAnnotation({ ...query(tab), sessionId: request.sessionId, detail: annotateDetail, agents: annotateAgents(tab.workspaceId), restore: kept?.raw ?? [] });
          if (annotating !== request) fail('CANCELLED');
          // The session owns the restored notes now (the layer has already reported them).
          if (annotateKept.get(tab.id) === kept) annotateKept.delete(tab.id);
          request.phase = 'active';
          // Keys go to the page: Escape leaves the mode and the note field can take focus.
          try { engine.getView(query(tab)).webContents.focus(); } catch {}
          emit(); return annotateView(context);
        } catch (error) { if (annotating === request) { annotating = null; emit(); } throw error; }
      }
      case 'annotate.stop': stopAnnotating(context); break;
      case 'live.start': return startLive(context, validateLiveAction(type, args));
      case 'live.stop': validateLiveAction(type, args); await finishLiveVoice(context); stopLive(context, 'stopped'); break;
      case 'live.say': {
        const { text } = validateLiveAction(type, args), current = liveSession(context);
        return access.live.instruct({ sessionId: current.sessionId, text, source: 'typed', page: livePage(current) });
      }
      case 'live.remove': { const { instructionId } = validateLiveAction(type, args); liveSession(context); access.live.remove(instructionId); break; }
      case 'live.copy-prompt': {
        validateLiveAction(type, args);
        if (context.privateScopeId) fail('LIVE_UNAVAILABLE');
        clipboard.writeText(LIVE_AGENT_PROMPT);
        testClipboardWrite?.(LIVE_AGENT_PROMPT);
        return true;
      }
      case 'annotate.copy': return annotateCopy(context);
      case 'annotate.send': {
        if (args.agentSessionId !== null) assertId(args.agentSessionId);
        return annotateSend(context, args.agentSessionId);
      }
      case 'annotate.clear': await engine.annotationCommand(annotateQuery(annotateSession(context)), 'clear'); break;
      case 'annotate.detail': {
        if (!DETAIL_LEVELS.includes(args.level)) fail('INVALID_ARGUMENT');
        annotateDetail = args.level;
        if (annotating?.ownerWindowId === context.id && annotating.phase === 'active')
          void engine.annotationCommand(annotateQuery(annotating), 'config', { detail: annotateDetail }).catch(() => {});
        emit(); return annotateDetail;
      }
      case 'review.pick': {
        stopAnnotating(context);
        if (selecting && selecting.ownerWindowId !== context.id) fail('SELECTION_BUSY');
        const tab = tabFor(args.tabId); await ensureTab(tab); await cancelPicker(context);
        const request = { ...query(tab), ownerWindowId: context.id, captureId: randomUUID(), phase: 'pending' };
        selecting = request; emit();
        try {
          const result = await engine.beginSelection({ ...request, mode: 'element' });
          if (selecting === request) { request.phase = 'active'; emit(); }
          return result;
        }
        catch (error) { if (selecting === request) selecting = null; emit(); throw error; }
      }
      case 'review.page': {
        if (selecting && selecting.ownerWindowId !== context.id) fail('SELECTION_BUSY');
        const tab = tabFor(args.tabId); await ensureTab(tab); await cancelPicker(context);
        const info = engine.getPageInfo(query(tab));
        const draft = await access.createDraft({ target: { ...info.target, origin: info.origin },
          selection: { kind: 'page', label: engine.navigation(query(tab)).title || 'Entire page' }, projectId: workspaceFor(tab.workspaceId).projectId });
        activeDrafts.set(tab.workspaceId, draft.feedbackId); context.reviewOpen = true; emit(); return draft;
      }
      case 'review.select': prepared?.invalidate({ownerWindowId:context.id}); currentDraft(args.workspaceId, args.feedbackId); activeDrafts.set(args.workspaceId, args.feedbackId); emit(); break;
      case 'review.invalidate-local': prepared?.invalidate({ownerWindowId:context.id}); break;
      case 'review.edit': { prepared?.invalidate({ownerWindowId:context.id}); const draft = access.editDraft(args); emit(); return draft; }
      case 'review.prepare-local': {
        if (!context.reviewOpen || context.workspaceId!==args.workspaceId || workspaceOwners.get(args.workspaceId)!==context ||
            activeDrafts.get(args.workspaceId)!==args.feedbackId || currentDraft(args.workspaceId,args.feedbackId).revision!==args.revision ||
            blockingWorkspaces.has(args.workspaceId) || privacy.getPrivacyState(args.workspaceId).blocked) fail('PREPARE_UNAVAILABLE');
        return prepared.prepare({ownerWindowId:context.id,...args});
      }
      case 'review.edit-moment': {
        prepared?.invalidate({ownerWindowId:context.id});
        if (!context.reviewOpen || workspaceOwners.get(context.workspaceId) !== context ||
            activeDrafts.get(context.workspaceId) !== args.feedbackId || blockingWorkspaces.has(context.workspaceId) ||
            privacy.getPrivacyState(context.workspaceId).blocked) fail('REVIEW_UNAVAILABLE');
        const draft = access.editMoment(args); emit(); return draft;
      }
      case 'review.send': { const delivery = access.sendFeedback(args); emit(); return delivery; }
      case 'review.cancel': access.cancelFeedback(args); emit(); break;
      case 'review.deselect': prepared?.invalidate({ownerWindowId:context.id}); if (context.workspaceId) activeDrafts.delete(context.workspaceId); emit(); break;
      case 'sent.open': case 'sent.copy': case 'sent.delete': case 'sent.send': return sentAction(context, type, validateSentAction(type, args));
      case 'privacy.enter': await enterPrivateWorkspace(args.workspaceId); break;
      case 'privacy.resume': privacy.resumePrivacy(args); access.attention.resumeWorkspace(args.workspaceId); blockingWorkspaces.delete(args.workspaceId); layout(workspaceOwners.get(args.workspaceId)); emit(); break;
      case 'attention.accept': return acceptAttention(args.attentionId, context);
      case 'attention.dismiss': return access.attention.dismiss(args.attentionId);
      case 'attention.sign-in': { const result = access.attention.decideSignIn(args.attentionId, args.decision); emit(); return result; }
      case 'attention.site': { const result = access.decideSite(args.attentionId, args.decision); emit(); return result; }
      case 'logins.refresh': case 'logins.add': case 'logins.edit': case 'logins.delete': case 'logins.share': case 'logins.unshare':
      case 'logins.agent-use': case 'logins.copy': case 'logins.show': case 'logins.fill': return loginAction(type, args, context);
      case 'vault.offer.save': case 'vault.offer.never': case 'vault.offer.dismiss': case 'vault.never.remove': case 'vault.activity.list':
      case 'vault.activity.clear': case 'vault.import.choose': case 'vault.import.review': case 'vault.import.confirm': case 'vault.import.cancel':
        return vaultAction(type, args, context);
      case 'agent.approve': { const intent = chromeActions.getStore() ?? chromeRecovery.capture(context); const result = await access.approveConnection(args, { assertCurrent: intent.assertCurrent }); emit(); return result; }
      case 'agent.approve-managed': { const intent = chromeActions.getStore() ?? chromeRecovery.capture(context); const result = await access.approveManagedConnection(args, { assertCurrent: intent.assertCurrent }); emit(); return result; }
      case 'admission.cancel': return admission.cancelJob(args);
      case 'agent.reject': access.rejectConnection(args.requestId); emit(); break;
      case 'agent.revoke': await access.revokeConnection(args.agentSessionId); emit(); break;
      // Take over: the same lease revocation the owner's own input on the page causes. The agent keeps its access and must acquire again.
      case 'agent.take-over': privacy.revoke({ workspaceId: args.workspaceId, reason: 'HUMAN_TAKEOVER' }); emit(); return true;
      case 'service.connection.create': {
        if (access.persistence) fail('SERVICE_DURABLE_REVIEW_REQUIRED');
        if (workspaceFor(args.workspaceId).lifecycle?.status === 'archived') fail('WORKSPACE_ARCHIVED');
        if (workspaceFor(args.workspaceId).identityId !== args.expectedWorkspaceIdentityId) fail('SERVICE_REVIEW_STALE');
        const input = { workspaceId: args.workspaceId, label: args.label };
        for (const name of ['provider', 'owner', 'repository', 'teamId', 'projectId', 'operations']) if (Object.hasOwn(args, name)) input[name] = args[name];
        return access.services.createConnection(input);
      }
      case 'service.connection.remove': {
        if (access.persistence) fail('SERVICE_DURABLE_REVIEW_REQUIRED');
        if (!access.services.ownerInventory().connections.some(item => item.id === args.serviceConnectionId)) fail('SERVICE_DENIED');
        const result = access.services.removeConnection(args.serviceConnectionId);
        for (const key of serviceShareRevisions.keys()) if (key.startsWith(args.serviceConnectionId + ':')) serviceShareRevisions.delete(key);
        return result;
      }
      case 'service.workspace.share': case 'service.workspace.revoke': {
        if (access.persistence) fail('SERVICE_DURABLE_REVIEW_REQUIRED');
        if (workspaceFor(args.workspaceId).lifecycle?.status === 'archived' && type === 'service.workspace.share') fail('WORKSPACE_ARCHIVED');
        if (!access.services.ownerInventory().connections.some(item => item.id === args.serviceConnectionId)) fail('SERVICE_DENIED');
        const key = args.serviceConnectionId + ':' + args.workspaceId;
        if (type === 'service.workspace.share') {
          assertServiceReview(args);
          const result = access.services.shareConnection({ serviceConnectionId: args.serviceConnectionId, workspaceId: args.workspaceId, operations: args.operations });
          serviceShareRevisions.set(key, (serviceShareRevisions.get(key) ?? 0) + 1); return result;
        }
        serviceShareRevisions.set(key, (serviceShareRevisions.get(key) ?? 0) + 1);
        return access.services.revokeWorkspaceShare(args);
      }
      case 'service.grant.create': {
        assertServiceReview(args);
        if (!access.services.humanView(context.workspaceId).connections.some(item => item.id === args.serviceConnectionId)) fail('SERVICE_DENIED');
        return access.services.grant({ serviceConnectionId: args.serviceConnectionId, workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId, operations: args.operations, expiresInMs: args.expiresInMs });
      }
      case 'service.grant.revoke': {
        if (!access.services.humanView(context.workspaceId).grants.some(item => item.id === args.serviceGrantId)) fail('SERVICE_DENIED');
        return access.services.revokeGrant(args.serviceGrantId);
      }
      case 'agent.copy-config': clipboard.writeText(JSON.stringify(snapshot(context).connectionConfig, null, 2)); return true;
      case 'agent.tools.refresh': return context.privateScopeId ? [] : agentTools.refresh();
      case 'agent.tool.connect': case 'agent.tool.disconnect': {
        // Changing another program's settings is an owner action in a normal window only.
        if (context.privateScopeId || typeof args.toolId !== 'string' || args.toolId.length > 64) fail('AGENT_TOOLS_UNAVAILABLE');
        return type === 'agent.tool.connect' ? agentTools.connect(args.toolId) : agentTools.disconnect(args.toolId);
      }
      case 'demo.open': {
        if (!fixtures) fixtures = await startQualificationFixtures({ durationMs: 7200000 });
        return perform({ type: 'tab.create', workspaceId: args.workspaceId, input: fixtures.origin + '/selection' }, context);
      }
      case 'voice.begin': return beginVoice(args, context);
      case 'voice.cancel': if (voice?.captureId === args.captureId && voice.ownerWindowId === context.id) await stopVoice(); break;
    }
    return true;
  }
  ipcMain.handle('caddi-desktop:state', event => { const context = trusted(event); if (!context) fail('UNTRUSTED_IPC'); return snapshot(context); });
  ipcMain.handle('caddi-desktop:action', async (event, input) => {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    try { return { ok: true, result: await act(input, context) }; }
    catch (error) { return { ok: false, code: error.code ?? 'ACTION_FAILED' }; }
  });
  ipcMain.handle('caddi-desktop:artifact-preview', (event, raw) => {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    try {
      systemLifecycle.capture({ purpose: 'feedback-preview' }).assertCurrent();
      if (context.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
      assertKeys(raw, ['workspaceId', 'feedbackId', 'revision', 'artifactId'], ['workspaceId', 'feedbackId', 'revision', 'artifactId']);
      const workspaceId = assertId(raw.workspaceId), feedbackId = assertId(raw.feedbackId);
      const revision = assertInteger(raw.revision, 'revision', { min: 1 }), artifactId = assertId(raw.artifactId);
      if (!context.reviewOpen || context.workspaceId !== workspaceId || workspaceOwners.get(workspaceId) !== context ||
          activeDrafts.get(workspaceId) !== feedbackId || blockingWorkspaces.has(workspaceId) ||
          privacy.getPrivacyState(workspaceId).blocked || currentDraft(workspaceId, feedbackId).revision !== revision) fail('PREVIEW_UNAVAILABLE');
      return { ok: true, result: access.previewArtifact({ workspaceId, feedbackId, revision, artifactId }) };
    } catch (error) { return { ok: false, code: error.code ?? 'PREVIEW_UNAVAILABLE' }; }
  });
  ipcMain.handle('caddi-desktop:prepared-preview', (event, raw) => {
    const context=trusted(event); if (!context) fail('UNTRUSTED_IPC');
    try {
      systemLifecycle.capture({ purpose: 'feedback-preview' }).assertCurrent();
      if (context.privateScopeId) fail('PRIVATE_FEATURE_UNAVAILABLE');
      assertKeys(raw,['workspaceId','feedbackId','revision','role','momentId'],['workspaceId','feedbackId','revision','role']);
      const binding={ownerWindowId:context.id,workspaceId:assertId(raw.workspaceId),feedbackId:assertId(raw.feedbackId),
        revision:assertInteger(raw.revision,'revision',{min:1})};
      return {ok:true,result:prepared.preview(binding,raw.role,raw.momentId)};
    } catch(error) { return {ok:false,code:error.code??'PREPARE_UNAVAILABLE'}; }
  });
  ipcMain.handle('caddi-desktop:layout', (event, raw) => {
    // A ResizeObserver layout invoke already sent by a trusted chrome can land
    // after its window was removed during an approved native close.
    if (retiringChromeIds.has(event.sender.id)) return false;
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    context.pageRect = desktopPageBounds(raw, context.window.getContentSize(), context.window.webContents.getZoomFactor()); layout(context); return true;
  });
  ipcMain.handle('caddi-desktop:audio', receiveAudio);
  ipcMain.handle('caddi-desktop:live-audio', receiveLiveAudio);
  ipcMain.handle('caddi-desktop:board-image', receiveBoardImage);
  ipcMain.handle('caddi-desktop:live-audio-stopped', (event, raw) => {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    if (liveVoice && liveVoice.ownerWindowId === context.id && raw?.sessionId === liveVoice.sessionId) liveVoice.resolveStopped();
    return true;
  });
  ipcMain.handle('caddi-desktop:audio-stopped', (event, raw) => {
    const context = trusted(event); if (!context) fail('UNTRUSTED_IPC');
    if (voice && voice.ownerWindowId === context.id && raw?.captureId === voice.captureId) { voice.audioAcknowledged = true; voice.resolveAudio(); }
    return true;
  });
  const restoredContexts = [];
  for (const saved of windowSessions.plan.windows) {
    if (saved.windowKey === initialRestore?.windowKey) continue;
    const workspace = workspaceFor(saved.workspaceId);
    if (workspace.identityId !== saved.identityId || workspace.lifecycle?.status === 'archived' || workspaceOwners.has(workspace.id)) continue;
    const restoredWindow = newChromeWindow(saved), context = makeContext(restoredWindow, workspace.id);
    context.windowKey = saved.windowKey; context.needsHydration = true;
    windows.set(context.id, context); engine.registerWindow(restoredWindow, { kind: 'normal' }); configureChrome(context);
    engine.transferWorkspace(workspace.id, restoredWindow); workspaceOwners.set(workspace.id, context); restoredContexts.push({ context, saved });
  }
  await window.loadURL(DESKTOP_URL);
  for (const { context } of restoredContexts) await context.window.loadURL(DESKTOP_URL);
  systemLifecycle.attachHost({ protect: protectSystem, onChange: () => { for (const context of windows.values()) layout(context); emit(); } });
  if (systemLifecycle.status().locked) { primaryContext.needsHydration = true; emit(); }
  else await displayCurrent(primaryContext);
  if (show) {
    for (const { context, saved } of restoredContexts) { if (saved.maximized) context.window.maximize(); context.window.showInactive(); }
    if (initialRestore?.maximized) window.maximize(); window.show(); window.focus();
  }
  startupRestoring = false; windowSessions.start(); windowSessions.focus(primaryContext);
  if (!windowSessions.snapshot().available) send('notice', 'Saved window layout could not be restored. Its original data was preserved; this session will not overwrite it.', primaryContext);
  function close(fromWindowClose = false) {
    if (closed) return Promise.resolve();
    if (!closeTask) {
      closing = true;
      portability.invalidateAll();
      closeTask = (fromWindowClose ? Promise.resolve() : windowCloseTail).then(finishClose).catch(error => { closeTask = null; closing = false; throw error; });
    }
    return closeTask;
  }
  async function finishClose() {
    closing = true;
    // Private pages must acknowledge real native close and Session cleanup before
    // the ordinary engine shutdown can proceed. A veto leaves this scope live.
    await actionTail;
    await portability.settle();
    shortcutRecording.close();
    for (const context of windows.values()) if (previews.has(context)) {
      const result = await previews.closeOwner(context); if (!result.closed) fail('PREVIEW_CLOSE_CANCELLED');
    }
    await windowSessions.flush();
    for (const context of [...windows.values()].filter(item => item.privateScopeId)) {
      const result = await privateWindows.close(context);
      if (!result.closed) fail('PRIVATE_CLOSE_CANCELLED');
      workspaceOwners.delete(context.workspaceId); engine.unregisterWindow(context.window);
      retiringChromeIds.add(context.window.webContents.id); windows.delete(context.id);
      context.destroying = true; if (!context.window.isDestroyed()) context.window.destroy();
    }
    unsubscribeExternalLinks?.(); stopLeaseChrome();
    await portability.close();
    for (const context of windows.values()) { externalLinks?.invalidateOwner(context); if (!chromeRecovery.ready(context)) chromeRecovery.cancel(context); }
    resources?.stop(); admission?.close(); await workspaceLifecycle?.close();
    workspaceSelection.close();
    prints?.close();
    defaultBrowser.close();
    await moments?.settle();
    await prepared?.close();
    engine.invalidatePopups({});
    sitePermissions.close();
    for (const context of windows.values()) stopFinding(context);
    clearTimeout(emitTimer); clearTimeout(metadataTimer);
    if (voice) {
      const item = voice;
      // Destroying the trusted recorder context cancels even unresolved OS-media prompts.
      item.controller.abort(); speech.cancel(item.captureId);
      const owner = windows.get(item.ownerWindowId);
      if (owner && !owner.window.webContents.isDestroyed()) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CaddiError('CAPTURE_STOP_PENDING', 'Recorder shutdown was not acknowledged')), 5000);
        owner.window.webContents.once('destroyed', () => { clearTimeout(timer); resolve(); });
        owner.window.webContents.close({ waitForBeforeUnload: false });
      });
      item.audioAcknowledged = true; item.resolveAudio();
      await item.worker?.catch(() => {});
      item.observer.unregister(); clearTimeout(item.timer); if (voice === item) voice = null;
    }
    await flushMetadata(); await tail; await store.flush();
    await historyRecorder?.close();
    if (history) await history.close().catch(error => { historyError = error.code ?? 'HISTORY_UNAVAILABLE'; });
    await downloads.close();
    await speech.close(); await access.close(); logins?.close(); clearTimeout(loginClipboardTimer);
    for (const item of vaultImports.values()) wipeCandidates(item.candidates); vaultImports.clear(); vaultOffers.clear(); await engine.close(); await fixtures?.close();
    await windowSessions.close(); await shortcuts.close(); privateScopes.close();
    policy.dispose(); privacy.dispose(); organizationUndo.close();
    closed = true; closing = false;
    systemLifecycle.close();
    chromeRecovery.close();
    for (const context of windows.values()) { context.destroying = true; if (!context.window.isDestroyed()) context.window.destroy(); }
    windows.clear(); workspaceOwners.clear();
    // Destroy trusted chrome before unregistering its IPC. A late ResizeObserver
    // layout invoke must never race into a removed handler during teardown.
    for (const channel of channels) ipcMain.removeHandler(channel);
    chromeSession.protocol.unhandle('caddi');
    Menu.setApplicationMenu(previousMenu);
  }
  return Object.freeze({ window, engine, access, privacy, policy, store, speech, downloads, sitePermissions, admission, resources, chromeRecovery, systemLifecycle, act, snapshot, offerExternalLinks,
    setEnrollmentRendezvous(publication) {
      if (ownedSystemProof) ownedSystemProof.assertCurrent();
      else if (!electronApp.hasSingleInstanceLock()) fail('RENDEZVOUS_OWNER_CHANGED');
      return connectionConfiguration.usePublication(publication);
    },
    enrollmentRendezvousUnavailable: error => connectionConfiguration.unavailable(error),
    ...(ownedSystemProof ? { testSystemProof: ownedSystemProof } : {}),
    ...(ownedSystemProof && persistenceMetadata?.testOnly ? { testPersistence: Object.freeze({
      createConnection(input, { window: ownerWindow = primaryContext?.window } = {}) {
        const context = windows.get(ownerWindow?.id);
        if (!context || context.window !== ownerWindow) fail('PERSISTENCE_REVIEW_REQUIRED');
        const owner = capturePersistenceOwner(context);
        if (input.initialShare && (input.initialShare.workspaceId !== owner.workspaceId || input.initialShare.identityId !== owner.identityId)) fail('PERSISTENCE_IDENTITY_CHANGED');
        return access.persistence.owner.createConnection(input, owner);
      },
    }) } : {}),
    getWindows: () => [...windows.values()].map(context => ({ id: context.id, window: context.window, workspaceId: context.workspaceId,
      private: !!context.privateScopeId, windowKey: context.windowKey, needsHydration: context.needsHydration })),
    focusExisting: () => { const context = [...windows.values()].find(item => !item.window.isDestroyed()); context?.window.show(); context?.window.focus(); },
    getState: () => structuredClone(state), flush: async () => { await flushMetadata(); await tail; await store.flush(); await historyRecorder?.flush(); await history?.flush(); await downloads.flush(); await privateWindows.flush(); await windowSessions.flush(); await shortcuts.flush(); }, close, requestQuit,
    ...(testCloseDecision ? { setTestCloseDecision: fn => { if (typeof fn !== 'function') fail('INVALID_ARGUMENT'); closeDecisionForTest = fn; } } : {}),
    ...(testPortabilityDialogs ? { setTestPortabilityDialogs: value => { portabilityDialogsForTest = validatePortabilityDialogs(value); } } : {}),
    ...(testPreviewMenu ? { takeTestPreviewMenu: () => { const value = capturedPreviewMenu; capturedPreviewMenu = null; return value; } } : {}),
    ...(testRecoveryDecision ? { setTestRecoveryDecision: fn => { if (typeof fn !== 'function') fail('INVALID_ARGUMENT'); recoveryDecisionForTest = fn; },
      offerChromeRecovery: windowId => { const context = windows.get(windowId); if (!context) fail('CLOSED'); return chromeActions.exit(() => chromeRecovery.offer(context)); } } : {}) });
}
