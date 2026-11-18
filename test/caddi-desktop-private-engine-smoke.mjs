// Standalone disposable engine proof. Main must call this BEFORE createDesktopApp;
// two live engines must not compete for the shared page IPC channel names.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { app, BrowserWindow } from 'electron';
import { createElectronEngine } from '../src/caddi/desktop/engine.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createProfilePaths, ensurePrivateDirectory } from '../src/caddi/desktop/profile-paths.mjs';
import { createDesktopResourceMonitor, DESKTOP_RESOURCE_POLICY } from '../src/caddi/desktop/resources.mjs';

const MAX_RUN_MS = 60000, WORK_MS = 45000, STEP_MS = 5000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const digest = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error?.code === expected;
async function sourceEvidence(root) {
  const files = [];
  async function walk(relative) {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name); if (entry.isSymbolicLink()) fail('PRIVATE_SOURCE_SYMLINK');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) { const bytes = await fs.readFile(path.join(root, name)); files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) }); }
      if (files.length > 1024) fail('PRIVATE_SOURCE_LIMIT');
    }
  }
  await walk('src/caddi');
  for (const name of ['package.json', 'package-lock.json', 'test/caddi-desktop-private-engine-smoke.mjs']) {
    const bytes = await fs.readFile(path.join(root, name)); files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: digest(JSON.stringify(files)), files,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 }).trim() };
}

export async function runDesktopPrivateEngineSmoke({ projectRoot, runRoot }) {
  const began = performance.now(), proofParent = path.join(projectRoot, '.test-artifacts', 'caddi-private-engine-proof');
  await fs.mkdir(proofParent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(proofParent, 'run-')); await fs.chmod(proof, 0o700);
  const reportPath = path.join(proof, 'report.json'), controller = new AbortController();
  const report = { format: 'caddi-private-engine-smoke-v1', status: 'running', startedAt: new Date().toISOString(),
    policy: { maximumRunMs: MAX_RUN_MS, maximumWorkMs: WORK_MS, operationTimeoutMs: STEP_MS, resources: DESKTOP_RESOURCE_POLICY },
    environment: { platform: process.platform, arch: process.arch, electron: process.versions.electron,
      chromium: process.versions.chrome, node: process.versions.node, osVersion: process.getSystemVersion() },
    workload: { persistentNormalIdentities: 2, populatedNormalIdentities: 1, emptyUnboundNormalProbes: 1,
      freshPrivateIdentities: 3, loopbackOnly: true, realCredentials: false,
      existingProfiles: false, hiddenWindows: true, maximumConcurrentWindows: 2, nativeWindowLifetimes: 3,
      injectedRendererCrashes: 2, agentConnections: 0 }, checks: [], resources: [],
    limits: ['Engine-only proof; private host/state/history/UI integration is not exercised.',
      'The persistent normal profile belongs solely to this new disposable run directory.',
      'Synthetic script userGesture verifies native unload behavior; this is not physical keyboard/focus qualification.',
      'No guarantee is made about OS swap, crash dumps, or forensic memory erasure.'] };
  let checkpoint = 'preflight', window, privateWindow, engine, privacy, monitor, server, resourceWatch, engineClosed = false, succeeded = false;
  const privateBindings = [], samples = new Set();
  function stop(reason) { if (!controller.signal.aborted) { const error = new Error(reason); error.code = reason; controller.abort(error); } }
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })); void aborted.catch(() => {});
  const deadline = setTimeout(() => stop('PRIVATE_SMOKE_DURATION'), WORK_MS);
  async function timed(promise, label, timeout = STEP_MS, cleanup = false) {
    checkpoint = label; if (!cleanup && controller.signal.aborted) throw controller.signal.reason;
    const remaining = MAX_RUN_MS - 2000 - (performance.now() - began);
    if (remaining <= 0) fail('PRIVATE_SMOKE_DURATION');
    timeout = Math.max(1, Math.min(timeout, remaining));
    let timer;
    try { return await Promise.race([promise, ...(cleanup ? [] : [aborted]), new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error('PRIVATE_SMOKE_TIMEOUT'); error.code = 'PRIVATE_SMOKE_TIMEOUT'; reject(error); }, timeout);
    })]); } finally { clearTimeout(timer); }
  }
  async function until(check, label) {
    const expires = performance.now() + STEP_MS;
    while (performance.now() < expires) { if (await timed(Promise.resolve().then(check), label)) return; await timed(pause(20), label); }
    fail('PRIVATE_SMOKE_TIMEOUT');
  }
  async function save() { report.elapsedMs = Math.round(performance.now() - began); report.checkpoint = checkpoint;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  async function check(name) { report.checks.push(name); console.log('PRIVATE_ENGINE_PASS ' + name); await save(); }
  function record(state, label) {
    if (!state?.sample || samples.has(state.sample.sampledAt)) return;
    samples.add(state.sample.sampledAt); report.resources.push({ label, elapsedMs: Math.round(performance.now() - began), ...state.sample,
      healthy: state.healthy, reason: state.reason });
  }
  async function resource(label) {
    const state = await timed(monitor.sample(), 'resource-' + label); record(state, label);
    if (!state.healthy) fail(state.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE');
  }
  const request = binding => ({ ...binding, beforeDispose: () => true });
  try {
    if (app.isPackaged || !process.argv.includes('--caddi-private-engine-smoke') || BrowserWindow.getAllWindows().length) fail('PRIVATE_STANDALONE_REQUIRED');
    const info = await fs.lstat(runRoot), real = await fs.realpath(runRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
        real !== runRoot || !runRoot.startsWith(path.join(projectRoot, '.test-artifacts') + path.sep)) fail('PRIVATE_DISPOSABLE_ROOT_REQUIRED');
    const dataRoot = ensurePrivateDirectory(path.join(runRoot, 'data'));
    if (app.getPath('sessionData') !== path.join(dataRoot, 'electron-session')) fail('PRIVATE_SESSION_PATH_MISMATCH');
    report.sourceBefore = await timed(sourceEvidence(projectRoot), 'source-before');
    monitor = createDesktopResourceMonitor({ directory: runRoot, getAppMetrics: () => app.getAppMetrics(), getSystemMemoryInfo: () => process.getSystemMemoryInfo() });
    monitor.start();
    try { await timed(monitor.preflight(), 'resource-preflight', 8000); } finally { record(monitor.snapshot(), 'preflight'); }
    resourceWatch = setInterval(() => { const state = monitor.snapshot(); record(state, 'periodic'); if (!state.healthy) stop(state.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE'); }, 250);
    server = http.createServer((req, response) => {
      if (req.method !== 'GET' || !['/normal', '/private-a', '/private-b', '/private-c', '/changed'].includes(req.url)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
      response.end('<!doctype html><title>Caddi private engine fixture</title><label>Draft<input id="draft" value="initial"></label>');
    });
    server.listen(0, '127.0.0.1'); await timed(once(server, 'listening'), 'fixture-listen');
    const origin = 'http://127.0.0.1:' + server.address().port;
    window = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    privacy = createControlCoordinator(); const profiles = createProfilePaths(dataRoot), profileCalls = [];
    engine = createElectronEngine({ window, privacy, profilePaths: { forIdentity(identityId) { profileCalls.push(identityId); return profiles.forIdentity(identityId); } } });
    privateWindow = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    engine.registerWindow(privateWindow, { kind: 'private' });
    assert.throws(() => engine.registerWindow(privateWindow), code('WINDOW_KIND_MISMATCH'));
    assert.throws(() => engine.registerWindow(window, { kind: 'private' }), code('WINDOW_KIND_MISMATCH'));
    const normal = { workspaceId: 'normal-' + randomUUID(), identityId: 'identity-' + randomUUID() };
    engine.createWorkspace(normal);
    assert.throws(() => engine.transferWorkspace(normal.workspaceId, privateWindow), code('WINDOW_KIND_MISMATCH'));
    assert.throws(() => engine.createPrivateWorkspace(normal), code('PRIVATE_IDENTITY_PROTECTED'));
    async function page(workspaceId, suffix, tabId = 'tab-' + randomUUID()) {
      const query = { workspaceId, tabId };
      engine.createTab({ ...query, url: origin + '/' + suffix });
      const wc = engine.getView(query).webContents;
      await until(() => engine.workspaceActivity(workspaceId).pages.some(item => item.tabId === query.tabId && item.ready && !item.busy) && wc.getTitle() === 'Caddi private engine fixture', 'page-' + suffix);
      return { query, wc, session: wc.session };
    }
    async function crashOwnedPage(current, siblings, label) {
      const processId = current.wc.getOSProcessId();
      assert.ok(Number.isSafeInteger(processId) && processId > 0);
      for (const sibling of [...siblings.map(item => item.wc), window.webContents, privateWindow.webContents])
        assert.notEqual(sibling.getOSProcessId(), processId, 'injected crash must be isolated to this synthetic page process');
      const gone = once(current.wc, 'render-process-gone');
      current.wc.forcefullyCrashRenderer();
      const [, details] = await timed(gone, label + '-crash');
      assert.ok(['crashed', 'killed'].includes(details.reason)); assert.equal(current.wc.isDestroyed(), false);
      const allocation = engine.workspaceAllocations(current.query.workspaceId).pages.find(item => item.tabId === current.query.tabId);
      assert.ok(allocation); assert.equal(allocation.destroyed, false);
      assert.equal(engine.navigation(current.query).crashed, true);
      report.rendererCrashes ??= []; report.rendererCrashes.push({ label, reason: details.reason, exitCode: details.exitCode });
    }
    const normalPage = await page(normal.workspaceId, 'normal'), normalSession = normalPage.session;
    assert.equal(normalSession.isPersistent(), true); assert.equal(normalSession.storagePath, profiles.forIdentity(normal.identityId).path);
    await timed(normalPage.wc.executeJavaScript('document.cookie="scope=normal-synthetic;Path=/;SameSite=Lax";localStorage.setItem("caddi-scope","normal-synthetic");draft.value="normal draft";'), 'normal-sentinel');
    normalSession.flushStorageData(); await timed(normalSession.cookies.flushStore(), 'normal-flush');
    const normalProfileDirectories = (await fs.readdir(profiles.root)).sort();
    await check('normal workspace uses a real persistent partition inside the new disposable root');
    const makePrivate = () => {
      const binding = engine.createPrivateWorkspace({ workspaceId: 'private-' + randomUUID(), identityId: 'private-id-' + randomUUID() });
      privateBindings.push(binding);
      assert.equal(engine.getWorkspaceOwnerWindow(binding.workspaceId), null);
      assert.throws(() => engine.createTab({ workspaceId: binding.workspaceId, tabId: 'unbound-' + randomUUID() }), code('WORKSPACE_WINDOW_UNBOUND'));
      assert.equal(engine.workspaceAllocations(binding.workspaceId).pages.length, 0);
      assert.throws(() => engine.transferWorkspace(binding.workspaceId, window), code('WINDOW_KIND_MISMATCH'));
      assert.deepEqual(engine.transferWorkspace(binding.workspaceId, privateWindow), { moved: true });
      return binding;
    };
    const a = makePrivate(), aPage = await page(a.workspaceId, 'private-a'), b = makePrivate(), bPage = await page(b.workspaceId, 'private-b');
    for (const current of [aPage, bPage]) { assert.equal(current.session.isPersistent(), false); assert.equal(current.session.storagePath, null); assert.notEqual(current.session, normalSession); }
    assert.notEqual(aPage.session, bPage.session); assert.deepEqual(profileCalls, [normal.identityId]);
    assert.deepEqual((await fs.readdir(profiles.root)).sort(), normalProfileDirectories);
    await check('private identities start unbound, require a private window and use distinct memory Sessions without persistent paths');
    const usage = await timed(engine.humanStorageUsage({ ...normal, expectedOwnerWindow: window, beforeRead: () => true }), 'normal-storage-usage', 3500);
    assert.equal(usage.workspaceId, normal.workspaceId); assert.equal(usage.identityId, normal.identityId);
    assert.ok(['measured', 'partial', 'pending'].includes(usage.status));
    for (const bytes of [usage.profileAllocatedBytes, usage.httpCacheBytes]) assert.ok(bytes === null || (Number.isSafeInteger(bytes) && bytes >= 0));
    assert.equal(JSON.stringify(usage).includes(profiles.root), false);
    await assert.rejects(engine.humanStorageUsage({ ...normal, expectedOwnerWindow: privateWindow, beforeRead: () => true }), code('STORAGE_CONTEXT_CHANGED'));
    const privateUsage = await timed(engine.humanStorageUsage({ workspaceId: a.workspaceId, identityId: a.identityId,
      expectedOwnerWindow: privateWindow, beforeRead: () => true }), 'private-storage-usage');
    assert.equal(privateUsage.status, 'not-applicable'); assert.equal(privateUsage.reason, 'PRIVATE_SESSION');
    assert.equal(privateUsage.profileAllocatedBytes, null); assert.equal(privateUsage.httpCacheBytes, null);
    report.storageUsage = { status: usage.status, profileAllocatedBytes: usage.profileAllocatedBytes, httpCacheBytes: usage.httpCacheBytes,
      reason: usage.reason, privateStatus: privateUsage.status };
    await check('owner-bound storage usage returns bounded counts or explicit incomplete status, and private usage is not measured');
    await timed(aPage.wc.executeJavaScript('document.cookie="scope=private-synthetic;Path=/;SameSite=Lax";localStorage.setItem("caddi-scope","private-synthetic");draft.value="private draft";'), 'private-sentinel');
    const read = current => current.wc.executeJavaScript('({cookie:document.cookie,storage:localStorage.getItem("caddi-scope"),draft:draft.value})');
    assert.deepEqual(await timed(read(normalPage), 'normal-isolation'), { cookie: 'scope=normal-synthetic', storage: 'normal-synthetic', draft: 'normal draft' });
    assert.deepEqual(await timed(read(bPage), 'private-sibling-isolation'), { cookie: '', storage: null, draft: 'initial' });
    await check('same-origin cookies, localStorage and drafts are isolated from normal and sibling private identities');
    for (const invalid of [{ ...request(a), capability: {} }, { ...request(a), identityId: b.identityId },
      { ...request(a), engineIncarnation: 'wrong-engine' }, { ...request(a), workspaceId: normal.workspaceId }])
      await assert.rejects(engine.disposePrivateWorkspace(invalid), code('PRIVATE_CAPABILITY_INVALID'));
    await assert.rejects(engine.disposePrivateWorkspace(request(a)), code('PRIVATE_PAGES_OPEN'));
    await assert.rejects(engine.closeTab(aPage.query), code('PRIVATE_NATIVE_CLOSE_REQUIRED'));
    await assert.rejects(engine.closeWorkspace(a.workspaceId), code('PRIVATE_DISPOSAL_REQUIRED'));
    await assert.rejects(engine.clearWorkspaceSiteData(a.workspaceId), code('PRIVATE_DISPOSAL_REQUIRED'));
    await assert.rejects(engine.close(), code('PRIVATE_PAGES_OPEN'));
    assert.equal(normalPage.wc.isDestroyed(), false); assert.equal(aPage.wc.isDestroyed(), false);
    assert.equal(engine.pageResidency().resident, 3);
    await check('wrong capabilities and all generic forceful disposal paths retain open native pages and normal state');
    await assert.rejects(engine.execute({ operation: 'page:observe', target: engine.getTarget(aPage.query), payload: {} }, { beforeDispatch: () => true }), code('PRIVATE_AGENT_ACCESS_DENIED'));
    // Reading page content is agent page work too, and the owner's Copy page as Markdown is page capture.
    await assert.rejects(engine.execute({ operation: 'page:read', target: engine.getTarget(aPage.query), payload: {} }, { beforeDispatch: () => true }), code('PRIVATE_AGENT_ACCESS_DENIED'));
    await assert.rejects(engine.execute({ operation: 'page:extract', target: engine.getTarget(aPage.query), payload: { kind: 'links' } }, { beforeDispatch: () => true }), code('PRIVATE_AGENT_ACCESS_DENIED'));
    await assert.rejects(engine.ownerReadPage(aPage.query), code('PRIVATE_CAPTURE_UNAVAILABLE'));
    await assert.rejects(engine.capturePageScreenshot(aPage.query, engine.getTarget(aPage.query)), code('PRIVATE_CAPTURE_UNAVAILABLE'));
    await assert.rejects(engine.beginSelection({ ...aPage.query }), code('PRIVATE_CAPTURE_UNAVAILABLE'));
    assert.throws(() => engine.allowPopupOnce({ ...aPage.query, ownerWindowId: privateWindow.id }), code('PRIVATE_POPUP_UNAVAILABLE'));
    assert.equal(await timed(aPage.wc.executeJavaScript('window.open("about:blank")===null'), 'private-popup-denied'), true);
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    await check('private pages reject agent execution, capture and auxiliary windows at the engine boundary');
    await resource('before-native-unload');
    const blocked = await timed(privacy.beginPrivacyBarrier({ workspaceId: a.workspaceId }), 'private-barrier');
    assert.equal(blocked.blocked, true); assert.equal(blocked.barrierReady, true);
    const activated = await timed(aPage.wc.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};navigator.userActivation.hasBeenActive', true), 'synthetic-activation');
    if (activated !== true) fail('PRIVATE_SYNTHETIC_ACTIVATION_UNAVAILABLE');
    let decisions = 0;
    const kept = await timed(engine.humanCloseTab(aPage.query, () => { decisions++; return false; }), 'native-stay');
    assert.deepEqual(kept, { closed: false }); assert.equal(decisions, 1); assert.equal(aPage.wc.isDestroyed(), false);
    assert.equal((await timed(read(aPage), 'private-draft-after-veto')).draft, 'private draft');
    assert.equal(privacy.getPrivacyState(a.workspaceId).blocked, true);
    await assert.rejects(engine.disposePrivateWorkspace(request(a)), code('PRIVATE_PAGES_OPEN'));
    await check('native beforeunload veto while already private-blocked retains the draft and prevents identity disposal');
    const stale = await timed(engine.humanCloseTab(aPage.query, async () => {
      decisions++; await privacy.beginPrivacyBarrier({ workspaceId: a.workspaceId }); return true;
    }), 'native-stale-privacy-epoch');
    assert.deepEqual(stale, { closed: false }); assert.equal(decisions, 2); assert.equal(aPage.wc.isDestroyed(), false);
    assert.equal(privacy.getPrivacyState(a.workspaceId).blocked, true);
    assert.ok(privacy.getPrivacyState(a.workspaceId).capturePrivacyEpoch > blocked.capturePrivacyEpoch);
    assert.equal(engine.workspaceAllocations(a.workspaceId).pages.length, 1);
    await check('a new private barrier invalidates an earlier unload approval without resuming authority or removing its allocation');
    const left = await timed(engine.humanCloseTab(aPage.query, () => { decisions++; return true; }), 'native-leave');
    assert.deepEqual(left, { closed: true }); assert.equal(aPage.wc.isDestroyed(), true); assert.equal(decisions, 3);
    assert.equal(engine.workspaceAllocations(a.workspaceId).pages.length, 0);
    assert.equal(privacy.getPrivacyState(a.workspaceId).blocked, true);
    assert.deepEqual(await timed(engine.disposePrivateWorkspace(request(a)), 'dispose-private-a'), { disposed: true });
    assert.deepEqual(await timed(aPage.session.cookies.get({ url: origin }), 'private-cookie-clear'), []);
    assert.equal(engine.getWorkspaceOwnerWindow(a.workspaceId), null);
    assert.deepEqual(await timed(read(normalPage), 'normal-after-disposal'), { cookie: 'scope=normal-synthetic', storage: 'normal-synthetic', draft: 'normal draft' });
    assert.equal(normalSession.isPersistent(), true); assert.equal(normalSession.storagePath, profiles.forIdentity(normal.identityId).path);
    await check('acknowledged native close permits exact private cleanup while persistent normal cookies and storage remain intact');
    const c = makePrivate(); let cPage = await page(c.workspaceId, 'private-c');
    assert.equal(cPage.session.isPersistent(), false); assert.equal(cPage.session.storagePath, null); assert.notEqual(cPage.session, aPage.session);
    assert.deepEqual(await timed(read(cPage), 'fresh-private-after-disposal'), { cookie: '', storage: null, draft: 'initial' });
    assert.throws(() => engine.createPrivateWorkspace({ workspaceId: a.workspaceId, identityId: a.identityId }), code('PRIVATE_IDENTITY_REUSED'));
    assert.throws(() => engine.createWorkspace({ workspaceId: a.workspaceId, identityId: a.identityId }), code('PRIVATE_IDENTITY_REUSED'));
    assert.deepEqual(profileCalls, [normal.identityId]); assert.deepEqual((await fs.readdir(profiles.root)).sort(), normalProfileDirectories);
    await check('a later private identity starts empty and retired private identifiers cannot become persistent identities');
    await timed(cPage.wc.executeJavaScript('localStorage.setItem("caddi-scope","crash-synthetic")'), 'private-crash-sentinel');
    const crashedPrivate = cPage;
    await crashOwnedPage(crashedPrivate, [normalPage, bPage], 'private');
    await assert.rejects(engine.disposePrivateWorkspace(request(c)), code('PRIVATE_PAGES_OPEN'));
    assert.deepEqual(await timed(engine.humanCloseTab(crashedPrivate.query, () => false), 'private-crashed-native-close'), { closed: true });
    assert.equal(crashedPrivate.wc.isDestroyed(), true); assert.equal(engine.workspaceAllocations(c.workspaceId).pages.length, 0);
    cPage = await page(c.workspaceId, 'private-c', crashedPrivate.query.tabId);
    assert.equal(cPage.session, crashedPrivate.session); assert.equal(cPage.session.isPersistent(), false); assert.equal(cPage.session.storagePath, null);
    assert.deepEqual(await timed(read(cPage), 'private-after-crash-reload'), { cookie: '', storage: 'crash-synthetic', draft: 'initial' });
    assert.equal(normalPage.wc.isDestroyed(), false); assert.equal(bPage.wc.isDestroyed(), false);
    await check('a crashed private renderer retains its allocation until native close acknowledgment and reloads in the same ephemeral Session');
    const park = extra => engine.parkWorkspace({ ...normal, expectedOwnerWindow: window, beforePark: () => true, ...extra });
    assert.throws(() => park({ expectedOwnerWindow: privateWindow }), code('WORKSPACE_OWNER_CHANGED'));
    assert.throws(() => park(), code('WORKSPACE_NOT_QUIESCENT'));
    assert.throws(() => engine.parkWorkspace({ workspaceId: b.workspaceId, identityId: b.identityId,
      expectedOwnerWindow: privateWindow, beforePark: () => true }), code('PRIVATE_WORKSPACE_PARK_DENIED'));
    assert.deepEqual(await timed(read(normalPage), 'normal-after-park-refusal'), { cookie: 'scope=normal-synthetic', storage: 'normal-synthetic', draft: 'normal draft' });
    assert.equal(engine.getWorkspaceOwnerWindow(normal.workspaceId), window);
    await check('parking refuses wrong owners, private identities and live native pages without losing the normal draft');
    await crashOwnedPage(normalPage, [bPage, cPage], 'normal');
    assert.deepEqual(await timed(engine.humanCloseTab(normalPage.query, () => false), 'normal-native-close'), { closed: true });
    assert.equal(normalPage.wc.isDestroyed(), true); assert.equal(engine.workspaceAllocations(normal.workspaceId).pages.length, 0);
    await check('a crashed ordinary renderer also requires and receives real native close acknowledgment before parking');
    assert.deepEqual(park(), { parked: true }); assert.equal(engine.getWorkspaceOwnerWindow(normal.workspaceId), null);
    assert.equal(normalSession.isPersistent(), true); assert.equal(normalSession.storagePath, profiles.forIdentity(normal.identityId).path);
    assert.equal((await timed(normalSession.cookies.get({ url: origin }), 'normal-cookies-parked')).find(item => item.name === 'scope')?.value, 'normal-synthetic');
    assert.throws(() => engine.createTab({ workspaceId: normal.workspaceId, tabId: 'parked-' + randomUUID() }), code('WORKSPACE_WINDOW_UNBOUND'));
    assert.throws(() => engine.transferWorkspace(normal.workspaceId, privateWindow), code('WINDOW_KIND_MISMATCH'));
    engine.unregisterWindow(window); window.destroy();
    await until(() => window.isDestroyed() && BrowserWindow.getAllWindows().length === 1, 'normal-window-closed');
    assert.equal(BrowserWindow.getAllWindows().length, 1); assert.equal(bPage.wc.isDestroyed(), false); assert.equal(cPage.wc.isDestroyed(), false);
    const unbound = { workspaceId: 'normal-unbound-' + randomUUID(), identityId: 'identity-unbound-' + randomUUID() };
    engine.createWorkspace(unbound); assert.equal(engine.getWorkspaceOwnerWindow(unbound.workspaceId), null);
    assert.throws(() => engine.createTab({ workspaceId: unbound.workspaceId, tabId: 'unbound-normal-' + randomUUID() }), code('WORKSPACE_WINDOW_UNBOUND'));
    assert.equal(engine.workspaceAllocations(unbound.workspaceId).pages.length, 0);
    await timed(engine.closeWorkspace(unbound.workspaceId), 'close-empty-normal-probe');
    await check('closing the last normal window leaves private pages alive and ordinary identities unbound with persistent storage intact');
    window = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    engine.registerWindow(window); assert.deepEqual(engine.transferWorkspace(normal.workspaceId, window), { moved: true });
    const reopened = await page(normal.workspaceId, 'normal');
    assert.equal(reopened.session, normalSession); assert.equal(engine.getWorkspaceOwnerWindow(normal.workspaceId), window);
    assert.deepEqual(await timed(read(reopened), 'normal-after-rebind'), { cookie: 'scope=normal-synthetic', storage: 'normal-synthetic', draft: 'initial' });
    assert.deepEqual(profileCalls, [normal.identityId, unbound.identityId]); assert.equal(BrowserWindow.getAllWindows().length, 2);
    assert.equal(bPage.wc.isDestroyed(), false); assert.equal(cPage.wc.isDestroyed(), false);
    await check('a fresh normal window rebinds the same parked identity and Session without affecting private siblings');
    await resource('final');
    succeeded = true;
  } catch (error) {
    report.failure = { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'PRIVATE_SMOKE_ASSERTION_FAILED', checkpoint };
  } finally {
    clearTimeout(deadline); clearInterval(resourceWatch); monitor?.stop();
    const cleanupProblems = [];
    if (engine) {
      // Only this helper's newly created synthetic pages are touched. Remove our
      // own fixture veto for cleanup, then still use acknowledged native closes.
      for (const binding of privateBindings) {
        let pages;
        try { pages = engine.workspaceAllocations(binding.workspaceId).pages; } catch { continue; }
        for (const page of pages) {
          const query = { workspaceId: binding.workspaceId, tabId: page.tabId };
          try {
            engine.cancelHumanClose(query);
            if (!page.destroyed && !page.closing && !engine.navigation(query).crashed) {
              const wc = engine.getView(query).webContents;
              if (wc && !wc.isDestroyed()) await timed(wc.executeJavaScript('window.onbeforeunload=null'), 'cleanup-fixture-veto', 1500, true);
            }
            const result = await timed(engine.humanCloseTab(query, () => true), 'cleanup-native-close', 2500, true);
            if (!result.closed) fail('PRIVATE_CLEANUP_CLOSE_PENDING');
          } catch (error) { cleanupProblems.push(error.code ?? 'PRIVATE_CLEANUP_CLOSE_PENDING'); }
        }
        try { await timed(engine.disposePrivateWorkspace(request(binding)), 'cleanup-private-identity', 3000, true); }
        catch (error) { cleanupProblems.push(error.code ?? 'PRIVATE_CLEANUP_PENDING'); }
      }
      try { await timed(engine.close(), 'cleanup-engine', 5000, true); engineClosed = true; }
      catch (error) { cleanupProblems.push(error.code ?? 'PRIVATE_CLEANUP_PENDING'); }
    }
    if (engineClosed || !engine) {
      privacy?.dispose();
      if (window && !window.isDestroyed()) window.destroy();
      if (privateWindow && !privateWindow.isDestroyed()) privateWindow.destroy();
    }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.cleanup = { engineClosed, problems: cleanupProblems };
    try { report.sourceAfter = await timed(sourceEvidence(projectRoot), 'source-after', 1500, true); }
    catch { report.failure ??= { code: 'PRIVATE_SOURCE_UNAVAILABLE', checkpoint }; }
    if (report.sourceBefore && report.sourceAfter && report.sourceBefore.sha256 !== report.sourceAfter.sha256)
      report.failure ??= { code: 'PRIVATE_SOURCE_CHANGED', checkpoint: 'source-after' };
    if (cleanupProblems.length) report.failure ??= { code: 'PRIVATE_CLEANUP_INCOMPLETE', checkpoint };
    if (performance.now() - began > MAX_RUN_MS) report.failure ??= { code: 'PRIVATE_SMOKE_DURATION', checkpoint };
    report.status = succeeded && !report.failure ? 'passed' : 'failed'; report.finishedAt = new Date().toISOString();
    report.reportPath = reportPath; await save();
  }
  console.log('CADDI_PRIVATE_ENGINE_REPORT ' + reportPath);
  if (report.status !== 'passed') fail(report.failure?.code ?? 'PRIVATE_SMOKE_FAILED');
  console.log('CADDI_PRIVATE_ENGINE_SMOKE_OK ' + report.checks.length + ' checks; persistent parking/rebind, empty ordinary probe and three fresh private identities');
  return report;
}
