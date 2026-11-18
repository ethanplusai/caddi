// One bounded hidden development app; synthetic loopback links only.
// DOM controls exercise trusted chrome IPC, not real native keyboard/focus.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  throw new Error('Timed out: ' + label);
}
async function sourceInventory(projectRoot) {
  const files = ['package.json', 'package-lock.json', 'test/caddi-desktop-external-links-smoke.mjs'];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await walk(file);
      else { assert.ok(entry.isFile()); files.push(file); }
    }
  }
  await walk('src/caddi'); files.sort();
  return Promise.all(files.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(projectRoot, file))).digest('hex') })));
}
export async function runDesktopExternalLinksSmoke(browser, { projectRoot, runRoot, externalLinks }) {
  assert.ok(process.argv.includes('--caddi-external-links-smoke') && !app.isPackaged);
  assert.equal(browser.snapshot().development.sessions, 'temporary');
  assert.equal(browser.window.isVisible(), false);
  const started = Date.now(), focusBefore = BrowserWindow.getFocusedWindow()?.id ?? null;
  const initial = browser.getState(), initialWorkspace = initial.activeWorkspaceId;
  const target = initial.workspaces.find(item => item.id !== initialWorkspace && item.lifecycle?.status !== 'archived');
  assert.ok(target, 'fixture has a second isolated workspace');
  const initialAuthority = JSON.stringify(browser.access.connections());
  const report = { format: 'caddi-external-links-smoke-v1', startedAt: new Date().toISOString(), status: 'running', checks: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform },
    limits: ['Synthetic loopback only; no OS handler registration or default-browser change.',
      'Hidden chrome DOM controls and exact IPC; no real keyboard/focus or external-application compatibility claim.'] };
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-external-links-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(parent, 'run-')), reportPath = path.join(proof, 'report.json');
  await fs.chmod(proof, 0o700);
  let server, deadlineExpired = false, requests = 0, protectedAtRequest = true;
  const deadline = setTimeout(() => { deadlineExpired = true; server?.closeAllConnections(); }, 45_000);
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const check = async name => {
    assert.equal(deadlineExpired, false, 'bounded external-link deadline');
    assert.equal(browser.window.isVisible(), false, 'inspection remains hidden');
    assert.equal(BrowserWindow.getFocusedWindow()?.id ?? null, focusBefore, 'no native focus change');
    report.checks.push(name); report.elapsedMs = Date.now() - started; console.log('EXTERNAL_LINK_PASS ' + name); await save();
  };
  const chrome = browser.window.webContents;
  const action = async input => {
    const result = await chrome.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')');
    assert.equal(result.ok, true, result.code); return result.result;
  };
  try {
    const info = await fs.lstat(runRoot);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700);
    report.sourceBefore = await sourceInventory(projectRoot); await save();
    const initialName = initial.workspaces.find(item => item.id === initialWorkspace).name;
    await until(() => chrome.executeJavaScript('!!window.caddi && document.getElementById("workspace-title").textContent===' + JSON.stringify(initialName)), 'trusted review controls ready');
    server = http.createServer((_request, response) => {
      requests++;
      protectedAtRequest &&= browser.privacy.getPrivacyState(target.id).blocked === true;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      response.end('<!doctype html><title>External link fixture</title><h1 id="external-proof">Explicitly opened</h1>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const first = origin + '/first?code=caddi-external-proof-A', second = origin + '/second?code=caddi-external-proof-B';
    assert.equal(externalLinks.intake(first).accepted, true);
    assert.equal(externalLinks.intakeArguments(['Caddi', second]).accepted, 1);
    assert.equal(externalLinks.intake(first).code, 'EXTERNAL_LINK_DUPLICATE');
    await pause(60);
    assert.equal(requests, 0); assert.equal(browser.getState().activeWorkspaceId, initialWorkspace);
    assert.equal(JSON.stringify(browser.snapshot()).includes('caddi-external-proof'), false);
    await check('startup/live-style intake stays queued without navigation, authority, or URL-bearing snapshots');

    await chrome.executeJavaScript('document.getElementById("external-links").click();true');
    await until(() => chrome.executeJavaScript('document.getElementById("external-links-dialog").open && document.querySelectorAll(".external-link-card").length===2'), 'owner review lists two links');
    assert.equal(await chrome.executeJavaScript('[...document.querySelectorAll(".external-link-card select")].every(n=>n.value==="")'), true);
    assert.equal(await chrome.executeJavaScript('[...document.querySelectorAll("[data-external-open]")].every(n=>n.disabled)'), true);
    assert.equal(requests, 0);
    const forms = await chrome.executeJavaScript('[...document.querySelectorAll(".external-link-card")].map(n=>({id:n.dataset.externalLinkId,url:n.querySelector("code").textContent}))');
    const firstId = forms.find(item => item.url === first).id;
    const priorTabIds = new Set(browser.getState().tabs.map(item => item.id));
    await chrome.executeJavaScript('(()=>{const f=[...document.querySelectorAll(".external-link-card")].find(n=>n.dataset.externalLinkId===' + JSON.stringify(firstId) + ');f.elements.workspaceId.value=' + JSON.stringify(target.id) + ';f.elements.workspaceId.dispatchEvent(new Event("change",{bubbles:true}));f.requestSubmit();})()');
    await until(() => browser.getState().tabs.some(item => item.workspaceId === target.id && !priorTabIds.has(item.id)), 'explicit target tab committed');
    const opened = browser.getState().tabs.find(item => item.workspaceId === target.id && !priorTabIds.has(item.id));
    await until(async () => {
      try { return await browser.engine.getView({ workspaceId: target.id, tabId: opened.id }).webContents.executeJavaScript('!!document.getElementById("external-proof")'); }
      catch { return false; }
    }, 'loopback page ready');
    await until(() => chrome.executeJavaScript('!document.getElementById("external-links-dialog").open'), 'review closes after explicit open');
    assert.equal(protectedAtRequest, true); assert.ok(requests >= 1);
    assert.equal(browser.privacy.getPrivacyState(target.id).blocked, true);
    assert.equal(JSON.stringify(browser.access.connections()), initialAuthority);
    assert.equal(externalLinks.summary().pending, 1);
    assert.equal(browser.engine.navigation({ workspaceId: target.id, tabId: opened.id }).url, first);
    assert.equal(browser.getState().tabs.find(item => item.id === opened.id).url, 'about:blank', 'private imported URL is not saved as ordinary metadata');
    await check('owner chooses a workspace; private takeover precedes the first request and no agent scope is created');

    await browser.act({ type: 'workspace.select', workspaceId: initialWorkspace });
    const projected = await chrome.executeJavaScript('window.caddi.getState()');
    assert.equal(JSON.stringify(projected).includes('caddi-external-proof-A'), false);
    assert.ok(browser.getState().tabs.some(item => item.id === opened.id));
    assert.equal(browser.engine.navigation({ workspaceId: target.id, tabId: opened.id }).url, first);
    const review = await action({ type: 'external-links.review' });
    await browser.act({ type: 'workspace.select', workspaceId: target.id });
    await browser.act({ type: 'workspace.select', workspaceId: initialWorkspace });
    const stale = await chrome.executeJavaScript('window.caddi.action(' + JSON.stringify({ type: 'external-links.open',
      reviewId: review.reviewId, linkId: review.links[0].id, workspaceId: target.id }) + ')');
    assert.equal(stale.ok, false); assert.equal(stale.code, 'EXTERNAL_LINK_REVIEW_STALE');
    assert.equal(externalLinks.summary().pending, 1);
    await check('unrelated workspace projection excludes opened link data and away-and-back selection cannot revive a review');

    await action({ type: 'external-links.close', reviewId: review.reviewId });
    await until(() => chrome.executeJavaScript('document.getElementById("workspace-title").textContent===' + JSON.stringify(initialName) + ' && document.getElementById("external-links-dialog").getAttribute("aria-busy")!=="true"'), 'owner workspace projection settled before next review');
    await chrome.executeJavaScript('document.getElementById("external-links").click();true');
    await until(() => chrome.executeJavaScript('document.getElementById("external-links-dialog").open && document.querySelectorAll(".external-link-card").length===1'), 'remaining link review');
    const beforeDismiss = requests;
    await chrome.executeJavaScript('document.querySelector(".external-link-card button[type=button]").click();true');
    await until(() => externalLinks.summary().pending === 0, 'link dismissed');
    assert.equal(requests, beforeDismiss);
    await until(() => chrome.executeJavaScript('!document.getElementById("close-external-links").disabled'), 'review ready to close');
    await chrome.executeJavaScript('document.getElementById("close-external-links").click();true');
    await until(() => chrome.executeJavaScript('!document.getElementById("external-links-dialog").open'), 'empty review closes');
    await check('dismiss removes only the reviewed pending link without navigation');

    await browser.act({ type: 'workspace.select', workspaceId: target.id });
    const current = browser.getState().workspaces.find(item => item.id === browser.getState().activeWorkspaceId);
    const folderId = await browser.act({ type: 'folder.create', groupId: current.activeGroupId, name: 'Undo proof', parentId: null });
    await browser.act({ type: 'tab.move', tabId: opened.id, groupId: current.activeGroupId, folderId });
    const remove = await browser.act({ type: 'folder.remove', folderId });
    assert.equal(remove.removed, true); assert.equal(remove.undoAvailable, true);
    await until(() => chrome.executeJavaScript('!document.getElementById("undo-folder-removal").hidden'), 'folder undo appears');
    await chrome.executeJavaScript('document.getElementById("undo-folder-removal").click();true');
    await until(() => browser.getState().folders.some(item => item.id === folderId), 'folder restored by owner control');
    assert.equal(browser.getState().tabs.find(item => item.id === opened.id).folderId, folderId);
    assert.equal(browser.getState().tabs.find(item => item.id === opened.id).url, 'about:blank');
    assert.equal(browser.engine.navigation({ workspaceId: target.id, tabId: opened.id }).url, first);
    assert.equal(browser.engine.getView({ workspaceId: target.id, tabId: opened.id }).webContents.isDestroyed(), false);
    await check('folder undo restores organization through chrome without replacing the live page or its URL');

    report.sourceAfter = await sourceInventory(projectRoot);
    assert.deepEqual(report.sourceAfter, report.sourceBefore, 'source stayed unchanged during the bounded run');
    report.sourceDigest = createHash('sha256').update(JSON.stringify(report.sourceBefore)).digest('hex');
    report.status = 'passed'; await save(); console.log('CADDI_EXTERNAL_LINKS_SMOKE_OK ' + report.checks.length + ' checks');
  } catch (error) {
    report.status = 'failed'; report.failure = { code: error.code ?? null, message: String(error.message).slice(0, 2000) };
    try {
      report.failureUi = await chrome.executeJavaScript('({dialogOpen:document.getElementById("external-links-dialog").open,busy:document.getElementById("external-links-dialog").getAttribute("aria-busy"),linkCards:document.querySelectorAll(".external-link-card").length,status:document.getElementById("external-links-status").textContent,workspace:document.getElementById("workspace-title").textContent,queueCount:document.getElementById("external-links-count").textContent,openDialogs:[...document.querySelectorAll("dialog[open]")].map(n=>n.id)})');
    } catch {}
    await save(); throw error;
  } finally {
    clearTimeout(deadline); server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    console.log('EXTERNAL_LINK_REPORT ' + reportPath);
  }
}
