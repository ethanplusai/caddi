import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMacVmStat, parseMacPressure, collectDesktopResources, evaluateDesktopResources,
  createDesktopResourceMonitor, DESKTOP_RESOURCE_POLICY } from '../src/caddi/desktop/resources.mjs';

const MIB = 1024 * 1024, GIB = 1024 * MIB;
const code = value => error => error?.code === value;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const vmStat = ({ free = 10000, speculative = 100000, fileBacked = 1000000, pageSize = 16384 } = {}) => [
  'Mach Virtual Memory Statistics: (page size of ' + pageSize + ' bytes)',
  'Pages free: ' + free + '.', 'Pages active: 900000.', 'Pages inactive: 800000.',
  'Pages speculative: ' + speculative + '.', 'Pages throttled: 0.', 'Pages wired down: 200000.',
  'Pages purgeable: 30000.', '"File-backed pages": ' + fileBacked + '.', 'Pages occupied by compressor: 400000.',
  'Pageouts: 12345.', 'Swapouts: 67890.', '',
].join('\n');
const goodSample = (sampledAt, extra = {}) => {
  const value = { sampledAt, durationMs: 2, physicalMemoryBytes: 48 * GIB,
    workingSetSumBytes: 500 * MIB, freeBytes: 256 * MIB, speculativeBytes: 128 * MIB, fileBackedBytes: 2 * GIB,
    purgeableBytes: 0, wiredBytes: 0, compressedBytes: 0, activeBytes: 0, inactiveBytes: 0,
    diskAvailableBytes: 100 * GIB, pressureLevel: 'normal', pressureRaw: 1, pageoutsCount: 10, swapoutsCount: 20, ...extra };
  return { ...value,
    freePlusSpeculativeBytes: Object.hasOwn(extra, 'freePlusSpeculativeBytes') ? extra.freePlusSpeculativeBytes : value.freeBytes + value.speculativeBytes,
    freePlusFileBackedBytes: Object.hasOwn(extra, 'freePlusFileBackedBytes') ? extra.freePlusFileBackedBytes : value.freeBytes + value.fileBackedBytes };
};

test('vm_stat estimates available memory as displayed free plus file-backed, retaining free/spec diagnostics', () => {
  const parsed = parseMacVmStat(vmStat({ free: 100, speculative: 200 }));
  assert.equal(parsed.freeBytes, 100 * 16384);
  assert.equal(parsed.speculativeBytes, 200 * 16384);
  assert.equal(parsed.freePlusSpeculativeBytes, 300 * 16384);
  assert.equal(parsed.fileBackedBytes, 1000000 * 16384);
  assert.equal(parsed.freePlusFileBackedBytes, 1000100 * 16384);
  assert.notEqual(parsed.freePlusFileBackedBytes, parsed.freePlusSpeculativeBytes + parsed.fileBackedBytes);
  assert.equal(parsed.purgeableBytes, 30000 * 16384);
  assert.equal(parsed.pageoutsCount, 12345);
  assert.equal(parsed.swapoutsCount, 67890);
  assert.equal(parseMacVmStat(vmStat({ free: 100, speculative: 200, pageSize: 4096 })).freePlusSpeculativeBytes, 300 * 4096);
  assert.equal(parseMacVmStat(vmStat({ free: 100, speculative: 200, pageSize: 4096 })).freePlusFileBackedBytes, 1000100 * 4096);
});

test('malformed, duplicated, missing, overflowed or unsupported vm_stat fields fail closed', () => {
  for (const input of [vmStat().replace('Pages speculative: 100000.\n', ''), vmStat() + 'Pages free: 1.\n',
    vmStat().replace('100000.', '-1.'), vmStat({ pageSize: 65536 }),
    vmStat().replace('Pages free: 10000.', 'Pages free: 999999999999999999999.'),
    vmStat().replace('Pages free: 10000.', 'Pages free: Infinity.'), vmStat({ fileBacked: Number.MAX_SAFE_INTEGER }),
    vmStat().replace('"File-backed pages": 1000000.\n', ''), 'garbage', vmStat() + 'not a counter'])
    assert.throws(() => parseMacVmStat(input), code('RESOURCE_VMSTAT_INVALID'));
});

test('OS pressure uses exported dispatch flags; internal enum zero and unknown combinations are denied', () => {
  assert.deepEqual(parseMacPressure('1\n'), { raw: 1, level: 'normal' });
  assert.equal(parseMacPressure('2\n').level, 'elevated'); assert.equal(parseMacPressure('4\n').level, 'critical');
  for (const value of ['0', '3', '5', '', 'normal', 'kern.memorystatus_vm_pressure_level: 1', '1\n4'])
    assert.throws(() => parseMacPressure(value), code('RESOURCE_PRESSURE_UNAVAILABLE'));
});

test('collector uses fixed read-only argv, KiB conversion and one conservative charge per process', async () => {
  const called = [], now = () => 1000;
  const sample = await collectDesktopResources({ directory: '/owned/run', platform: 'darwin', now, physicalMemoryBytes: 48 * GIB,
    runCommand: async (file, args) => { called.push({ file, args }); return { stdout: file.endsWith('vm_stat') ? vmStat() : '1\n' }; },
    statfs: async directory => { assert.equal(directory, '/owned/run'); return { bsize: 4096, bavail: 100 * GIB / 4096 }; },
    getAppMetrics: () => [
      { pid: 100, type: 'Browser', memory: { workingSetSize: 100 * 1024 }, cpu: { percentCPUUsage: 1 } },
      { pid: 100, type: 'Browser', memory: { workingSetSize: 90 * 1024 }, cpu: { percentCPUUsage: 1 } },
      { pid: 101, type: 'Tab', memory: { workingSetSize: 200 * 1024 }, cpu: { percentCPUUsage: 2 } },
    ], getSystemMemoryInfo: () => ({ total: 48 * GIB / 1024, free: 123, purgeable: 456, fileBacked: 789 }),
  });
  assert.deepEqual(called, [{ file: '/usr/bin/vm_stat', args: [] },
    { file: '/usr/sbin/sysctl', args: ['-n', 'kern.memorystatus_vm_pressure_level'] }]);
  assert.equal(sample.workingSetSumBytes, 300 * MIB); assert.equal(sample.processCount, 2); assert.equal(sample.rendererCount, 1);
  assert.equal(sample.electronSystem.freeBytes, 123 * 1024);
  assert.equal(sample.freePlusSpeculativeBytes, 110000 * 16384);
  assert.equal(sample.freePlusFileBackedBytes, 1010000 * 16384);
  // The admission estimate uses one vm_stat snapshot, not a mix with the later
  // independent Electron system-memory observation (kept as diagnostics).
  assert.notEqual(sample.freePlusFileBackedBytes, sample.electronSystem.freeBytes + sample.electronSystem.fileBackedBytes);
  assert.equal(sample.diskAvailableBytes, 100 * GIB);
});

test('collector denies missing metrics, failed probes and unsupported platforms without optimistic fallback', async () => {
  const configuration = { directory: '/owned/run', platform: 'darwin', now: () => 1000,
    runCommand: async file => ({ stdout: file.endsWith('vm_stat') ? vmStat() : '1\n' }),
    statfs: async () => ({ bsize: 4096, bavail: 100 * GIB / 4096 }),
    getAppMetrics: () => [{ pid: 1, type: 'Browser', memory: { workingSetSize: 100 * 1024 }, cpu: { percentCPUUsage: 0 } }],
    getSystemMemoryInfo: () => ({ total: 48 * GIB / 1024, free: 1, purgeable: 2, fileBacked: 3 }) };
  await assert.rejects(collectDesktopResources({ ...configuration, platform: 'linux' }), code('RESOURCE_PLATFORM_UNSUPPORTED'));
  await assert.rejects(collectDesktopResources({ ...configuration, runCommand: async () => { throw new Error('unavailable'); } }), code('RESOURCE_SAMPLE_UNAVAILABLE'));
  await assert.rejects(collectDesktopResources({ ...configuration, getAppMetrics: () => [] }), code('RESOURCE_SAMPLE_UNAVAILABLE'));
  await assert.rejects(collectDesktopResources({ ...configuration, getSystemMemoryInfo: () => ({ free: 1 }) }), code('RESOURCE_SAMPLE_UNAVAILABLE'));
  await assert.rejects(collectDesktopResources({ ...configuration,
    getSystemMemoryInfo: () => ({ total: 48 * GIB / 1024, free: 40 * GIB / 1024, purgeable: 0, fileBacked: 40 * GIB / 1024 }) }), code('RESOURCE_SAMPLE_UNAVAILABLE'));
  await assert.rejects(collectDesktopResources({ ...configuration,
    runCommand: async file => ({ stdout: file.endsWith('vm_stat') ? vmStat({ fileBacked: 49 * GIB / 16384 }) : '1\n' }) }), code('RESOURCE_SAMPLE_INVALID'));
});

test('all resource thresholds and normal pressure are independent gates and retain exact safety floors', () => {
  assert.equal(DESKTOP_RESOURCE_POLICY.minimumSystemReserveBytes, 512 * MIB);
  assert.equal(DESKTOP_RESOURCE_POLICY.maximumElectronWorkingSetSumBytes, 4 * GIB);
  assert.equal(DESKTOP_RESOURCE_POLICY.minimumDiskAvailableBytes, 2 * GIB);
  assert.equal(DESKTOP_RESOURCE_POLICY.id, 'caddi-macos-free-file-backed-v4');
  assert.equal(DESKTOP_RESOURCE_POLICY.systemReserveMetric, 'freePlusFileBackedBytes');
  assert.equal(evaluateDesktopResources(goodSample(1000), { now: 1000 }).healthy, true);
  for (const [extra, reason] of [
    [{ freeBytes: 256 * MIB, fileBackedBytes: 256 * MIB - 1 }, 'RESOURCE_SYSTEM_RESERVE'],
    [{ diskAvailableBytes: 2 * GIB - 1 }, 'RESOURCE_DISK_RESERVE'],
    [{ workingSetSumBytes: 4 * GIB + 1 }, 'RESOURCE_APP_MEMORY_LIMIT'],
    [{ physicalMemoryBytes: 4 * GIB, workingSetSumBytes: GIB + 1 }, 'RESOURCE_APP_MEMORY_LIMIT'],
    [{ pressureLevel: 'elevated' }, null],
    [{ pressureLevel: 'critical' }, 'RESOURCE_OS_PRESSURE'],
  ]) assert.equal(evaluateDesktopResources(goodSample(1000, extra), { now: 1000 }).reason, reason);
  assert.equal(evaluateDesktopResources(goodSample(1000), { now: 4000 }).available, false);
  assert.equal(evaluateDesktopResources(goodSample(1001), { now: 1000 }).available, false);
  assert.equal(evaluateDesktopResources(goodSample(1000, { freePlusSpeculativeBytes: 100 * GIB }), { now: 1000 }).available, false);
});

test('cache-heavy normal pressure can admit without requiring unused free pages or lowering any floor', () => {
  const sample = goodSample(1000, { freeBytes: 50 * MIB, speculativeBytes: 100 * MIB, fileBackedBytes: 14 * GIB,
    inactiveBytes: 17 * GIB, purgeableBytes: 3 * GIB });
  assert.ok(sample.freePlusSpeculativeBytes < 512 * MIB);
  assert.equal(sample.freePlusFileBackedBytes, 14 * GIB + 50 * MIB);
  assert.equal(evaluateDesktopResources(sample, { now: 1000 }).healthy, true);
  assert.equal(evaluateDesktopResources({ ...sample, pressureLevel: 'elevated' }, { now: 1000 }).healthy, true, 'macOS "warn" alone does not stop agents');
  assert.equal(evaluateDesktopResources({ ...sample, pressureLevel: 'critical' }, { now: 1000 }).reason, 'RESOURCE_OS_PRESSURE');
  assert.equal(evaluateDesktopResources({ ...sample, workingSetSumBytes: 4 * GIB + 1 }, { now: 1000 }).reason, 'RESOURCE_APP_MEMORY_LIMIT');
  assert.equal(evaluateDesktopResources({ ...sample, diskAvailableBytes: 2 * GIB - 1 }, { now: 1000 }).reason, 'RESOURCE_DISK_RESERVE');
  assert.equal(evaluateDesktopResources(sample, { now: 4000 }).reason, 'RESOURCE_SAMPLE_STALE');
});

test('inactive purgeable and speculative categories cannot rescue an insufficient available estimate', () => {
  const sample = goodSample(1000, { freeBytes: 100 * MIB, speculativeBytes: 128 * MIB, fileBackedBytes: 300 * MIB,
    inactiveBytes: 17 * GIB, purgeableBytes: 3 * GIB });
  assert.ok(sample.freePlusFileBackedBytes + sample.speculativeBytes > 512 * MIB);
  assert.equal(evaluateDesktopResources(sample, { now: 1000 }).reason, 'RESOURCE_SYSTEM_RESERVE');
  assert.equal(evaluateDesktopResources(goodSample(1000, { freeBytes: 256 * MIB, fileBackedBytes: 256 * MIB }), { now: 1000 }).healthy, true);
});

test('missing malformed inconsistent overflowed or physically impossible estimate fields fail closed', () => {
  for (const extra of [
    { freeBytes: undefined }, { fileBackedBytes: null }, { fileBackedBytes: -1 }, { fileBackedBytes: NaN },
    { freePlusFileBackedBytes: Infinity }, { freePlusFileBackedBytes: 999 }, { freePlusSpeculativeBytes: 999 },
    { freeBytes: Number.MAX_SAFE_INTEGER, fileBackedBytes: Number.MAX_SAFE_INTEGER },
    { fileBackedBytes: 49 * GIB }, { freeBytes: 30 * GIB, fileBackedBytes: 30 * GIB },
    { freeBytes: 30 * GIB, speculativeBytes: 30 * GIB }, { inactiveBytes: 49 * GIB },
  ]) {
    const result = evaluateDesktopResources(goodSample(1000, extra), { now: 1000 });
    assert.equal(result.available, false); assert.equal(result.reason, 'RESOURCE_SAMPLE_INVALID');
  }
});

test('monitor needs three healthy fresh samples spanning one second and resets after pressure', async t => {
  let clock = 1000, pressure = 'normal', calls = 0;
  const monitor = createDesktopResourceMonitor({ now: () => clock, sampleResources: async () => { calls++; return goodSample(clock, { pressureLevel: pressure, pageoutsCount: calls, swapoutsCount: calls * 2 }); } });
  t.after(() => monitor.stop());
  assert.equal((await monitor.sample()).healthy, false);
  clock = 1500; assert.equal((await monitor.sample()).healthy, false);
  clock = 2000; assert.equal((await monitor.sample()).healthy, true);
  const before = calls; assert.equal((await monitor.preflight()).healthy, true); assert.equal(calls, before);
  assert.equal(monitor.snapshot().sample.pageoutsDelta, 1); assert.equal(monitor.snapshot().sample.swapoutsDelta, 2);
  pressure = 'critical'; clock = 2500; assert.equal((await monitor.sample()).reason, 'RESOURCE_OS_PRESSURE');
  pressure = 'normal'; clock = 3000; assert.equal((await monitor.sample()).healthy, false);
  clock = 3500; assert.equal((await monitor.sample()).healthy, false);
  clock = 4000; assert.equal((await monitor.sample()).healthy, true);
  clock = 7000; assert.equal(monitor.snapshot().healthy, false); assert.equal(monitor.snapshot().reason, 'RESOURCE_SAMPLE_STALE');
});

test('cached timestamps cannot warm the monitor; fresh sampling gaps reset health', async t => {
  let clock = 1000, sampledAt = 1000;
  const monitor = createDesktopResourceMonitor({ now: () => clock, sampleResources: async () => goodSample(sampledAt) });
  t.after(() => monitor.stop());
  await monitor.sample(); clock = 1500; await monitor.sample(); clock = 2000; await monitor.sample();
  assert.equal(monitor.snapshot().healthy, false); assert.equal(monitor.snapshot().consecutiveHealthy, 1);
  sampledAt = clock = 5000; await monitor.sample(); assert.equal(monitor.snapshot().consecutiveHealthy, 1);
});

test('a hung collector times out but retains its single in-flight slot until the actual read settles', { timeout: 5000 }, async t => {
  const gate = deferred(); let calls = 0, clock = 1000;
  const monitor = createDesktopResourceMonitor({ now: () => clock, sampleResources: () => { calls++; return gate.promise; } });
  t.after(() => monitor.stop());
  const first = monitor.sample(), same = monitor.sample(); assert.equal(first, same);
  assert.equal((await first).reason, 'RESOURCE_SAMPLE_TIMEOUT');
  for (let i = 0; i < 5; i++) assert.equal((await monitor.sample()).healthy, false);
  assert.equal(calls, 1);
  clock = 4000; gate.resolve(goodSample(1000)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.snapshot().healthy, false);
  monitor.stop(); assert.equal(monitor.snapshot().reason, 'RESOURCE_MONITOR_STOPPED');
});
