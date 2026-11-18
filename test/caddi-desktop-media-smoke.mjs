// Checkout-only, synthetic devices and loopback pages. No real system permission
// API, device labels, audio samples, camera pixels or physical focus are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, BrowserWindow, webContents } from 'electron';
import { createSiteMediaAccess } from '../src/caddi/desktop/site-media-access.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let smokeSystem = null;
function assertSmokeLane() {
  assert.ok(process.argv.includes('--caddi-media-smoke') && !app.isPackaged);
  assert.equal(app.commandLine.hasSwitch('use-fake-device-for-media-stream'), true);
  assert.equal(app.commandLine.hasSwitch('use-fake-ui-for-media-stream'), false);
}
export function createMediaSmokeSystemAccess() {
  assertSmokeLane();
  assert.equal(smokeSystem, null, 'One synthetic system adapter per disposable run');
  const state = { hold: false, pending: null, requests: 0 };
  const adapter = createSiteMediaAccess({
    getStatus(type) { assert.ok(['microphone', 'camera'].includes(type)); return state.hold ? 'not-determined' : 'granted'; },
    requestAccess(type) {
      assertSmokeLane(); assert.ok(['microphone', 'camera'].includes(type)); assert.equal(state.hold, true); assert.equal(state.pending, null);
      state.requests++;
      return new Promise(resolve => { state.pending = answer => { state.hold = false; state.pending = null; resolve(answer); }; });
    },
  });
  smokeSystem = { state, adapter }; return adapter;
}
async function sources(root) {
  const entries = [], hash = data => createHash('sha256').update(data).digest('hex');
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file); else entries.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
      assert.ok(entries.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'scripts/package-caddi.mjs', 'test/caddi-desktop-media-smoke.mjs'])
    entries.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
const fixtureHTML = `<!doctype html><meta charset="utf-8"><title>Media fixture</title>
<style>body{font:18px system-ui;padding:40px;color:#142126;background:#edf4f6}input{display:block;padding:12px;margin:12px 0}</style>
<h1>Synthetic media fixture</h1><label>Unsaved draft<input id="draft" value="fixture draft"></label><div id="frames"></div>
<script>
window.jobs={};window.streams=[];
window.probe=(name,constraints)=>{jobs[name]={status:'requesting'};navigator.mediaDevices.getUserMedia(constraints).then(stream=>{
streams.push(stream);jobs[name]={status:'allowed',kinds:stream.getTracks().map(track=>track.kind)};
},error=>{jobs[name]={status:'denied',code:error.name}});return true};
window.trackStates=()=>streams.flatMap(stream=>stream.getTracks().map(track=>({kind:track.kind,state:track.readyState})));
window.displayProbe=()=>{jobs.display={status:'requesting'};navigator.mediaDevices.getDisplayMedia({video:true}).then(stream=>{
stream.getTracks().forEach(track=>track.stop());jobs.display={status:'allowed'};
},error=>{jobs.display={status:'denied',code:error.name}});return true};
</script>`;

export async function runDesktopMediaSmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assertSmokeLane(); assert.ok(smokeSystem); assert.equal(browser.window.isVisible(), false);
  assert.equal(browser.engine.capabilities.persistentStorage, false); assert.equal(typeof browser.setTestCloseDecision, 'function');
  const realRun = await fs.realpath(runRoot), realData = await fs.realpath(dataRoot);
  assert.ok(realData.startsWith(realRun + path.sep), 'Disposable data must remain inside this smoke run');
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-site-media-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 }); const proof = await fs.mkdtemp(path.join(parent, 'run-'));
  const reportPath = path.join(proof, 'report.json'), started = Date.now();
  const report = { format: 'caddi-site-media-smoke-v1', status: 'running', startedAt: new Date().toISOString(), checks: [], screenshots: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 75000, mainWatchdogMs: 90000, maximumSimultaneousNativeWindows: 2, observedNativeWindows: 0 },
    syntheticOnly: true, realDeviceAccess: false, realSystemPermissionCalls: 0,
    limits: ['Chromium fake camera/microphone only; the permission UI and both application permission handlers remain enabled.',
      'Synthetic system consent is injected only in a hidden disposable app. Real macOS prompts and hardware are unqualified.',
      'Track kind/readyState are inspected in owned fixtures; no labels, device identifiers, samples, frames or recordings are collected.',
      'Permission revocation does not claim that existing streams ended. Native document destruction acknowledges only that page ending.',
      'Beforeunload uses script userGesture and a synthetic owner decision. Windows remain hidden; physical focus is unqualified.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const check = async name => { report.checks.push(name); console.log('MEDIA_PASS ' + name); await save(); };
  let server, deadline, stopped = false, unowned = null;
  const liveWindows = new Set(), observedWindows = new Set();
  const track = native => {
    if (observedWindows.has(native.id)) return; observedWindows.add(native.id); liveWindows.add(native.id);
    report.bounds.observedNativeWindows = Math.max(report.bounds.observedNativeWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  for (const owner of browser.getWindows()) track(owner.window);
  const created = (_event, native) => track(native); app.on('browser-window-created', created);
  async function timed(value, label, ms = 7000) {
    report.lastOperation = label; if (stopped) throw new Error('Media proof deadline'); let timer;
    try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(predicate, label, ms = 7000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  const chrome = browser.window.webContents, state = owner => owner.executeJavaScript('window.caddi.getState()');
  async function act(owner, input) {
    const reply = await timed(owner.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), input.type);
    assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result;
  }
  async function dismissPermissions() {
    await chrome.executeJavaScript('document.getElementById("permissions-dialog").close()');
    await act(chrome, { type: 'overlay.set', open: false });
  }
  async function clickDecision(id, decision) {
    const selector = 'button[data-permission-id="' + id + '"][data-permission-decision="' + decision + '"]';
    await until(() => chrome.executeJavaScript('!!document.querySelector(' + JSON.stringify(selector) + ')&&!document.querySelector(' + JSON.stringify(selector) + ').disabled'), 'rendered exact permission decision');
    await chrome.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').click()');
  }
  async function probe(page, name, constraints) {
    await page.executeJavaScript('probe(' + JSON.stringify(name) + ',' + JSON.stringify(constraints) + ')', true);
  }
  async function denied(page, name, constraints) {
    await probe(page, name, constraints);
    await until(() => page.executeJavaScript('jobs[' + JSON.stringify(name) + '].status!=="requesting"'), 'denied ' + name);
    assert.equal(await page.executeJavaScript('jobs[' + JSON.stringify(name) + '].status'), 'denied');
  }
  const activeTab = (metadata, workspaceId) => {
    const workspace = metadata.workspaces.find(item => item.id === workspaceId);
    return metadata.groups.find(item => item.id === workspace.activeGroupId).activeTabId;
  };
  const pageAt = url => webContents.getAllWebContents().find(contents => !contents.isDestroyed() && contents.getURL() === url);
  async function capture(file) {
    try {
      await chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      const pixels = await timed(chrome.capturePage(), 'permission chrome pixels', 3000);
      await fs.writeFile(path.join(proof, file), pixels.toPNG(), { mode: 0o600 }); report.screenshots.push({ file, available: true });
    } catch (error) { report.screenshots.push({ file, available: false, reason: String(error?.message ?? error).slice(0, 160) }); }
  }
  try {
    report.sourceBefore = await sources(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; browser.engine.cancelHumanClose(); smokeSystem.state.pending?.(false); }, 75000);
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; worker-src blob:; media-src blob:; connect-src 'none'; form-action 'none'" });
      response.end(fixtureHTML);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port, initial = browser.getState();
    const project = initial.workspaces.find(item => item.kind === 'project'), personal = initial.workspaces.find(item => item.kind === 'personal');
    assert.ok(project && personal);
    const navigate = async (workspaceId, pathname) => {
      await act(chrome, { type: 'workspace.select', workspaceId });
      const tabId = activeTab(browser.getState(), workspaceId);
      await act(chrome, { type: 'navigate', tabId, input: origin + pathname });
      const query = { workspaceId, tabId };
      await until(() => browser.engine.navigation(query).title === 'Media fixture' && !!browser.engine.permissionBinding(browser.engine.getView(query).webContents.id), 'native media fixture ready');
      return { query, page: browser.engine.getView(query).webContents };
    };
    const projectPage = await navigate(project.id, '/project');
    await denied(projectPage.page, 'project', { audio: true });
    assert.equal(browser.sitePermissions.list(project.id).pending.length, 0);
    assert.equal(smokeSystem.state.requests, 0);
    await check('an ordinary project workspace cannot acquire website microphone permission or trigger a system request');

    let normal = await navigate(personal.id, '/personal');
    const personalSession = normal.page.session;
    await normal.page.executeJavaScript('document.getElementById("frames").innerHTML="<iframe id=child src=/frame></iframe>"');
    await until(() => normal.page.executeJavaScript('typeof document.getElementById("child").contentWindow.probe==="function"'), 'same-origin subframe fixture');
    await normal.page.executeJavaScript('document.getElementById("child").contentWindow.probe("subframe",{audio:true})', true);
    await until(() => normal.page.executeJavaScript('document.getElementById("child").contentWindow.jobs.subframe.status!=="requesting"'), 'subframe denied');
    assert.equal(await normal.page.executeJavaScript('document.getElementById("child").contentWindow.jobs.subframe.status'), 'denied');
    await normal.page.executeJavaScript('displayProbe()', true);
    await until(() => normal.page.executeJavaScript('jobs.display.status!=="requesting"'), 'display capture denied');
    assert.equal(await normal.page.executeJavaScript('jobs.display.status'), 'denied');
    assert.equal(browser.sitePermissions.list(personal.id).pending.length, 0);
    await check('same-origin subframe camera/microphone and display capture deny before any owner approval');

    // Invalid synthetic source only. The application continues to deny every
    // display-capture request; never enumerate or approve a real desktop source.
    await denied(normal.page, 'legacy-display', { audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: 'caddi-invalid-synthetic-source',
    } } });
    assert.equal(browser.sitePermissions.list(personal.id).pending.length, 0);
    assert.equal(smokeSystem.state.requests, 0);
    assert.deepEqual(await normal.page.executeJavaScript('trackStates()'), []);
    await check('legacy desktop capture with an invalid synthetic source rejects without owner approval, issued tracks or system consent');

    const privateReply = await act(chrome, { type: 'window.private.open' });
    const privateOwner = browser.getWindows().find(owner => owner.id === privateReply.windowId), privateChrome = privateOwner.window.webContents;
    await until(async () => (await state(privateChrome)).privateBrowsing?.status === 'active', 'private owner ready');
    const privateState = await state(privateChrome), privateWorkspaceId = privateState.metadata.activeWorkspaceId, privateTabId = activeTab(privateState.metadata, privateWorkspaceId);
    await act(privateChrome, { type: 'navigate', tabId: privateTabId, input: origin + '/private' });
    await until(() => browser.engine.navigation({ workspaceId: privateWorkspaceId, tabId: privateTabId }).title === 'Media fixture', 'private media fixture');
    const privatePage = browser.engine.getView({ workspaceId: privateWorkspaceId, tabId: privateTabId }).webContents;
    await denied(privatePage, 'private', { audio: true, video: true });
    assert.equal(browser.engine.permissionBinding(privatePage.id), null);
    await privateChrome.executeJavaScript('document.getElementById("close-private-window").click()');
    await until(() => privateOwner.window.isDestroyed(), 'private fixture close');
    await check('private identity media requests remain denied and no private request enters normal owner permission state');

    const previewURL = origin + '/preview';
    await act(chrome, { type: 'preview.open', input: previewURL });
    await until(() => !!pageAt(previewURL) && !pageAt(previewURL).isLoading(), 'preview media fixture');
    const previewPage = pageAt(previewURL); await denied(previewPage, 'preview', { audio: true, video: true });
    assert.equal(browser.engine.permissionBinding(previewPage.id), null);
    const preview = (await state(chrome)).preview;
    await act(chrome, { type: 'preview.close', previewId: preview.id, generation: preview.generation });
    assert.equal(previewPage.isDestroyed(), true);
    unowned = new BrowserWindow({ show: false, parent: browser.window, webPreferences: { session: personalSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await unowned.loadURL(origin + '/unowned-popup'); await denied(unowned.webContents, 'unowned', { audio: true, video: true });
    assert.equal(browser.engine.permissionBinding(unowned.webContents.id), null);
    unowned.close(); await until(() => unowned.isDestroyed(), 'unowned same-session fixture close'); unowned = null;
    assert.equal(browser.sitePermissions.list(personal.id).pending.length, 0);
    await check('preview and unowned popup-shaped WebContents in the same Personal Session cannot acquire media authority');

    await probe(normal.page, 'combined', { audio: true, video: true });
    await until(() => browser.sitePermissions.list(personal.id).pending.length === 1, 'actual Electron combined permission request');
    const combined = browser.sitePermissions.list(personal.id).pending[0];
    assert.equal(combined.permission, 'media'); assert.deepEqual(combined.mediaTypes, ['audio', 'video']); assert.equal(combined.origin, origin);
    assert.equal(await normal.page.executeJavaScript('jobs.combined.status'), 'requesting');
    await clickDecision(combined.id, 'allow');
    await until(() => normal.page.executeJavaScript('jobs.combined.status==="allowed"'), 'combined synthetic tracks allowed');
    assert.deepEqual((await normal.page.executeJavaScript('trackStates()')).sort((a, b) => a.kind.localeCompare(b.kind)),
      [{ kind: 'audio', state: 'live' }, { kind: 'video', state: 'live' }]);
    let media = browser.sitePermissions.list(personal.id).media[0];
    assert.deepEqual(media.grantedMediaTypes, ['audio', 'video']); assert.equal(media.mayBeUsing, true);
    report.nativeRequest = { acceptedStrictDocumentURLBinding: true, mediaTypes: combined.mediaTypes, ordinaryPersonalOnly: true };
    await capture('personal-media-permission.png');
    await check('actual Electron45 request provenance passes strict URL/main-document binding and explicit combined owner approval yields only fake audio/video tracks');

    await until(() => chrome.executeJavaScript('!!document.querySelector(' + JSON.stringify('[data-media-control="revoke:' + media.id + ':audio"]') + ')'), 'rendered per-type revoke');
    await chrome.executeJavaScript('document.querySelector(' + JSON.stringify('[data-media-control="revoke:' + media.id + ':audio"]') + ').click()');
    await until(() => browser.sitePermissions.list(personal.id).media[0]?.grantedMediaTypes.join(',') === 'video', 'only audio permission revoked');
    assert.ok((await normal.page.executeJavaScript('trackStates()')).every(track => track.state === 'live'));
    await probe(normal.page, 'new-audio', { audio: true });
    await until(() => browser.sitePermissions.list(personal.id).pending.length === 1, 'new audio requires another owner review');
    await clickDecision(browser.sitePermissions.list(personal.id).pending[0].id, 'deny');
    await until(() => normal.page.executeJavaScript('jobs["new-audio"].status==="denied"'), 'revoked audio request denied');
    assert.equal(browser.sitePermissions.list(personal.id).media[0].mayBeUsing, true);
    await check('per-type revoke blocks a new microphone request while video permission and already-live fake tracks remain truthfully distinct');

    const sameDocument = browser.engine.mediaDocumentBinding(normal.page.id), oldRecord = browser.sitePermissions.list(personal.id).media[0];
    await normal.page.executeJavaScript('history.pushState({},"","#media-review")');
    await until(() => browser.sitePermissions.list(personal.id).media[0]?.grantedMediaTypes.length === 0, 'hash navigation revokes future grants');
    assert.equal(browser.engine.mediaDocumentBinding(normal.page.id).mediaDocumentId, sameDocument.mediaDocumentId);
    assert.equal(browser.sitePermissions.list(personal.id).media[0].id, oldRecord.id);
    assert.ok((await normal.page.executeJavaScript('trackStates()')).every(track => track.state === 'live'));
    await dismissPermissions();
    await act(chrome, { type: 'workspace.select', workspaceId: project.id });
    const background = await state(chrome);
    assert.equal(background.sitePermissions.media.length, 0);
    assert.ok(background.mediaActivity.possiblePages >= 1);
    assert.equal(background.mediaActivity.workspaces.find(workspace => workspace.workspaceId === personal.id)?.count, 1);
    assert.ok((await normal.page.executeJavaScript('trackStates()')).every(track => track.state === 'live'));
    await act(chrome, { type: 'workspace.select', workspaceId: personal.id });
    assert.equal(browser.engine.getView(normal.query).webContents, normal.page);
    assert.equal(browser.engine.mediaDocumentBinding(normal.page.id).mediaDocumentId, sameDocument.mediaDocumentId);
    assert.equal(browser.sitePermissions.list(personal.id).media[0].id, oldRecord.id);
    await check('switching workspace preserves a window-wide possible-media indicator and the same retained native document without exposing its grant as a project permission');
    await act(chrome, { type: 'navigate', tabId: normal.query.tabId, input: origin + '/replacement' });
    await until(() => browser.engine.navigation(normal.query).url === origin + '/replacement' && !!browser.engine.permissionBinding(normal.page.id), 'actual replacement document ready');
    assert.notEqual(browser.engine.mediaDocumentBinding(normal.page.id).mediaDocumentId, sameDocument.mediaDocumentId);
    assert.equal(browser.sitePermissions.list(personal.id).media.length, 0);
    await check('same-document navigation retains possible existing capture, while an actual main-document replacement acknowledges and removes the old issued record');

    smokeSystem.state.hold = true;
    await probe(normal.page, 'late-system', { audio: true });
    await until(() => browser.sitePermissions.list(personal.id).pending.length === 1, 'late system request review');
    const late = browser.sitePermissions.list(personal.id).pending[0]; await clickDecision(late.id, 'allow');
    await until(() => !!smokeSystem.state.pending && browser.sitePermissions.list(personal.id).pending[0]?.phase === 'waiting-for-system', 'synthetic system permission wait');
    assert.equal(smokeSystem.adapter.inspect().busy, true);
    await clickDecision(late.id, 'deny');
    await until(() => normal.page.executeJavaScript('jobs["late-system"].status==="denied"'), 'owner cancellation during system wait');
    assert.equal(smokeSystem.adapter.inspect().busy, true); smokeSystem.state.pending(true);
    await until(() => !smokeSystem.adapter.inspect().busy, 'actual synthetic promise settlement');
    assert.equal(browser.sitePermissions.list(personal.id).media.length, 0); assert.equal(browser.sitePermissions.list(personal.id).pending.length, 0);
    await check('Cancel during system permission wait denies the site immediately, retains the native slot, and ignores later synthetic OS approval');

    await probe(normal.page, 'before-end', { audio: true });
    await until(() => browser.sitePermissions.list(personal.id).pending.length === 1, 'new exact media review');
    await clickDecision(browser.sitePermissions.list(personal.id).pending[0].id, 'allow');
    await until(() => normal.page.executeJavaScript('jobs["before-end"].status==="allowed"'), 'new synthetic audio stream');
    await dismissPermissions();
    const beforePrivacy = browser.engine.mediaDocumentBinding(normal.page.id);
    await act(chrome, { type: 'privacy.enter', workspaceId: personal.id });
    assert.equal(browser.privacy.getPrivacyState(personal.id).blocked, true);
    assert.equal(browser.engine.permissionBinding(normal.page.id), null);
    assert.equal(browser.engine.mediaDocumentBinding(normal.page.id).mediaDocumentId, beforePrivacy.mediaDocumentId);
    media = browser.sitePermissions.list(personal.id).media[0];
    assert.equal(media.mayBeUsing, true); assert.deepEqual(media.grantedMediaTypes, []);
    assert.ok((await normal.page.executeJavaScript('trackStates()')).every(track => track.state === 'live'));
    let decisions = 0; browser.setTestCloseDecision(async () => { decisions++; return false; });
    assert.equal(await normal.page.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};navigator.userActivation.hasBeenActive', true), true);
    const endInput = () => { const row = browser.sitePermissions.list(personal.id).media[0]; return { type: 'permission.media.end', workspaceId: personal.id, mediaRecordId: row.id, expectedRevision: row.revision }; };
    const stayed = await act(chrome, endInput());
    assert.equal(stayed.closed, false); assert.equal(stayed.ended, false); assert.equal(decisions, 1);
    assert.equal(normal.page.isDestroyed(), false); assert.equal(browser.sitePermissions.list(personal.id).media[0].mayBeUsing, true);
    assert.ok((await normal.page.executeJavaScript('trackStates()')).every(track => track.state === 'live'));
    browser.setTestCloseDecision(async () => { decisions++; return true; });
    const ended = await act(chrome, endInput());
    assert.equal(ended.closed, true); assert.equal(ended.ended, true); assert.equal(decisions, 2); assert.equal(normal.page.isDestroyed(), true);
    assert.equal(browser.sitePermissions.list(personal.id).media.length, 0);
    assert.equal(browser.getState().tabs.find(tab => tab.id === normal.query.tabId).status, 'closed');
    assert.equal(browser.privacy.getPrivacyState(personal.id).blocked, true);
    assert.equal(browser.engine.workspaceAllocations(personal.id).pages.some(page => page.tabId === normal.query.tabId), false);
    await check('privacy revokes new requests without claiming a stop; exact blocked-document End honors native Stay then acknowledges Leave without reopening the page or resuming agents');

    assert.equal(browser.getWindows().every(owner => !owner.window.isVisible()), true);
    assert.ok(report.bounds.observedNativeWindows <= report.bounds.maximumSimultaneousNativeWindows);
    assert.equal(smokeSystem.state.requests, 1); report.syntheticSystemRequests = smokeSystem.state.requests;
    report.sourceAfter = await sources(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.status = 'passed'; await save(); console.log('MEDIA_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
  } catch (error) {
    report.status = 'failed'; report.error = { code: error?.code ?? 'MEDIA_ASSERTION', message: String(error?.message ?? error).slice(0, 1200), stack: String(error?.stack ?? '').slice(0, 6000) };
    await save(); throw error;
  } finally {
    clearTimeout(deadline); smokeSystem.state.pending?.(false); browser.setTestCloseDecision(async () => true); browser.engine.cancelHumanClose();
    if (unowned && !unowned.isDestroyed()) unowned.close(); app.off('browser-window-created', created);
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
