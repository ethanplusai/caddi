// Explicit checkout-only qualification. Never imports Electron into the driver.
// Run only when the coordinator has frozen source and other native proof windows.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appendFileSync, createWriteStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createOwnedSystemProof } from '../src/caddi/desktop/owned-system-proof.mjs';
import { FAULT_LIMITS, pause, digest, processIdentity, processGroup, sameProcess, validateOwnedGroup,
  writePrivateJSON, sourceEvidence, readCheckpointAtExit } from './caddi-fault-support.mjs';

assert.equal(process.platform, 'darwin', 'This bounded fixture targets the development Mac lane');
assert.equal(process.versions.electron, undefined, 'Run this driver with Node, not Electron');
assert.deepEqual(process.argv.slice(2), ['--caddi-fault-smoke'], 'Explicit isolated fault-proof flag is required');
const projectRoot = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(import.meta.url), electronExecutable = await fs.realpath(require('electron'));
const bundlePath = path.resolve(electronExecutable, '../../..');
assert.ok(bundlePath.endsWith('/Electron.app') && electronExecutable === path.join(bundlePath, 'Contents/MacOS/Electron'));
const parent = path.join(projectRoot, '.test-artifacts', 'caddi-fault-proof');
await fs.mkdir(parent, { recursive: true, mode: 0o700 });
assert.equal((await fs.lstat(parent)).isSymbolicLink(), false);
const runRoot = await fs.realpath(await fs.mkdtemp(path.join(parent, 'run-'))); await fs.chmod(runRoot, 0o700);
const dataRoot = path.join(runRoot, 'data'); await fs.mkdir(dataRoot, { mode: 0o700 });
for (const phase of ['seed', 'restore']) await fs.mkdir(path.join(runRoot, phase), { mode: 0o700 });
const reportPath = path.join(runRoot, 'report.json'), journalPath = path.join(runRoot, 'driver-journal.jsonl');
const started = Date.now(), nonce = randomBytes(24).toString('hex');
const report = { format: 'caddi-browser-gpu-fault-v1', status: 'running', startedAt: new Date().toISOString(), checks: [],
  bounds: { ...FAULT_LIMITS, maximumConcurrentChildApps: 1, observedConcurrentChildApps: 0 },
  workload: { persistentWorkspaceIdentities: 2, nativeAppLifetimes: 2, injectedMainProcessExits: 1,
    maximumInjectedGPUExits: 1, realAccounts: false, realDevices: false, realSystemPrompts: false, existingProfiles: false },
  limits: [
    'Only this new test run directory is used. The original main child is killed through its recorded ChildProcess object after a completed metadata checkpoint.',
    'Cookie flush promises and completed strict IndexedDB transactions are awaited. Electron flushStorageData is a void DOMStorage API; power-loss and arbitrary mid-write atomicity are not qualified.',
    'One unfinished synthetic POST is observed without a response. A restart must not replay it, but no generic exactly-once network guarantee is implied.',
    'Saved identities and tab metadata are restored lazily. Unsaved DOM form values are explicitly not promised across a browser-process crash.',
    'GPU signaling requires Electron metric PID plus creation time and rechecked OS owner, process-group, start-time and executable identity. Unprovable GPU ownership is reported unsupported without signaling.',
    'If the controlled GPU failure kills trusted chrome, the owned child aborts before an interactive recovery dialog. That outcome is not a successful chrome-recovery qualification.',
    'All windows stay hidden. Physical focus, real hardware rendering, sustained workloads, device permissions and signed release recovery remain unqualified.'
  ], children: [], processSignals: [], cleanup: { childAppsExited: false, recordedHelpersGone: false, loopbackStopped: false },
  network: { requests: [], mutationCount: 0, mutationBodiesValid: true } };
let server, active = null, sourceBefore, failure = null, deadline, hardDeadline, stopping = false, activeCount = 0;
const sockets = new Set(), allChildren = [], allRecorded = new Map(), runtimeRoots = {};
function journal(type, detail = {}) {
  appendFileSync(journalPath, JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, type, ...detail }) + '\n', { mode: 0o600 });
}
async function save() { report.elapsedMs = Date.now() - started; await writePrivateJSON(reportPath, report); }
async function check(name) { report.checks.push(name); journal('pass', { name }); console.log('FAULT_PASS ' + name); await save(); }
function remaining(maximum) { return Math.max(1, Math.min(maximum, FAULT_LIMITS.totalMs - 1500 - (Date.now() - started))); }
async function timed(value, label, ms = FAULT_LIMITS.stepMs) {
  report.lastOperation = label; let timer;
  if (stopping) throw new Error('FAULT_DRIVER_DEADLINE');
  try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FAULT_TIMEOUT: ' + label)), remaining(ms)); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label, ms = FAULT_LIMITS.stepMs) {
  const end = Date.now() + remaining(ms);
  while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label)) return; await pause(30); }
  throw new Error('FAULT_TIMEOUT: ' + label);
}
function observeLog(stream, filename, record, name) {
  const out = createWriteStream(filename, { flags: 'wx', mode: 0o600 }); let bytes = 0, dropped = 0;
  stream.on('data', chunk => {
    const available = Math.max(0, FAULT_LIMITS.maximumLogBytes - bytes), take = Math.min(available, chunk.length);
    if (take) out.write(chunk.subarray(0, take)); bytes += take; dropped += chunk.length - take;
  });
  const closed = new Promise(resolve => { stream.once('end', () => out.end()); out.once('close', () => {
    record.logs[name] = { bytes, droppedBytes: dropped, file: path.relative(runRoot, filename) }; resolve();
  }); });
  out.on('error', () => {}); return closed;
}
async function launch(phase, configPath) {
  assert.equal(active, null, 'One owned child app at a time');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(electronExecutable, [path.join(projectRoot, 'test/caddi-fault-child.mjs'),
    '--caddi-fault-config=' + configPath, '--caddi-fault-phase=' + phase],
  { cwd: projectRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { phase, pid: child.pid ?? null, spawnedAt: new Date().toISOString(), logs: {}, exit: null, ownedGroup: [] };
  report.children.push(record); allChildren.push({ child, record }); activeCount++;
  report.bounds.observedConcurrentChildApps = Math.max(report.bounds.observedConcurrentChildApps, activeCount);
  assert.equal(report.bounds.observedConcurrentChildApps, 1);
  const entry = { child, record, identity: null, finished: false, logTasks: [] };
  active = entry;
  entry.exit = new Promise(resolve => {
    child.once('exit', (code, signal) => { entry.finished = true; record.exit = { code, signal, at: new Date().toISOString() }; activeCount--; journal('child-exit', { phase, pid: child.pid, code, signal }); resolve(record.exit); });
    child.once('error', error => { entry.finished = true; record.exit = { spawnError: error.code ?? 'SPAWN_ERROR' }; activeCount--; resolve(record.exit); });
  });
  entry.logTasks.push(observeLog(child.stdout, path.join(runRoot, phase, 'stdout.log'), record, 'stdout'));
  entry.logTasks.push(observeLog(child.stderr, path.join(runRoot, phase, 'stderr.log'), record, 'stderr'));
  await until(async () => {
    if (entry.finished) throw new Error('FAULT_CHILD_EARLY_EXIT');
    const identity = await processIdentity(child.pid);
    if (!identity) return false;
    if (identity.pgid !== child.pid || identity.ppid !== process.pid || identity.uid !== process.getuid() || identity.executable !== electronExecutable) throw new Error('FAULT_CHILD_OWNERSHIP');
    entry.identity = identity; record.identity = identity; return true;
  }, 'exact spawned child identity');
  journal('child-started', { phase, pid: child.pid, pgid: entry.identity.pgid }); await save(); return entry;
}
async function childState(entry) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(runRoot, entry.record.phase, 'state.json'), 'utf8'));
    assert.equal(value.format, 'caddi-fault-state-v1'); assert.equal(value.nonce, nonce); assert.equal(value.pid, entry.child.pid); assert.equal(value.phase, entry.record.phase);
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function waitState(entry, status, ms) {
  let found;
  await until(async () => {
    const value = await readCheckpointAtExit({ readState: () => childState(entry), hasExited: () => entry.finished, requested: status });
    if (value) { found = value; return true; }
    return false;
  }, entry.record.phase + ' ' + status, ms);
  return found;
}
async function captureOwnedGroup(entry) {
  assert.equal(entry.finished, false);
  const identity = await processIdentity(entry.child.pid);
  if (!sameProcess(entry.identity, identity) || identity.ppid !== process.pid) throw new Error('FAULT_CHILD_IDENTITY_CHANGED');
  const group = await processGroup(entry.child.pid);
  if (!validateOwnedGroup(group, { mainPid: entry.child.pid, uid: process.getuid(), bundlePath, mainExecutable: electronExecutable })) throw new Error('FAULT_PROCESS_GROUP_UNPROVEN');
  entry.record.ownedGroup = group;
  for (const item of group) allRecorded.set(item.pid + ':' + item.started, item);
  journal('owned-group-captured', { phase: entry.record.phase, processes: group.map(item => ({ pid: item.pid, ppid: item.ppid, pgid: item.pgid })) });
  return group;
}
async function signalMain(entry, signal, reason) {
  if (entry.finished) return false;
  const current = await processIdentity(entry.child.pid);
  if (!sameProcess(entry.identity, current) || current.ppid !== process.pid || entry.child.exitCode !== null || entry.child.signalCode !== null) throw new Error('FAULT_MAIN_SIGNAL_IDENTITY');
  const result = entry.child.kill(signal);
  if (!result) throw new Error('FAULT_MAIN_SIGNAL_REJECTED');
  const item = { target: 'exact-ChildProcess', phase: entry.record.phase, pid: entry.child.pid, signal, reason, at: new Date().toISOString() };
  report.processSignals.push(item); journal('signal', item); return true;
}
async function reapRecorded(entry) {
  // Only identities captured while the exact owned main was alive are eligible.
  const helpers = entry.record.ownedGroup.filter(item => item.pid !== entry.child.pid);
  for (const original of helpers) {
    let current = await processIdentity(original.pid);
    if (!sameProcess(original, current)) continue;
    await pause(100); current = await processIdentity(original.pid);
    if (!sameProcess(original, current)) continue;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      current = await processIdentity(original.pid);
      if (!sameProcess(original, current)) break;
      if (current.ppid !== 1 && current.ppid !== original.ppid) throw new Error('FAULT_ORPHAN_PARENT_CHANGED');
      try { process.kill(original.pid, signal); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      const item = { target: 'captured-native-helper', phase: entry.record.phase, pid: original.pid, signal, at: new Date().toISOString() };
      report.processSignals.push(item); journal('signal', item);
      await pause(150);
    }
    if (sameProcess(original, await processIdentity(original.pid))) throw new Error('FAULT_HELPER_EXIT_UNACKNOWLEDGED');
  }
  // An uncaptured survivor is preserved and blocks a second child; never infer
  // ownership merely from a matching executable name or an orphaned process group.
  let survivors = await processGroup(entry.child.pid);
  const settledBy = Math.min(Date.now() + 1500, started + FAULT_LIMITS.totalMs - 2500);
  while (survivors.length && Date.now() < settledBy) { await pause(50); survivors = await processGroup(entry.child.pid); }
  if (survivors.length) { entry.record.unreapedGroup = survivors; throw new Error('FAULT_UNCAPTURED_SURVIVOR'); }
  await Promise.race([Promise.all(entry.logTasks), pause(500)]);
  if (active === entry) active = null;
}
async function preserveMetadata(label) {
  const destination = path.join(runRoot, label + '-metadata'); await fs.mkdir(destination, { mode: 0o700 });
  const evidence = [];
  for (const relative of ['metadata/state.json', 'metadata/state.previous.json', 'window-session/windows.json', 'window-session/windows.previous.json']) {
    try {
      const filename = path.join(dataRoot, relative), info = await fs.lstat(filename);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 * 1024);
      const bytes = await fs.readFile(filename), name = relative.replaceAll('/', '--');
      await fs.writeFile(path.join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
      evidence.push({ path: relative, bytes: bytes.length, sha256: digest(bytes), preservedAs: label + '-metadata/' + name });
    } catch (error) { if (error.code !== 'ENOENT') throw error; evidence.push({ path: relative, absent: true }); }
  }
  return evidence;
}

try {
  hardDeadline = setTimeout(() => {
    stopping = true;
    if (active && !active.finished && active.child.exitCode === null && active.child.signalCode === null) active.child.kill('SIGKILL');
    for (const socket of sockets) socket.destroy(); server?.close();
    report.status = 'failed'; report.elapsedMs = Date.now() - started;
    report.error = { code: 'FAULT_HARD_DEADLINE', message: 'The exact child was terminated; final helper cleanup and source comparison remain unconfirmed.' };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.exit(1);
  }, FAULT_LIMITS.totalMs - 1000);
  deadline = setTimeout(() => { stopping = true; if (active && !active.finished) {
    // The ChildProcess handle has not been reaped/replaced. The normal catch path
    // handles verified helper cleanup and preserves the failure report.
    const entry = active; if (entry.child.exitCode === null && entry.child.signalCode === null) {
      const signal = { target: 'exact-ChildProcess', phase: entry.record.phase, pid: entry.child.pid, signal: 'SIGKILL', reason: 'work deadline' };
      report.processSignals.push(signal); journal('signal', signal); entry.child.kill('SIGKILL');
    }
  } }, FAULT_LIMITS.workMs);
  sourceBefore = await sourceEvidence(projectRoot); report.sourceBefore = sourceBefore; await save();
  const fixture = '<!doctype html><meta charset="utf-8"><title>Caddi fault fixture</title><h1>Owned fault fixture</h1><input id="draft" value="fresh document draft"><canvas id="fixture-canvas" width="32" height="32"></canvas>';
  server = http.createServer((request, response) => {
    if (report.network.requests.length >= FAULT_LIMITS.maximumRequests) { response.writeHead(429); response.end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    report.network.requests.push({ method: request.method, path: url.pathname, elapsedMs: Date.now() - started, phase: active?.record.phase ?? 'between-children' });
    if (request.method === 'POST' && url.pathname === '/mutation') {
      let body = '';
      request.on('data', chunk => { body += chunk.toString('utf8'); if (body.length > 256) request.destroy(); });
      request.on('end', () => { report.network.mutationCount++; report.network.mutationBodiesValid &&= body === 'synthetic-unfinished-request'; journal('unfinished-post-observed', { count: report.network.mutationCount }); });
      // Deliberately no response: this is the one bounded ambiguous in-flight effect.
      return;
    }
    if (request.method !== 'GET' || !['/a', '/b', '/never-loaded-0', '/never-loaded-1', '/favicon.ico'].includes(url.pathname)) { response.writeHead(404); response.end(); return; }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'none'; frame-src 'none'; worker-src 'none'" });
    response.end(fixture);
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const configPath = path.join(runRoot, 'config.json');
  for (const phase of ['seed', 'restore']) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(projectRoot, '.test-artifacts', phase === 'seed' ? 'cf-s-' : 'cf-r-')));
    await fs.chmod(directory, 0o700);
    const info = await fs.lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
    assert.ok(Buffer.byteLength(path.join(directory, 'b.sock')) <= 100 && Buffer.byteLength(path.join(directory, 'e.sock')) <= 100,
      'Owned runtime path must fit the unchanged transport socket bound');
    runtimeRoots[phase] = { directory, dev: info.dev, ino: info.ino };
    await writePrivateJSON(path.join(directory, 'owner.json'), { nonce, phase, proofRoot: runRoot, driverPid: process.pid });
  }
  report.runtimeRoots = runtimeRoots;
  for (const name of ['electron', 'electron-session']) await fs.mkdir(path.join(dataRoot, name), { mode: 0o700 });
  const ownedSystemProof = createOwnedSystemProof({ proofRoot: runRoot, dataRoot,
    sessionDataRoot: path.join(dataRoot, 'electron-session'), runRoots: Object.values(runtimeRoots).map(item => item.directory) });
  await writePrivateJSON(configPath, { format: 'caddi-owned-fault-config-v1', projectRoot, runRoot, dataRoot,
    origin, driverPid: process.pid, electronExecutable, bundlePath, nonce, runtimeRoots, systemProof: ownedSystemProof.receipt(), expiresAt: started + FAULT_LIMITS.totalMs });
  let entry = await launch('seed', configPath);
  await waitState(entry, 'seed-ready', 40000);
  await until(() => report.network.mutationCount === 1, 'server observed one unfinished synthetic POST');
  assert.equal(report.network.mutationBodiesValid, true);
  assert.equal(report.network.requests.some(item => item.path.startsWith('/never-loaded-')), false);
  report.seed = JSON.parse(await fs.readFile(path.join(runRoot, 'seed/result.json'), 'utf8'));
  assert.equal(report.seed.status, 'checkpointed');
  report.beforeCrashMetadata = await preserveMetadata('before-crash');
  assert.ok(report.beforeCrashMetadata.some(item => item.path === 'metadata/state.json' && !item.absent));
  await captureOwnedGroup(entry); await save();
  await signalMain(entry, 'SIGKILL', 'deliberate abrupt exit after actual durable checkpoint');
  const firstExit = await timed(entry.exit, 'owned main-process exit', 5000);
  assert.equal(firstExit.signal, 'SIGKILL');
  await reapRecorded(entry);
  await check('the exact owned main child exits by SIGKILL after the checkpoint; all captured native helpers acknowledge exit before restart');
  const networkBeforeRestore = report.network.requests.length;
  entry = await launch('restore', configPath);
  await waitState(entry, 'restore-lazy', 20000);
  assert.equal(report.network.requests.length, networkBeforeRestore, 'Startup does not hydrate saved site URLs');
  assert.equal(report.network.mutationCount, 1, 'The unfinished POST is not replayed');
  await check('restart reaches a lazy blank owner without fetching a saved site or replaying the unfinished POST');
  await writePrivateJSON(path.join(runRoot, 'restore/lazy-ack.json'), { nonce, pid: entry.child.pid, approved: true });
  // Capture the owned native group while it is live for bounded failure cleanup.
  await captureOwnedGroup(entry);
  await waitState(entry, 'restore-verified', 40000);
  await captureOwnedGroup(entry);
  await writePrivateJSON(path.join(runRoot, 'restore/close-ack.json'), { nonce, pid: entry.child.pid, approved: true });
  await waitState(entry, 'complete', 10000);
  const restoredExit = await timed(entry.exit, 'restored owned child exits cleanly', 5000);
  assert.equal(restoredExit.code, 0); assert.equal(restoredExit.signal, null);
  report.restore = JSON.parse(await fs.readFile(path.join(runRoot, 'restore/result.json'), 'utf8'));
  assert.equal(report.restore.status, 'passed'); assert.equal(report.restore.cleanup.nativeClosed, true);
  await reapRecorded(entry);
  assert.equal(report.network.mutationCount, 1); assert.equal(report.network.requests.some(item => item.path.startsWith('/never-loaded-')), false);
  report.afterRestoreMetadata = await preserveMetadata('after-restore');
  await check('explicit restored pages recover their isolated persisted site state, while unloaded background tabs and unfinished network work remain untouched');
  report.gpuStatus = report.restore.gpu.status;
  if (report.gpuStatus === 'passed') await check('the controlled owned GPU failure is acknowledged by native events and live page recovery');
  else assert.equal(report.gpuStatus, 'unsupported', 'A failed GPU attempt cannot be relabeled unsupported');
} catch (error) { failure = error; }
finally {
  clearTimeout(deadline);
  const cleanupErrors = [];
  if (active) {
    const entry = active;
    try {
      if (!entry.finished) {
        try { await captureOwnedGroup(entry); }
        catch (error) { cleanupErrors.push({ stage: 'cleanup-group-capture', message: String(error.message ?? error).slice(0, 300) }); }
        try { await signalMain(entry, 'SIGKILL', 'bounded failed fixture cleanup'); }
        catch (error) {
          // An unreaped direct ChildProcess remains an exact owned capability even
          // if the auxiliary ps probe failed. Never apply this fallback to helpers.
          if (!entry.finished && entry.child.exitCode === null && entry.child.signalCode === null) {
            entry.child.kill('SIGKILL'); journal('exact-child-cleanup-fallback', { pid: entry.child.pid });
          } else throw error;
        }
        await Promise.race([entry.exit, pause(2000)]);
      }
      if (!entry.finished) throw new Error('FAULT_CHILD_EXIT_UNACKNOWLEDGED');
      await reapRecorded(entry);
    } catch (error) { cleanupErrors.push({ stage: 'owned-child', message: String(error.message ?? error).slice(0, 500) }); }
  }
  report.cleanup.childAppsExited = allChildren.every(item => item.record.exit !== null);
  try {
    const survivors = [];
    for (const value of allRecorded.values()) if (sameProcess(value, await processIdentity(value.pid))) survivors.push(value.pid);
    report.cleanup.recordedHelpersGone = survivors.length === 0; report.cleanup.recordedSurvivors = survivors;
  } catch (error) { cleanupErrors.push({ stage: 'owned-process-verification', message: String(error.message ?? error).slice(0, 300) }); }
  if (server) {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); report.cleanup.loopbackStopped = !server.listening;
  }
  report.cleanup.runtimeDirectoriesRemoved = [];
  if (report.cleanup.childAppsExited && report.cleanup.recordedHelpersGone) {
    for (const [phase, owned] of Object.entries(runtimeRoots)) {
      try {
        const info = await fs.lstat(owned.directory);
        assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.dev === owned.dev && info.ino === owned.ino && info.uid === process.getuid());
        assert.equal(await fs.realpath(owned.directory), owned.directory);
        const marker = JSON.parse(await fs.readFile(path.join(owned.directory, 'owner.json'), 'utf8'));
        assert.deepEqual(marker, { nonce, phase, proofRoot: runRoot, driverPid: process.pid });
        await fs.rm(owned.directory, { recursive: true, force: false });
        report.cleanup.runtimeDirectoriesRemoved.push(phase);
      } catch (error) { cleanupErrors.push({ stage: 'owned-runtime-directory', phase, message: String(error.message ?? error).slice(0, 300) }); }
    }
  }
  for (const phase of ['seed', 'restore']) {
    if (report[phase]) continue;
    try { report[phase] = JSON.parse(await fs.readFile(path.join(runRoot, phase, 'result.json'), 'utf8')); } catch {}
  }
  report.cleanup.errors = cleanupErrors;
  if ((!report.cleanup.childAppsExited || !report.cleanup.recordedHelpersGone || cleanupErrors.length) && !failure) failure = new Error('FAULT_CLEANUP_UNCONFIRMED');
  try { report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, sourceBefore); }
  catch (error) { failure ??= error; }
  report.status = failure ? 'failed' : report.gpuStatus === 'unsupported' ? 'passed-with-unsupported-gpu' : 'passed';
  if (failure) report.error = { code: failure.code ?? 'FAULT_ASSERTION', message: String(failure.message ?? failure).slice(0, 1600), stack: String(failure.stack ?? '').slice(0, 6000) };
  await save();
  clearTimeout(hardDeadline);
  console.log('FAULT_RESULT ' + JSON.stringify({ status: report.status, checks: report.checks.length, reportPath, gpuStatus: report.gpuStatus ?? 'not-completed' }));
  if (failure) process.exitCode = 1;
}
