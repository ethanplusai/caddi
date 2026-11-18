// Development admission uses Chromium's pinned approximate available-memory
// formula. This is an estimate, not a guarantee or a macOS available-memory API.
// Apple vm_stat prints free_count - speculative_count as "Pages free" and
// external_page_count as "File-backed pages". Add these two displayed categories
// from ONE vm_stat snapshot. Never add speculative, inactive or purgeable again.
// https://github.com/apple-oss-distributions/system_cmds/blob/408bba7453608006b89772db185defbac8fe2fd0/vm_stat/vm_stat.c#L132-L135
// Electron 45.0.0 pins Chromium 156.0.8078.48; its GetAvailablePhysicalMemory is
// free + file_backed, with free_count - speculative_count supplying free.
// https://github.com/chromium/chromium/blob/156.0.8078.48/base/process/process_metrics_apple.mm
// Pressure sysctl returns dispatch flags, not XNU's internal pressure enum:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c#L1885-L1910
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event_private.h#L301-L303
// The private sysctl is a development probe. Unsupported/error states deny
// admission; a production integration needs qualified public OS notifications.
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CaddiError, assertInteger } from '../contracts.mjs';

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const runFile = promisify(execFile);
const fail = code => { throw new CaddiError(code, 'Resource admission could not be established'); };
const finiteCount = value => Number.isSafeInteger(value) && value >= 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const VM_MEMORY_FIELDS = Object.freeze(['freeBytes', 'speculativeBytes', 'freePlusSpeculativeBytes',
  'fileBackedBytes', 'freePlusFileBackedBytes', 'purgeableBytes', 'wiredBytes', 'compressedBytes', 'activeBytes', 'inactiveBytes']);
function validMemoryEstimate(sample, physicalMemoryBytes) {
  if (!finiteCount(physicalMemoryBytes) || !physicalMemoryBytes ||
      VM_MEMORY_FIELDS.some(key => !finiteCount(sample[key]) || sample[key] > physicalMemoryBytes)) return false;
  const freePlusSpeculativeBytes = sample.freeBytes + sample.speculativeBytes;
  const freePlusFileBackedBytes = sample.freeBytes + sample.fileBackedBytes;
  return finiteCount(freePlusSpeculativeBytes) && finiteCount(freePlusFileBackedBytes) &&
    sample.freePlusSpeculativeBytes === freePlusSpeculativeBytes && sample.freePlusFileBackedBytes === freePlusFileBackedBytes;
}
export const DESKTOP_RESOURCE_POLICY = Object.freeze({
  id: 'caddi-macos-free-file-backed-v4',
  systemReserveMetric: 'freePlusFileBackedBytes',
  minimumSystemReserveBytes: 512 * MIB,
  maximumElectronWorkingSetSumBytes: 4 * GIB,
  maximumPhysicalMemoryFraction: 0.25,
  minimumDiskAvailableBytes: 2 * GIB,
  sampleIntervalMs: 500, maximumSampleAgeMs: 2500, maximumSampleDurationMs: 2000,
  minimumHealthySamples: 3, minimumHealthySpanMs: 1000, commandTimeoutMs: 1500,
  vmStatSource: 'https://github.com/apple-oss-distributions/system_cmds/blob/408bba7453608006b89772db185defbac8fe2fd0/vm_stat/vm_stat.c#L132-L135',
  availableEstimateSource: 'https://github.com/chromium/chromium/blob/156.0.8078.48/base/process/process_metrics_apple.mm',
});

export function parseMacVmStat(output) {
  if (typeof output !== 'string' || output.length > 65536) fail('RESOURCE_VMSTAT_INVALID');
  const lines = output.trim().split(/\r?\n/);
  const header = /^Mach Virtual Memory Statistics: \(page size of ([0-9]+) bytes\)$/.exec(lines.shift()?.trim());
  const pageSizeBytes = Number(header?.[1]);
  if (![4096, 16384].includes(pageSizeBytes)) fail('RESOURCE_VMSTAT_INVALID');
  const values = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const item = /^("[^"]+"|[A-Za-z][A-Za-z -]*):\s*([0-9]+)\.\s*$/.exec(line.trim());
    if (!item) fail('RESOURCE_VMSTAT_INVALID');
    const label = item[1].replace(/^"|"$/g, ''), value = Number(item[2]);
    if (values.has(label) || !finiteCount(value)) fail('RESOURCE_VMSTAT_INVALID');
    values.set(label, value);
  }
  const count = label => { if (!values.has(label)) fail('RESOURCE_VMSTAT_INVALID'); return values.get(label); };
  const bytes = label => { const value = count(label) * pageSizeBytes; if (!finiteCount(value)) fail('RESOURCE_VMSTAT_INVALID'); return value; };
  const freeBytes = bytes('Pages free'), speculativeBytes = bytes('Pages speculative'), fileBackedBytes = bytes('File-backed pages');
  const freePlusSpeculativeBytes = freeBytes + speculativeBytes;
  const freePlusFileBackedBytes = freeBytes + fileBackedBytes;
  if (!finiteCount(freePlusSpeculativeBytes) || !finiteCount(freePlusFileBackedBytes)) fail('RESOURCE_VMSTAT_INVALID');
  return Object.freeze({ pageSizeBytes, freeBytes, speculativeBytes, freePlusSpeculativeBytes, fileBackedBytes, freePlusFileBackedBytes,
    purgeableBytes: bytes('Pages purgeable'),
    wiredBytes: bytes('Pages wired down'), compressedBytes: bytes('Pages occupied by compressor'),
    activeBytes: bytes('Pages active'), inactiveBytes: bytes('Pages inactive'),
    pageoutsCount: count('Pageouts'), swapoutsCount: count('Swapouts') });
}

export function parseMacPressure(output) {
  if (typeof output !== 'string' || !/^[124]\s*$/.test(output)) fail('RESOURCE_PRESSURE_UNAVAILABLE');
  const raw = Number(output.trim());
  return Object.freeze({ raw, level: raw === 1 ? 'normal' : raw === 2 ? 'elevated' : 'critical' });
}

function electronMemory(metrics, system) {
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > 1024 || !system ||
      ['total', 'free', 'purgeable', 'fileBacked'].some(key => !finiteCount(system[key]))) fail('RESOURCE_MEMORY_UNAVAILABLE');
  const processes = new Map();
  for (const metric of metrics) {
    if (!Number.isSafeInteger(metric?.pid) || metric.pid <= 0 || !finiteCount(metric.memory?.workingSetSize) ||
        !Number.isFinite(metric.cpu?.percentCPUUsage) || metric.cpu.percentCPUUsage < 0) fail('RESOURCE_MEMORY_UNAVAILABLE');
    const value = { pid: metric.pid, workingSetBytes: metric.memory.workingSetSize * 1024,
      cpuPercent: metric.cpu.percentCPUUsage, renderer: metric.type === 'Tab' };
    if (!finiteCount(value.workingSetBytes)) fail('RESOURCE_MEMORY_UNAVAILABLE');
    const prior = processes.get(value.pid);
    // One PID is charged once; duplicate records retain the larger observation.
    if (!prior || prior.workingSetBytes < value.workingSetBytes) processes.set(value.pid, value);
  }
  const items = [...processes.values()];
  const workingSetSumBytes = items.reduce((sum, item) => sum + item.workingSetBytes, 0);
  if (!finiteCount(workingSetSumBytes) || workingSetSumBytes === 0) fail('RESOURCE_MEMORY_UNAVAILABLE');
  const systemBytes = Object.fromEntries(['total', 'free', 'purgeable', 'fileBacked'].map(key => [key + 'Bytes', system[key] * 1024]));
  if (!systemBytes.totalBytes || Object.values(systemBytes).some(value => !finiteCount(value) || value > systemBytes.totalBytes) ||
      !finiteCount(systemBytes.freeBytes + systemBytes.fileBackedBytes) || systemBytes.freeBytes + systemBytes.fileBackedBytes > systemBytes.totalBytes)
    fail('RESOURCE_MEMORY_UNAVAILABLE');
  const cpuPercentSum = items.reduce((sum, item) => sum + item.cpuPercent, 0);
  if (!Number.isFinite(cpuPercentSum)) fail('RESOURCE_MEMORY_UNAVAILABLE');
  return { workingSetSumBytes, processCount: items.length, rendererCount: items.filter(item => item.renderer).length,
    cpuPercentSum, electronSystem: systemBytes };
}

async function command(file, args) {
  return runFile(file, args, { encoding: 'utf8', timeout: DESKTOP_RESOURCE_POLICY.commandTimeoutMs,
    maxBuffer: 65536, windowsHide: true, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
}

/** All command paths/arguments are fixed. No shell, credentials or target URLs. */
export async function collectDesktopResources({ directory, getAppMetrics, getSystemMemoryInfo,
  physicalMemoryBytes = os.totalmem(), platform = process.platform, now = Date.now,
  runCommand = command, statfs = fs.statfs } = {}) {
  if (platform !== 'darwin') fail('RESOURCE_PLATFORM_UNSUPPORTED');
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof getAppMetrics !== 'function' ||
      typeof getSystemMemoryInfo !== 'function' || typeof now !== 'function') fail('RESOURCE_CONFIGURATION_INVALID');
  assertInteger(physicalMemoryBytes, 'physical memory', { min: 1 });
  const sampledAt = now();
  let vm, pressure, disk, memory;
  try {
    const results = await Promise.allSettled([
      runCommand('/usr/bin/vm_stat', []),
      runCommand('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      statfs(directory),
    ]);
    if (results.some(result => result.status !== 'fulfilled')) fail('RESOURCE_SAMPLE_UNAVAILABLE');
    [vm, pressure, disk] = results.map(result => result.value);
    memory = electronMemory(getAppMetrics(), getSystemMemoryInfo());
  } catch { fail('RESOURCE_SAMPLE_UNAVAILABLE'); }
  const durationMs = now() - sampledAt;
  if (!finiteCount(sampledAt) || !finiteCount(durationMs) || durationMs > DESKTOP_RESOURCE_POLICY.maximumSampleDurationMs) fail('RESOURCE_SAMPLE_STALE');
  const memoryInfo = parseMacVmStat(vm?.stdout), pressureInfo = parseMacPressure(pressure?.stdout);
  const diskAvailableBytes = Number(disk?.bsize) * Number(disk?.bavail);
  if (!finiteCount(diskAvailableBytes) || !validMemoryEstimate(memoryInfo, physicalMemoryBytes) ||
      Object.values(memory.electronSystem).some(value => value > physicalMemoryBytes)) fail('RESOURCE_SAMPLE_INVALID');
  return Object.freeze({ sampledAt, durationMs, physicalMemoryBytes, ...memory, ...memoryInfo,
    pressureRaw: pressureInfo.raw, pressureLevel: pressureInfo.level, diskAvailableBytes });
}

export function evaluateDesktopResources(sample, { now = Date.now() } = {}) {
  const unavailable = reason => Object.freeze({ available: false, healthy: false, level: 'unknown', reason });
  if (!sample || !finiteCount(now) || !finiteCount(sample.sampledAt) || sample.sampledAt > now ||
      now - sample.sampledAt > DESKTOP_RESOURCE_POLICY.maximumSampleAgeMs) return unavailable('RESOURCE_SAMPLE_STALE');
  for (const key of ['workingSetSumBytes', 'physicalMemoryBytes', 'diskAvailableBytes'])
    if (!finiteCount(sample[key])) return unavailable('RESOURCE_SAMPLE_INVALID');
  if (!sample.workingSetSumBytes || !validMemoryEstimate(sample, sample.physicalMemoryBytes) ||
      !['normal', 'elevated', 'critical'].includes(sample.pressureLevel))
    return unavailable('RESOURCE_SAMPLE_INVALID');
  const maximumElectronWorkingSetSumBytes = Math.min(DESKTOP_RESOURCE_POLICY.maximumElectronWorkingSetSumBytes,
    Math.floor(sample.physicalMemoryBytes * DESKTOP_RESOURCE_POLICY.maximumPhysicalMemoryFraction));
  // macOS reports "warn" (elevated) often on a busy Mac with plenty of memory to reclaim; refusing all agent work then
  // made agents hang for minutes. Only critical pressure stops new work. The app, reserve and disk floors still apply.
  const reason = sample.pressureLevel === 'critical' ? 'RESOURCE_OS_PRESSURE' :
    sample.workingSetSumBytes > maximumElectronWorkingSetSumBytes ? 'RESOURCE_APP_MEMORY_LIMIT' :
      sample.freePlusFileBackedBytes < DESKTOP_RESOURCE_POLICY.minimumSystemReserveBytes ? 'RESOURCE_SYSTEM_RESERVE' :
        sample.diskAvailableBytes < DESKTOP_RESOURCE_POLICY.minimumDiskAvailableBytes ? 'RESOURCE_DISK_RESERVE' : null;
  return Object.freeze({ available: true, healthy: reason === null, level: sample.pressureLevel,
    reason, maximumElectronWorkingSetSumBytes });
}

/** Asynchronous bounded sampler. A snapshot never treats a stale reading as safe. */
export function createDesktopResourceMonitor({ onChange = () => {}, now = Date.now, sampleResources, ...configuration } = {}) {
  if (typeof onChange !== 'function' || typeof now !== 'function' ||
      (sampleResources !== undefined && typeof sampleResources !== 'function')) fail('RESOURCE_CONFIGURATION_INVALID');
  const collect = sampleResources ?? (() => collectDesktopResources({ ...configuration, now }));
  let sample = null, previous = null, pending = null, underlying = null, timer = null, running = false, stopped = false;
  let failure = 'RESOURCE_SAMPLE_UNAVAILABLE', consecutiveHealthy = 0, firstHealthyAt = null;
  const changed = () => { try { onChange(); } catch {} };
  function snapshot() {
    const decision = stopped ? { available: false, healthy: false, level: 'unknown', reason: 'RESOURCE_MONITOR_STOPPED' } :
      failure ? { available: false, healthy: false, level: 'unknown', reason: failure } : evaluateDesktopResources(sample, { now: now() });
    const warmed = consecutiveHealthy >= DESKTOP_RESOURCE_POLICY.minimumHealthySamples &&
      firstHealthyAt !== null && sample && sample.sampledAt - firstHealthyAt >= DESKTOP_RESOURCE_POLICY.minimumHealthySpanMs;
    return Object.freeze({ ...decision, healthy: decision.healthy && warmed,
      reason: decision.healthy && !warmed ? 'RESOURCE_WARMUP' : decision.reason,
      sampledAt: sample?.sampledAt ?? null, policyId: DESKTOP_RESOURCE_POLICY.id, consecutiveHealthy,
      sample: sample ? Object.freeze({ ...sample }) : null });
  }
  function takeSample() {
    if (stopped) return Promise.resolve(snapshot());
    if (pending) return pending;
    // A timed-out read may still be inside the OS. Do not accumulate another
    // probe until that actual collector settles; stale snapshots deny admission.
    if (underlying) return Promise.resolve(snapshot());
    pending = (async () => {
      let deadline;
      try {
        underlying = Promise.resolve().then(collect);
        const actual = underlying;
        void actual.finally(() => { if (underlying === actual) underlying = null; }).catch(() => {});
        const value = await Promise.race([actual, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new CaddiError('RESOURCE_SAMPLE_TIMEOUT', 'Resource probe timed out')),
            DESKTOP_RESOURCE_POLICY.maximumSampleDurationMs);
        })]);
        if (stopped) return snapshot();
        const decision = evaluateDesktopResources(value, { now: now() });
        if (!decision.available) fail(decision.reason);
        const countersAdvance = previous && value.sampledAt > previous.sampledAt &&
          value.pageoutsCount >= previous.pageoutsCount && value.swapoutsCount >= previous.swapoutsCount;
        sample = Object.freeze({ ...value, pageoutsDelta: countersAdvance ? value.pageoutsCount - previous.pageoutsCount : null,
          swapoutsDelta: countersAdvance ? value.swapoutsCount - previous.swapoutsCount : null,
          counterIntervalMs: countersAdvance ? value.sampledAt - previous.sampledAt : null });
        if (decision.healthy) {
          if (previous && (value.sampledAt <= previous.sampledAt ||
              value.sampledAt - previous.sampledAt > DESKTOP_RESOURCE_POLICY.maximumSampleAgeMs)) {
            consecutiveHealthy = 0; firstHealthyAt = null;
          }
          consecutiveHealthy++; firstHealthyAt ??= value.sampledAt;
        } else { consecutiveHealthy = 0; firstHealthyAt = null; }
        previous = value; failure = null;
      } catch (error) {
        failure = ['RESOURCE_SAMPLE_TIMEOUT', 'RESOURCE_SAMPLE_STALE', 'RESOURCE_SAMPLE_INVALID', 'RESOURCE_VMSTAT_INVALID',
          'RESOURCE_PRESSURE_UNAVAILABLE', 'RESOURCE_PLATFORM_UNSUPPORTED'].includes(error?.code) ? error.code : 'RESOURCE_SAMPLE_UNAVAILABLE';
        consecutiveHealthy = 0; firstHealthyAt = null;
      } finally { clearTimeout(deadline); pending = null; changed(); }
      return snapshot();
    })();
    return pending;
  }
  async function cycle() {
    await takeSample();
    if (running && !stopped) { timer = setTimeout(cycle, DESKTOP_RESOURCE_POLICY.sampleIntervalMs); timer.unref?.(); }
  }
  return Object.freeze({
    policy: DESKTOP_RESOURCE_POLICY, sample: takeSample, snapshot,
    start() { if (stopped) fail('RESOURCE_MONITOR_STOPPED'); if (!running) { running = true; void cycle(); } return snapshot(); },
    async preflight() {
      const ready = snapshot();
      if (ready.healthy) return ready;
      const began = now();
      for (let attempt = 0; attempt < 5; attempt++) {
        const value = await takeSample();
        if (value.healthy) return value;
        if (value.reason !== 'RESOURCE_WARMUP') fail(value.reason ?? 'RESOURCE_SAMPLE_UNAVAILABLE');
        if (now() - began > 8000) fail('RESOURCE_SAMPLE_TIMEOUT');
        await pause(DESKTOP_RESOURCE_POLICY.sampleIntervalMs);
      }
      fail('RESOURCE_WARMUP');
    },
    stop() { stopped = true; running = false; clearTimeout(timer); timer = null; changed(); return snapshot(); },
  });
}
