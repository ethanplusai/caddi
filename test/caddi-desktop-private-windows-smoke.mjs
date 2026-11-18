// One disposable app, then a serial restart of that same disposable metadata.
// No physical keyboard/focus qualification and no existing account/profile use.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { app, Menu } from 'electron';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = result => { assert.equal(result?.status, 'completed', JSON.stringify(result)); return result.result; };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceEvidence(root) {
  const result = [];
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file); else result.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) });
      assert.ok(result.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'test/caddi-desktop-private-windows-smoke.mjs'])
    result.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) });
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function durableBytes(root) {
  const chunks = []; let total = 0;
  async function walk(directory) {
    let items; try { items = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const item of items) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file); else {
        const bytes = await fs.readFile(file); total += bytes.length; assert.ok(total < 8 * 1024 * 1024); chunks.push(bytes);
      }
    }
  }
  for (const folder of ['metadata', 'history', 'window-session', 'preferences']) await walk(path.join(root, folder));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runDesktopPrivateWindowsSmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.ok(process.argv.includes('--caddi-private-windows-smoke') && !app.isPackaged);
  assert.equal(browser.window.isVisible(), false); assert.equal(typeof browser.setTestCloseDecision, 'function');
  assert.equal(typeof browser.setTestRecoveryDecision, 'function');
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-private-windows-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 }); const proof = await fs.mkdtemp(path.join(parent, 'run-'));
  const reportPath = path.join(proof, 'report.json'), started = Date.now();
  const report = { format: 'caddi-private-windows-smoke-v1', status: 'running', startedAt: new Date().toISOString(), checks: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 90000, mainWatchdogMs: 120000, fixtureMaxConcurrentWindows: 5, fixtureMaxWindowLifetimes: 10,
      productWindowLimit: 8, maxConcurrentWindows: 0, windowLifetimes: 0 },
    limits: ['Only synthetic loopback pages, generated identities and disposable metadata are used.',
      'All windows remain hidden. Script userGesture exercises native beforeunload; physical keyboard/focus and native-sheet interaction are unqualified.',
      'Shortcut preferences and native accelerator wiring are inspected, without claiming physical key delivery.',
      'Metadata/history/topology exclusion and Session cleanup are checked; no forensic RAM, swap or crash-dump erasure claim.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const check = async name => { report.checks.push(name); console.log('PRIVATE_WINDOWS_PASS ' + name); await save(); };
  const checkpoint = label => { report.checkpoint = { label, elapsedMs: Date.now() - started }; };
  let current = browser, client, server, deadline, stopped = false, restartRun = null, restartStarted = false;
  const seenWindows = new Set(), liveWindows = new Set();
  const trackWindow = native => {
    if (seenWindows.has(native.id)) return;
    seenWindows.add(native.id); liveWindows.add(native.id);
    report.bounds.windowLifetimes = seenWindows.size;
    report.bounds.maxConcurrentWindows = Math.max(report.bounds.maxConcurrentWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  for (const owner of browser.getWindows()) trackWindow(owner.window);
  const onCreated = (_event, native) => trackWindow(native);
  app.on('browser-window-created', onCreated);
  async function timed(value, label, timeout = 8000) {
    report.lastOperation = label;
    if (stopped) throw new Error('Private window proof deadline');
    let timer;
    try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(fn, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(fn), label)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  const uiState = wc => wc.executeJavaScript('window.caddi.getState()');
  async function actIn(wc, input) {
    const result = await timed(wc.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), 'trusted chrome ' + input.type);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  }
  async function captureChrome(wc, file) {
    await timed(wc.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))'), 'chrome screenshot paint');
    let pixels;
    try { pixels = await timed(wc.capturePage(), 'chrome screenshot pixels', 3000); }
    catch (error) {
      (report.screenshots ??= []).push({ file, available: false, reason: String(error?.message ?? 'Native capture unavailable').slice(0, 160) });
      report.limits.push('Trusted chrome screenshot ' + file + ' was unavailable; its rendered DOM assertions remain required.'); return;
    }
    await fs.writeFile(path.join(proof, file), pixels.toPNG(), { mode: 0o600 });
    (report.screenshots ??= []).push({ file, available: true });
  }
  const nativeWindow = (owner, id) => { const found = owner.getWindows().find(item => item.id === id); assert.ok(found); return found; };
  try {
    report.sourceBefore = await sourceEvidence(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; current.engine.cancelHumanClose(); client?.close(); }, 90000);
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
      response.end('<!doctype html><title>' + (request.url.startsWith('/normal') ? 'Normal fixture' : 'Private fixture') + '</title><label>Draft<input id="draft" value="initial"></label>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port, marker = 'private-only-' + randomUUID();
    const normalState = browser.getState(), normalId = normalState.activeWorkspaceId;
    const normalWorkspace = normalState.workspaces.find(item => item.id === normalId), normalGroup = normalState.groups.find(item => item.id === normalWorkspace.activeGroupId);
    const normalQuery = { workspaceId: normalId, tabId: normalGroup.activeTabId };
    await browser.act({ type: 'navigate', tabId: normalQuery.tabId, input: origin + '/normal' });
    await until(() => browser.engine.navigation(normalQuery).title === 'Normal fixture', 'normal page ready');
    const normalPage = browser.engine.getView(normalQuery).webContents, normalSession = normalPage.session;
    await normalPage.executeJavaScript('document.cookie="scope=normal-only;Path=/;SameSite=Lax";localStorage.setItem("scope","normal-only");draft.value="normal draft"');
    await browser.flush();
    const pending = deferred(), connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Private exclusion fixture', onPending: pending.resolve });
    void connecting.catch(() => {}); const challenge = await pending.promise;
    const approved = await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId: normalId, origins: [origin], mode: 'observe' });
    client = await connecting;
    const call = (name, args = {}) => client.request(toBrokerRequest(name, args));
    const created = await browser.act({ type: 'window.private.open' }), privateWindow = nativeWindow(browser, created.windowId), privateChrome = privateWindow.window.webContents;
    await until(async () => (await uiState(privateChrome)).privateBrowsing?.status === 'active', 'private scope ready');
    const privateState = await uiState(privateChrome), privateId = privateState.metadata.activeWorkspaceId, privateIdentity = privateState.metadata.workspaces[0].identityId;
    const privateTab = privateState.metadata.tabs[0].id, privateQuery = { workspaceId: privateId, tabId: privateTab };
    await until(() => privateChrome.executeJavaScript('!document.getElementById("private-window-badge").hidden && document.getElementById("workspace-title").textContent === "Private browsing"'), 'permanent private chrome badge');
    assert.equal(await privateChrome.executeJavaScript('document.getElementById("normal-workspace-controls").hidden && document.getElementById("workspace-list").children.length===0'), true);
    await actIn(privateChrome, { type: 'navigate', tabId: privateTab, input: origin + '/private?' + marker });
    await until(() => browser.engine.navigation(privateQuery).title === 'Private fixture', 'private page ready');
    const privatePage = browser.engine.getView(privateQuery).webContents, privateSession = privatePage.session;
    assert.equal(privateSession.isPersistent(), false); assert.equal(privateSession.storagePath, null); assert.notEqual(privateSession, normalSession);
    await privatePage.executeJavaScript('document.cookie="scope=private-only;Path=/;SameSite=Lax";localStorage.setItem("scope","private-only");draft.value="private draft"');
    await browser.flush();
    assert.match((await uiState(privateChrome)).metadata.tabs.find(item => item.id === privateTab).url, new RegExp(marker));
    assert.equal(JSON.stringify(browser.getState()).includes(marker), false); assert.equal(JSON.stringify(browser.snapshot()).includes(privateId), false);
    assert.equal(JSON.stringify(completed(await call('caddi_workspaces'))).includes(privateId), false);
    assert.equal((await call('caddi_targets', { workspaceId: privateId, grantId: approved.grantId })).status, 'rejected');
    for (const input of [{ type: 'agent.copy-config' }, { type: 'history.list', workspaceId: privateId, query: '' },
      { type: 'storage.usage', workspaceId: privateId }, { type: 'page.print', tabId: privateTab }, { type: 'review.open' }]) {
      const denied = await privateChrome.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')');
      assert.equal(denied.ok, false); assert.equal(denied.code, 'PRIVATE_FEATURE_UNAVAILABLE');
    }
    await until(() => privateChrome.executeJavaScript('document.getElementById("address").value===' + JSON.stringify(origin + '/private?' + marker) +
      '&&document.querySelector(".tab-row.active")?.dataset.tab===' + JSON.stringify(privateTab)), 'private selected-page controls rendered');
    await captureChrome(privateChrome, 'private-window-chrome.png');
    await check('private chrome, memory metadata and native Session are isolated from normal snapshots and authenticated agent discovery');

    const second = await actIn(privateChrome, { type: 'window.private.open' }), secondWindow = nativeWindow(browser, second.windowId), secondChrome = secondWindow.window.webContents;
    const secondState = await uiState(secondChrome), secondId = secondState.metadata.activeWorkspaceId, secondTab = secondState.metadata.tabs[0].id;
    await actIn(secondChrome, { type: 'navigate', tabId: secondTab, input: origin + '/sibling' });
    const secondQuery = { workspaceId: secondId, tabId: secondTab };
    await until(() => browser.engine.navigation(secondQuery).title === 'Private fixture', 'sibling private page ready');
    const secondPage = browser.engine.getView(secondQuery).webContents;
    assert.notEqual(secondPage.session, privateSession);
    assert.deepEqual(await secondPage.executeJavaScript('({cookie:document.cookie,storage:localStorage.getItem("scope")})'), { cookie: '', storage: null });
    assert.deepEqual(await normalPage.executeJavaScript('({cookie:document.cookie,storage:localStorage.getItem("scope"),draft:draft.value})'), { cookie: 'scope=normal-only', storage: 'normal-only', draft: 'normal draft' });
    const bytes = await durableBytes(dataRoot);
    for (const value of [marker, privateId, privateIdentity, secondId]) assert.equal(bytes.includes(value), false);
    await check('same-origin private siblings keep distinct cookies and storage; durable metadata/history/window records contain no private identity or URL marker');

    const extra = await actIn(secondChrome, { type: 'tab.create', workspaceId: secondId, input: 'about:blank', activate: false });
    await browser.flush(); const beforeOrder = await uiState(secondChrome), residentBefore = browser.engine.pageResidency().resident;
    await actIn(secondChrome, { type: 'tab.reorder', tabId: extra, beforeId: secondTab, expectedRevision: beforeOrder.metadata.revision });
    assert.equal(browser.engine.pageResidency().resident, residentBefore);
    const stale = await secondChrome.executeJavaScript('window.caddi.action(' + JSON.stringify({ type: 'tab.reorder', tabId: secondTab, beforeId: extra, expectedRevision: beforeOrder.metadata.revision }) + ')');
    assert.equal(stale.ok, false); assert.equal(stale.code, 'ORDER_STALE');
    await check('private reorder is scoped memory metadata with no page allocation and rejects stale reviewed revision');

    browser.setTestRecoveryDecision(async () => 'recover');
    const beforeCrash = await Promise.all(browser.getWindows().map(async owner => ({ windowId: owner.id, workspaceId: owner.workspaceId,
      private: owner.private, processId: owner.window.webContents.getOSProcessId(),
      recoveryGeneration: (await uiState(owner.window.webContents)).chromeRecovery.generation })));
    const crashProcess = privateChrome.getOSProcessId(), privateProcess = privatePage.getOSProcessId();
    const pageProcesses = [{ role: 'normal', processId: normalPage.getOSProcessId() },
      { role: 'private', processId: privateProcess }, { role: 'private-sibling', processId: secondPage.getOSProcessId() }];
    assert.ok(crashProcess > 0); assert.equal(pageProcesses.some(page => page.processId === crashProcess), false,
      'Trusted chrome crash must not target a process containing an untrusted page');
    const affected = beforeCrash.filter(owner => owner.processId === crashProcess), observedCrashes = [];
    const crashListeners = browser.getWindows().map(owner => {
      const listener = (_event, detail) => observedCrashes.push({ windowId: owner.id, reason: detail.reason });
      owner.window.webContents.on('render-process-gone', listener); return { wc: owner.window.webContents, listener };
    });
    report.chromeCrash = { targetWindowId: privateWindow.id, processId: crashProcess, chromeBefore: beforeCrash, pageProcesses,
      expectedAffectedWindowIds: affected.map(owner => owner.windowId), observedCrashes };
    privateChrome.forcefullyCrashRenderer();
    await until(async () => { try { const value = await uiState(privateChrome); return value.chromeRecovery.phase === 'ready' && value.chromeRecovery.generation >= 1 &&
      await privateChrome.executeJavaScript('!document.getElementById("private-window-badge").hidden && document.getElementById("workspace-title").textContent==="Private browsing"'); } catch { return false; } }, 'private chrome recovered');
    assert.equal(privatePage.getOSProcessId(), privateProcess); assert.equal(await privatePage.executeJavaScript('draft.value'), 'private draft');
    assert.equal(browser.privacy.getPrivacyState(privateId).blocked, true); assert.equal(privateWindow.window.isVisible(), false);
    for (const owner of affected) {
      const wc = nativeWindow(browser, owner.windowId).window.webContents;
      await until(async () => { try { const value = await uiState(wc); return value.chromeRecovery.phase === 'ready' &&
        value.chromeRecovery.generation > owner.recoveryGeneration && value.metadata.activeWorkspaceId === owner.workspaceId &&
        (owner.private ? value.privateBrowsing?.status === 'active' : value.privateBrowsing === null); } catch { return false; } }, 'affected chrome context recovery');
      assert.equal(browser.privacy.getPrivacyState(owner.workspaceId).blocked, true);
    }
    for (const { wc, listener } of crashListeners) if (!wc.isDestroyed()) wc.off('render-process-gone', listener);
    assert.deepEqual(observedCrashes.map(value => value.windowId).sort((a, b) => a - b), affected.map(value => value.windowId).sort((a, b) => a - b));
    await check('actual chrome process crash records every affected owner, restores each exact scope, and retains the private page and draft behind its privacy barrier');
    // Chromium may share the trusted-chrome process across windows. The proof
    // records that scope; only an explicit synthetic owner action resumes a
    // normal workspace before the later ordinary-window close scenario.
    report.chromeCrash.explicitNormalResumes = [];
    for (const owner of affected.filter(owner => !owner.private)) {
      await actIn(nativeWindow(browser, owner.windowId).window.webContents, { type: 'privacy.resume', workspaceId: owner.workspaceId });
      report.chromeCrash.explicitNormalResumes.push(owner.windowId);
    }

    assert.equal(await privatePage.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};navigator.userActivation.hasBeenActive', true), true);
    let decisions = 0; browser.setTestCloseDecision(async () => { decisions++; return false; });
    await privateChrome.executeJavaScript('document.getElementById("close-private-window").click()');
    await until(async () => decisions === 1 && (await uiState(privateChrome)).privateBrowsing.status === 'active', 'private native stay decision');
    assert.equal(privatePage.isDestroyed(), false); assert.equal(await privatePage.executeJavaScript('draft.value'), 'private draft');
    browser.setTestCloseDecision(async () => { decisions++; return true; });
    await privateChrome.executeJavaScript('document.getElementById("close-private-window").click()');
    await until(() => privateWindow.window.isDestroyed(), 'private native close and cleanup');
    assert.equal(decisions, 2); assert.equal(privatePage.isDestroyed(), true);
    assert.deepEqual(await privateSession.cookies.get({ url: origin }), []);
    assert.equal(browser.engine.getWorkspaceOwnerWindow(privateId), null);
    assert.equal(normalPage.isDestroyed(), false); assert.equal(await normalPage.executeJavaScript('draft.value'), 'normal draft');
    await check('real private close controls honor native stay/leave and wait for Session cleanup without closing or altering the normal page');

    await browser.flush(); const savedBeforeClose = JSON.parse(await fs.readFile(path.join(dataRoot, 'window-session/windows.json'), 'utf8'));
    const normalClose = await browser.act({ type: 'window.close' }); assert.notEqual(normalClose, false);
    assert.equal(browser.window.isDestroyed(), true); assert.equal(browser.engine.getWorkspaceOwnerWindow(normalId), null);
    assert.equal(secondWindow.window.isDestroyed(), false);
    await browser.flush(); assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataRoot, 'window-session/windows.json'), 'utf8')), savedBeforeClose);
    await secondChrome.executeJavaScript('document.getElementById("open-normal-window").click()');
    await until(() => browser.getWindows().some(item => !item.private), 'new normal window from private chrome');
    const reopenedNormal = browser.getWindows().find(item => !item.private), normalChrome = reopenedNormal.window.webContents;
    await until(async () => (await uiState(normalChrome)).metadata.activeWorkspaceId === normalId, 'parked normal identity rebound');
    await until(() => browser.engine.navigation(normalQuery).title === 'Normal fixture', 'parked normal page reloaded');
    const resumedPage = browser.engine.getView(normalQuery).webContents;
    assert.equal(resumedPage.session, normalSession); assert.equal((await uiState(normalChrome)).metadata.workspaces.find(item => item.id === normalId).identityId, normalWorkspace.identityId);
    assert.equal(reopenedNormal.window.isVisible(), false);
    await check('last normal window parks its identity without erasing saved topology; explicit New Normal Window restores that same Session without private transfer');

    await normalChrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("about-dialog").open'), 'settings about dialog');
    await normalChrome.executeJavaScript('document.getElementById("open-shortcuts").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("shortcuts-dialog").open'), 'shortcut settings dialog');
    await until(() => normalChrome.executeJavaScript('document.querySelectorAll("#shortcut-fields input[id^=shortcut-]").length===15&&document.getElementById("shortcut-normal-window")?.value==="Primary+N"'), 'complete fifteen-command shortcut settings rendered');
    await normalChrome.executeJavaScript('document.getElementById("shortcut-normal-window").scrollIntoView({block:"center"})');
    await captureChrome(normalChrome, 'shortcut-settings-chrome.png');
    await normalChrome.executeJavaScript('const field=document.getElementById("shortcut-f");field.value="Primary+Shift+F";field.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("shortcuts-form").requestSubmit()');
    await until(async () => (await uiState(normalChrome)).shortcuts.bindings.f === 'Primary+Shift+F', 'shortcut saved from actual controls');
    const findMenu = Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu.items.find(item => item.label === 'Find in Page');
    assert.equal(findMenu.accelerator, 'CmdOrCtrl+Shift+F');
    await normalChrome.executeJavaScript('document.getElementById("close-shortcuts").click()');
    await check('actual shortcut settings commit a complete reviewed map and update the same native menu command binding');

    await until(() => normalChrome.executeJavaScript('!document.getElementById("shortcuts-dialog").open'), 'shortcut dialog closed');
    await normalChrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("about-dialog").open'), 'storage settings launcher');
    await normalChrome.executeJavaScript('document.getElementById("open-storage").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("storage-dialog").open&&document.getElementById("storage-state").textContent==="Not applicable"'), 'temporary normal storage status rendered');
    assert.equal(await normalChrome.executeJavaScript('document.getElementById("storage-workspace").textContent'), normalWorkspace.name);
    await captureChrome(normalChrome, 'storage-settings-chrome.png');
    await normalChrome.executeJavaScript('document.getElementById("close-storage").click()');
    await until(() => normalChrome.executeJavaScript('!document.getElementById("storage-dialog").open'), 'storage dialog closed');
    await check('actual owner storage dialog reports temporary sessions explicitly without fabricated zero usage or any clear-data action');

    checkpoint('first workspace moved into its own normal window');
    await actIn(normalChrome, { type: 'window.open-workspace' });
    await until(() => browser.getWindows().filter(item => !item.private).length === 2, 'two normal windows for saved restoration');
    const twoNormalIds = new Set(browser.getWindows().filter(item => !item.private).map(item => item.id));
    const priorWorkspaces = browser.getState().workspaces;
    assert.equal(priorWorkspaces.every(workspace => browser.getWindows().some(owner => owner.workspaceId === workspace.id)), true);
    await normalChrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("about-dialog").open'), 'new-normal settings action');
    await normalChrome.executeJavaScript('document.getElementById("about-normal-window").click()');
    await until(() => browser.getWindows().filter(item => !item.private).length === 3, 'explicit third normal window');
    const thirdNormal = browser.getWindows().find(item => !item.private && !twoNormalIds.has(item.id));
    await until(() => !!thirdNormal.window.webContents.getURL() && browser.getWindows().find(item => item.id === thirdNormal.id)?.workspaceId,
      'third normal owner bound');
    const thirdWorkspaceId = browser.getWindows().find(item => item.id === thirdNormal.id).workspaceId;
    const thirdWorkspace = browser.getState().workspaces.find(workspace => workspace.id === thirdWorkspaceId);
    assert.equal(browser.getState().workspaces.length, priorWorkspaces.length + 1); assert.equal(thirdWorkspace.kind, 'personal');
    assert.equal(priorWorkspaces.some(workspace => workspace.id === thirdWorkspace.id || workspace.identityId === thirdWorkspace.identityId), false);
    await check('New Normal Window creates a new personal identity when every existing workspace is already owned');

    checkpoint('populate scoped controls before removing final owned workspace');
    await normalChrome.executeJavaScript('document.getElementById("show-history").click()');
    await until(() => normalChrome.executeJavaScript('!document.getElementById("history-panel").hidden'), 'old-owner history panel populated');
    await normalChrome.executeJavaScript('document.getElementById("show-downloads").click()');
    await until(() => normalChrome.executeJavaScript('!document.getElementById("downloads-panel").hidden'), 'old-owner downloads panel populated');
    normalChrome.send('caddi-desktop:command', 'f');
    await until(() => normalChrome.executeJavaScript('!document.getElementById("find-bar").hidden'), 'old-owner find bar visible');
    await normalChrome.executeJavaScript('document.getElementById("command-button").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("command-dialog").open&&document.getElementById("command-results").children.length>0'), 'old-owner command choices populated');
    checkpoint('move final owned workspace into new normal window');
    const finalMove = await actIn(normalChrome, { type: 'window.open-workspace' });
    const movedOwner = nativeWindow(browser, finalMove.windowId);
    checkpoint('verify empty owner after native workspace transfer');
    await until(() => normalChrome.executeJavaScript('document.getElementById("workspace-kind").textContent==="Choose a workspace"&&'+
      '["history-panel","downloads-panel","find-bar","group-popover"].every(id=>document.getElementById(id).hidden)&&'+
      '["history-results","download-results","group-list","group-select","command-results"].every(id=>document.getElementById(id).children.length===0)&&'+
      '!document.getElementById("command-dialog").open&&["show-history","show-downloads","new-tab","new-group","new-folder"].every(id=>document.getElementById(id).disabled)'), 'empty owner controls fully reset');
    assert.equal((await uiState(normalChrome)).metadata.activeWorkspaceId, null);
    checkpoint('empty owner controls cleared; verify new-window actions remain reachable');
    await normalChrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => normalChrome.executeJavaScript('document.getElementById("about-dialog").open&&'+
      '!document.getElementById("about-normal-window").disabled&&!document.getElementById("about-private-window").disabled'), 'new window actions remain reachable from empty owner');
    await normalChrome.executeJavaScript('document.getElementById("close-about").click()');
    await until(() => normalChrome.executeJavaScript('!document.getElementById("about-dialog").open'), 'empty owner settings closed');
    checkpoint('request native close of empty normal owner');
    // A renderer that is intentionally destroyed cannot return its closing IPC
    // receipt. Exercise the native close event and require actual destruction.
    reopenedNormal.window.close();
    await until(() => reopenedNormal.window.isDestroyed(), 'empty normal owner closed');
    assert.equal(browser.getWindows().some(owner => owner.id === reopenedNormal.id), false);
    assert.equal(movedOwner.window.isDestroyed(), false);
    assert.equal(browser.engine.getWorkspaceOwnerWindow(finalMove.workspaceId), movedOwner.window);
    checkpoint('empty normal owner destroyed; transferred identity remains bound');
    await check('moving the last owned workspace clears old panels, find, groups and commands while an empty owner keeps explicit new-window actions');

    checkpoint('request sibling private close through actual private control');
    await secondChrome.executeJavaScript('document.getElementById("close-private-window").click()');
    await until(() => secondWindow.window.isDestroyed(), 'second private scope disposed');
    assert.equal(secondPage.isDestroyed(), true); assert.equal(browser.engine.getWorkspaceOwnerWindow(secondId), null);
    assert.equal(browser.getWindows().some(owner => owner.private), false);
    checkpoint('sibling private scope disposed; save final normal topology');
    await browser.flush(); const normalRows = browser.getWindows().filter(item => !item.private).map(item => ({ windowKey: item.windowKey, workspaceId: item.workspaceId }));
    assert.equal(normalRows.length, 3); assert.ok(normalRows.every(item => !item.workspaceId.startsWith('private-')));
    client.close(); client = null; checkpoint('close first disposable app after topology flush'); await timed(browser.close(), 'first app close');
    // Match the entry point's short, fresh od-* sibling. Nesting this under the
    // original run root exceeds the unchanged Darwin Unix-socket path bound.
    assert.match(path.basename(runRoot), /^od-[A-Za-z0-9]{6}$/);
    const ownedSystemProof = browser.testSystemProof;
    restartRun = ownedSystemProof.createRunRoot();
    assert.notEqual(restartRun, runRoot);
    await fs.chmod(restartRun, 0o700);
    report.restartDirectory = { freshOwnedFactory: true, byteLength: Buffer.byteLength(restartRun), cleanup: 'pending' };
    checkpoint('restart disposable app from saved normal topology');
    restartStarted = true;
    current = await timed(createDesktopApp({ projectRoot, dataRoot, runRoot: restartRun, show: false, enableMicrophone: false, persistentProfiles: false,
      ownedSystemProof, systemLifecycle: ownedSystemProof.createLifecycle(),
      testCloseDecision: async () => true }), 'serial saved-window restart', 15000);
    const restored = current.getWindows();
    assert.deepEqual(restored.map(item => ({ windowKey: item.windowKey, workspaceId: item.workspaceId })).sort((a, b) => a.windowKey.localeCompare(b.windowKey)),
      normalRows.sort((a, b) => a.windowKey.localeCompare(b.windowKey)));
    assert.equal(restored.some(item => item.private), false); assert.equal(restored.filter(item => item.needsHydration).length, 2);
    const deferredWindow = restored.find(item => item.needsHydration);
    assert.equal(current.engine.workspaceAllocations(deferredWindow.workspaceId).pages.length, 0);
    assert.equal(current.snapshot().shortcuts.bindings.f, 'Primary+Shift+F');
    const lazyState = await uiState(deferredWindow.window.webContents), lazyWorkspace = lazyState.metadata.workspaces.find(item => item.id === deferredWindow.workspaceId);
    const lazyGroup = lazyState.metadata.groups.find(item => item.id === lazyWorkspace.activeGroupId);
    await actIn(deferredWindow.window.webContents, { type: 'tab.select', tabId: lazyGroup.activeTabId });
    assert.ok(current.engine.workspaceAllocations(deferredWindow.workspaceId).pages.length >= 1);
    assert.equal(restored.every(item => !item.window.isVisible()), true);
    report.restoredWindows = restored.map(item => ({ windowKey: item.windowKey, workspaceId: item.workspaceId, initiallyDeferred: item.needsHydration }));
    await check('serial app restart restores normal window keys and workspace identities, keeps other presentations unloaded until selected, and reloads saved shortcuts');
    assert.ok(report.bounds.maxConcurrentWindows <= report.bounds.fixtureMaxConcurrentWindows);
    assert.ok(report.bounds.windowLifetimes <= report.bounds.fixtureMaxWindowLifetimes);
    report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.status = 'passed'; await save(); console.log('PRIVATE_WINDOWS_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
  } catch (error) {
    report.status = 'failed'; report.error = { code: error?.code ?? 'PRIVATE_WINDOW_ASSERTION', message: String(error?.message ?? error).slice(0, 900),
      stack: String(error?.stack ?? '').slice(0, 5000) };
    report.windowsAtFailure = current.getWindows().map(owner => {
      const destroyed = owner.window.isDestroyed(); let chromeDestroyed = true;
      if (!destroyed) try { chromeDestroyed = owner.window.webContents.isDestroyed(); } catch {}
      return { windowId: owner.id, workspaceId: owner.workspaceId, private: owner.private, destroyed, chromeDestroyed };
    });
    await save(); throw error;
  } finally {
    clearTimeout(deadline); client?.close(); current.setTestCloseDecision?.(async () => true); current.engine.cancelHumanClose();
    let restartClosed = false;
    if (current !== browser) { await current.close(); restartClosed = true; }
    // Delete only the exact directory returned by this helper's mkdtemp, after
    // its app has stopped. A failed/unknown startup stays available for diagnosis.
    if (restartRun && (!restartStarted || restartClosed)) {
      await fs.rm(restartRun, { recursive: true, force: true });
      if (report.restartDirectory) { report.restartDirectory.cleanup = 'completed'; await save(); }
    }
    app.off('browser-window-created', onCreated);
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
