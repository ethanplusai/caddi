// Separate development entry: never migrates or reads the earlier browser's profiles.
import { app, protocol, dialog, shell, powerMonitor, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopApp } from './app.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';
import { setAsideEarlierData } from './earlier-data.mjs';
import { createProductStore } from '../state/store.mjs';
import { loadInProcessKeyBoundary } from '../platform/in-process-keychain.mjs';
import { createKeychainLoginSecrets, createFakeLoginSecrets, loginKeychainService } from '../platform/login-secrets.mjs';
import { SPEECH_RESOURCE_DIRECTORY } from './speech-pins.mjs';
import { createExternalLinks } from './external-links.mjs';
import { createSystemLifecycle } from './system-lifecycle.mjs';
import { createOwnedSystemProof } from './owned-system-proof.mjs';
import { publishDesktopRendezvous } from '../access/rendezvous.mjs';
import { CONNECTOR_NODE, CONNECTOR_RESOURCE_DIRECTORY, isStaleConnectorLaunch } from './connector-pins.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packaged = app.isPackaged;
// A coding tool set up by Caddi 0.1.4 or earlier starts the agent client with Caddi's own executable and
// ELECTRON_RUN_AS_NODE. That no longer runs scripts, so it lands here: say what to do and leave at once,
// before anything else starts (no window, no data folder, no single-instance lock). The client script has had
// other names (0.1.2 used another one), so recognise the launch by the switch and by any script argument,
// never by one file name: otherwise every new agent thread opens the whole app.
if (packaged && isStaleConnectorLaunch(process.env, process.argv.slice(1))) {
  app.dock?.hide();
  process.stderr.write('CADDI_CONNECTION_OUTDATED: This Caddi connection was set up by an earlier version. Open Caddi, then choose Reconnect for this tool in the Agents dialog.\n');
  app.exit(2);
  await new Promise(() => {});
}
// The public build carries channel "release" in its sealed manifest. It gets its own name and
// data folder; a source run and the local development bundle keep theirs.
let releaseBuild = false;
if (packaged) try { releaseBuild = JSON.parse(readFileSync(path.join(path.dirname(projectRoot), 'caddi-build.json'), 'utf8')).channel === 'release'; } catch {}
const productName = releaseBuild ? 'Caddi' : 'Caddi Development';
const speechResourceRoot = packaged ? path.join(path.dirname(projectRoot), SPEECH_RESOURCE_DIRECTORY) : null;
const packagedSmoke = process.argv.includes('--caddi-packaged-smoke');
const packagedPrintSmoke = process.argv.includes('--caddi-packaged-print-smoke');
const reviewSmoke = process.argv.includes('--caddi-review-smoke');
const uiGallerySmoke = process.argv.includes('--caddi-ui-gallery-smoke');
const annotateSmoke = process.argv.includes('--caddi-annotate-smoke');
const liveSmoke = process.argv.includes('--caddi-live-smoke');
const boardSmoke = process.argv.includes('--caddi-board-smoke');
const loginsSmoke = process.argv.includes('--caddi-logins-smoke');
const browserUseSmoke = process.argv.includes('--caddi-browser-use-smoke');
const extractionSmoke = process.argv.includes('--caddi-extraction-smoke');
const printSmoke = process.argv.includes('--caddi-print-smoke');
const beforeUnloadProbe = process.argv.includes('--caddi-beforeunload-probe');
const filePickerProbe = process.argv.includes('--caddi-file-picker-probe');
const everydaySmoke = process.argv.includes('--caddi-everyday-smoke');
const closeSmoke = process.argv.includes('--caddi-close-smoke');
const scaleSmoke = process.argv.includes('--caddi-scale-smoke');
const workspaceSmoke = process.argv.includes('--caddi-workspace-smoke');
const capacitySmoke = process.argv.includes('--caddi-capacity-smoke');
const externalLinksSmoke = process.argv.includes('--caddi-external-links-smoke');
const recoverySmoke = process.argv.includes('--caddi-recovery-smoke');
const privateEngineSmoke = process.argv.includes('--caddi-private-engine-smoke');
const privateWindowsSmoke = process.argv.includes('--caddi-private-windows-smoke');
const previewSmoke = process.argv.includes('--caddi-preview-smoke');
const downloadHistorySmoke = process.argv.includes('--caddi-download-history-smoke');
const portabilitySmoke = process.argv.includes('--caddi-portability-smoke');
const mediaSmoke = process.argv.includes('--caddi-media-smoke');
const compatibilitySmoke = process.argv.includes('--caddi-compatibility-smoke');
const systemLifecycleSmoke = process.argv.includes('--caddi-system-lifecycle-smoke');
const persistenceSmoke = process.argv.includes('--caddi-persistence-smoke');
const providerSmoke = process.argv.includes('--caddi-provider-smoke');
const ownerFlowSmoke = process.argv.includes('--caddi-owner-flow-smoke');
if (providerSmoke && !persistenceSmoke) throw new Error('Provider smoke requires the owned persistence smoke entry.');
if (ownerFlowSmoke && (!providerSmoke || !persistenceSmoke)) throw new Error('Owner flow smoke requires the owned provider and persistence smoke entries.');
const rendezvousSmoke = process.argv.includes('--caddi-rendezvous-smoke');
if (packagedSmoke && !packaged) throw new Error('Packaged smoke requires the Caddi Development bundle.');
if (packagedPrintSmoke && !packaged) throw new Error('Packaged print smoke requires the Caddi Development bundle.');
if (reviewSmoke && packaged) throw new Error('Review smoke is available only in a development checkout.');
if (uiGallerySmoke && packaged) throw new Error('UI gallery smoke is available only in a development checkout.');
if (annotateSmoke && packaged) throw new Error('Annotate smoke is available only in a development checkout.');
if (liveSmoke && packaged) throw new Error('Live smoke is available only in a development checkout.');
if (boardSmoke && packaged) throw new Error('Board smoke is available only in a development checkout.');
if (loginsSmoke && packaged) throw new Error('Logins smoke is available only in a development checkout.');
if (browserUseSmoke && packaged) throw new Error('Browser use smoke is available only in a development checkout.');
if (extractionSmoke && packaged) throw new Error('Extraction smoke is available only in a development checkout.');
if (printSmoke && packaged) throw new Error('Print smoke is available only in a development checkout.');
if (everydaySmoke && packaged) throw new Error('Everyday smoke is available only in a development checkout.');
if ((beforeUnloadProbe || closeSmoke) && packaged) throw new Error('Native close smoke is available only in a development checkout.');
if (scaleSmoke && packaged) throw new Error('Scale smoke is available only in a development checkout.');
if (workspaceSmoke && packaged) throw new Error('Workspace smoke is available only in a development checkout.');
if (capacitySmoke && packaged) throw new Error('Capacity smoke is available only in a development checkout.');
if (externalLinksSmoke && packaged) throw new Error('External link smoke is available only in a development checkout.');
if (recoverySmoke && packaged) throw new Error('Recovery smoke is available only in a development checkout.');
if (privateEngineSmoke && packaged) throw new Error('Private engine smoke is available only in a development checkout.');
if (privateWindowsSmoke && packaged) throw new Error('Private windows smoke is available only in a development checkout.');
if (previewSmoke && packaged) throw new Error('Preview smoke is available only in a development checkout.');
if (downloadHistorySmoke && packaged) throw new Error('Download history smoke is available only in a development checkout.');
if (portabilitySmoke && packaged) throw new Error('Portability smoke is available only in a development checkout.');
if (mediaSmoke && packaged) throw new Error('Media smoke is available only in a development checkout.');
if (compatibilitySmoke && packaged) throw new Error('Compatibility smoke is available only in a development checkout.');
if (systemLifecycleSmoke && packaged) throw new Error('System lifecycle smoke is available only in a development checkout.');
if (persistenceSmoke && packaged) throw new Error('Persistence smoke is available only in a development checkout.');
if (rendezvousSmoke && packaged) throw new Error('Rendezvous smoke is available only in a development checkout.');
if (process.argv.includes('--caddi-smoke') && packaged) throw new Error('Desktop smoke is available only in a development checkout.');
if (mediaSmoke) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// Every host name except loopback fails to resolve, so searches and DNS failures never leave the Mac.
if (everydaySmoke) app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
const smoke = packagedSmoke || packagedPrintSmoke || reviewSmoke || uiGallerySmoke || annotateSmoke || liveSmoke || boardSmoke || loginsSmoke || browserUseSmoke || extractionSmoke || printSmoke || everydaySmoke || beforeUnloadProbe || filePickerProbe || closeSmoke || scaleSmoke || workspaceSmoke || capacitySmoke || externalLinksSmoke || recoverySmoke || privateEngineSmoke || privateWindowsSmoke || previewSmoke || downloadHistorySmoke || portabilitySmoke || mediaSmoke || compatibilitySmoke || systemLifecycleSmoke || persistenceSmoke || rendezvousSmoke || process.argv.includes('--caddi-smoke');
let browser, closing = false, finished = false, cleanupTask, rendezvousPublication = null;
const externalLinks = createExternalLinks();
function offerWaitingLinks() {
  if (closing || finished) return;
  try { void Promise.resolve(browser?.offerExternalLinks?.()).catch(() => {}); } catch {}
}
// Register before the first async startup step. Never navigate from an OS event.
app.on('open-url', (event, raw) => {
  event.preventDefault();
  if (smoke || closing || finished) return;
  const result = externalLinks.intake(raw);
  if (result.accepted) offerWaitingLinks();
});
let runRoot, dataRoot, earlierDataFolder = null;
let interceptedPrints = 0;
const copiedNotes = [];
if (smoke) {
  const parent = packaged ? await fs.realpath(os.tmpdir()) : path.join(projectRoot, '.test-artifacts');
  if (!packaged) await fs.mkdir(parent, { recursive: true });
  runRoot = await fs.realpath(await fs.mkdtemp(path.join(parent, 'od-')));
  dataRoot = path.join(runRoot, 'data');
} else if (packaged) {
  const folder = path.join(app.getPath('appData'), releaseBuild ? 'Caddi' : 'Caddi Development');
  // Data from 0.1.2 and earlier cannot be read by this version; keep it whole and start fresh.
  try { earlierDataFolder = setAsideEarlierData(folder); } catch (error) { console.error('Earlier data could not be set aside:', error.code ?? error.message); }
  dataRoot = ensurePrivateDirectory(folder);
  runRoot = await fs.realpath(await fs.mkdtemp(path.join(dataRoot, 'run-')));
} else {
  const artifacts = path.join(projectRoot, '.test-artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  runRoot = await fs.realpath(await fs.mkdtemp(path.join(artifacts, 'od-')));
  dataRoot = path.join(projectRoot, '.caddi-development');
}
await fs.chmod(runRoot, 0o700);
const sessionDataRoot = smoke && !privateEngineSmoke ? path.join(runRoot, 'session') : path.join(dataRoot, 'electron-session');
for (const directory of [dataRoot, path.join(dataRoot, 'electron'), sessionDataRoot]) ensurePrivateDirectory(directory);
// This proof is minted only for the fresh directories created above, before
// Electron or the browser writes profile data. A hidden window alone is never
// sufficient to replace the real powerMonitor in an ordinary composition.
const ownedSystemProof = smoke && !privateEngineSmoke ? createOwnedSystemProof({ proofRoot: runRoot, dataRoot, sessionDataRoot, runRoots: [runRoot] }) : null;
const systemLifecycle = privateEngineSmoke ? null : ownedSystemProof?.createLifecycle() ?? createSystemLifecycle({ monitor: powerMonitor });
app.setName(productName);
app.setPath('userData', path.join(dataRoot, 'electron'));
app.setPath('sessionData', sessionDataRoot);
protocol.registerSchemesAsPrivileged([{ scheme: 'caddi', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let nativeKeyStatus = { loaded: false, productionQualified: false, reason: 'native-addon-unavailable' };
// Saved login passwords. Automated runs never touch the real keychain: they get an in-memory stand-in.
// Each build has its own keychain service, so release, the development bundle and a source run never see each other's items.
let loginSecrets = null;
let testServiceBackend = null;
let persistenceFixture = null;
let testSiteMediaAccess = null;
const recoveryCancelled = () => Object.assign(new Error('Recovery cancelled'), { code: 'RECOVERY_CANCELLED' });
async function showMetadataProblem(error, recoverable = false) {
  const result = await dialog.showMessageBox({ type: 'warning', title: 'Caddi workspace data needs attention',
    message: error.code === 'UNSUPPORTED_SCHEMA' ? 'These workspace files need a newer compatible Caddi build.' :
      recoverable ? 'Saved workspace metadata cannot be read. A verified earlier snapshot is available.' : 'Saved workspace metadata cannot be read. No verified earlier snapshot is available.',
    detail: 'Caddi has not reset or replaced the files. Website profiles are separate. Active agent access is never restored. Workspace metadata folder: ' + path.join(dataRoot, 'metadata'),
    buttons: recoverable ? ['Quit', 'Review earlier snapshot'] : ['Quit', 'Show data folder'], defaultId: 0, cancelId: 0, noLink: true });
  if (result.response !== 1) throw recoveryCancelled();
  if (!recoverable) { await shell.openPath(dataRoot); throw recoveryCancelled(); }
}
async function createWithRecovery() {
  const options = { projectRoot, dataRoot, runRoot, show: !smoke, enableMicrophone: !smoke, persistentProfiles: !smoke,
    speechResourceRoot,
    nativeKeyStatus, testServiceBackend, externalLinks, systemLifecycle, ownedSystemProof, loginSecrets,
    persistenceConfiguration: persistenceFixture?.configuration ?? null,
    testDefaultBrowser: persistenceFixture?.ownerFlow?.defaultBrowser ?? null,
    testOwnerCredentialAcquirer: persistenceFixture?.ownerFlow?.acquireCredential ?? null,
    testSiteMediaAccess,
    testPortabilityDialogs: portabilitySmoke ? { chooseImportFile: async () => null, chooseExportFile: async () => null } : null,
    testPreviewMenu: previewSmoke ? () => {} : null,
    testDownloadSavePath: smoke ? ({ name }) => path.join(runRoot, 'downloads', name) : null,
    testPdfSavePath: smoke ? ({ name }) => path.join(runRoot, name) : null,
    testPrintPage: smoke ? (_webContents, _options, callback) => {
      interceptedPrints++;
      callback(false, 'Print job canceled');
    } : null,
    testCloseDecision: smoke ? async () => true : null,
    testClipboardWrite: annotateSmoke || liveSmoke || extractionSmoke ? text => { copiedNotes.push(text); } : null,
    testLiveAudio: liveSmoke,
    testRecoveryDecision: recoverySmoke ? async () => 'keep-paused' : privateWindowsSmoke ? async () => 'recover' : null,
    testRevealFile: smoke ? file => fs.writeFile(path.join(runRoot, 'revealed-download.txt'), file) : null,
    // Automated runs never look at, or change, the real coding tools on this Mac.
    agentToolsHome: smoke ? path.join(runRoot, 'agent-tools-home') : null,
    // A packaged app starts the agent client on its bundled, pinned Node.js runtime, so nobody has to install
    // Node.js. Caddi's own executable cannot run scripts as Node (its Electron fuses are off).
    agentRuntime: packaged ? { command: path.join(path.dirname(projectRoot), CONNECTOR_RESOURCE_DIRECTORY, CONNECTOR_NODE.program.bundled), env: {} } : null,
    firstRunWelcome: !smoke };
  try { return await createDesktopApp(options); }
  catch (error) {
    if (smoke) throw error;
    if (error.code === 'UNSAFE_PROFILE_PATH') {
      const result = await dialog.showMessageBox({ type: 'error', title: 'Caddi profile is unavailable',
        message: 'A workspace profile directory is unsafe or unavailable.',
        detail: 'Caddi did not open the affected website profile or change its files. Inspect the private development data folder before trying again: ' + dataRoot,
        buttons: ['Quit', 'Show data folder'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response === 1) await shell.openPath(dataRoot);
      throw recoveryCancelled();
    }
    if (error.code === 'UNSUPPORTED_SCHEMA') { await showMetadataProblem(error); throw recoveryCancelled(); }
    if (error.code !== 'RECOVERY_REQUIRED') throw error;
    const store = createProductStore({ directory: path.join(dataRoot, 'metadata') });
    let report;
    try { report = await store.inspect(); }
    catch (inspectError) { await showMetadataProblem(inspectError); throw recoveryCancelled(); }
    const recoverable = !report.primary.valid && report.backup.valid;
    await showMetadataProblem(error, recoverable);
    const second = await dialog.showMessageBox({ type: 'warning', title: 'Confirm workspace metadata recovery',
      message: `Restore the verified workspace snapshot at revision ${report.backup.revision}?`,
      detail: 'Caddi will preserve the damaged original bytes in a separate file. Changes after this earlier snapshot may be absent. Website profile data is not replaced.',
      buttons: ['Cancel', 'Restore earlier snapshot'], defaultId: 0, cancelId: 0, noLink: true });
    if (second.response !== 1) throw recoveryCancelled();
    await store.recoverFromBackup({ expectedPrimaryDigest: report.primary.digest, expectedBackupDigest: report.backup.digest });
    return createDesktopApp(options);
  }
}
async function cleanup() {
  if (finished) return;
  if (!cleanupTask) cleanupTask = (async () => {
    await browser?.close();
    // The locator is retired only after the actual enrollment/access shutdown
    // acknowledges. Its exact-file capability never removes a newer publication.
    await rendezvousPublication?.close();
    persistenceFixture?.destroy();
    systemLifecycle?.close(); ownedSystemProof?.close();
    externalLinks.close();
    // runRoot is exactly the fresh mkdtemp directory this entry created, never user supplied.
    await fs.rm(runRoot, { recursive: true, force: true });
    finished = true;
  })().catch(error => { cleanupTask = null; throw error; });
  return cleanupTask;
}
if (!smoke && !app.requestSingleInstanceLock()) {
  await cleanup(); app.quit();
} else {
  if (!smoke) externalLinks.intakeArguments(process.argv);
  app.on('second-instance', (_event, argv) => {
    if (smoke || closing || finished) return;
    const result = externalLinks.intakeArguments(argv);
    browser?.focusExisting();
    if (result.accepted) offerWaitingLinks();
  });
  app.on('window-all-closed', () => { if (!smoke) app.quit(); });
  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    Promise.resolve().then(() => browser?.requestQuit() ?? true).then(approved => approved ? cleanup() : false).then(result => {
      if (result === false) {
        closing = false;
        // Keep Open resumes presentation of the same exact publication; it does
        // not publish a new descriptor or recover any agent authority.
        if (rendezvousPublication) {
          try { browser.setEnrollmentRendezvous(rendezvousPublication); }
          catch (error) { browser.enrollmentRendezvousUnavailable(error); }
        }
        return;
      }
      app.quit();
    }, error => {
      closing = false;
      console.error('Caddi close failed:', error.code ?? 'CLOSE_FAILED');
      if (!smoke && !browser?.window.isDestroyed()) dialog.showErrorBox('Caddi stayed open', 'Workspace changes could not be saved. Please try again.');
    });
  });
  const watchdog = smoke ? setTimeout(() => { console.error('CADDI_DESKTOP_SMOKE_TIMEOUT'); app.exit(1); }, privateEngineSmoke ? 60_000 : everydaySmoke ? 600_000 : previewSmoke || portabilitySmoke || mediaSmoke || compatibilitySmoke ? 90_000 : 120_000) : null;
  app.whenReady().then(async () => {
    // A source run would otherwise show Electron's own icon in the Dock. A packaged app gets its icon from the bundle.
    if (!packaged && !smoke && process.platform === 'darwin') {
      try {
        const icon = nativeImage.createFromPath(path.join(projectRoot, 'assets/caddi-brand/caddi-icon-512.png'));
        if (!icon.isEmpty()) app.dock?.setIcon(icon);
      } catch {}
    }
    if (privateEngineSmoke) {
      // This helper owns the sole native engine and its hidden window. Constructing
      // the ordinary browser first would collide with the fixed page IPC boundary.
      const { runDesktopPrivateEngineSmoke } = await import('../../../test/caddi-desktop-private-engine-smoke.mjs');
      await runDesktopPrivateEngineSmoke({ projectRoot, runRoot });
      await cleanup(); clearTimeout(watchdog); app.exit(0); return;
    }
    systemLifecycle.start();
    if (smoke && !packaged) {
      const { createSyntheticServiceBackend } = await import('../services/testing.mjs');
      testServiceBackend = createSyntheticServiceBackend();
    }
    if (mediaSmoke) {
      const { createMediaSmokeSystemAccess } = await import('../../../test/caddi-desktop-media-smoke.mjs');
      testSiteMediaAccess = createMediaSmokeSystemAccess();
    }
    if (systemLifecycleSmoke) testSiteMediaAccess = { authorize: async () => ({ allowed: true }) };
    if (persistenceSmoke) {
      const { createPersistenceSmokeConfiguration } = await import('../../../test/caddi-desktop-persistence-smoke.mjs');
      persistenceFixture = createPersistenceSmokeConfiguration({ dataRoot });
      testServiceBackend = persistenceFixture.serviceBackend;
    }
    try {
      const native = loadInProcessKeyBoundary();
      nativeKeyStatus = { loaded: native.loaded, productionQualified: false, reason: native.reason };
      if (!smoke) loginSecrets = createKeychainLoginSecrets({ binding: native.binding,
        service: loginKeychainService(packaged ? (releaseBuild ? 'release' : 'development') : 'source') });
    } catch (error) {
      nativeKeyStatus = { loaded: false, productionQualified: false, reason: error.code ?? 'native-addon-unavailable' };
    }
    if (smoke) loginSecrets = createFakeLoginSecrets({ service: 'build.caddi.test.smoke' });
    browser = await createWithRecovery();
    if (earlierDataFolder) void dialog.showMessageBox({ type: 'info', title: 'Caddi started fresh',
      message: 'Caddi started fresh because this version cannot open data saved by Caddi 0.1.2.',
      detail: 'Nothing was deleted. Your earlier workspaces, history and website sign-ins are kept in: ' + earlierDataFolder +
        '\n\nReconnect your coding tools from the Agents dialog.',
      buttons: ['OK', 'Show folder'], defaultId: 0, cancelId: 0, noLink: true })
      .then(result => { if (result.response === 1) shell.showItemInFolder(earlierDataFolder); }).catch(() => {});
    if (!smoke) {
      const owner = browser, access = owner.access;
      const assertOwner = () => {
        if (closing || finished || browser !== owner || browser.access !== access || !app.hasSingleInstanceLock())
          throw Object.assign(new Error('The local connection owner changed'), { code: 'RENDEZVOUS_OWNER_CHANGED' });
        return access.assertEnrollmentCurrent();
      };
      try {
        assertOwner();
        const directory = ensurePrivateDirectory(path.join(dataRoot, 'mcp'));
        rendezvousPublication = await publishDesktopRendezvous({ descriptorPath: path.join(directory, 'runtime.json'),
          enrollmentSocket: access.enrollmentSocket, runtimeId: access.enrollmentRuntimeId, assertOwner });
        owner.setEnrollmentRendezvous(rendezvousPublication);
      } catch (error) {
        // Unsafe/stale sources are preserved. The browser and its actual
        // session-only enrollment socket remain usable without a stable address.
        owner.enrollmentRendezvousUnavailable(error);
      }
    }
    if (smoke) {
      if (rendezvousSmoke) {
        const { runDesktopRendezvousSmoke } = await import('../../../test/caddi-desktop-rendezvous-smoke.mjs');
        await runDesktopRendezvousSmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (persistenceSmoke) {
        const { runDesktopPersistenceSmoke } = await import('../../../test/caddi-desktop-persistence-smoke.mjs');
        await runDesktopPersistenceSmoke(browser, { projectRoot, dataRoot, runRoot, fixture: persistenceFixture });
      } else if (systemLifecycleSmoke) {
        const { runSystemLifecycleSmoke } = await import('../../../test/caddi-system-lifecycle-smoke.mjs');
        await runSystemLifecycleSmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (packagedPrintSmoke) {
        const { runPackagedPrintSmoke } = await import('./packaged-smoke.mjs');
        const audioIndex = process.argv.indexOf('--caddi-synthetic-audio');
        await runPackagedPrintSmoke(browser, { projectRoot, runRoot, dataRoot, speechResourceRoot,
          syntheticAudio: audioIndex >= 0 ? process.argv[audioIndex + 1] : null });
      } else if (packagedSmoke) {
        const { runPackagedSmoke } = await import('./packaged-smoke.mjs');
        const audioIndex = process.argv.indexOf('--caddi-synthetic-audio');
        await runPackagedSmoke(browser, { projectRoot, runRoot, dataRoot, speechResourceRoot,
          syntheticAudio: audioIndex >= 0 ? process.argv[audioIndex + 1] : null });
      } else if (reviewSmoke) {
        const { runDesktopReviewSmoke } = await import('../../../test/caddi-desktop-review-smoke.mjs');
        await runDesktopReviewSmoke(browser, { projectRoot, runRoot });
      } else if (uiGallerySmoke) {
        const { runDesktopUiGallery } = await import('../../../test/caddi-desktop-ui-gallery.mjs');
        await runDesktopUiGallery(browser, { projectRoot, runRoot });
      } else if (annotateSmoke) {
        const { runDesktopAnnotateSmoke } = await import('../../../test/caddi-desktop-annotate-smoke.mjs');
        await runDesktopAnnotateSmoke(browser, { projectRoot, runRoot, getCopiedNotes: () => copiedNotes });
      } else if (boardSmoke) {
        const { runDesktopBoardSmoke } = await import('../../../test/caddi-desktop-board-smoke.mjs');
        await runDesktopBoardSmoke(browser, { projectRoot, runRoot });
      } else if (liveSmoke) {
        const { runDesktopLiveSmoke } = await import('../../../test/caddi-desktop-live-smoke.mjs');
        await runDesktopLiveSmoke(browser, { projectRoot, runRoot, getCopiedNotes: () => copiedNotes });
      } else if (loginsSmoke) {
        const { runDesktopLoginsSmoke } = await import('../../../test/caddi-desktop-logins-smoke.mjs');
        await runDesktopLoginsSmoke(browser, { projectRoot, runRoot, loginSecrets });
      } else if (browserUseSmoke) {
        const { runDesktopBrowserUseSmoke } = await import('../../../test/caddi-desktop-browser-use-smoke.mjs');
        await runDesktopBrowserUseSmoke(browser, { projectRoot, runRoot });
      } else if (extractionSmoke) {
        const { runDesktopExtractionSmoke } = await import('../../../test/caddi-desktop-extraction-smoke.mjs');
        await runDesktopExtractionSmoke(browser, { projectRoot, runRoot, getCopied: () => copiedNotes });
      } else if (printSmoke) {
        const { runDesktopPrintSmoke } = await import('../../../test/caddi-desktop-print-smoke.mjs');
        await runDesktopPrintSmoke(browser, { projectRoot, runRoot, getInterceptedPrints: () => interceptedPrints });
      } else if (everydaySmoke) {
        const { runDesktopEverydaySmoke } = await import('../../../test/caddi-desktop-everyday-smoke.mjs');
        await runDesktopEverydaySmoke(browser, { projectRoot, runRoot, getInterceptedPrints: () => interceptedPrints });
      } else if (filePickerProbe) {
        const { runFilePickerProbe } = await import('../../../test/caddi-desktop-file-picker-probe.mjs');
        await runFilePickerProbe(browser);
      } else if (beforeUnloadProbe) {
        const { runNativeBeforeUnloadProbe } = await import('../../../test/caddi-desktop-beforeunload-probe.mjs');
        await runNativeBeforeUnloadProbe(browser);
      } else if (closeSmoke) {
        const { runDesktopCloseSmoke } = await import('../../../test/caddi-desktop-close-smoke.mjs');
        await runDesktopCloseSmoke(browser, { projectRoot, runRoot });
      } else if (scaleSmoke) {
        const { runDesktopScaleSmoke } = await import('../../../test/caddi-desktop-scale-smoke.mjs');
        await runDesktopScaleSmoke(browser, { projectRoot, runRoot });
      } else if (workspaceSmoke) {
        const { runDesktopWorkspaceSmoke } = await import('../../../test/caddi-desktop-workspace-smoke.mjs');
        await runDesktopWorkspaceSmoke(browser, { projectRoot, runRoot });
      } else if (capacitySmoke) {
        const { runDesktopCapacitySmoke } = await import('../../../test/caddi-desktop-capacity-smoke.mjs');
        await runDesktopCapacitySmoke(browser, { projectRoot, runRoot });
      } else if (externalLinksSmoke) {
        const { runDesktopExternalLinksSmoke } = await import('../../../test/caddi-desktop-external-links-smoke.mjs');
        await runDesktopExternalLinksSmoke(browser, { projectRoot, runRoot, externalLinks });
      } else if (recoverySmoke) {
        const { runDesktopRecoverySmoke } = await import('../../../test/caddi-desktop-recovery-smoke.mjs');
        await runDesktopRecoverySmoke(browser, { projectRoot, runRoot });
      } else if (privateWindowsSmoke) {
        const { runDesktopPrivateWindowsSmoke } = await import('../../../test/caddi-desktop-private-windows-smoke.mjs');
        await runDesktopPrivateWindowsSmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (previewSmoke) {
        const { runDesktopPreviewSmoke } = await import('../../../test/caddi-desktop-preview-smoke.mjs');
        await runDesktopPreviewSmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (downloadHistorySmoke) {
        const { runDesktopDownloadHistorySmoke } = await import('../../../test/caddi-desktop-download-history-smoke.mjs');
        await runDesktopDownloadHistorySmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (portabilitySmoke) {
        const { runDesktopPortabilitySmoke } = await import('../../../test/caddi-desktop-portability-smoke.mjs');
        await runDesktopPortabilitySmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (mediaSmoke) {
        const { runDesktopMediaSmoke } = await import('../../../test/caddi-desktop-media-smoke.mjs');
        await runDesktopMediaSmoke(browser, { projectRoot, dataRoot, runRoot });
      } else if (compatibilitySmoke) {
        const { runDesktopCompatibilitySmoke } = await import('../../../test/caddi-desktop-compatibility-smoke.mjs');
        await runDesktopCompatibilitySmoke(browser, { projectRoot, dataRoot, runRoot });
      } else {
        const { runDesktopSmoke } = await import('../../../test/caddi-desktop-smoke.mjs');
        await runDesktopSmoke(browser, { projectRoot, runRoot });
      }
      await cleanup(); clearTimeout(watchdog); app.exit(0);
    } else {
      if (externalLinks.summary().pending) offerWaitingLinks();
      console.log('CADDI_DESKTOP_READY ' + JSON.stringify({ name: productName, development: !releaseBuild,
        enrollmentSocket: browser.access.enrollmentSocket, connectionSetup: browser.snapshot().connectionSetup,
        sessionStorage: 'persistent-isolated-development', systemLifecycle: browser.systemLifecycle.snapshot() }));
    }
  }).catch(async error => {
    clearTimeout(watchdog); console.error('CADDI_DESKTOP_ERROR', error.code ?? 'UNCLASSIFIED', error.stack ?? error.message);
    if (smoke && browser?.engine.lifecycleDiagnostics) console.error('CADDI_LIFECYCLE', JSON.stringify(browser.engine.lifecycleDiagnostics()));
    await cleanup().catch(() => {});
    if (!smoke && app.isReady() && error.code !== 'RECOVERY_CANCELLED') dialog.showErrorBox('Caddi could not start', 'The development browser could not start. Details are in the local terminal.');
    app.exit(1);
  });
}
