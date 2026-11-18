// Bounded native qualification of 160 project metadata tabs, 20 lightweight
// pages, actual operation admission and real scoped MCP connections. The
// separate capacity phase reaches 32 resident pages using disposable blanks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { app } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { DESKTOP_RESOURCE_POLICY } from '../src/caddi/desktop/resources.mjs';

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const TIERS = Object.freeze([1, 2, 4, 8, 12, 20]);
const MAX_RUN_MS = 100000, OPERATION_TIMEOUT_MS = 5000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const p95 = samples => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? null;
const completed = receipt => { if (receipt?.status !== 'completed') fail('SCALE_MCP_OPERATION_REJECTED'); return receipt.result; };

async function sourceEvidence(projectRoot) {
  const files = [];
  async function walk(relative) {
    for (const entry of (await fs.readdir(path.join(projectRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) fail('SCALE_SOURCE_SYMLINK');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(projectRoot, name));
        files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
      }
      if (files.length > 1024) fail('SCALE_SOURCE_CAPACITY');
    }
  }
  await walk('src/caddi');
  for (const name of ['package.json', 'package-lock.json', 'test/caddi-desktop-scale-smoke.mjs']) {
    const bytes = await fs.readFile(path.join(projectRoot, name));
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: hash(JSON.stringify(files)), files,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', timeout: 2000 }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', timeout: 2000 }).trim() };
}

export async function runDesktopScaleSmoke(browser, { projectRoot, runRoot }) {
  const started = performance.now(), startedAt = new Date().toISOString();
  const controller = new AbortController(), clients = [], fixtures = [], listeners = [];
  const proofParent = path.join(projectRoot, '.test-artifacts', 'caddi-scale-proof');
  await fs.mkdir(proofParent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(proofParent, 'run-'));
  await fs.chmod(proof, 0o700);
  const reportPath = path.join(proof, 'report.json');
  const policy = {
    maximumRunMs: MAX_RUN_MS, operationTimeoutMs: OPERATION_TIMEOUT_MS,
    maximumElectronWorkingSetSumBytes: Math.min(4 * GIB, Math.floor(os.totalmem() / 4)),
    minimumSystemFreePlusFileBackedBytes: 512 * MIB, minimumDiskAvailableBytes: 2 * GIB,
    resourcePolicy: DESKTOP_RESOURCE_POLICY,
    maximumEventLoopStallMs: 1000, maximumChromeRoundTripMs: 1000,
    diagnosticGoals: { chromeRoundTripP95Ms: 100, loadedWorkspaceSwitchP95Ms: 250 },
  };
  const report = { format: 'caddi-native-scale-smoke-v3', startedAt, status: 'running', policy,
    environment: { platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion(),
      electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      physicalMemoryBytes: os.totalmem(), logicalCpuCount: os.cpus().length },
    workload: { requestedProjectWorkspaces: 20, pagesPerProject: 1, metadataTabsPerProject: 8,
      requestedProjectMetadataTabs: 160, requestedAgentConnections: 20,
      tiers: [...TIERS], roundsPerTier: 2, fixturePagesCreated: 0, pairedAgents: 0,
      syntheticOnly: true, persistentProfiles: false, microphone: false, externalServices: false,
      schedulerIntegrated: true, pageEviction: false, pageCapacityWaiting: false },
    limits: ['160 metadata tabs with one lightweight resident fixture per project; not 160 simultaneously resident tabs.',
      'Brief concurrent scoped operations; not sustained active-agent capacity or a soak.',
      'Chrome round-trip is an IPC/DOM responsiveness proxy, not real keyboard-input latency.',
      'Electron working-set sum can double-count shared pages; this is a conservative process sum.',
      'System reserve uses displayed vm_stat free plus file-backed memory from the same snapshot. Free plus speculative remains diagnostic; it is not added to that estimate.',
      'Normal OS pressure and three healthy samples across one second are independent admission requirements.',
      'The hidden app verifies selected-workspace state and IPC, not physical keyboard/focus behavior on a locked desktop.',
      'At 32 resident pages further selection is refused; explicit owner close and retry are required.',
      'No real accounts, media devices, protected credentials, extensions, automatic page eviction or release qualification.'],
    checks: [], stages: [], resources: [], maximumEventLoopStallMs: 0 };
  let checkpoint = 'preflight', server, resourceWatch, lastTick = performance.now(), finished = false;
  let releaseHeldResponses = false;
  const heldResponses = [], requestCounts = new Map(), recordedResourceSamples = new Set();
  const save = async () => {
    report.elapsedMs = Math.round(performance.now() - started);
    report.checkpoint = checkpoint;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  };
  const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  void cancelled.catch(() => {});
  function stop(code) {
    if (!controller.signal.aborted) { const error = new Error(code); error.code = code; controller.abort(error); }
  }
  async function bounded(pending, label, timeoutMs = OPERATION_TIMEOUT_MS) {
    checkpoint = label;
    if (controller.signal.aborted) throw controller.signal.reason;
    let timer;
    try {
      return await Promise.race([pending, cancelled, new Promise((_, reject) => {
        timer = setTimeout(() => { const error = new Error('SCALE_OPERATION_TIMEOUT'); error.code = 'SCALE_OPERATION_TIMEOUT'; reject(error); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function until(test, label) {
    const end = performance.now() + OPERATION_TIMEOUT_MS;
    while (performance.now() < end) {
      if (await bounded(Promise.resolve().then(test), label)) return;
      await bounded(pause(20), label);
    }
    fail('SCALE_OPERATION_TIMEOUT');
  }
  const deadline = setTimeout(() => stop('SCALE_DURATION_LIMIT'), MAX_RUN_MS);
  const pulse = setInterval(() => {
    const time = performance.now(), lag = Math.max(0, time - lastTick - 250); lastTick = time;
    report.maximumEventLoopStallMs = Math.max(report.maximumEventLoopStallMs, lag);
    if (lag > policy.maximumEventLoopStallMs) stop('SCALE_EVENT_LOOP_STALL');
  }, 250);
  function recordResource(status, label) {
    if (!status?.sample || recordedResourceSamples.has(status.sample.sampledAt)) return;
    recordedResourceSamples.add(status.sample.sampledAt);
    const sample = { label, elapsedMs: Math.round(performance.now() - started), ...status.sample,
      healthy: status.healthy, reason: status.reason, consecutiveHealthy: status.consecutiveHealthy };
    report.resources.push(sample);
    report.sampledResourceExtrema ??= { workingSetSumBytes: 0, processCount: 0, rendererCount: 0,
      cpuPercentSum: 0, minimumFreePlusSpeculativeBytes: sample.freePlusSpeculativeBytes,
      minimumFileBackedBytes: sample.fileBackedBytes, minimumFreePlusFileBackedBytes: sample.freePlusFileBackedBytes,
      minimumDiskAvailableBytes: sample.diskAvailableBytes, maximumSampleDurationMs: 0 };
    for (const key of ['workingSetSumBytes', 'processCount', 'rendererCount', 'cpuPercentSum'])
      report.sampledResourceExtrema[key] = Math.max(report.sampledResourceExtrema[key], sample[key]);
    report.sampledResourceExtrema.minimumFreePlusSpeculativeBytes = Math.min(report.sampledResourceExtrema.minimumFreePlusSpeculativeBytes, sample.freePlusSpeculativeBytes);
    report.sampledResourceExtrema.minimumFileBackedBytes = Math.min(report.sampledResourceExtrema.minimumFileBackedBytes, sample.fileBackedBytes);
    report.sampledResourceExtrema.minimumFreePlusFileBackedBytes = Math.min(report.sampledResourceExtrema.minimumFreePlusFileBackedBytes, sample.freePlusFileBackedBytes);
    report.sampledResourceExtrema.minimumDiskAvailableBytes = Math.min(report.sampledResourceExtrema.minimumDiskAvailableBytes, sample.diskAvailableBytes);
    report.sampledResourceExtrema.maximumSampleDurationMs = Math.max(report.sampledResourceExtrema.maximumSampleDurationMs, sample.durationMs);
  }
  function resourceFailure(status) {
    if (!status?.healthy) return status?.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE';
    const sample = status.sample;
    if (status.policyId !== DESKTOP_RESOURCE_POLICY.id || DESKTOP_RESOURCE_POLICY.systemReserveMetric !== 'freePlusFileBackedBytes' ||
        !['freeBytes','fileBackedBytes','freePlusFileBackedBytes'].every(key => Number.isSafeInteger(sample?.[key]) && sample[key] >= 0) ||
        sample.freePlusFileBackedBytes !== sample.freeBytes + sample.fileBackedBytes) return 'SCALE_RESOURCE_METRIC_INVALID';
    if (sample.freePlusFileBackedBytes < policy.minimumSystemFreePlusFileBackedBytes) return 'RESOURCE_SYSTEM_RESERVE';
    return null;
  }
  async function resources(label) {
    const status = await bounded(browser.resources.sample(), 'resource-' + label);
    recordResource(status, label);
    const refusal = resourceFailure(status); if (refusal) fail(refusal);
    await save();
    return status.sample;
  }
  async function check(name) { report.checks.push(name); console.log('SCALE_PASS ' + name); await save(); }
  const watchPage = wc => {
    const lost = () => stop('SCALE_RENDERER_LOST');
    wc.on('render-process-gone', lost); listeners.push(() => wc.removeListener('render-process-gone', lost));
  };
  try {
    const initial = browser.getState();
    if (app.isPackaged || !process.argv.includes('--caddi-scale-smoke') ||
        browser.snapshot().development.sessions !== 'temporary' ||
        initial.workspaces.length > 2 || initial.tabs.some(tab => tab.url !== 'about:blank') ||
        browser.access.connections().length || browser.window.isVisible()) fail('SCALE_DISPOSABLE_APP_REQUIRED');
    const rootInfo = await fs.lstat(runRoot), realRoot = await fs.realpath(runRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() ||
        (rootInfo.mode & 0o777) !== 0o700 || realRoot !== runRoot ||
        !runRoot.startsWith(path.join(projectRoot, '.test-artifacts') + path.sep) ||
        !browser.access.enrollmentSocket.startsWith(runRoot + path.sep)) fail('SCALE_PRIVATE_RUN_ROOT_REQUIRED');
    report.sourceBefore = await bounded(sourceEvidence(projectRoot), 'source-before');
    if (!browser.resources?.preflight || !browser.admission?.snapshot || !browser.access?.queueStats) fail('SCALE_ADMISSION_NOT_COMPOSED');
    try { await bounded(browser.resources.preflight(), 'resource-preflight', 8000); }
    finally { recordResource(browser.resources.snapshot(), 'preflight'); }
    await resources('baseline');
    resourceWatch = setInterval(() => {
      const state = browser.resources.snapshot();
      recordResource(state, 'periodic');
      const refusal = resourceFailure(state); if (refusal) stop(refusal);
    }, 250);
    watchPage(browser.window.webContents);
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1'), match = /^\/scale\/(\d{2})$/.exec(url.pathname);
      if (!match || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
      const marker = 'fixture-' + match[1];
      requestCounts.set(match[1], (requestCounts.get(match[1]) ?? 0) + 1);
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
        response.end('<!doctype html><html><head><title>Caddi scale ' + match[1] + '</title><style>body{font:16px system-ui;padding:32px}input{padding:8px}</style></head><body><h1>' + marker + '</h1><label for="draft">Project draft</label><input id="draft" value="draft-' + marker + '"><output id="owner">' + marker + '</output><script>document.cookie="scale_owner=' + marker + '; Path=/; SameSite=Lax";localStorage.setItem("scale_owner","' + marker + '");window.scaleMarker="' + marker + '";</script></body></html>');
      };
      if (url.searchParams.get('hold') === 'admission' && !releaseHeldResponses) heldResponses.push(send);
      else send();
    });
    server.listen(0, '127.0.0.1'); await bounded(once(server, 'listening'), 'fixture-server');
    const origin = 'http://127.0.0.1:' + server.address().port;
    report.fixtureOrigin = origin;
    const chrome = browser.window.webContents;
    for (let index = 0; index < 20; index++) {
      const number = String(index + 1).padStart(2, '0'), name = 'Scale project ' + number;
      const workspaceId = index === 0 ? initial.workspaces.find(item => item.kind === 'project').id :
        await bounded(browser.act({ type: 'workspace.create', name, kind: 'project' }), 'create-workspace');
      if (index === 0) await bounded(browser.act({ type: 'workspace.rename', workspaceId, name }), 'name-workspace');
      await bounded(browser.act({ type: 'workspace.select', workspaceId }), 'select-workspace');
      const tab = browser.getState().tabs.find(item => item.workspaceId === workspaceId && item.status === 'open');
      assert.ok(tab);
      const query = { workspaceId, tabId: tab.id };
      await bounded(browser.act({ type: 'navigate', tabId: tab.id, input: origin + '/scale/' + number }), 'load-fixture');
      await until(() => {
        try { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Caddi scale ' + number; }
        catch { return false; }
      }, 'fixture-ready');
      const wc = browser.engine.getView(query).webContents;
      watchPage(wc);
      const backgroundTabs = [], selected = browser.getState().activeWorkspaceId;
      const activeTabId = browser.getState().groups.find(group => group.id === browser.getState().workspaces.find(workspace => workspace.id === workspaceId).activeGroupId).activeTabId;
      for (let background = 0; background < 7; background++) {
        const tabId = await bounded(browser.act({ type: 'tab.create', workspaceId, input: 'about:blank', activate: false }), 'background-metadata');
        backgroundTabs.push(tabId);
        assert.equal(browser.getState().activeWorkspaceId, selected);
        assert.equal(browser.getState().groups.find(group => group.id === browser.getState().workspaces.find(workspace => workspace.id === workspaceId).activeGroupId).activeTabId, activeTabId);
        assert.equal(browser.engine.workspaceActivity(workspaceId).pages.some(page => page.tabId === tabId), false);
      }
      fixtures.push({ index, number, name, workspaceId, tabId: tab.id, query, wc, backgroundTabs,
        marker: 'fixture-' + number, expectedDraft: 'draft-fixture-' + number });
      report.workload.fixturePagesCreated = fixtures.length;
      await resources('page-' + number);
    }
    assert.equal(new Set(fixtures.map(item => item.wc.session)).size, 20);
    report.workload.configuredProjectWorkspaces = browser.getState().workspaces.filter(item => item.kind === 'project').length;
    report.workload.totalConfiguredWorkspaces = browser.getState().workspaces.length;
    report.workload.totalTabRecords = browser.getState().tabs.length;
    const projectIds = new Set(fixtures.map(item => item.workspaceId));
    const projectTabs = browser.getState().tabs.filter(tab => projectIds.has(tab.workspaceId) && tab.status === 'open');
    assert.equal(projectTabs.length, 160);
    for (const fixture of fixtures) assert.equal(projectTabs.filter(tab => tab.workspaceId === fixture.workspaceId).length, 8);
    report.workload.projectOpenMetadataTabsBeforeCapacity = projectTabs.length;
    report.workload.unloadedProjectMetadataTabsBeforeCapacity = fixtures.reduce((sum, fixture) => sum + fixture.backgroundTabs.length, 0);
    assert.equal(report.workload.unloadedProjectMetadataTabsBeforeCapacity, 140);
    await check('20 real lightweight pages use distinct Electron sessions');
    await check('160 project metadata tabs preserve selection with 140 unloaded background tabs');

    async function pair(fixture) {
      let onPending;
      const pending = new Promise(resolve => { onPending = resolve; });
      const connected = connectDesktopClient({ socketPath: browser.access.enrollmentSocket,
        clientName: 'Scale agent ' + fixture.number, onPending }).then(client => {
        clients.push(client); if (controller.signal.aborted) client.close(); return client;
      });
      void connected.catch(() => {});
      const challenge = await bounded(pending, 'pairing-challenge');
      const connection = await bounded(browser.act({ type: 'agent.approve', requestId: challenge.requestId,
        comparisonCode: challenge.comparisonCode, workspaceId: fixture.workspaceId, origins: [origin], mode: 'control' }), 'pairing-approval');
      const client = await bounded(connected, 'pairing-connect'), mcp = createDesktopMcpSession({ client });
      const initialized = await bounded(mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'bounded-scale-fixture', version: '1' } } }), 'mcp-initialize');
      assert.equal(initialized.error, undefined);
      await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
      let sequence = 1;
      const tool = async (name, args = {}, timeoutMs = OPERATION_TIMEOUT_MS) => {
        const reply = await bounded(mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }), 'mcp-' + name, timeoutMs);
        if (reply.error || !reply.result?.structuredContent) fail('SCALE_MCP_PROTOCOL');
        return reply.result.structuredContent;
      };
      const visible = completed(await tool('caddi_workspaces'));
      assert.deepEqual(visible.map(item => item.workspaceId), [fixture.workspaceId]);
      fixture.agent = { connection, tool };
    }
    for (const fixture of fixtures) { await pair(fixture); report.workload.pairedAgents++; }
    assert.equal(browser.access.connections().filter(item => item.connected).length, 20);
    await check('20 agents complete real scoped local pairing and MCP initialization');
    const humanWorkspaceId = fixtures[0].workspaceId;
    await bounded(browser.act({ type: 'workspace.select', workspaceId: humanWorkspaceId }), 'human-workspace');
    // Hold the first four real loopback navigations at the HTTP response. This
    // makes admission observable without freezing the UI thread or fabricating
    // native completion. Remaining requests must wait in the real scheduler.
    const navigationScopes = await bounded(Promise.all(fixtures.map(async fixture => {
      const grantId = fixture.agent.connection.grantId;
      const targets = completed(await fixture.agent.tool('caddi_targets', { workspaceId: fixture.workspaceId, grantId }));
      const target = targets.targets.find(item => item.tabId === fixture.tabId); assert.ok(target);
      const lease = completed(await fixture.agent.tool('caddi_acquire_control', { workspaceId: fixture.workspaceId,
        grantId, ttlMs: 20000, idempotencyKey: 'queue-acquire-' + fixture.number }));
      return { fixture, grantId, target, leaseEpoch: lease.leaseEpoch };
    })), 'queue-prepare', 15000);
    const navigationReplies = navigationScopes.map(scope => scope.fixture.agent.tool('caddi_navigate', {
      grantId: scope.grantId, target: scope.target, leaseEpoch: scope.leaseEpoch,
      url: origin + '/scale/' + scope.fixture.number + '?hold=admission', idempotencyKey: 'queue-navigate-' + scope.fixture.number,
    }, 15000));
    const allNavigationReplies = Promise.all(navigationReplies); void allNavigationReplies.catch(() => {});
    await until(() => { const state = browser.admission.snapshot(); return state.active === 4 && state.queued === 16; }, 'queue-four-active-sixteen-waiting');
    await until(() => heldResponses.length === 4, 'queue-four-native-responses-held');
    const queuedState = browser.admission.snapshot(), queuedRequests = browser.access.queueStats();
    assert.equal(queuedRequests.outstanding, 20); assert.equal(queuedRequests.nativeInFlight, 4);
    assert.equal(queuedRequests.awaitingAdmission, 16); assert.equal(queuedRequests.waitingForWorkspace, 0);
    const waiting = queuedState.jobs.filter(job => job.state === 'queued');
    const humanCancelled = waiting.at(-1), leaseCancelled = waiting.at(-2);
    assert.ok(humanCancelled && leaseCancelled && humanCancelled.workspaceId !== leaseCancelled.workspaceId);
    const humanScope = navigationScopes.find(scope => scope.fixture.workspaceId === humanCancelled.workspaceId);
    const releaseScope = navigationScopes.find(scope => scope.fixture.workspaceId === leaseCancelled.workspaceId);
    const countsBeforeCancellation = [humanScope, releaseScope].map(scope => requestCounts.get(scope.fixture.number));
    await bounded(browser.act({ type: 'admission.cancel', jobId: humanCancelled.jobId }), 'queued-human-cancel');
    const releaseBegan = performance.now();
    completed(await releaseScope.fixture.agent.tool('caddi_release_control', { workspaceId: releaseScope.fixture.workspaceId,
      grantId: releaseScope.grantId, leaseEpoch: releaseScope.leaseEpoch, idempotencyKey: 'queue-release-' + releaseScope.fixture.number }));
    const queuedControlReleaseMs = performance.now() - releaseBegan;
    await until(() => browser.admission.snapshot().queued === 14, 'queued-cancellations-fenced');
    assert.equal(browser.admission.snapshot().active, 4);
    releaseHeldResponses = true; for (const send of heldResponses.splice(0)) send();
    const navigationResults = await bounded(allNavigationReplies, 'queue-drain', 15000);
    for (let index = 0; index < navigationScopes.length; index++) {
      const scope = navigationScopes[index], receipt = navigationResults[index];
      if ([humanScope, releaseScope].includes(scope)) assert.notEqual(receipt.status, 'completed');
      else completed(receipt);
    }
    assert.deepEqual([humanScope, releaseScope].map(scope => requestCounts.get(scope.fixture.number)), countsBeforeCancellation);
    await bounded(Promise.all(navigationScopes.filter(scope => scope !== releaseScope).map(async scope => completed(
      await scope.fixture.agent.tool('caddi_release_control', { workspaceId: scope.fixture.workspaceId,
        grantId: scope.grantId, leaseEpoch: scope.leaseEpoch, idempotencyKey: 'queue-release-' + scope.fixture.number })))), 'queue-release-leases');
    await until(() => browser.admission.snapshot().active === 0 && browser.access.queueStats().outstanding === 0, 'queue-quiescent');
    report.operationAdmission = { limit: 4, perWorkspaceLimit: 1, observedActive: queuedState.active,
      observedQueued: queuedState.queued, dispatcherRequests: queuedRequests, queuedHumanCancelNeverDispatched: true,
      queuedLeaseReleaseNeverDispatched: true, queuedControlReleaseMs, completedNavigations: 18,
      cancelledRequestOutcomes: [humanScope, releaseScope].map((scope, index) => {
        const receipt = navigationResults[navigationScopes.indexOf(scope)];
        return { workspaceId: scope.fixture.workspaceId, cancellation: index === 0 ? 'owner-job-cancel' : 'agent-lease-release',
          status: receipt.status, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(receipt.code ?? '') ? receipt.code : null, nativeRequestDelta: 0 };
      }),
      metrics: browser.admission.snapshot().metrics };
    assert.equal(report.operationAdmission.metrics.peakActive, 4);
    assert.ok(report.operationAdmission.metrics.peakQueuedAtCapacity >= 16);
    assert.equal(browser.getState().activeWorkspaceId, humanWorkspaceId);
    await check('real native queue admits four, holds sixteen, and cancels two queued actions before dispatch');
    await resources('queue-drained');
    let activePipelines = 0;
    async function pipeline(fixture, tier, round, stage) {
      const begin = performance.now(), agent = fixture.agent, grantId = agent.connection.grantId;
      activePipelines++; stage.peakInFlightPipelines = Math.max(stage.peakInFlightPipelines, activePipelines);
      try {
        const targets = completed(await agent.tool('caddi_targets', { workspaceId: fixture.workspaceId, grantId }));
        const target = targets.targets.find(item => item.tabId === fixture.tabId); assert.ok(target);
        const observation = completed(await agent.tool('caddi_observe', { grantId, target }));
        const element = observation.result.elements.find(item => item.role === 'textbox'); assert.ok(element);
        const key = 'scale-' + fixture.number + '-' + tier + '-' + round;
        const lease = completed(await agent.tool('caddi_acquire_control', { workspaceId: fixture.workspaceId, grantId, ttlMs: 10000, idempotencyKey: key + '-acquire' }));
        const draft = 'draft-' + fixture.marker + '-' + tier + '-' + round;
        completed(await agent.tool('caddi_fill', { grantId, target: observation.target, leaseEpoch: lease.leaseEpoch,
          elementId: element.id, value: draft, idempotencyKey: key + '-fill' }));
        completed(await agent.tool('caddi_release_control', { workspaceId: fixture.workspaceId, grantId,
          leaseEpoch: lease.leaseEpoch, idempotencyKey: key + '-release' }));
        assert.equal(await bounded(fixture.wc.executeJavaScript('document.getElementById("draft").value'), 'verify-draft'), draft);
        fixture.expectedDraft = draft;
        return performance.now() - begin;
      } finally { activePipelines--; }
    }
    async function chromeProbe() {
      const values = [];
      for (let sample = 0; sample < 5; sample++) {
        const begin = performance.now();
        assert.equal(await bounded(chrome.executeJavaScript('document.getElementById("workspace-title").textContent'), 'chrome-probe'), fixtures[0].name);
        const elapsed = performance.now() - begin; values.push(elapsed);
        if (elapsed > policy.maximumChromeRoundTripMs) fail('SCALE_CHROME_STALL');
        await bounded(pause(25), 'chrome-probe-spacing');
      }
      return values;
    }
    async function switchProbe(tier) {
      const values = [];
      for (const index of [tier - 1, 0, tier - 1, 0]) {
        const fixture = fixtures[index], begin = performance.now();
        await bounded(browser.act({ type: 'workspace.select', workspaceId: fixture.workspaceId }), 'workspace-switch');
        await until(async () => await chrome.executeJavaScript('document.getElementById("workspace-title").textContent') === fixture.name, 'workspace-visible');
        values.push(performance.now() - begin);
      }
      return values;
    }
    for (const tier of TIERS) {
      const stage = { tier, configuredProjectWorkspaces: 20, connectedAgents: 20,
        operatingAgents: tier, idleConnectedAgents: 20 - tier, nativeOperationLimit: 4,
        peakInFlightPipelines: 0, roundsCompleted: 0,
        pipelineDurationsMs: [], chromeRoundTripsMs: [], status: 'running' };
      report.stages.push(stage);
      await resources('tier-' + tier + '-before');
      const begin = performance.now();
      for (let round = 1; round <= 2; round++) {
        const [durations, probes] = await bounded(Promise.all([
          Promise.all(fixtures.slice(0, tier).map(fixture => pipeline(fixture, tier, round, stage))), chromeProbe(),
        ]), 'tier-' + tier + '-round-' + round, 15000);
        stage.pipelineDurationsMs.push(...durations); stage.chromeRoundTripsMs.push(...probes); stage.roundsCompleted++;
        assert.equal(browser.getState().activeWorkspaceId, humanWorkspaceId);
      }
      stage.operationsCompleted = tier * 2 * 5;
      stage.operationWindowMs = performance.now() - begin;
      stage.operationsPerSecond = stage.operationsCompleted / (stage.operationWindowMs / 1000);
      stage.pipelineP95Ms = p95(stage.pipelineDurationsMs); stage.chromeRoundTripP95Ms = p95(stage.chromeRoundTripsMs);
      stage.loadedWorkspaceSwitchDurationsMs = await switchProbe(tier);
      stage.loadedWorkspaceSwitchP95Ms = p95(stage.loadedWorkspaceSwitchDurationsMs);
      stage.diagnosticGoals = { chromeRoundTrip: stage.chromeRoundTripP95Ms <= policy.diagnosticGoals.chromeRoundTripP95Ms,
        loadedWorkspaceSwitch: stage.loadedWorkspaceSwitchP95Ms <= policy.diagnosticGoals.loadedWorkspaceSwitchP95Ms };
      if (tier > 1) {
        const wrong = await fixtures[0].agent.tool('caddi_observe', { grantId: fixtures[0].agent.connection.grantId,
          target: browser.engine.getTarget(fixtures[tier - 1].query) });
        assert.equal(wrong.code, 'ACCESS_DENIED');
      }
      await resources('tier-' + tier + '-after');
      stage.status = 'passed';
      report.maximumVerifiedTier = tier;
      await check('tier ' + tier + ' scoped pipelines preserve selected workspace and reject foreign targets');
    }
    await bounded(browser.act({ type: 'privacy.enter', workspaceId: humanWorkspaceId }), 'private-workspace');
    const privateReceipt = await fixtures[0].agent.tool('caddi_targets', { workspaceId: humanWorkspaceId, grantId: fixtures[0].agent.connection.grantId });
    assert.equal(privateReceipt.code, 'PRIVACY_BLOCKED');
    await pipeline(fixtures[19], 'private-neighbor', 1, { peakInFlightPipelines: 0 });
    await bounded(browser.act({ type: 'privacy.resume', workspaceId: humanWorkspaceId }), 'resume-workspace');
    await check('private takeover blocks one agent while another workspace completes');
    for (const fixture of fixtures) {
      const value = await bounded(fixture.wc.executeJavaScript('({cookie:document.cookie,storage:localStorage.getItem("scale_owner"),marker:window.scaleMarker,draft:document.getElementById("draft").value})'), 'verify-isolation');
      assert.equal(value.cookie, 'scale_owner=' + fixture.marker); assert.equal(value.storage, fixture.marker);
      assert.equal(value.marker, fixture.marker); assert.equal(value.draft, fixture.expectedDraft);
      assert.equal(fixture.wc.isDestroyed(), false);
    }
    await check('all 20 same-origin identities and draft values remain isolated without eviction');
    const residentPages = () => browser.getState().workspaces.flatMap(workspace => browser.engine.workspaceActivity(workspace.id).pages.map(page => ({ workspaceId: workspace.id, ...page })));
    const candidates = fixtures.flatMap(fixture => fixture.backgroundTabs.map(tabId => ({ workspaceId: fixture.workspaceId, tabId })));
    const loadedBlanks = [];
    for (const candidate of candidates) {
      if (residentPages().length >= 32) break;
      await bounded(browser.act({ type: 'workspace.select', workspaceId: candidate.workspaceId }), 'capacity-workspace');
      await bounded(browser.act({ type: 'tab.select', tabId: candidate.tabId }), 'capacity-load-blank');
      await until(() => residentPages().some(page => page.tabId === candidate.tabId && page.ready && !page.busy), 'capacity-blank-ready');
      loadedBlanks.push(candidate); await resources('resident-' + residentPages().length);
    }
    assert.equal(residentPages().length, 32); assert.ok(loadedBlanks.length > 0);
    const blocked = candidates.find(candidate => !residentPages().some(page => page.tabId === candidate.tabId)); assert.ok(blocked);
    await bounded(browser.act({ type: 'workspace.select', workspaceId: blocked.workspaceId }), 'capacity-refusal-workspace');
    const selectionBefore = JSON.stringify(browser.getState().groups.map(group => [group.id, group.activeTabId]));
    let refusal = null;
    try { await bounded(browser.act({ type: 'tab.select', tabId: blocked.tabId }), 'capacity-refusal'); }
    catch (error) { refusal = error?.code; }
    assert.equal(refusal, 'PAGE_CAPACITY'); assert.equal(residentPages().length, 32);
    assert.equal(JSON.stringify(browser.getState().groups.map(group => [group.id, group.activeTabId])), selectionBefore);
    assert.equal(residentPages().some(page => page.tabId === blocked.tabId), false);
    for (const fixture of fixtures) {
      assert.equal(fixture.wc.isDestroyed(), false);
      assert.equal(await bounded(fixture.wc.executeJavaScript('document.getElementById("draft").value'), 'capacity-protected-draft'), fixture.expectedDraft);
    }
    const disposable = loadedBlanks.at(-1);
    await bounded(browser.act({ type: 'workspace.select', workspaceId: disposable.workspaceId }), 'capacity-close-workspace');
    await bounded(browser.act({ type: 'tab.close', tabId: disposable.tabId }), 'capacity-close-disposable');
    assert.equal(residentPages().length, 31);
    await bounded(browser.act({ type: 'workspace.select', workspaceId: blocked.workspaceId }), 'capacity-retry-workspace');
    await bounded(browser.act({ type: 'tab.select', tabId: blocked.tabId }), 'capacity-explicit-retry');
    assert.equal(residentPages().length, 32);
    assert.equal(residentPages().some(page => page.tabId === blocked.tabId), true);
    await bounded(browser.act({ type: 'workspace.select', workspaceId: humanWorkspaceId }), 'restore-owner-workspace');
    await bounded(browser.act({ type: 'tab.select', tabId: fixtures[0].tabId }), 'restore-owner-tab');
    report.pageCapacity = { limit: 32, refusal, selectionUnchangedOnRefusal: true, protectedDraftsPreserved: 20,
      disposableBlankPagesLoaded: loadedBlanks.length, afterExplicitClose: 31, afterExplicitRetry: 32,
      automaticWaiting: false, automaticEviction: false,
      projectOpenMetadataTabsAfterExplicitClose: browser.getState().tabs.filter(tab => projectIds.has(tab.workspaceId) && tab.status === 'open').length };
    await check('32 resident-page boundary refuses safely and explicit disposable close permits retry');
    await resources('final');
    report.operationAdmission.finalMetrics = browser.admission.snapshot().metrics;
    report.operationAdmission.finalRequests = browser.access.queueStats();
    assert.equal(report.operationAdmission.finalMetrics.peakActive, 4);
    assert.equal(report.operationAdmission.finalRequests.outstanding, 0);
    report.workload.finalResidentPages = residentPages().length;
    report.workload.finalProjectMetadataRecords = browser.getState().tabs.filter(tab => projectIds.has(tab.workspaceId)).length;
    report.sourceAfter = await bounded(sourceEvidence(projectRoot), 'source-after');
    if (report.sourceBefore.sha256 !== report.sourceAfter.sha256) fail('SCALE_SOURCE_CHANGED');
    report.maximumVerifiedTier = 20;
    report.diagnosticPerformanceGoalsMet = report.stages.every(stage => Object.values(stage.diagnosticGoals).every(Boolean));
    report.status = 'passed'; finished = true;
  } catch (error) {
    report.status = 'failed';
    report.failure = { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'SCALE_ASSERTION_FAILED', checkpoint };
    stop(report.failure.code);
  } finally {
    clearTimeout(deadline); clearInterval(pulse); clearInterval(resourceWatch);
    for (const remove of listeners) remove();
    for (const client of clients) { try { client.close(); } catch {} }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (!report.sourceAfter) { try { report.sourceAfter = await sourceEvidence(projectRoot); } catch {} }
    report.finishedAt = new Date().toISOString(); report.reportPath = reportPath;
    await save();
  }
  console.log('CADDI_SCALE_REPORT ' + reportPath);
  if (!finished) fail(report.failure?.code ?? 'SCALE_FAILED');
  console.log('CADDI_SCALE_SMOKE_OK ' + report.checks.length + ' checks; 160 metadata tabs; 20 agents; 4 native operation slots; 32 resident-page boundary');
  return report;
}
