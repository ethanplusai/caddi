// Invoked only by caddi-fault-driver.mjs. One hidden app and fresh owned profiles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appendFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, protocol } from 'electron';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { ensurePrivateDirectory } from '../src/caddi/desktop/profile-paths.mjs';
import { stateDigest } from '../src/caddi/state/store.mjs';
import { openOwnedSystemProof } from '../src/caddi/desktop/owned-system-proof.mjs';
import { FAULT_LIMITS, pause, digest, processIdentity, sameProcess, validateGpuIdentity, writePrivateJSON } from './caddi-fault-support.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configArg = process.argv.find(value => value.startsWith('--caddi-fault-config='));
const phaseArg = process.argv.find(value => value.startsWith('--caddi-fault-phase='));
assert.ok(configArg && phaseArg && !app.isPackaged && process.platform === 'darwin', 'Checkout-only owned fault child');
const configPath = path.resolve(configArg.slice('--caddi-fault-config='.length)), phase = phaseArg.slice('--caddi-fault-phase='.length);
assert.ok(['seed', 'restore'].includes(phase));
console.log('CADDI_FAULT_BOOT ' + JSON.stringify({ phase, pid: process.pid, stage: 'entry-module' }));
const runRoot = await fs.realpath(path.dirname(configPath));
const expectedParent = await fs.realpath(path.join(projectRoot, '.test-artifacts', 'caddi-fault-proof'));
assert.equal(path.dirname(runRoot), expectedParent);
assert.equal(path.basename(configPath), 'config.json');
const configInfo = await fs.lstat(configPath);
assert.equal(configInfo.isSymbolicLink(), false); assert.ok(configInfo.isFile() && configInfo.size < 8192 && (configInfo.mode & 0o077) === 0);
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
assert.equal(config.format, 'caddi-owned-fault-config-v1'); assert.equal(config.projectRoot, projectRoot);
assert.equal(config.runRoot, runRoot); assert.equal(config.driverPid, process.ppid);
assert.equal(await fs.realpath(process.execPath), config.electronExecutable);
assert.match(config.nonce, /^[a-f0-9]{48}$/); assert.match(config.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(config.dataRoot, path.join(runRoot, 'data')); assert.ok(Date.now() < config.expiresAt);
assert.equal(configInfo.uid, process.getuid());
ensurePrivateDirectory(runRoot); ensurePrivateDirectory(config.dataRoot);
const phaseRoot = ensurePrivateDirectory(path.join(runRoot, phase));
appendFileSync(path.join(phaseRoot, 'journal.jsonl'), JSON.stringify({ type: 'entry-paths-validated', phase, pid: process.pid,
  at: new Date().toISOString(), appReady: app.isReady() }) + '\n', { mode: 0o600 });
const runtime = config.runtimeRoots?.[phase];
assert.ok(runtime && typeof runtime.directory === 'string');
assert.equal(path.dirname(runtime.directory), path.join(projectRoot, '.test-artifacts'));
assert.match(path.basename(runtime.directory), phase === 'seed' ? /^cf-s-[A-Za-z0-9]+$/ : /^cf-r-[A-Za-z0-9]+$/);
ensurePrivateDirectory(runtime.directory);
const runtimeInfo = await fs.lstat(runtime.directory);
assert.equal(runtimeInfo.dev, runtime.dev); assert.equal(runtimeInfo.ino, runtime.ino);
const runtimeMarker = path.join(runtime.directory, 'owner.json'), markerInfo = await fs.lstat(runtimeMarker);
assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink() && markerInfo.size < 4096 && markerInfo.uid === process.getuid() && (markerInfo.mode & 0o077) === 0);
assert.deepEqual(JSON.parse(await fs.readFile(runtimeMarker, 'utf8')), { nonce: config.nonce, phase, proofRoot: runRoot, driverPid: config.driverPid });
assert.ok(Buffer.byteLength(path.join(runtime.directory, 'b.sock')) <= 100);
for (const directory of [path.join(config.dataRoot, 'electron'), path.join(config.dataRoot, 'electron-session')]) ensurePrivateDirectory(directory);
const ownedSystemProof = openOwnedSystemProof(config.systemProof), systemLifecycle = ownedSystemProof.createLifecycle();
app.setName('Caddi Isolated Fault Proof');
app.setPath('userData', path.join(config.dataRoot, 'electron'));
app.setPath('sessionData', path.join(config.dataRoot, 'electron-session'));
protocol.registerSchemesAsPrivileged([{ scheme: 'caddi', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const started = Date.now(), reportFile = path.join(phaseRoot, 'result.json'), stateFile = path.join(phaseRoot, 'state.json');
const journalFile = path.join(phaseRoot, 'journal.jsonl');
const report = { format: 'caddi-fault-child-v1', phase, nonce: config.nonce, pid: process.pid, parentPid: process.ppid,
  status: 'running', startedAt: new Date().toISOString(), checks: [], nativeEvents: [],
  environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
  bounds: { maximumSimultaneousWindows: 1, observedWindows: 0, nativeWindowLifetimes: 0 },
  gpu: { status: 'not-started' }, cleanup: { nativeClosed: false } };
let browser, failed = null, watchdog, resourceTimer, resourceFailure = null, activeWindows = 0, finishing = false;
const nativePages = new Set(), sessionSet = new Set();
function journal(type, detail = {}) {
  const value = { type, phase, pid: process.pid, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...detail };
  appendFileSync(journalFile, JSON.stringify(value) + '\n', { mode: 0o600 });
}
function fatalChrome(details) {
  // A persistent fixture cannot inject the production recovery choice. Stop this
  // owned child before its native dialog is offered, and record an unqualified
  // result instead of pretending that chrome recovered.
  const event = { surface: 'chrome', reason: details.reason, exitCode: details.exitCode, at: Date.now() };
  report.nativeEvents.push(event); report.status = 'failed'; report.error = { code: 'FAULT_CHROME_GONE', message: 'Owned chrome crashed; interactive recovery was not exercised.' };
  journal('chrome-gone-abort', event);
  try { browser?.chromeRecovery.close(); } catch {}
  const fd = openSync(reportFile, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  app.exit(78);
}
// This fixture owns termination. Electron otherwise quits automatically after
// the last native window closes, potentially interrupting the awaited final
// journal/checkpoint. The unchanged watchdog still bounds cleanup and reporting.
app.on('window-all-closed', () => { journal('all-native-windows-closed', { finishing }); });
app.on('browser-window-created', (_event, native) => {
  activeWindows++; report.bounds.nativeWindowLifetimes++;
  report.bounds.observedWindows = Math.max(report.bounds.observedWindows, activeWindows);
  native.once('closed', () => { activeWindows--; });
  native.webContents.prependListener('render-process-gone', (_event, details) => fatalChrome(details));
  if (activeWindows > 1) { report.error = { code: 'FAULT_WINDOW_BOUND' }; app.exit(79); }
});
app.on('child-process-gone', (_event, details) => {
  const event = { surface: 'child', type: details.type, reason: details.reason, exitCode: details.exitCode, at: Date.now() };
  report.nativeEvents.push(event); journal('child-process-gone', event);
});
async function timed(work, label, ms = FAULT_LIMITS.stepMs) {
  report.lastOperation = label;
  if (resourceFailure && !finishing) throw resourceFailure;
  assert.ok(Date.now() < config.expiresAt - 4000, 'Total fixture deadline');
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FAULT_TIMEOUT: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label, ms = FAULT_LIMITS.stepMs) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label, Math.min(ms, FAULT_LIMITS.stepMs))) return; await pause(25); }
  throw new Error('FAULT_TIMEOUT: ' + label);
}
async function save() { report.elapsedMs = Date.now() - started; await writePrivateJSON(reportFile, report); }
async function check(name) { report.checks.push(name); journal('pass', { name }); await save(); }
async function checkpoint(status, extra = {}) {
  const temporary = stateFile + '.tmp';
  await writePrivateJSON(temporary, { format: 'caddi-fault-state-v1', nonce: config.nonce, pid: process.pid, phase, status, ...extra });
  await fs.rename(temporary, stateFile); journal('checkpoint', { status });
}
const activeTab = (state, workspaceId) => state.groups.find(group => group.id === state.workspaces.find(item => item.id === workspaceId).activeGroupId).activeTabId;
function projection(state) {
  return { activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map(item => ({ id: item.id, identityId: item.identityId, name: item.name, kind: item.kind, activeGroupId: item.activeGroupId, lifecycle: item.lifecycle ?? null })),
    groups: state.groups.map(item => ({ id: item.id, workspaceId: item.workspaceId, name: item.name, activeTabId: item.activeTabId, activeLayoutId: item.activeLayoutId ?? null })),
    tabs: state.tabs.map(item => ({ id: item.id, workspaceId: item.workspaceId, groupId: item.groupId, url: item.url, title: item.title,
      status: item.status, pinned: item.pinned === true, folderId: item.folderId ?? null, dormant: item.dormant ?? false, createdAt: item.createdAt })),
    folders: state.folders ?? [], layouts: state.layouts ?? [] };
}
function track(page) {
  if (nativePages.has(page)) return page;
  nativePages.add(page); sessionSet.add(page.session);
  page.on('render-process-gone', (_event, details) => {
    const event = { surface: 'page', webContentsId: page.id, reason: details.reason, exitCode: details.exitCode, at: Date.now() };
    report.nativeEvents.push(event); journal('renderer-process-gone', event);
  });
  return page;
}
async function select(workspaceId, tabId = null) {
  await timed(browser.act({ type: 'workspace.select', workspaceId }), 'owner workspace selection');
  if (tabId) await timed(browser.act({ type: 'tab.select', tabId }), 'owner explicit tab selection');
  const query = { workspaceId, tabId: tabId ?? activeTab(browser.getState(), workspaceId) };
  return { query, page: track(browser.engine.getView(query).webContents) };
}
async function navigate(workspaceId, pathname) {
  const current = await select(workspaceId);
  await timed(browser.act({ type: 'navigate', tabId: current.query.tabId, input: config.origin + pathname }), 'loopback navigation');
  await until(() => current.page.getURL() === config.origin + pathname && !current.page.isLoading() && current.page.getTitle() === 'Caddi fault fixture', 'loopback document ready');
  return current;
}
async function evaluate(page, callback, args = []) {
  return timed(page.executeJavaScript('(' + callback.toString() + ')(...' + JSON.stringify(args) + ')'), 'owned page script');
}
async function readSentinel(page) {
  return evaluate(page, async () => {
    const value = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('caddi-fault-fixture', 1);
      opening.onupgradeneeded = () => { opening.transaction.abort(); reject(new Error('Missing persisted database')); };
      opening.onerror = () => reject(new Error('Database open failed'));
      opening.onsuccess = () => {
        const database = opening.result, tx = database.transaction('sentinels', 'readonly'), get = tx.objectStore('sentinels').get('value');
        get.onsuccess = () => { const result = get.result; tx.oncomplete = () => { database.close(); resolve(result); }; };
        tx.onerror = () => { database.close(); reject(new Error('Database read failed')); };
      };
    });
    return { localStorage: localStorage.getItem('caddi-fault'), indexedDB: value, draft: document.getElementById('draft').value };
  });
}
async function flushDurableState() {
  for (const session of sessionSet) {
    session.flushStorageData(); // Electron's DOMStorage flush API is void, not an fsync receipt.
    await timed(session.cookies.flushStore(), 'persistent cookie store flush');
  }
  await timed(browser.flush(), 'application stores flushed');
}
async function seed() {
  const initial = browser.getState(), personal = initial.workspaces.find(item => item.kind === 'personal'), project = initial.workspaces.find(item => item.kind === 'project');
  assert.ok(personal && project && personal.identityId !== project.identityId);
  const entries = [];
  for (const [workspace, pathname, value] of [[personal, '/a', 'synthetic-personal-' + config.nonce], [project, '/b', 'synthetic-project-' + config.nonce]]) {
    const { query, page } = await navigate(workspace.id, pathname);
    assert.equal(page.session.isPersistent(), true); assert.ok(page.session.storagePath.startsWith(path.join(config.dataRoot, 'electron-session') + path.sep));
    await evaluate(page, async marker => {
      localStorage.setItem('caddi-fault', marker); document.getElementById('draft').value = 'UNSAVED-' + marker;
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('caddi-fault-fixture', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('sentinels');
        request.onerror = () => reject(new Error('Database open failed'));
        request.onsuccess = () => {
          const database = request.result, tx = database.transaction('sentinels', 'readwrite', { durability: 'strict' });
          tx.objectStore('sentinels').put(marker, 'value');
          tx.oncomplete = () => { database.close(); resolve(); }; tx.onerror = () => { database.close(); reject(new Error('Database commit failed')); };
        };
      });
      return true;
    }, [value]);
    await timed(page.session.cookies.set({ url: config.origin, name: 'caddi_fault', value, path: '/', httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 3600, sameSite: 'lax' }), 'synthetic persistent cookie');
    const unloadedTabId = await timed(browser.act({ type: 'tab.create', workspaceId: workspace.id, input: config.origin + '/never-loaded-' + entries.length, activate: false }), 'background metadata only');
    assert.equal(browser.engine.workspaceAllocations(workspace.id).pages.some(item => item.tabId === unloadedTabId), false);
    entries.push({ workspaceId: workspace.id, identityId: workspace.identityId, tabId: query.tabId, unloadedTabId, pathname, value });
  }
  assert.equal(sessionSet.size, 2);
  await select(personal.id);
  const blankTabId = await timed(browser.act({ type: 'tab.create', workspaceId: personal.id, input: 'about:blank', activate: true }), 'blank startup anchor');
  await until(() => !browser.engine.getView({ workspaceId: personal.id, tabId: blankTabId }).webContents.isLoading(), 'blank anchor ready');
  const intendedDocuments = metadata => entries.every(entry => {
    const tab = metadata.tabs.find(item => item.id === entry.tabId);
    return tab?.workspaceId === entry.workspaceId && tab.url === config.origin + entry.pathname && tab.title === 'Caddi fault fixture';
  });
  // Native did-finish-load is not a receipt for the host's coalesced metadata
  // queue. Bind the checkpoint to these two fixed intended documents first.
  await until(() => intendedDocuments(browser.getState()), 'both intended documents acknowledged by host metadata');
  await flushDurableState();
  const checkpointState = browser.getState(); assert.equal(intendedDocuments(checkpointState), true);
  const expectedProjection = projection(checkpointState);
  const diskBytes = await fs.readFile(path.join(config.dataRoot, 'metadata', 'state.json'));
  assert.ok(diskBytes.length < 4 * 1024 * 1024);
  const persisted = JSON.parse(diskBytes.toString('utf8'));
  assert.equal(persisted.format, 'caddi-state-snapshot'); assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.sha256, stateDigest(persisted.state));
  assert.equal(intendedDocuments(persisted.state), true);
  assert.deepEqual(projection(persisted.state), expectedProjection, 'flushed on-disk checkpoint matches the intended pre-crash projection');
  assert.deepEqual(projection(browser.getState()), expectedProjection, 'host projection did not advance during checkpoint verification');
  const expected = { format: 'caddi-fault-sentinels-v1', entries, blankTabId, metadata: expectedProjection,
    metadataSnapshotSha256: digest(diskBytes), durableAPIs: {
    applicationFlush: true, cookieFlushPromises: sessionSet.size, domStorageFlushInvocations: sessionSet.size,
    indexedDBStrictTransactionsCompleted: entries.length, actualMetadataFileVerified: true, powerLossAtomicityQualified: false } };
  await writePrivateJSON(path.join(runRoot, 'expected.json'), expected);
  await check('two independent persistent identities durably checkpoint metadata, cookies and completed strict IndexedDB writes');
  await check('unloaded metadata tabs have no native page; the saved startup tab is about:blank');
  const source = track(browser.engine.getView({ workspaceId: entries[0].workspaceId, tabId: entries[0].tabId }).webContents);
  await evaluate(source, () => { window.unfinishedMutation = 'pending'; void fetch('/mutation', { method: 'POST', cache: 'no-store', body: 'synthetic-unfinished-request' })
    .then(() => { window.unfinishedMutation = 'completed'; }, () => { window.unfinishedMutation = 'failed'; }); return true; });
  report.nativeProcesses = app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, creationTime: item.creationTime }));
  report.status = 'checkpointed'; await save();
  await checkpoint('seed-ready', { metadataTabs: expected.metadata.tabs.length, nativeProcesses: report.nativeProcesses });
  // Deliberately do not call close: the driver kills this exact owned main process.
  await new Promise(() => {});
}
async function gpuRecovery(anchor, expected) {
  await evaluate(anchor.page, () => { const canvas = document.createElement('canvas'); canvas.id = 'gpu-proof'; canvas.width = canvas.height = 32;
    document.body.append(canvas); const gl = canvas.getContext('webgl'); if (gl) { gl.clearColor(0.2, 0.4, 0.6, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.finish(); }
    return { webglAvailable: !!gl }; });
  const metrics = app.getAppMetrics().filter(item => item.type === 'GPU');
  if (metrics.length !== 1) { report.gpu = { status: 'unsupported', reason: 'A unique owned GPU process was not available.' }; return; }
  const metric = { pid: metrics[0].pid, type: metrics[0].type, creationTime: metrics[0].creationTime };
  let identity;
  try { identity = await processIdentity(metric.pid); }
  catch { report.gpu = { status: 'unsupported', reason: 'OS process identity could not be established.' }; return; }
  const owner = { mainPid: process.pid, uid: process.getuid(), bundlePath: config.bundlePath };
  if (!validateGpuIdentity(metric, identity, owner)) { report.gpu = { status: 'unsupported', reason: 'GPU parent, group, executable or creation time was not proven.' }; return; }
  const checked = await processIdentity(metric.pid), current = app.getAppMetrics().find(item => item.pid === metric.pid && item.type === 'GPU');
  if (!sameProcess(identity, checked) || !validateGpuIdentity(current, checked, owner) || current.creationTime !== metric.creationTime) {
    report.gpu = { status: 'unsupported', reason: 'GPU identity changed before the controlled fault.' }; return;
  }
  report.gpu = { status: 'prepared', target: { ...metric, ...identity }, signal: null };
  journal('owned-gpu-prepared', report.gpu); await save();
  // Recheck immediately after evidence I/O, before the only GPU signal.
  const finalIdentity = await processIdentity(metric.pid), finalMetric = app.getAppMetrics().find(item => item.pid === metric.pid && item.type === 'GPU');
  if (!sameProcess(identity, finalIdentity) || !validateGpuIdentity(finalMetric, finalIdentity, owner) || finalMetric.creationTime !== metric.creationTime) {
    report.gpu = { status: 'unsupported', reason: 'GPU identity changed at the final signal fence.' }; return;
  }
  const at = Date.now();
  try { process.kill(metric.pid, 'SIGKILL'); }
  catch (error) {
    if (error.code === 'ESRCH') { report.gpu = { status: 'unsupported', reason: 'The proven GPU exited before the controlled signal.' }; return; }
    throw error;
  }
  report.gpu.status = 'injected'; report.gpu.signal = 'SIGKILL'; report.gpu.injectedAt = at;
  journal('owned-gpu-signal', { pid: metric.pid, creationTime: metric.creationTime, at });
  await until(() => report.nativeEvents.some(event => event.surface === 'child' && event.type === 'GPU' && event.at >= at), 'actual GPU child-process-gone');
  await until(() => app.getAppMetrics().some(item => item.type === 'GPU' && (item.pid !== metric.pid || item.creationTime !== metric.creationTime)), 'replacement native GPU', 10000);
  const pageCrashes = report.nativeEvents.filter(event => event.surface === 'page' && event.at >= at);
  report.gpu.pageRendererCrashes = pageCrashes;
  report.gpu.recovery = pageCrashes.length ? 'explicit-owner-reload-required' : 'page-renderers-survived';
  if (pageCrashes.some(event => event.webContentsId === anchor.page.id)) {
    await timed(browser.act({ type: 'reload', tabId: anchor.query.tabId }), 'owner reload after GPU page crash');
    await until(() => !anchor.page.isLoading() && anchor.page.getTitle() === 'Caddi fault fixture', 'page reload after GPU fault');
  }
  const live = await readSentinel(anchor.page);
  assert.equal(live.localStorage, expected.value); assert.equal(live.indexedDB, expected.value);
  const responsive = await evaluate(anchor.page, () => { document.getElementById('draft').value = 'after-owned-gpu-fault';
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16; const context = canvas.getContext('2d');
    context.fillStyle = '#142126'; context.fillRect(0, 0, 16, 16); return { draft: document.getElementById('draft').value, alpha: context.getImageData(0, 0, 1, 1).data[3] }; });
  assert.deepEqual(responsive, { draft: 'after-owned-gpu-fault', alpha: 255 });
  report.gpu.replacement = app.getAppMetrics().filter(item => item.type === 'GPU').map(item => ({ pid: item.pid, type: item.type, creationTime: item.creationTime }));
  report.gpu.engineAfter = browser.engine.lifecycleDiagnostics().map(item => ({ workspaceId: item.workspaceId, tabId: item.tabId, destroyed: item.destroyed, rendererGone: item.rendererGone }));
  report.gpu.status = 'passed';
  await check('exact owned GPU termination produces a real child-process-gone event, a replacement GPU and a responsive isolated page');
}
async function restore() {
  const expected = JSON.parse(await fs.readFile(path.join(runRoot, 'expected.json'), 'utf8'));
  assert.equal(expected.format, 'caddi-fault-sentinels-v1');
  await timed(browser.flush(), 'restored initial metadata flush');
  assert.deepEqual(projection(browser.getState()), expected.metadata);
  const allocations = browser.engine.lifecycleDiagnostics();
  assert.equal(allocations.length, 1); assert.equal(allocations[0].tabId, expected.blankTabId);
  assert.equal(browser.engine.navigation({ workspaceId: allocations[0].workspaceId, tabId: allocations[0].tabId }).url, 'about:blank');
  assert.equal(browser.access.connections().length, 0); assert.equal(browser.access.pendingConnections().length, 0);
  assert.equal(browser.getState().workspaces.some(item => browser.privacy.hasActiveLease(item.id)), false);
  assert.equal(browser.snapshot().services.owner.connections.length, 0);
  await check('abrupt main-process exit restores the saved workspace, identity, group and tab projection with one lazy about:blank native page and no agent authority');
  await checkpoint('restore-lazy', { nativePages: allocations.length });
  // The parent records the live server counters before explicit tab hydration.
  await until(async () => {
    try { const answer = JSON.parse(await fs.readFile(path.join(phaseRoot, 'lazy-ack.json'), 'utf8'));
      return answer.nonce === config.nonce && answer.pid === process.pid && answer.approved === true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'parent lazy-network receipt', 4000);
  let anchor;
  report.restored = [];
  for (const entry of expected.entries) {
    const current = await select(entry.workspaceId, entry.tabId); anchor = current;
    await until(() => current.page.getURL() === config.origin + entry.pathname && !current.page.isLoading() && current.page.getTitle() === 'Caddi fault fixture', 'explicit restored page loaded');
    assert.equal(current.page.session.isPersistent(), true);
    assert.ok(current.page.session.storagePath.startsWith(path.join(config.dataRoot, 'electron-session') + path.sep));
    assert.equal(browser.getState().workspaces.find(item => item.id === entry.workspaceId).identityId, entry.identityId);
    const value = await readSentinel(current.page), cookies = await current.page.session.cookies.get({ url: config.origin, name: 'caddi_fault' });
    assert.equal(value.localStorage, entry.value); assert.equal(value.indexedDB, entry.value);
    assert.equal(value.draft, 'fresh document draft'); assert.equal(cookies.length, 1);
    assert.equal(cookies[0].value, entry.value); assert.equal(cookies[0].httpOnly, true); assert.equal(cookies[0].session, false);
    assert.equal(browser.engine.workspaceAllocations(entry.workspaceId).pages.some(item => item.tabId === entry.unloadedTabId), false);
    report.restored.push({ workspaceId: entry.workspaceId, identityId: entry.identityId, tabId: entry.tabId,
      persistentSession: true, localStorage: true, indexedDB: true, persistentHttpOnlyCookie: true, unsavedDraftRestored: false, backgroundTabRemainsUnloaded: true });
  }
  assert.equal(sessionSet.size, 2);
  await check('owner-selected pages recover distinct persistent cookie, localStorage and IndexedDB sentinels; unsaved DOM drafts are not promised or recovered');
  await gpuRecovery(anchor, expected.entries[expected.entries.length - 1]);
  await flushDurableState();
}

async function runFaultChild() {
try {
  journal('electron-ready', { appReady: app.isReady() });
  browser = await timed(createDesktopApp({ projectRoot, dataRoot: config.dataRoot, runRoot: runtime.directory, show: false, enableMicrophone: false, persistentProfiles: true,
    systemLifecycle, ownedSystemProof }), 'fresh hidden persistent composition', 15000);
  report.systemLifecycleSource = browser.systemLifecycle.snapshot().source;
  assert.equal(browser.getWindows().length, 1); assert.equal(browser.window.isVisible(), false);
  assert.equal(browser.engine.capabilities.persistentStorage, true);
  assert.equal(typeof browser.setTestCloseDecision, 'undefined'); assert.equal(typeof browser.setTestRecoveryDecision, 'undefined');
  const initialResource = await timed(browser.resources.preflight(), 'unchanged runtime resource preflight', 8000);
  report.resources = [initialResource];
  resourceTimer = setInterval(() => {
    const sample = browser.resources.snapshot();
    if (report.resources.at(-1)?.sample?.sampledAt !== sample.sample?.sampledAt) report.resources.push(sample);
    if (!sample.healthy && sample.reason !== 'RESOURCE_WARMUP') resourceFailure ??= new Error(sample.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE');
  }, 1000);
  journal('native-app-ready', { nativeWindows: 1 });
  if (phase === 'seed') await seed();
  else {
    await restore();
    await checkpoint('restore-verified');
    await until(async () => {
      try { const answer = JSON.parse(await fs.readFile(path.join(phaseRoot, 'close-ack.json'), 'utf8'));
        return answer.nonce === config.nonce && answer.pid === process.pid && answer.approved === true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'parent final native inventory receipt', 4000);
  }
} catch (error) { failed = error; }
finally {
  finishing = true; clearInterval(resourceTimer);
  if (browser) {
    try { await timed(browser.close(), 'owned native app close', 7000); report.cleanup.nativeClosed = true;
      assert.equal(browser.getWindows().length, 0); assert.equal([...nativePages].every(page => page.isDestroyed()), true); }
    catch (error) { failed ??= error; report.cleanup.error = String(error?.message ?? error).slice(0, 300); }
  }
  report.status = failed ? 'failed' : 'passed';
  if (failed) report.error = { code: failed.code ?? 'FAULT_CHILD_ASSERTION', message: String(failed.message ?? failed).slice(0, 1200), stack: String(failed.stack ?? '').slice(0, 5000) };
  await save(); await checkpoint(failed ? 'failed' : 'complete');
  clearTimeout(watchdog);
  app.exit(failed ? 1 : 0);
}
}
// Electron waits for entry-module evaluation before ready. Await only the setup
// required before ready above; awaiting whenReady at top level would deadlock it.
// See Electron's ESM main-process startup guidance.
watchdog = setTimeout(() => { journal('child-deadline'); app.exit(80); }, Math.min(FAULT_LIMITS.childMs, config.expiresAt - Date.now() - 3000));
journal('entry-configured', { appReady: app.isReady() });
void app.whenReady().then(runFaultChild).catch(error => {
  clearTimeout(watchdog); clearInterval(resourceTimer);
  report.status = 'failed'; report.error = { code: 'FAULT_ENTRY_FAILURE', message: String(error?.message ?? error).slice(0, 1200) };
  journal('entry-failed', { code: report.error.code });
  const fd = openSync(reportFile, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  app.exit(1);
});
