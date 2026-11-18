// Test-only process ownership and evidence helpers. No application entry imports this file.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const FAULT_LIMITS = Object.freeze({ totalMs: 120000, workMs: 108000, childMs: 65000, stepMs: 7000,
  maximumProcesses: 64, maximumLogBytes: 262144, maximumRequests: 128, maximumNativeWindows: 1 });
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The validated file read can finish with a previous checkpoint while the exact
// child writes its final checkpoint and exits. Exit is observed only afterward;
// one final validated read is then authoritative. Never infer success from exit.
export async function readCheckpointAtExit({ readState, hasExited, requested }) {
  let value = await readState();
  if (value?.status === 'failed') throw new Error('FAULT_CHILD_REPORTED_FAILURE');
  if (value?.status === requested) return value;
  if (!hasExited()) return null;
  value = await readState();
  if (value?.status === 'failed') throw new Error('FAULT_CHILD_REPORTED_FAILURE');
  if (value?.status === requested) return value;
  throw new Error('FAULT_CHILD_EARLY_EXIT');
}

export function parseProcessRows(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) throw new Error('FAULT_PROCESS_OUTPUT');
  const rows = text.trim() ? text.trim().split('\n') : [];
  if (rows.length > FAULT_LIMITS.maximumProcesses) throw new Error('FAULT_PROCESS_LIMIT');
  return rows.map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) throw new Error('FAULT_PROCESS_FORMAT');
    const [pid, ppid, pgid, uid] = match.slice(1, 5).map(Number);
    if (![pid, ppid, pgid, uid].every(Number.isSafeInteger) || pid < 1 || pgid < 1 || ppid < 0 || uid < 0) throw new Error('FAULT_PROCESS_FORMAT');
    return { pid, ppid, pgid, uid, started: match[5].replace(/\s+/g, ' '), executable: match[6] };
  });
}
async function ps(selector, value) {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(value) || value <= 1 || !['-p', '-g'].includes(selector)) throw new Error('FAULT_PROCESS_PLATFORM');
  try {
    const result = await run('/bin/ps', ['-ww', selector, String(value), '-o', 'pid=,ppid=,pgid=,uid=,lstart=,comm='],
      { timeout: 1500, maxBuffer: 32768, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    return parseProcessRows(result.stdout);
  } catch (error) {
    if (error.code === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return [];
    throw error;
  }
}
export const processIdentity = async pid => {
  const values = await ps('-p', pid);
  if (values.length > 1 || (values.length && values[0].pid !== pid)) throw new Error('FAULT_PROCESS_IDENTITY');
  return values[0] ?? null;
};
export const processGroup = pgid => ps('-g', pgid);
export function sameProcess(expected, actual) {
  return !!expected && !!actual && ['pid', 'pgid', 'uid', 'started', 'executable'].every(key => expected[key] === actual[key]);
}
export function validateOwnedGroup(rows, { mainPid, uid, bundlePath, mainExecutable }) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > FAULT_LIMITS.maximumProcesses || new Set(rows.map(row => row.pid)).size !== rows.length) return false;
  const byId = new Map(rows.map(row => [row.pid, row]));
  const main = byId.get(mainPid);
  if (!main || main.pgid !== mainPid || main.uid !== uid || main.executable !== mainExecutable) return false;
  for (const row of rows) {
    if (row.pgid !== mainPid || row.uid !== uid || !path.isAbsolute(row.executable) ||
        (row.executable !== mainExecutable && !row.executable.startsWith(bundlePath + path.sep))) return false;
    let ancestor = row, remaining = rows.length;
    while (ancestor.pid !== mainPid && remaining-- > 0) { ancestor = byId.get(ancestor.ppid); if (!ancestor) return false; }
    if (ancestor.pid !== mainPid) return false;
  }
  return true;
}
export function validateGpuIdentity(metric, identity, { mainPid, uid, bundlePath }) {
  return metric?.type === 'GPU' && Number.isSafeInteger(metric.pid) && metric.pid > 1 && metric.pid !== mainPid &&
    Number.isFinite(metric.creationTime) && metric.creationTime > 0 && identity?.pid === metric.pid &&
    identity.ppid === mainPid && identity.pgid === mainPid && identity.uid === uid &&
    path.isAbsolute(identity.executable) && identity.executable.startsWith(bundlePath + path.sep) &&
    typeof identity.started === 'string' && identity.started.length > 0;
}
export async function writePrivateJSON(filename, value) {
  const handle = await fs.open(filename, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
export async function sourceEvidence(root) {
  const files = [];
  async function walk(relative) {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.equal(entry.isSymbolicLink(), false, 'Source inventory does not follow symlinks');
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else { const bytes = await fs.readFile(path.join(root, filename)); files.push({ path: filename, bytes: bytes.length, sha256: digest(bytes) }); }
      assert.ok(files.length <= 1024);
    }
  }
  await walk('src/caddi');
  for (const filename of ['package.json', 'package-lock.json', 'scripts/package-caddi.mjs',
    'test/caddi-fault-driver.mjs', 'test/caddi-fault-child.mjs', 'test/caddi-fault-support.mjs', 'test/caddi-fault-support.test.mjs']) {
    const bytes = await fs.readFile(path.join(root, filename)); files.push({ path: filename, bytes: bytes.length, sha256: digest(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 2000, maxBuffer: 8192, encoding: 'utf8' })).stdout.trim();
  return { sha256: digest(JSON.stringify(files)), head, files };
}
