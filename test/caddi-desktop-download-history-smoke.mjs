// Disposable native DownloadItem proof and serial restart. No account, Finder,
// network outside loopback or user-chosen file is used by this fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { decodeDownloadJournal } from '../src/caddi/downloads/model.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceEvidence(root) {
  const files = [];
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false);
      const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file);
      else files.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) });
      assert.ok(files.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'test/caddi-desktop-download-history-smoke.mjs'])
    files.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function runDesktopDownloadHistorySmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.ok(process.argv.includes('--caddi-download-history-smoke') && !app.isPackaged);
  assert.equal(browser.window.isVisible(), false);
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-download-history-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(parent, 'run-')), reportPath = path.join(proof, 'report.json'), started = Date.now();
  const report = { format: 'caddi-download-history-smoke-v1', status: 'running', startedAt: new Date().toISOString(), checks: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 90000, mainWatchdogMs: 120000, fixtureMaxConcurrentWindows: 1, fixtureMaxWindowLifetimes: 2,
      maxConcurrentWindows: 1, windowLifetimes: 1 },
    limits: ['Only fixed synthetic loopback responses, disposable identities and fixture-owned Save destinations are used.',
      'Native Save and Finder UI are substituted by checkout-only callbacks; no physical keyboard/focus or native chooser qualification.',
      'An actual active DownloadItem journal snapshot is restored after acknowledged cleanup to test recovery. This is not an operating-system crash proof.',
      'Trusted chrome screenshots do not include the separately composed native website pixels.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const check = async name => { report.checks.push(name); console.log('DOWNLOAD_HISTORY_PASS ' + name); await save(); };
  let current = browser, server, restartRun, restartStarted = false, stopped = false, deadline;
  const seenWindows = new Set([browser.window.id]), liveWindows = new Set([browser.window.id]);
  browser.window.once('closed', () => liveWindows.delete(browser.window.id));
  const onWindow = (_event, native) => {
    if (seenWindows.has(native.id)) return;
    seenWindows.add(native.id); liveWindows.add(native.id);
    report.bounds.windowLifetimes = seenWindows.size;
    report.bounds.maxConcurrentWindows = Math.max(report.bounds.maxConcurrentWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  app.on('browser-window-created', onWindow);
  async function timed(value, label, timeout = 8000) {
    report.lastOperation = label;
    if (stopped) throw new Error('Download history proof deadline');
    let timer;
    try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(fn, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(fn), label)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  const journalFile = path.join(dataRoot, 'downloads', 'downloads.json');
  const journal = async () => decodeDownloadJournal(await fs.readFile(journalFile));
  const uiAct = async input => {
    const result = await timed(current.window.webContents.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), 'trusted chrome ' + input.type);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  };
  const names = new Map([['/completed', 'public-notes.txt'], ['/private', 'private-only.txt'], ['/after-resume', 'private-after-resume.txt'],
    ['/slow-close', 'public-after-close.bin'], ['/slow-restart', 'public-stopped.bin']]);
  const requests = new Map();
  try {
    report.sourceBefore = await sourceEvidence(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; current.engine.cancelHumanClose(); server?.closeAllConnections(); }, 90000);
    await fs.mkdir(path.join(runRoot, 'downloads'), { mode: 0o700 });
    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (names.has(pathname)) {
        requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
        const slow = pathname.startsWith('/slow-'), length = slow ? 262144 : 32;
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="' + names.get(pathname) + '"', 'content-length': length });
        if (!slow) { response.end(Buffer.alloc(length, 65)); return; }
        let sent = 0;
        const timer = setInterval(() => {
          if (sent >= length) { clearInterval(timer); response.end(); return; }
          response.write(Buffer.alloc(4096, 66)); sent += 4096;
        }, pathname === '/slow-restart' ? 100 : 40);
        response.on('close', () => clearInterval(timer)); return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
      response.end('<!doctype html><title>' + (pathname === '/private-page' ? 'Private source fixture' : 'Public source fixture') +
        '</title><h1>Download history fixture</h1><p>Only synthetic bytes.</p><a href="/completed">Save notes</a>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const state = browser.getState(), workspaceId = state.activeWorkspaceId;
    const workspace = state.workspaces.find(item => item.id === workspaceId);
    let tabId = state.groups.find(item => item.id === workspace.activeGroupId).activeTabId;
    const page = () => current.engine.getView({ workspaceId, tabId }).webContents;
    const load = async pathname => {
      await current.act({ type: 'navigate', tabId, input: origin + pathname });
      await until(() => page().getURL() === origin + pathname && !page().isLoadingMainFrame(), 'document ' + pathname);
      await current.flush();
    };
    const startDownload = async pathname => {
      await page().executeJavaScript('(()=>{const a=document.createElement("a");a.href=' + JSON.stringify(origin + pathname) + ';document.body.append(a);a.click();a.remove();})()', true);
    };
    const completed = async name => {
      await until(() => current.downloads.list(workspaceId).some(row => row.name === name && row.status === 'completed'), 'completed ' + name);
      await current.flush(); return current.downloads.list(workspaceId).find(row => row.name === name);
    };
    await load('/public-page'); await startDownload('/completed');
    const publicRow = await completed('public-notes.txt');
    assert.equal((await journal()).records.length, 1);
    assert.equal((await journal()).records[0].state, 'completed');
    assert.equal(JSON.stringify(publicRow).includes(runRoot), false);
    assert.equal(JSON.stringify(publicRow).includes('identityId'), false);
    assert.equal((await fs.stat(journalFile)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(journalFile))).mode & 0o077, 0);
    await check('actual native attachment completes into owner-only persistent history with private files and no paths or native resume state in chrome');

    await current.act({ type: 'privacy.enter', workspaceId });
    await load('/private-page'); await startDownload('/private'); await completed('private-only.txt');
    await current.act({ type: 'privacy.resume', workspaceId });
    await startDownload('/after-resume'); await completed('private-after-resume.txt');
    const afterPrivate = await fs.readFile(journalFile, 'utf8');
    assert.equal(afterPrivate.includes('private-only'), false); assert.equal(afterPrivate.includes('private-after-resume'), false);
    assert.deepEqual((await journal()).records.map(row => row.id), [publicRow.id]);
    await check('private-takeover downloads and attachment navigation after Resume never enter saved history while prior public history remains');

    await load('/fresh-public-page');
    const initiatingTab = tabId, initiatingPage = page();
    await startDownload('/slow-close');
    await until(() => current.downloads.list(workspaceId).some(row => row.name === 'public-after-close.bin' && row.receivedBytes > 0), 'public slow DownloadItem');
    const replacementId = await current.act({ type: 'tab.create', workspaceId, input: origin + '/replacement', activate: false });
    await current.act({ type: 'tab.close', tabId: initiatingTab }); assert.equal(initiatingPage.isDestroyed(), true);
    tabId = replacementId;
    await current.act({ type: 'tab.select', tabId });
    await until(() => !page().isLoadingMainFrame(), 'replacement page');
    const afterClose = await completed('public-after-close.bin');
    assert.ok((await journal()).records.some(row => row.id === afterClose.id && row.state === 'completed'));
    await check('a fresh public document restores download eligibility and an already accepted public transfer persists after its initiating native tab closes');

    await load('/public-restart-page'); await startDownload('/slow-restart');
    await until(() => current.downloads.list(workspaceId).some(row => row.name === 'public-stopped.bin' && row.receivedBytes > 0 && row.canCancel), 'native in-flight restart snapshot');
    await current.flush();
    const activeBytes = await fs.readFile(journalFile), activeState = decodeDownloadJournal(activeBytes);
    const active = activeState.records.find(row => row.name === 'public-stopped.bin');
    assert.equal(active.state, 'active'); assert.ok(active.receivedBytes > 0); assert.equal(active.completedPath, null);
    report.activeSnapshot = { sha256: digest(activeBytes), state: active.state, receivedBytes: active.receivedBytes,
      capturedFromNativeDownloadItem: true, restoredAfterAcknowledgedShutdown: true };
    const otherId = await current.act({ type: 'workspace.create', name: 'Other downloads fixture', kind: 'project' });
    assert.deepEqual(current.snapshot().downloads, []);
    assert.deepEqual(current.downloads.list(otherId), []);
    await current.act({ type: 'workspace.select', workspaceId }); await current.flush();
    await timed(current.close(), 'first disposable app shutdown'); assert.equal(current.downloads.activeCount, 0);
    // Restore only captured synthetic bytes inside this fixture-owned root.
    // Native transfers have been acknowledged cancelled; no process is left alive.
    await fs.writeFile(journalFile, activeBytes, { mode: 0o600 });
    await check('native active-transfer snapshot contains no resume authority, and another workspace sees none of the original workspace download rows');

    assert.match(path.basename(runRoot), /^od-[A-Za-z0-9]{6}$/);
    const ownedSystemProof = current.testSystemProof;
    restartRun = ownedSystemProof.createRunRoot();
    await fs.chmod(restartRun, 0o700); restartStarted = true;
    const requestCounts = [...requests], revealed = [];
    current = await timed(createDesktopApp({ projectRoot, dataRoot, runRoot: restartRun, show: false, enableMicrophone: false,
      ownedSystemProof, systemLifecycle: ownedSystemProof.createLifecycle(),
      persistentProfiles: false, testCloseDecision: async () => true, testRevealFile: file => { revealed.push(file); },
      testDownloadSavePath: ({ name }) => path.join(runRoot, 'downloads', name) }), 'serial app restart', 15000);
    await until(() => current.window.webContents.executeJavaScript('!!document.getElementById("show-downloads")'), 'restored chrome');
    if (current.snapshot().metadata.activeWorkspaceId !== workspaceId) await uiAct({ type: 'workspace.select', workspaceId });
    const restored = current.snapshot().downloads;
    assert.equal(restored.length, 3); assert.ok(restored.every(row => row.restored && !row.canResume && !row.canCancel));
    assert.equal(current.downloads.activeCount, 0);
    assert.equal(restored.find(row => row.id === active.id).status, 'interrupted');
    assert.ok(restored.filter(row => row.status === 'completed').length === 2);
    assert.equal(JSON.stringify(restored).includes('private-only'), false);
    assert.equal(JSON.stringify(restored).includes(runRoot), false);
    assert.deepEqual([...requests], requestCounts);
    assert.equal(current.snapshot().downloadHistory.available, true);
    await check('serial app restart restores completed rows and captured active work as terminal interrupted records without automatic network requests, native items or resume controls');

    await current.window.webContents.executeJavaScript('document.getElementById("show-downloads").click()');
    await until(() => current.window.webContents.executeJavaScript('!document.getElementById("downloads-panel").hidden&&document.getElementById("download-results").children.length===3'), 'restored downloads panel');
    assert.equal(await current.window.webContents.executeJavaScript('document.getElementById("download-results").textContent.includes("Earlier session")'), true);
    await uiAct({ type: 'download.reveal', workspaceId, downloadId: publicRow.id });
    const selected = path.join(runRoot, 'downloads', 'public-notes.txt');
    assert.deepEqual(revealed, [selected]);
    await fs.rename(selected, selected + '.original'); await fs.writeFile(selected, 'synthetic replacement');
    const denied = await current.window.webContents.executeJavaScript('window.caddi.action(' +
      JSON.stringify({ type: 'download.reveal', workspaceId, downloadId: publicRow.id }) + ')');
    assert.equal(denied.ok, false); assert.equal(revealed.length, 1);
    assert.ok(JSON.stringify(denied).includes('DOWNLOAD_FILE_CHANGED'));
    await current.window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
    try {
      const pixels = await timed(current.window.webContents.capturePage(), 'restored download chrome pixels', 3000);
      await fs.writeFile(path.join(proof, 'restored-downloads-chrome.png'), pixels.toPNG(), { mode: 0o600 });
      report.screenshots = [{ file: 'restored-downloads-chrome.png', available: true }];
    } catch { report.screenshots = [{ file: 'restored-downloads-chrome.png', available: false }]; }
    await uiAct({ type: 'download.control', workspaceId, downloadId: active.id, operation: 'dismiss' }); await current.flush();
    assert.equal((await journal()).records.some(row => row.id === active.id), false);
    await check('actual restored-download controls label earlier sessions, reveal only the verified selected file, reject a replacement and persist explicit dismissal');

    assert.ok(report.bounds.maxConcurrentWindows <= report.bounds.fixtureMaxConcurrentWindows);
    assert.ok(report.bounds.windowLifetimes <= report.bounds.fixtureMaxWindowLifetimes);
    report.requests = Object.fromEntries(requests);
    report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.status = 'passed'; await save();
    console.log('DOWNLOAD_HISTORY_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
  } catch (error) {
    report.status = 'failed'; report.error = { code: error?.code ?? 'DOWNLOAD_HISTORY_ASSERTION',
      message: String(error?.message ?? error).slice(0, 900), stack: String(error?.stack ?? '').slice(0, 5000) };
    await save(); throw error;
  } finally {
    clearTimeout(deadline); app.off('browser-window-created', onWindow);
    let restartClosed = false;
    if (current !== browser) { await current.close(); restartClosed = true; }
    if (restartRun && (!restartStarted || restartClosed)) {
      await fs.rm(restartRun, { recursive: true, force: true });
      report.restartDirectoryCleanup = 'completed'; await save();
    }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}

