// One hidden ordinary owner plus one hidden ephemeral private window. All files,
// origins and identities are synthetic; the actual owner review UI and file I/O
// run, while native Open/Save panels use explicit checkout-only callbacks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, webContents } from 'electron';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { createPortabilityExport } from '../src/caddi/state/portability.mjs';
import { stateDigest } from '../src/caddi/state/store.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceEvidence(root) {
  const entries = [];
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file); else entries.push({ path: file, sha256: sha(await fs.readFile(path.join(root, file))) });
      assert.ok(entries.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'test/caddi-desktop-portability-smoke.mjs'])
    entries.push({ path: file, sha256: sha(await fs.readFile(path.join(root, file))) });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
function sourceOrganization(origin) {
  let state = createProductState();
  const commands = [
    { type: 'workspace.create', id: 'source-workspace', identityId: 'source-identity', name: 'Imported studio', kind: 'personal', projectId: null },
    { type: 'group.create', id: 'source-group', workspaceId: 'source-workspace', name: 'Research', color: '#337765' },
    { type: 'folder.create', id: 'source-folder', workspaceId: 'source-workspace', groupId: 'source-group', parentId: null, name: 'Reference' },
  ];
  for (const command of commands) state = applyProductCommand(state, command);
  for (let index = 0; index < 25; index++) state = applyProductCommand(state, { type: 'tab.create', id: 'source-tab-' + index,
    workspaceId: 'source-workspace', groupId: 'source-group', url: origin + '/unloaded-' + index,
    title: 'Reference page ' + (index + 1), now: index + 1, activate: false });
  state = applyProductCommand(state, { type: 'tab.move', tabId: 'source-tab-0', groupId: 'source-group', folderId: 'source-folder' });
  const envelope = JSON.parse(createPortabilityExport({ format: 'caddi', state, workspaceIds: ['source-workspace'] }).bytes);
  envelope.state.tabs[0].url = origin + '/unloaded-0?token=synthetic-portability-secret&view=kept#private-fragment';
  envelope.state.identities[0].engineRef = 'synthetic-source-profile';
  return Buffer.from(JSON.stringify(envelope) + '\n');
}

export async function runDesktopPortabilitySmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.ok(process.argv.includes('--caddi-portability-smoke') && !app.isPackaged);
  assert.equal(browser.window.isVisible(), false); assert.equal(typeof browser.setTestPortabilityDialogs, 'function');
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-portability-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(parent, 'run-')), reportPath = path.join(proof, 'report.json'), started = Date.now();
  const report = { format: 'caddi-portability-smoke-v1', status: 'running', startedAt: new Date().toISOString(), checks: [], screenshots: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 75000, mainWatchdogMs: 90000, fixtureMaxConcurrentWindows: 2, fixtureMaxWindowLifetimes: 2,
      maxConcurrentWindows: 1, windowLifetimes: 1 },
    limits: ['All files, URLs, cookies and identities are synthetic and confined to this disposable proof.',
      'Actual trusted chrome controls, stable source reading, metadata publication and exclusive export are exercised; native Open/Save panels use checkout-only file callbacks.',
      'No physical focus, keyboard, real-account sign-in, imported-site compatibility, power-loss or operating-system crash qualification is claimed.',
      'Combined ordinary/private capacity is inspected through the real review; exact boundary/held-commit races are covered separately by focused host tests.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const checkpoint = label => { report.checkpoint = { label, elapsedMs: Date.now() - started }; };
  const check = async label => { report.checks.push(label); console.log('PORTABILITY_PASS ' + label); await save(); };
  let server, deadline, stopped = false, importFile = null, exportFile = null, privateWindow = null, requestCount = 0;
  const seenWindows = new Set([browser.window.id]), liveWindows = new Set([browser.window.id]);
  browser.window.once('closed', () => liveWindows.delete(browser.window.id));
  const onWindow = (_event, native) => {
    if (seenWindows.has(native.id)) return; seenWindows.add(native.id); liveWindows.add(native.id);
    report.bounds.windowLifetimes = seenWindows.size; report.bounds.maxConcurrentWindows = Math.max(report.bounds.maxConcurrentWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  app.on('browser-window-created', onWindow);
  async function timed(value, label, timeout = 8000) {
    report.lastOperation = label; if (stopped) throw new Error('Portability proof deadline');
    let timer; try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(predicate, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  const chrome = browser.window.webContents, uiState = () => chrome.executeJavaScript('window.caddi.getState()');
  const inputAction = (native, input) => timed(native.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), 'owner action ' + input.type);
  const act = async input => { const result = await inputAction(chrome, input); assert.equal(result.ok, true, JSON.stringify(result)); return result.result; };
  const click = id => chrome.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').click()');
  const nativeIds = () => webContents.getAllWebContents().filter(item => !item.isDestroyed()).map(item => item.id).sort((a, b) => a - b);
  async function openDialog(mode = 'import', format = 'caddi') {
    if (await chrome.executeJavaScript('document.getElementById("portability-dialog").open')) {
      await until(() => chrome.executeJavaScript('!document.getElementById("portability-close").disabled'), 'file review may close');
      await click('portability-close');
      await until(() => chrome.executeJavaScript('!document.getElementById("portability-dialog").open'), 'file review closed');
    }
    await click('about-app'); await until(() => chrome.executeJavaScript('document.getElementById("about-dialog").open'), 'settings visible');
    await click('open-portability'); await until(() => chrome.executeJavaScript('document.getElementById("portability-dialog").open'), 'file controls visible');
    await click(mode === 'import' ? 'portability-import-mode' : 'portability-export-mode');
    await chrome.executeJavaScript('document.getElementById("portability-format").value=' + JSON.stringify(format) + ';document.getElementById("portability-format").dispatchEvent(new Event("change",{bubbles:true}))');
  }
  async function startReview() {
    await until(() => chrome.executeJavaScript('!document.getElementById("portability-start").disabled'), 'file review start enabled');
    await click('portability-start');
    await until(() => chrome.executeJavaScript('!document.getElementById("portability-review").hidden&&!document.getElementById("portability-apply").disabled'), 'review and bounded first page rendered');
    const state = await uiState(); assert.equal(state.portability.active, true);
    return { reviewId: state.portability.reviewId, generation: state.portability.generation, expectedRevision: state.metadata.revision };
  }
  async function screenshot(file) {
    await timed(chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))'), 'review font and layout readiness');
    try { const pixels = await timed(chrome.capturePage(), 'trusted review pixels', 3000); await fs.writeFile(path.join(proof, file), pixels.toPNG(), { mode: 0o600 }); report.screenshots.push({ file, available: true }); }
    catch (error) { report.screenshots.push({ file, available: false, reason: String(error?.message ?? error).slice(0, 160) }); }
  }
  try {
    report.sourceBefore = await sourceEvidence(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; browser.engine.cancelHumanClose(); }, 75000);
    server = http.createServer((_request, response) => { requestCount++; response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Unexpected imported page request'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const files = path.join(runRoot, 'portability-owned'); await fs.mkdir(files, { mode: 0o700 });
    const sourcePath = path.join(files, 'organization.json'), bookmarkPath = path.join(files, 'bookmarks.html');
    const sourceBytes = sourceOrganization(origin), sourceHash = sha(sourceBytes);
    const bookmarkBytes = Buffer.from('<!DOCTYPE NETSCAPE-Bookmark-file-1><META CHARSET="UTF-8"><DL><p><DT><H3>Bookmarks</H3><DL><p>' +
      '<DT><A HREF="' + origin + '/bookmark?token=synthetic&view=one">Bookmark &amp; reference</A>' +
      '<DT><A HREF="javascript:globalThis.unexpectedImport=true">Unsafe bookmark</A></DL><p></DL><p>');
    await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 }); await fs.writeFile(bookmarkPath, bookmarkBytes, { mode: 0o600 });
    browser.setTestPortabilityDialogs({ chooseImportFile: async ({ assertCurrent }) => { assertCurrent(); return importFile; },
      chooseExportFile: async ({ assertCurrent }) => { assertCurrent(); return exportFile; } });
    await browser.flush(); const initial = browser.getState(), workspaceId = initial.activeWorkspaceId;
    const workspace = initial.workspaces.find(item => item.id === workspaceId), group = initial.groups.find(item => item.id === workspace.activeGroupId);
    const parentPage = browser.engine.getView({ workspaceId, tabId: group.activeTabId }).webContents, parentSession = parentPage.session;
    await parentSession.cookies.set({ url: 'https://portability.synthetic.test', name: 'existing-signin', value: 'synthetic-owner-cookie', secure: true });
    const agentsBefore = browser.access.connections();

    checkpoint('native chooser cancel leaves organization untouched');
    await openDialog(); await click('portability-start');
    await until(() => chrome.executeJavaScript('document.getElementById("portability-state").textContent.includes("selection cancelled")'), 'chooser cancellation rendered');
    assert.equal(stateDigest(browser.getState()), stateDigest(initial)); assert.equal((await uiState()).portability.active, false);
    await check('actual owner file controls handle native chooser cancellation without metadata or native page changes');

    checkpoint('private and ordinary metadata share reviewed admission');
    await click('portability-close'); await until(() => chrome.executeJavaScript('!document.getElementById("portability-dialog").open'), 'review dialog closed before private owner');
    await act({ type: 'window.private.open' }); privateWindow = browser.getWindows().find(item => item.private); assert.ok(privateWindow);
    const privateState = await privateWindow.window.webContents.executeJavaScript('window.caddi.getState()');
    const denied = await inputAction(privateWindow.window.webContents, { type: 'portability.import.choose', format: 'caddi' });
    assert.equal(denied.ok, false); assert.match(denied.code, /^PRIVATE_/u);
    assert.equal(privateState.portability.available, false); assert.equal(privateState.portability.active, false);
    importFile = sourcePath; await openDialog(); const cancelledReview = await startReview();
    const openCount = browser.getState().tabs.filter(tab => tab.status === 'open').length + privateState.metadata.tabs.filter(tab => tab.status === 'open').length;
    assert.ok(await chrome.executeJavaScript('document.getElementById("portability-capacity").textContent.includes(' + JSON.stringify(openCount + ' existing + 25 imported') + ')'));
    const firstRows = await chrome.executeJavaScript('document.getElementById("portability-rows").children.length'); assert.equal(firstRows, 20);
    await click('portability-next'); await until(() => chrome.executeJavaScript('document.getElementById("portability-page-status").textContent.startsWith("21")'), 'next bounded review page');
    assert.ok(await chrome.executeJavaScript('document.getElementById("portability-rows").children.length<=20'));
    await screenshot('import-review-chrome.png'); await click('portability-cancel');
    await until(async () => !(await uiState()).portability.active, 'review cancellation received');
    const stale = await inputAction(chrome, { type: 'portability.import.apply', ...cancelledReview });
    assert.equal(stale.ok, false); assert.equal(stale.code, 'PORTABILITY_REVIEW_STALE');
    assert.equal(browser.getState().workspaces.length, initial.workspaces.length);
    await check('real review pages are bounded, combined admission counts private tabs, private controls deny portability and Cancel consumes the exact receipt');

    checkpoint('changed source refused after owner review');
    const changedReview = await startReview(), beforeChanged = stateDigest(browser.getState());
    await fs.writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n')]), { mode: 0o600 });
    const changedHash = sha(await fs.readFile(sourcePath)); await click('portability-apply');
    await until(() => chrome.executeJavaScript('document.getElementById("portability-state").textContent.includes("selected file changed")'), 'changed-source refusal rendered');
    assert.equal(stateDigest(browser.getState()), beforeChanged); assert.equal(sha(await fs.readFile(sourcePath)), changedHash);
    const replayChanged = await inputAction(chrome, { type: 'portability.import.apply', ...changedReview });
    assert.equal(replayChanged.ok, false); assert.equal(replayChanged.code, 'PORTABILITY_REVIEW_STALE');
    await fs.writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    await check('source bytes changed after review are refused by the final host fence and never overwritten or partially imported');

    checkpoint('reviewed Caddi import publishes fresh unloaded identities');
    await openDialog(); const reviewed = await startReview(), beforeImport = browser.getState(), nativeBefore = nativeIds();
    assert.equal(requestCount, 0); await click('portability-apply');
    await until(() => browser.getState().workspaces.length === beforeImport.workspaces.length + 1, 'reviewed import committed');
    await until(() => chrome.executeJavaScript('document.getElementById("portability-state").textContent.startsWith("Imported 1 workspace")'), 'import success rendered');
    const afterImport = browser.getState(), imported = afterImport.workspaces.find(item => !beforeImport.workspaces.some(old => old.id === item.id));
    assert.ok(imported); assert.notEqual(imported.id, 'source-workspace'); assert.notEqual(imported.identityId, 'source-identity');
    assert.equal(afterImport.identities.find(item => item.id === imported.identityId).engineRef, null);
    assert.equal(afterImport.tabs.filter(item => item.workspaceId === imported.id).length, 25);
    assert.equal(afterImport.activeWorkspaceId, beforeImport.activeWorkspaceId); assert.deepEqual(afterImport.settings, beforeImport.settings);
    assert.deepEqual(nativeIds(), nativeBefore); assert.equal(browser.engine.getWorkspaceOwnerWindow(imported.id), null);
    assert.equal(browser.engine.getView({ workspaceId, tabId: group.activeTabId }).webContents, parentPage); assert.equal(parentPage.session, parentSession);
    assert.equal((await parentSession.cookies.get({ url: 'https://portability.synthetic.test', name: 'existing-signin' }))[0]?.value, 'synthetic-owner-cookie');
    assert.deepEqual(browser.access.connections(), agentsBefore); assert.equal(requestCount, 0);
    assert.doesNotMatch(JSON.stringify(afterImport), /synthetic-portability-secret|synthetic-source-profile|private-fragment/);
    assert.equal(sha(await fs.readFile(sourcePath)), sourceHash);
    const replay = await inputAction(chrome, { type: 'portability.import.apply', ...reviewed });
    assert.equal(replay.ok, false); assert.equal(replay.code, 'PORTABILITY_REVIEW_STALE');
    assert.equal(browser.getState().workspaces.length, afterImport.workspaces.length);
    await check('owner Apply adds fresh identities and remapped organization without page loads, focus changes, grant creation or changes to the existing Session');

    checkpoint('bookmark HTML reviewed separately and never executed');
    importFile = bookmarkPath; await openDialog('import', 'bookmarks'); await startReview();
    await chrome.executeJavaScript('document.getElementById("portability-section").value="skipped";document.getElementById("portability-section").dispatchEvent(new Event("change",{bubbles:true}))');
    await until(() => chrome.executeJavaScript('!document.getElementById("portability-apply").disabled&&document.getElementById("portability-rows").textContent.length>0'), 'unsafe bookmark reviewed as skipped');
    const beforeBookmarks = browser.getState(), contentsBeforeBookmarks = nativeIds(); await click('portability-apply');
    await until(() => browser.getState().workspaces.length === beforeBookmarks.workspaces.length + 1, 'bookmark import committed');
    await until(() => chrome.executeJavaScript('document.getElementById("portability-state").textContent.startsWith("Imported")'), 'bookmark success rendered');
    const bookmarkWorkspace = browser.getState().workspaces.find(item => !beforeBookmarks.workspaces.some(old => old.id === item.id));
    const bookmarkTabs = browser.getState().tabs.filter(item => item.workspaceId === bookmarkWorkspace.id);
    assert.equal(bookmarkTabs.length, 1); assert.equal(bookmarkTabs[0].url, origin + '/bookmark?view=one');
    assert.deepEqual(nativeIds(), contentsBeforeBookmarks); assert.equal(requestCount, 0);
    assert.equal(sha(await fs.readFile(bookmarkPath)), sha(bookmarkBytes));
    await check('bookmark HTML imports reviewed safe destinations and reports skipped active content without executing or loading it');

    checkpoint('immutable reviewed export survives unrelated metadata update');
    await openDialog('export', 'caddi');
    assert.equal(await chrome.executeJavaScript('document.querySelectorAll("#portability-workspaces input:checked").length'), 1);
    assert.equal(await chrome.executeJavaScript('document.querySelector("#portability-workspaces input:checked").value'), workspaceId);
    const exportState = browser.getState(), expectedExport = createPortabilityExport({ format: 'caddi', state: exportState, workspaceIds: [workspaceId] }).bytes;
    await startReview(); await screenshot('export-review-chrome.png');
    await act({ type: 'tab.create', workspaceId: imported.id, input: 'about:blank', activate: false });
    exportFile = path.join(files, 'reviewed-export.json'); await click('portability-apply');
    await until(() => chrome.executeJavaScript('document.getElementById("portability-state").textContent.startsWith("Saved reviewed-export.json")'), 'exclusive export success rendered');
    const savedBytes = await fs.readFile(exportFile); assert.deepEqual(savedBytes, expectedExport);
    assert.equal(JSON.parse(savedBytes).state.workspaces.length, 1);
    assert.equal(savedBytes.toString().includes(imported.identityId), false); assert.equal(savedBytes.toString().includes(privateState.metadata.activeWorkspaceId), false);
    report.export = { sha256: sha(savedBytes), bytes: savedBytes.length, mode: (await fs.stat(exportFile)).mode & 0o777 };
    assert.equal(report.export.mode, 0o600);
    await check('real export review saves only explicitly selected immutable organization bytes into a private new file despite unrelated later metadata updates');

    checkpoint('exclusive export refuses overwrite');
    await openDialog('export', 'caddi'); await startReview(); await click('portability-apply');
    await until(() => chrome.executeJavaScript('document.getElementById("portability-state").textContent.includes("already exists")'), 'existing-destination refusal rendered');
    assert.equal(sha(await fs.readFile(exportFile)), sha(savedBytes)); assert.equal(sha(await fs.readFile(sourcePath)), sourceHash);
    await check('existing export destinations are never overwritten and repeated native save intent cannot alter the previous file');

    checkpoint('owner switch away and back invalidates the exact review');
    importFile = sourcePath; await openDialog('import', 'caddi'); const old = await startReview();
    const otherWorkspace = initial.workspaces.find(item => item.id !== workspaceId); assert.ok(otherWorkspace);
    await act({ type: 'workspace.select', workspaceId: otherWorkspace.id }); await act({ type: 'workspace.select', workspaceId });
    const staleOwner = await inputAction(chrome, { type: 'portability.import.apply', ...old });
    assert.equal(staleOwner.ok, false); assert.equal(staleOwner.code, 'PORTABILITY_REVIEW_STALE');
    assert.equal(requestCount, 0); assert.equal(browser.getState().workspaces.length, initial.workspaces.length + 2);
    await check('switching the owner away and back revokes reviewed import authority instead of reviving an old receipt');

    checkpoint('private cleanup and preserved source evidence');
    privateWindow.window.close(); await until(() => privateWindow.window.isDestroyed(), 'private owner actual native cleanup');
    await browser.flush();
    assert.equal(sha(await fs.readFile(sourcePath)), sourceHash); assert.equal(sha(await fs.readFile(bookmarkPath)), sha(bookmarkBytes));
    assert.equal(browser.getWindows().every(owner => !owner.window.isVisible()), true);
    assert.ok(report.bounds.maxConcurrentWindows <= report.bounds.fixtureMaxConcurrentWindows); assert.equal(report.bounds.windowLifetimes, 2);
    report.sources = [{ format: 'caddi', sha256: sourceHash, bytes: sourceBytes.length }, { format: 'bookmarks', sha256: sha(bookmarkBytes), bytes: bookmarkBytes.length }];
    report.importedSiteRequests = requestCount;
    report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.status = 'passed'; await save(); console.log('PORTABILITY_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
  } catch (error) {
    report.status = 'failed'; report.error = { code: error?.code ?? 'PORTABILITY_ASSERTION', message: String(error?.message ?? error).slice(0, 1200), stack: String(error?.stack ?? '').slice(0, 6000) };
    report.windowsAtFailure = browser.getWindows().map(owner => ({ id: owner.id, workspaceId: owner.workspaceId, private: owner.private, destroyed: owner.window.isDestroyed() }));
    await save(); throw error;
  } finally {
    clearTimeout(deadline); browser.engine.cancelHumanClose(); browser.setTestCloseDecision?.(async () => true);
    browser.setTestPortabilityDialogs({ chooseImportFile: async () => null, chooseExportFile: async () => null });
    app.off('browser-window-created', onWindow);
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
