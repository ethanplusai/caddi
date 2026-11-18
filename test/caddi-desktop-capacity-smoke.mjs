// Separate disposable capacity proof: one project identity, one synthetic form,
// and blank pages. This does not repeat or recertify the 20-workspace workload.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { app } from 'electron';
import { DESKTOP_RESOURCE_POLICY } from '../src/caddi/desktop/resources.mjs';

const MAX_RUN_MS = 100000, OPERATION_TIMEOUT_MS = 5000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
async function sourceEvidence(projectRoot) {
  const files = [];
  async function walk(relative) {
    for (const item of (await fs.readdir(path.join(projectRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, item.name);
      if (item.isSymbolicLink()) fail('CAPACITY_SOURCE_SYMLINK');
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) { const data = await fs.readFile(path.join(projectRoot, name)); files.push({ path: name, bytes: data.length, sha256: hash(data) }); }
      if (files.length > 1024) fail('CAPACITY_SOURCE_LIMIT');
    }
  }
  await walk('src/caddi');
  for (const name of ['package.json', 'package-lock.json', 'test/caddi-desktop-capacity-smoke.mjs']) {
    const data = await fs.readFile(path.join(projectRoot, name)); files.push({ path: name, bytes: data.length, sha256: hash(data) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: hash(JSON.stringify(files)), files,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', timeout: 2000 }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', timeout: 2000 }).trim() };
}

export async function runDesktopCapacitySmoke(browser, { projectRoot, runRoot }) {
  const began = performance.now(), controller = new AbortController();
  const proofParent = path.join(projectRoot, '.test-artifacts', 'caddi-capacity-proof');
  await fs.mkdir(proofParent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(proofParent, 'run-')); await fs.chmod(proof, 0o700);
  const reportPath = path.join(proof, 'report.json');
  const report = { format: 'caddi-native-capacity-smoke-v1', status: 'running', startedAt: new Date().toISOString(),
    policy: { maximumRunMs: MAX_RUN_MS, operationTimeoutMs: OPERATION_TIMEOUT_MS,
      maximumEventLoopStallMs: 1000, resources: DESKTOP_RESOURCE_POLICY },
    environment: { platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion(),
      electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    workload: { projectIdentities: 1, targetResidentPages: 32, realAgentConnections: 0,
      syntheticFormPages: 1, otherPages: 'about:blank', persistentProfiles: false, externalServices: false,
      automaticEviction: false, automaticPageWaiting: false },
    limits: ['One project identity and mostly blank pages; not the earlier 20-identity workload.',
      'Resource extrema are sampled process sums; shared memory may be counted across different processes.',
      'This hidden fixture verifies metadata selection and form retention, not physical focus or keyboard latency.',
      'The resource policy, resident-page limit and all timeouts remain unchanged.'],
    checks: [], resources: [], maximumEventLoopStallMs: 0, progress: {} };
  const recordedSamples = new Set(), watched = new Set(), removeListeners = [];
  let checkpoint = 'preflight', server, resourceWatch, lastTick = performance.now(), finished = false;
  const save = async () => { report.elapsedMs = Math.round(performance.now() - began); report.checkpoint = checkpoint;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
  function stop(code) { if (!controller.signal.aborted) { const error = new Error(code); error.code = code; controller.abort(error); } }
  const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  void cancelled.catch(() => {});
  async function bounded(promise, label, timeoutMs = OPERATION_TIMEOUT_MS) {
    checkpoint = label; if (controller.signal.aborted) throw controller.signal.reason;
    let timeout;
    try { return await Promise.race([promise, cancelled, new Promise((_, reject) => {
      timeout = setTimeout(() => { const error = new Error('CAPACITY_OPERATION_TIMEOUT'); error.code = 'CAPACITY_OPERATION_TIMEOUT'; reject(error); }, timeoutMs);
    })]); } finally { clearTimeout(timeout); }
  }
  async function until(test, label) {
    const deadline = performance.now() + OPERATION_TIMEOUT_MS;
    while (performance.now() < deadline) { if (await bounded(Promise.resolve().then(test), label)) return; await bounded(pause(20), label); }
    fail('CAPACITY_OPERATION_TIMEOUT');
  }
  const deadline = setTimeout(() => stop('CAPACITY_DURATION_LIMIT'), MAX_RUN_MS);
  const pulse = setInterval(() => { const stamp = performance.now(), lag = Math.max(0, stamp - lastTick - 250); lastTick = stamp;
    report.maximumEventLoopStallMs = Math.max(report.maximumEventLoopStallMs, lag); if (lag > 1000) stop('CAPACITY_EVENT_LOOP_STALL'); }, 250);
  const residentPages = () => browser.getState().workspaces.flatMap(workspace => browser.engine.workspaceActivity(workspace.id).pages.map(page => ({ workspaceId: workspace.id, ...page })));
  const selection = () => { const state = browser.getState(); return JSON.stringify({ activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map(workspace => [workspace.id, workspace.activeGroupId]),
    groups: state.groups.map(group => [group.id, group.activeTabId, group.activeLayoutId]), layouts: state.layouts }); };
  function recordResource(state, label) {
    if (!state?.sample || recordedSamples.has(state.sample.sampledAt)) return;
    recordedSamples.add(state.sample.sampledAt);
    const pages = residentPages(), sample = { label, elapsedMs: Math.round(performance.now() - began), ...state.sample,
      residentPageCount: pages.length, residentWorkspaceCount: new Set(pages.map(page => page.workspaceId)).size,
      healthy: state.healthy, reason: state.reason };
    report.resources.push(sample);
    report.sampledResourceExtrema ??= { workingSetSumBytes: 0, processCount: 0, rendererCount: 0, cpuPercentSum: 0,
      minimumFreePlusSpeculativeBytes: sample.freePlusSpeculativeBytes, minimumDiskAvailableBytes: sample.diskAvailableBytes };
    for (const key of ['workingSetSumBytes', 'processCount', 'rendererCount', 'cpuPercentSum'])
      report.sampledResourceExtrema[key] = Math.max(report.sampledResourceExtrema[key], sample[key]);
    report.sampledResourceExtrema.minimumFreePlusSpeculativeBytes = Math.min(report.sampledResourceExtrema.minimumFreePlusSpeculativeBytes, sample.freePlusSpeculativeBytes);
    report.sampledResourceExtrema.minimumDiskAvailableBytes = Math.min(report.sampledResourceExtrema.minimumDiskAvailableBytes, sample.diskAvailableBytes);
  }
  async function resources(label) {
    const state = await bounded(browser.resources.sample(), 'resources-' + label); recordResource(state, label);
    if (!state.healthy) fail(state.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE');
    report.progress.residentPages = residentPages().length; await save(); return state.sample;
  }
  function watch(wc) { if (watched.has(wc.id)) return; watched.add(wc.id);
    const lost = () => stop('CAPACITY_RENDERER_LOST'); wc.on('render-process-gone', lost); removeListeners.push(() => wc.removeListener('render-process-gone', lost)); }
  async function check(name) { report.checks.push(name); console.log('CAPACITY_PASS ' + name); await save(); }
  try {
    const initial = browser.getState();
    if (app.isPackaged || !process.argv.includes('--caddi-capacity-smoke') || browser.window.isVisible() ||
        browser.snapshot().development.sessions !== 'temporary' || initial.workspaces.length > 2 ||
        initial.tabs.some(tab => tab.url !== 'about:blank') || browser.access.connections().length || !browser.resources?.preflight)
      fail('CAPACITY_DISPOSABLE_APP_REQUIRED');
    const info = await fs.lstat(runRoot), realRoot = await fs.realpath(runRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
        realRoot !== runRoot || !runRoot.startsWith(path.join(projectRoot, '.test-artifacts') + path.sep) ||
        !browser.access.enrollmentSocket.startsWith(runRoot + path.sep)) fail('CAPACITY_PRIVATE_RUN_REQUIRED');
    report.sourceBefore = await bounded(sourceEvidence(projectRoot), 'source-before');
    try { await bounded(browser.resources.preflight(), 'resource-preflight', 8000); }
    finally { recordResource(browser.resources.snapshot(), 'preflight'); }
    const baseline = await resources('baseline');
    report.workload.initialResidentPages = residentPages().length;
    report.initialProcesses = { processCount: baseline.processCount, rendererCount: baseline.rendererCount, workingSetSumBytes: baseline.workingSetSumBytes };
    resourceWatch = setInterval(() => { const state = browser.resources.snapshot(); recordResource(state, 'periodic');
      if (!state.healthy) stop(state.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE'); }, 250);
    watch(browser.window.webContents);
    const workspace = initial.workspaces.find(item => item.kind === 'project'); assert.ok(workspace);
    await bounded(browser.act({ type: 'workspace.select', workspaceId: workspace.id }), 'select-project');
    const originalGroupId = browser.getState().workspaces.find(item => item.id === workspace.id).activeGroupId;
    const formTab = browser.getState().tabs.find(item => item.workspaceId === workspace.id && item.groupId === originalGroupId && item.status === 'open'); assert.ok(formTab);
    server = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/form') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
      response.end('<!doctype html><title>Caddi capacity proof</title><label>Unsubmitted synthetic draft<input id="draft" value="initial"></label><script>window.capacityMarker="original-document";addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue=""});</script>');
    });
    server.listen(0, '127.0.0.1'); await bounded(once(server, 'listening'), 'fixture-listen');
    const origin = 'http://127.0.0.1:' + server.address().port; report.fixtureOrigin = origin;
    await bounded(browser.act({ type: 'navigate', tabId: formTab.id, input: origin + '/form' }), 'load-protected-form');
    const form = browser.engine.getView({ workspaceId: workspace.id, tabId: formTab.id }).webContents; watch(form);
    await until(() => !form.isLoading() && form.getTitle() === 'Caddi capacity proof', 'form-ready');
    await bounded(form.executeJavaScript('document.getElementById("draft").value="capacity-unsaved-synthetic";document.getElementById("draft").dispatchEvent(new Event("input",{bubbles:true}));'), 'fill-synthetic-draft');
    const verifyForm = async () => { assert.equal(form.isDestroyed(), false);
      const value = await bounded(form.executeJavaScript('({value:document.getElementById("draft").value,marker:window.capacityMarker})'), 'verify-protected-form');
      assert.deepEqual(value, { value: 'capacity-unsaved-synthetic', marker: 'original-document' }); };
    async function emptyGroup(name) {
      const groupId = await bounded(browser.act({ type: 'group.create', workspaceId: workspace.id, name }), 'create-empty-group');
      const tabs = [];
      for (let index = 0; index < 2; index++) tabs.push(await bounded(browser.act({ type: 'tab.create', workspaceId: workspace.id, input: 'about:blank', activate: false }), 'create-unloaded-pane'));
      await bounded(browser.act({ type: 'group.select', groupId: originalGroupId }), 'restore-original-group');
      assert.equal(tabs.some(tabId => residentPages().some(page => page.tabId === tabId)), false);
      return { groupId, tabs };
    }
    const splitGroup = await emptyGroup('Prepared capacity split');
    await bounded(browser.act({ type: 'split.toggle', tabId: splitGroup.tabs[0] }), 'prepare-inactive-split');
    assert.equal(browser.getState().workspaces.find(item => item.id === workspace.id).activeGroupId, originalGroupId);
    assert.equal(splitGroup.tabs.some(tabId => residentPages().some(page => page.tabId === tabId)), false);
    const plainGroup = await emptyGroup('Unmaterialized capacity split');
    const blanks = [];
    for (let index = 0; index < 33; index++) blanks.push(await bounded(browser.act({ type: 'tab.create', workspaceId: workspace.id,
      input: 'about:blank', activate: false }), 'create-blank-metadata'));
    assert.equal(residentPages().length, report.workload.initialResidentPages);
    const loaded = [];
    async function materialize(tabId) {
      await bounded(browser.act({ type: 'tab.select', tabId }), 'materialize-blank');
      await until(() => residentPages().some(page => page.tabId === tabId && page.ready && !page.busy), 'blank-ready');
      const wc = browser.engine.getView({ workspaceId: workspace.id, tabId }).webContents; watch(wc); loaded.push({ tabId, wc });
      await resources('resident-' + residentPages().length);
    }
    for (const tabId of blanks) { if (residentPages().length >= 31) break; await materialize(tabId); }
    assert.equal(residentPages().length, 31); await verifyForm();
    await check('31 actual resident pages retain the original synthetic form in one project identity');
    async function refusal(action, label, expectedResident = 31) {
      const before = selection(); let code = null;
      try { await bounded(browser.act(action), label); } catch (error) { code = error?.code; }
      assert.equal(code, 'PAGE_CAPACITY'); assert.equal(selection(), before); assert.equal(residentPages().length, expectedResident);
      for (const page of loaded) assert.equal(page.wc.isDestroyed(), false);
      await verifyForm(); return code;
    }
    report.groupRefusal = await refusal({ type: 'group.select', groupId: splitGroup.groupId }, 'two-pane-group-refusal');
    assert.equal(splitGroup.tabs.some(tabId => residentPages().some(page => page.tabId === tabId)), false);
    await check('group selection requiring two unloaded panes refuses atomically with one resident slot left');
    await bounded(browser.act({ type: 'group.select', groupId: plainGroup.groupId }), 'select-empty-split-group');
    report.splitRefusal = await refusal({ type: 'split.toggle', tabId: plainGroup.tabs[0] }, 'two-pane-split-refusal');
    assert.equal(plainGroup.tabs.some(tabId => residentPages().some(page => page.tabId === tabId)), false);
    await check('creating a two-pane split refuses atomically with one resident slot left');
    await bounded(browser.act({ type: 'group.select', groupId: originalGroupId }), 'restore-main-group');
    const nextBlank = blanks.find(tabId => !residentPages().some(page => page.tabId === tabId)); assert.ok(nextBlank); await materialize(nextBlank);
    assert.equal(residentPages().length, 32); await verifyForm();
    await check('32 real resident pages coexist without eviction or form loss');
    const blockedTab = blanks.find(tabId => !residentPages().some(page => page.tabId === tabId)); assert.ok(blockedTab);
    report.hardRefusal = await refusal({ type: 'tab.select', tabId: blockedTab }, 'thirty-third-page-refusal', 32);
    assert.equal(residentPages().some(page => page.tabId === blockedTab), false);
    await check('33rd page is refused without changing selection, layouts or existing pages');
    const disposable = loaded.at(-1);
    await bounded(browser.act({ type: 'tab.close', tabId: disposable.tabId }), 'explicit-disposable-close');
    await until(() => residentPages().length === 31 && disposable.wc.isDestroyed(), 'disposable-close-acknowledged');
    await verifyForm(); await resources('after-explicit-close');
    await materialize(blockedTab); assert.equal(residentPages().length, 32); await verifyForm();
    await check('explicit disposable close reclaims one slot and an explicit retry succeeds');
    await bounded(browser.act({ type: 'tab.select', tabId: formTab.id }), 'restore-form-selection');
    await verifyForm(); await resources('final');
    report.workload.finalResidentPages = residentPages().length;
    report.workload.finalResidentWorkspaceIdentities = new Set(residentPages().map(page => page.workspaceId)).size;
    report.workload.totalMetadataRecords = browser.getState().tabs.length;
    report.sourceAfter = await bounded(sourceEvidence(projectRoot), 'source-after');
    if (report.sourceBefore.sha256 !== report.sourceAfter.sha256) fail('CAPACITY_SOURCE_CHANGED');
    report.status = 'passed'; finished = true;
  } catch (error) {
    report.status = 'failed'; report.failure = { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'CAPACITY_ASSERTION_FAILED', checkpoint };
    stop(report.failure.code);
  } finally {
    clearTimeout(deadline); clearInterval(pulse); clearInterval(resourceWatch);
    for (const remove of removeListeners) remove();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (!report.sourceAfter) { try { report.sourceAfter = await sourceEvidence(projectRoot); } catch {} }
    report.finishedAt = new Date().toISOString(); report.reportPath = reportPath; await save();
  }
  console.log('CADDI_CAPACITY_REPORT ' + reportPath);
  if (!finished) fail(report.failure?.code ?? 'CAPACITY_FAILED');
  console.log('CADDI_CAPACITY_SMOKE_OK ' + report.checks.length + ' checks; one project identity; 32 resident-page boundary');
  return report;
}
