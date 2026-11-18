// One hidden disposable app and synthetic loopback pages. This verifies the
// native page lifetime and owner boundary, not physical focus/key delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { app, webContents } from 'electron';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = value => { assert.equal(value?.status, 'completed', JSON.stringify(value)); return value.result; };
async function sourceEvidence(root) {
  const entries = [], hash = bytes => createHash('sha256').update(bytes).digest('hex');
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file); else entries.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
      assert.ok(entries.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'test/caddi-desktop-preview-smoke.mjs'])
    entries.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function savedPageMetadata(root) {
  const chunks = []; let total = 0;
  async function walk(directory) {
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const item of entries) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file); else {
        const bytes = await fs.readFile(file); total += bytes.length; assert.ok(total < 8 * 1024 * 1024); chunks.push(bytes);
      }
    }
  }
  for (const directory of ['metadata', 'history']) await walk(path.join(root, directory));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runDesktopPreviewSmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.ok(process.argv.includes('--caddi-preview-smoke') && !app.isPackaged);
  assert.equal(browser.window.isVisible(), false); assert.equal(typeof browser.takeTestPreviewMenu, 'function');
  assert.equal(typeof browser.setTestCloseDecision, 'function'); assert.ok(runRoot);
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-page-preview-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 }); const proof = await fs.mkdtemp(path.join(parent, 'run-'));
  const reportPath = path.join(proof, 'report.json'), started = Date.now();
  const report = { format: 'caddi-page-preview-smoke-v1', status: 'running', startedAt: new Date().toISOString(), checks: [], screenshots: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 75000, mainWatchdogMs: 90000, fixtureMaxConcurrentWindows: 2, maxConcurrentWindows: 0, windowLifetimes: 0, previewLifetimes: 0 },
    limits: ['All pages, drafts, cookies and MCP agents are synthetic, and all native windows stay hidden.',
      'Native context-menu callbacks receive the actual main frame and a synthetic link event. Physical right-click routing is unqualified.',
      'Shortcut recording uses a DOM chord after native mode acknowledgment. Native menu-ignore restoration is inspected; physical key delivery is unqualified.',
      'Beforeunload uses script userGesture and an explicit synthetic owner decision. No native prompt or OS focus claim.',
      'Saved metadata/history exclusion is checked; a preview deliberately uses the selected workspace Session and can change its site storage.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const checkpoint = label => { report.checkpoint = { label, elapsedMs: Date.now() - started }; };
  const check = async name => { report.checks.push(name); console.log('PREVIEW_PASS ' + name); await save(); };
  let server, client, deadline, stopped = false, restoreMenuIgnore = null;
  const requests = new Map();
  const seenWindows = new Set(), liveWindows = new Set();
  const trackWindow = native => {
    if (seenWindows.has(native.id)) return;
    seenWindows.add(native.id); liveWindows.add(native.id); report.bounds.windowLifetimes = seenWindows.size;
    report.bounds.maxConcurrentWindows = Math.max(report.bounds.maxConcurrentWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  for (const owner of browser.getWindows()) trackWindow(owner.window);
  const onCreated = (_event, native) => trackWindow(native);
  app.on('browser-window-created', onCreated);
  async function timed(value, label, timeout = 7000) {
    report.lastOperation = label; if (stopped) throw new Error('Preview proof deadline');
    let timer;
    try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(predicate, label, timeout = 7000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  const uiState = chrome => chrome.executeJavaScript('window.caddi.getState()');
  async function actIn(chrome, input) {
    const receipt = await timed(chrome.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), 'owner action ' + input.type);
    assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt.result;
  }
  const pageAt = url => webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL() === url);
  async function captureChrome(chrome, file) {
    await timed(chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))'), 'rendered chrome paint');
    try {
      const pixels = await timed(chrome.capturePage(), 'chrome pixels', 3000);
      await fs.writeFile(path.join(proof, file), pixels.toPNG(), { mode: 0o600 }); report.screenshots.push({ file, available: true });
    } catch (error) { report.screenshots.push({ file, available: false, reason: String(error?.message ?? error).slice(0, 160) }); }
  }
  async function openTyped(chrome, url) {
    await until(() => chrome.executeJavaScript('!document.getElementById("preview-address-button").disabled'), 'preview address control enabled');
    await chrome.executeJavaScript('document.getElementById("address").value=' + JSON.stringify(url) + ';document.getElementById("preview-address-button").click()');
    await until(async () => { const state = await uiState(chrome); return state.preview?.url === url && state.preview.canPromote === true; }, 'typed preview ready');
    await until(() => chrome.executeJavaScript('!document.getElementById("page-preview-bar").hidden&&!document.getElementById("page-preview-keep").disabled'), 'actual preview header rendered');
    report.bounds.previewLifetimes++; return (await uiState(chrome)).preview;
  }
  try {
    report.sourceBefore = await sourceEvidence(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; browser.engine.cancelHumanClose(); client?.close(); }, 75000);
    const marker = 'preview-proof-' + randomUUID();
    server = http.createServer((request, response) => {
      requests.set(request.url, (requests.get(request.url) ?? 0) + 1);
      if (request.url === '/preview-download') {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="preview-denied.txt"', 'content-length': '17' });
        response.end('synthetic preview'); return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
      response.end('<!doctype html><title>Preview fixture</title><style>body{min-height:2500px;font:18px system-ui;padding:40px;background:#edf4f6;color:#142126}input{display:block;margin:16px 0;padding:12px}</style>' +
        '<h1>Page preview fixture</h1><label>Unsaved draft<input id="draft" value="initial"></label><a id="preview-link" href="/link-' + marker + '">Preview another page</a>' +
        '<script>window.pageInstance=Math.random().toString(36);</script>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port, initial = browser.getState(), workspaceId = initial.activeWorkspaceId;
    const workspace = initial.workspaces.find(item => item.id === workspaceId), group = initial.groups.find(item => item.id === workspace.activeGroupId);
    const parentQuery = { workspaceId, tabId: group.activeTabId }, ownerWindow = browser.window, chrome = ownerWindow.webContents;
    checkpoint('prepare normal parent and scoped agent');
    await browser.act({ type: 'navigate', tabId: parentQuery.tabId, input: origin + '/parent' });
    await until(() => browser.engine.navigation(parentQuery).title === 'Preview fixture', 'normal parent ready');
    const parentPage = browser.engine.getView(parentQuery).webContents, nativeSession = parentPage.session;
    await parentPage.executeJavaScript('document.cookie="previewScope=normal;Path=/;SameSite=Lax";localStorage.setItem("preview-scope","normal");draft.value="parent unsaved draft"');
    await browser.flush();
    const pending = deferred(), connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Synthetic preview agent', onPending: pending.resolve });
    void connecting.catch(() => {}); const challenge = await timed(pending.promise, 'agent enrollment pending');
    const connection = await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode,
      workspaceId, origins: [origin], mode: 'control' });
    client = await timed(connecting, 'agent enrollment');
    const call = (name, args = {}) => client.request(toBrokerRequest(name, args));
    const otherReceipt = await actIn(chrome, { type: 'window.normal.open' });
    const sibling = browser.getWindows().find(item => item.id === otherReceipt.windowId); assert.ok(sibling);
    const siblingChrome = sibling.window.webContents;
    await until(async () => (await uiState(siblingChrome)).metadata.activeWorkspaceId !== null, 'second normal owner ready');
    assert.notEqual(sibling.workspaceId, workspaceId); assert.equal(browser.getWindows().length, 2);
    await browser.flush();
    const lease = completed(await call('caddi_acquire_control', { workspaceId, grantId: connection.grantId, idempotencyKey: 'before-preview' }));
    assert.ok(lease.leaseEpoch >= 1); assert.equal(browser.privacy.hasActiveLease(workspaceId), true);
    const savedBefore = browser.getState(), allocationsBefore = new Set(browser.engine.workspaceAllocations(workspaceId).pages.map(item => item.tabId));
    const previewURL = origin + '/' + marker;
    checkpoint('open typed preview through actual controls');
    let preview = await openTyped(chrome, previewURL);
    const previewPage = pageAt(previewURL); assert.ok(previewPage); assert.equal(previewPage.session, nativeSession);
    const previewTab = browser.engine.workspaceAllocations(workspaceId).pages.find(item => !allocationsBefore.has(item.tabId))?.tabId;
    assert.ok(previewTab); const previewQuery = { workspaceId, tabId: previewTab };
    assert.equal(browser.getState().tabs.some(tab => tab.id === previewTab), false);
    assert.deepEqual(browser.getState().tabs.filter(tab => tab.workspaceId === workspaceId), savedBefore.tabs.filter(tab => tab.workspaceId === workspaceId));
    assert.equal(browser.getState().groups.find(item => item.id === group.id).activeTabId, parentQuery.tabId);
    assert.equal(await parentPage.executeJavaScript('draft.value'), 'parent unsaved draft');
    assert.equal(await previewPage.executeJavaScript('localStorage.getItem("preview-scope")'), 'normal');
    assert.match(await previewPage.executeJavaScript('document.cookie'), /previewScope=normal/);
    assert.equal((await uiState(siblingChrome)).preview, null); assert.equal(JSON.stringify(await uiState(siblingChrome)).includes(marker), false);
    assert.equal(browser.access.connections().find(item => item.agentSessionId === connection.agentSessionId).lease, null);
    await check('typed owner preview shares only its workspace Session, preserves parent draft/selection and does not enter saved tabs or another owner snapshot');

    checkpoint('assert excluded native and agent targets');
    for (const getter of ['getTarget', 'getPageInfo', 'getView']) assert.throws(() => browser.engine[getter](previewQuery), code('PREVIEW_ACCESS_DENIED'));
    assert.equal(browser.engine.listTargets(workspaceId).some(target => target.tabId === previewTab), false);
    const targets = completed(await call('caddi_targets', { workspaceId, grantId: connection.grantId }));
    assert.equal(JSON.stringify(targets).includes(previewTab), false); assert.equal(JSON.stringify(targets).includes(marker), false);
    const parentTarget = browser.engine.getTarget(parentQuery);
    await assert.rejects(browser.engine.execute({ operation: 'page:observe', target: { ...parentTarget, tabId: previewTab }, payload: {} }, { beforeDispatch: () => true }), code('PREVIEW_ACCESS_DENIED'));
    await assert.rejects(browser.engine.execute({ operation: 'page:observe', target: parentTarget, payload: {} }, { beforeDispatch: () => true }), code('HUMAN_REVIEW_ACTIVE'));
    await assert.rejects(browser.act({ type: 'preview.open', input: origin + '/second' }), code('PREVIEW_BUSY'));
    await assert.rejects(browser.act({ type: 'window.open-workspace' }), code('PREVIEW_BUSY'));
    assert.equal(browser.engine.permissionBinding(previewPage.id), null);
    assert.equal(await previewPage.executeJavaScript('window.open(' + JSON.stringify(origin + '/preview-popup') + ')===null', true), true);
    assert.equal(browser.getWindows().length, 2); assert.equal(requests.has('/preview-popup'), false);
    const priorDownloads = browser.downloads.list(workspaceId), attemptedDownload = deferred();
    const observeDownload = (event, _item, contents) => { if (contents === previewPage) attemptedDownload.resolve(event.defaultPrevented === true); };
    nativeSession.on('will-download', observeDownload);
    try { previewPage.downloadURL(origin + '/preview-download'); assert.equal(await timed(attemptedDownload.promise, 'preview native download blocked'), true); }
    finally { nativeSession.off('will-download', observeDownload); }
    assert.deepEqual(browser.downloads.list(workspaceId), priorDownloads);
    await check('preview IDs cannot become generic targets; parent agent execution, preview permissions, popups and downloads stay denied without renewed control');

    checkpoint('edit temporary live page and verify persistence exclusion');
    const keptURL = origin + '/kept-' + marker;
    const instance = await previewPage.executeJavaScript('draft.value="preview draft retained";document.title="Reviewed preview draft";history.pushState({},"",' + JSON.stringify(keptURL) + ');pageInstance');
    await until(async () => { const value = (await uiState(chrome)).preview; return value?.url === keptURL && value.title === 'Reviewed preview draft' && value.canPromote; }, 'preview navigation and title observed');
    await previewPage.executeJavaScript('window.scrollTo(0,350)');
    await until(() => previewPage.executeJavaScript('window.scrollY>0'), 'meaningful preview scroll position');
    const scrollY = await previewPage.executeJavaScript('window.scrollY');
    await browser.flush(); assert.equal((await savedPageMetadata(dataRoot)).includes(marker), false);
    // getState() is direct IPC; the owner renderer updates on the bounded state
    // broadcast. Require the actual address/header presentation before pixels.
    await until(() => chrome.executeJavaScript('document.getElementById("address").value===' + JSON.stringify(keptURL) +
      '&&document.getElementById("page-preview-url").textContent===' + JSON.stringify(keptURL) +
      '&&document.getElementById("page-preview-title").textContent==="Reviewed preview draft"'), 'updated preview address and title rendered');
    assert.equal(await chrome.executeJavaScript('document.getElementById("address").value'), keptURL);
    await captureChrome(chrome, 'preview-owner-chrome.png');
    await check('preview navigation and title remain transient while owner chrome shows the actual preview address');

    checkpoint('native unload veto and same-page Keep');
    let decisions = 0; browser.setTestCloseDecision(async () => { decisions++; return false; });
    assert.equal(await previewPage.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};navigator.userActivation.hasBeenActive', true), true);
    await chrome.executeJavaScript('document.getElementById("page-preview-close").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("page-preview-state").textContent==="The page asked to stay open. Your preview is still here."'), 'actual preview close veto rendered');
    assert.equal(decisions, 1); assert.equal(previewPage.isDestroyed(), false);
    assert.equal(await previewPage.executeJavaScript('draft.value'), 'preview draft retained');
    await until(() => chrome.executeJavaScript('!document.getElementById("page-preview-keep").disabled'), 'Keep available after veto');
    const previewProcess = previewPage.getOSProcessId();
    await chrome.executeJavaScript('document.getElementById("page-preview-keep").click()');
    await until(async () => !(await uiState(chrome)).preview && browser.getState().tabs.some(tab => tab.id === previewTab), 'same-page Keep completed');
    assert.equal(browser.engine.getView(previewQuery).webContents, previewPage); assert.equal(previewPage.getOSProcessId(), previewProcess);
    assert.equal(previewPage.session, nativeSession); assert.equal(await previewPage.executeJavaScript('pageInstance'), instance);
    assert.equal(await previewPage.executeJavaScript('draft.value'), 'preview draft retained');
    assert.equal(await previewPage.executeJavaScript('window.scrollY'), scrollY);
    assert.equal(browser.getState().groups.find(item => item.id === group.id).activeTabId, previewTab);
    assert.equal(browser.getState().tabs.find(tab => tab.id === previewTab).url, keptURL);
    assert.equal(requests.get('/' + marker), 1); assert.equal(requests.has('/kept-' + marker), false);
    assert.equal(browser.access.connections().find(item => item.agentSessionId === connection.agentSessionId).lease, null);
    await browser.flush();
    const visits = await actIn(chrome, { type: 'history.list', workspaceId, query: marker });
    assert.equal(visits.length, 1); assert.equal(visits[0].url, keptURL); assert.equal(visits[0].visitCount, 1);
    await previewPage.executeJavaScript('window.onbeforeunload=null');
    await until(() => chrome.executeJavaScript('document.getElementById("page-preview-bar").hidden&&document.getElementById("address").value===' + JSON.stringify(keptURL)), 'saved tab presentation rendered');
    await check('native Stay retains the preview; Keep commits one history visit and promotes the same page, process, Session, draft and nonzero scroll position without navigation or renewed control');

    checkpoint('record chord after exact trusted-chrome native acknowledgment');
    const ignoreCalls = [], nativeIgnore = chrome.setIgnoreMenuShortcuts;
    chrome.setIgnoreMenuShortcuts = function(value) { ignoreCalls.push(value); return nativeIgnore.call(this, value); };
    restoreMenuIgnore = () => { if (!chrome.isDestroyed()) { chrome.setIgnoreMenuShortcuts = nativeIgnore; nativeIgnore.call(chrome, false); } };
    await chrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("about-dialog").open'), 'settings launcher');
    await chrome.executeJavaScript('document.getElementById("open-shortcuts").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("shortcuts-dialog").open&&document.getElementById("shortcut-record-f")'), 'shortcut recorder rendered');
    await chrome.executeJavaScript('document.getElementById("shortcut-record-f").click()');
    await until(async () => (await uiState(chrome)).shortcutRecording.active && await chrome.executeJavaScript('document.getElementById("shortcut-record-f").textContent==="Press your shortcut…"'), 'native recording mode acknowledged');
    const recording = (await uiState(chrome)).shortcutRecording;
    assert.ok(recording.expiresAt > Date.now() && recording.expiresAt <= Date.now() + 15000); assert.ok(ignoreCalls.includes(true));
    assert.equal(await chrome.executeJavaScript('document.activeElement===document.getElementById("shortcut-record-f")'), true);
    await chrome.executeJavaScript('document.getElementById("shortcut-record-f").dispatchEvent(new KeyboardEvent("keydown",{key:"F",code:"KeyF",metaKey:true,shiftKey:true,bubbles:true,cancelable:true}))');
    await until(async () => !(await uiState(chrome)).shortcutRecording.active && await chrome.executeJavaScript('document.getElementById("shortcut-f").value==="Primary+Shift+F"'), 'recorded chord and restored native dispatch');
    assert.equal(ignoreCalls.at(-1), false);
    await captureChrome(chrome, 'shortcut-recorder-chrome.png');
    await chrome.executeJavaScript('document.getElementById("shortcuts-form").requestSubmit()');
    await until(async () => (await uiState(chrome)).shortcuts.bindings.f === 'Primary+Shift+F', 'reviewed chord saved');
    await chrome.executeJavaScript('document.getElementById("close-shortcuts").click()');
    await until(() => chrome.executeJavaScript('!document.getElementById("shortcuts-dialog").open'), 'shortcut dialog closed');
    restoreMenuIgnore(); restoreMenuIgnore = null;
    await check('actual chord recorder waits for native chrome-only mode, stages a canonical shortcut and restores menu dispatch before explicit Save');

    checkpoint('native source-bound link menu stale receipt');
    await until(() => browser.engine.getView(previewQuery).getVisible(), 'kept native page visible after settings');
    const linkURL = await previewPage.executeJavaScript('document.getElementById("preview-link").href');
    const emitLinkMenu = () => previewPage.emit('context-menu', {}, { frame: previewPage.mainFrame, linkURL, x: 10, y: 10 });
    emitLinkMenu(); const staleMenu = browser.takeTestPreviewMenu(); assert.ok(staleMenu);
    await previewPage.executeJavaScript('history.pushState({},"","/source-changed")');
    await until(() => browser.engine.navigation(previewQuery).url.endsWith('/source-changed'), 'source document changed');
    await assert.rejects(staleMenu.open(), error => ['PREVIEW_STALE', 'STALE_TARGET'].includes(error.code));
    assert.equal((await uiState(chrome)).preview, null);
    emitLinkMenu(); const liveMenu = browser.takeTestPreviewMenu(); assert.ok(liveMenu);
    assert.equal(liveMenu.windowId, ownerWindow.id); assert.equal(liveMenu.workspaceId, workspaceId); assert.equal(liveMenu.sourceTabId, previewTab);
    await timed(liveMenu.open(), 'live native link menu'); report.bounds.previewLifetimes++;
    await until(async () => (await uiState(chrome)).preview?.source === 'link' && pageAt(linkURL), 'native link preview ready');
    await assert.rejects(liveMenu.open(), code('PREVIEW_STALE'));
    await check('native link-menu receipt binds its exact main document and owner; stale or repeated menu clicks cannot open another preview');

    checkpoint('owner close honors preview beforeunload and native acknowledgment');
    const linkPage = pageAt(linkURL); assert.ok(linkPage);
    assert.equal(await linkPage.executeJavaScript('draft.value="link draft";window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};navigator.userActivation.hasBeenActive', true), true);
    const beforeWindowDecision = decisions;
    ownerWindow.close(); await until(() => decisions > beforeWindowDecision, 'owner close decision');
    await until(async () => (await uiState(chrome)).preview?.status === 'active', 'owner close veto settled');
    assert.equal(ownerWindow.isDestroyed(), false); assert.equal(linkPage.isDestroyed(), false);
    browser.setTestCloseDecision(async () => { decisions++; return true; });
    // A closing renderer cannot return its own IPC. Require native destroyed ACK.
    ownerWindow.close(); await until(() => ownerWindow.isDestroyed(), 'owner native destroyed acknowledgment');
    assert.equal(linkPage.isDestroyed(), true); assert.equal(previewPage.isDestroyed(), false); assert.equal(parentPage.isDestroyed(), false);
    assert.equal(browser.engine.getWorkspaceOwnerWindow(workspaceId), sibling.window);
    assert.equal(browser.getWindows().length, 1); assert.equal((await uiState(siblingChrome)).preview, null);
    await check('closing an owner honors preview Stay/Leave and releases its transient page before transferring ordinary saved pages to the remaining owner');

    checkpoint('paused preview cleanup never resumes agent authority');
    await actIn(siblingChrome, { type: 'workspace.select', workspaceId });
    const pausedURL = origin + '/paused-' + marker;
    preview = await openTyped(siblingChrome, pausedURL); const pausedPage = pageAt(pausedURL); assert.ok(pausedPage);
    await actIn(siblingChrome, { type: 'privacy.enter', workspaceId });
    await until(async () => (await uiState(siblingChrome)).preview?.status === 'paused', 'preview paused under privacy barrier');
    assert.equal(pausedPage.isDestroyed(), false);
    const paused = (await uiState(siblingChrome)).preview;
    const deniedKeep = await siblingChrome.executeJavaScript('window.caddi.action(' + JSON.stringify({ type: 'preview.promote', previewId: paused.id,
      generation: paused.generation, expectedRevision: browser.getState().revision }) + ')');
    assert.equal(deniedKeep.ok, false); assert.equal(deniedKeep.code, 'PREVIEW_PRIVACY_BLOCKED');
    assert.equal(await pausedPage.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};navigator.userActivation.hasBeenActive', true), true);
    await siblingChrome.executeJavaScript('document.getElementById("page-preview-close").click()');
    await until(async () => !(await uiState(siblingChrome)).preview && pausedPage.isDestroyed(), 'blocked preview native close acknowledgment');
    assert.equal(browser.privacy.getPrivacyState(workspaceId).blocked, true);
    assert.equal(browser.access.connections().find(item => item.agentSessionId === connection.agentSessionId).lease, null);
    assert.equal(browser.getState().tabs.some(tab => tab.url === pausedURL), false);
    await check('private takeover pauses the retained preview, denies Keep and still permits exact native cleanup without resuming agents');

    assert.equal(browser.getWindows().every(owner => !owner.window.isVisible()), true);
    assert.ok(report.bounds.maxConcurrentWindows <= report.bounds.fixtureMaxConcurrentWindows);
    assert.equal(report.bounds.windowLifetimes, 2);
    assert.equal(report.bounds.previewLifetimes, 3);
    report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.status = 'passed'; await save(); console.log('PREVIEW_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
  } catch (error) {
    report.status = 'failed'; report.error = { code: error?.code ?? 'PREVIEW_ASSERTION', message: String(error?.message ?? error).slice(0, 1200),
      stack: String(error?.stack ?? '').slice(0, 6000) };
    report.windowsAtFailure = browser.getWindows().map(owner => ({ id: owner.id, workspaceId: owner.workspaceId, destroyed: owner.window.isDestroyed(), private: owner.private }));
    await save(); throw error;
  } finally {
    clearTimeout(deadline); restoreMenuIgnore?.(); client?.close(); browser.setTestCloseDecision(async () => true); browser.engine.cancelHumanClose();
    app.off('browser-window-created', onCreated);
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
