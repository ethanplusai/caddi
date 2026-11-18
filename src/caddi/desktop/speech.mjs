import fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { CaddiError, assertId, assertInteger, assertKeys } from '../contracts.mjs';
import { SPEECH_MODEL_ID, SPEECH_SOURCE_COMMIT, SPEECH_PROVENANCE, SPEECH_RESOURCE_DIRECTORY, SPEECH_PINS, BUNDLED_SPEECH_PINS } from './speech-pins.mjs';

const MAX_AUDIO_BYTES = 1_920_000;
const MAX_TEXT_BYTES = 65_536;
const MAX_PROCESS_OUTPUT = 131_072;
const MODEL_ID = SPEECH_MODEL_ID;
const fail = code => { throw new CaddiError(code, 'Local transcription is unavailable. Typed feedback remains available.'); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = s => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(s[k])).join(':');
const stableStamp = s => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs'].map(k => String(s[k])).join(':');
function ctimeOnlyDrift(before, handleAfter, pathAfter) {
  return stamp(handleAfter) === stamp(pathAfter) && stableStamp(before) === stableStamp(handleAfter) &&
    before.ctimeNs !== handleAfter.ctimeNs;
}

// These are the exact local evaluation inputs already inspected in this project.
// Neither the renderer nor a client can select another program, model or argument.
const PINS = SPEECH_PINS.filter(pin => pin.development);
// The same pinned program and model, asked for one segment per word with its
// start and end time (CSV, milliseconds). Used by Live mode to line words up
// with what the pointer was on. Still fixed: no caller supplies an argument.
const wordArguments = (model, input, output) => ['-m', model, '-f', input, '-t', '2', '-l', 'en', '-ng', '-np', '-ml', '1', '-sow', '-ocsv', '-of', output];
const MAX_WORDS = 2000;
/**
 * Words the speaker is likely to use (the page title, names of things on the page), given to the model as its
 * starting context so names come out right. Letters, digits and light punctuation only, bounded, never a flag.
 */
export function speechPrompt(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[^\p{L}\p{N} ,.'&-]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^-+/, '').slice(0, 240).trim();
}

async function directory(value, { privateMode = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) fail('SPEECH_PATH_INVALID');
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022) || (privateMode && (stat.mode & 0o077)) || await fs.realpath(value) !== value) fail('SPEECH_PATH_INVALID');
  return value;
}

async function verifyPinned(file, pin, previous, metadataRetry = 1) {
  if (await fs.realpath(file) !== file) fail('SPEECH_ASSET_INVALID');
  const before = await fs.lstat(file, { bigint: true });
  const size = Number(before.size);
  if (!before.isFile() || Number(before.uid) !== process.getuid() || before.nlink !== 1n ||
      (Number(before.mode) & 0o022) || size <= 0 || size > (pin.maximum ?? pin.bytes) ||
      (pin.bytes && size !== pin.bytes) || (pin.role === 'program' && !(Number(before.mode) & 0o100))) fail('SPEECH_ASSET_INVALID');
  const signature = stamp(before);
  if (previous === signature) return signature;
  const handle = await fs.open(file, C.O_RDONLY | C.O_NOFOLLOW);
  const block = Buffer.alloc(1024 * 1024);
  try {
    if (stamp(await handle.stat({ bigint: true })) !== signature) fail('SPEECH_ASSET_CHANGED');
    const hash = createHash('sha256');
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > size) fail('SPEECH_ASSET_CHANGED');
      hash.update(block.subarray(0, bytesRead));
    }
    const digest = hash.digest('hex');
    if (total !== size || (pin.sha256 && digest !== pin.sha256)) fail('SPEECH_ASSET_INVALID');
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(file, { bigint: true });
    if (stamp(handleAfter) !== signature || stamp(pathAfter) !== signature) {
      // A copied test model has exhibited ctime-only drift during an otherwise
      // pinned read. A fresh full hash is allowed only for that exact case.
      // Inode, mode, link, size, mtime or path/descriptor changes fail closed.
      if (metadataRetry > 0 && ctimeOnlyDrift(before, handleAfter, pathAfter))
        return await verifyPinned(file, pin, undefined, metadataRetry - 1);
      fail('SPEECH_ASSET_CHANGED');
    }
    return signature;
  } finally { block.fill(0); await handle.close(); }
}

async function discover(projectRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('SPEECH_PLATFORM_UNAVAILABLE');
  await directory(projectRoot);
  const signatures = new Map();
  const files = new Map(PINS.map(pin => [pin.role, path.join(projectRoot, pin.development)]));
  const refresh = async () => {
    for (const pin of PINS) signatures.set(pin.role, await verifyPinned(files.get(pin.role), pin, signatures.get(pin.role)));
  };
  await refresh();
  return Object.freeze({
    modelId: MODEL_ID, executable: files.get('program'), refresh,
    arguments: (input, output) => ['-m', files.get('model'), '-f', input, '-t', '2', '-l', 'en', '-ng', '-nt', '-np', '-otxt', '-of', output],
    wordArguments: (input, output) => wordArguments(files.get('model'), input, output),
  });
}

/** The pin to check a bundled file against: the reviewed pin, or for a signed program the recorded signed fingerprint. */
function signedProgramPin(pin, entry) {
  if (!Object.hasOwn(entry, 'signedSha256') && !Object.hasOwn(entry, 'signedBytes')) return pin;
  if (pin.role !== 'program' || typeof entry.signedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.signedSha256) ||
      !Number.isSafeInteger(entry.signedBytes) || entry.signedBytes <= entry.bytes || entry.signedBytes > entry.bytes + 1024 * 1024) fail('SPEECH_ASSET_INVALID');
  return Object.freeze({ ...pin, sha256: entry.signedSha256, bytes: entry.signedBytes });
}
async function verifyCodeSignature(file) {
  const result = await new Promise(resolve => {
    execFile('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 15000 }, error => resolve(!error));
  });
  if (!result) fail('SPEECH_ASSET_INVALID');
}

async function discoverBundled(resourceRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('SPEECH_PLATFORM_UNAVAILABLE');
  // resourceRoot is derived by trusted main from its own module location.
  // Verify the enclosing Resources directory as well as the leaf before use.
  if (path.basename(resourceRoot) !== SPEECH_RESOURCE_DIRECTORY ||
      path.basename(path.dirname(resourceRoot)) !== 'Resources') fail('SPEECH_PATH_INVALID');
  await directory(path.dirname(resourceRoot));
  await directory(resourceRoot);
  const manifestFile = path.join(resourceRoot, 'manifest.json');
  const manifestPin = { role: 'manifest', maximum: 16_384 };
  const files = new Map(BUNDLED_SPEECH_PINS.map(pin => [pin.role, path.join(resourceRoot, pin.bundled)]));
  const signatures = new Map();
  const refresh = async () => {
    // Manifest is checked on every use. It documents exactly the same pins as
    // the executable source; it cannot select a substitute model or program.
    await verifyPinned(manifestFile, { ...manifestPin, sha256: null });
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
    catch { fail('SPEECH_ASSET_INVALID'); }
    if (manifest?.format !== 'caddi-local-speech-v1' || manifest.sourceCommit !== SPEECH_SOURCE_COMMIT ||
        JSON.stringify(manifest.provenance) !== JSON.stringify(SPEECH_PROVENANCE) ||
        manifest.modelId !== MODEL_ID || !Array.isArray(manifest.assets) ||
        manifest.assets.length !== BUNDLED_SPEECH_PINS.length) fail('SPEECH_ASSET_INVALID');
    for (const [index, pin] of BUNDLED_SPEECH_PINS.entries()) {
      const entry = manifest.assets[index];
      if (entry?.role !== pin.role || entry.path !== pin.bundled || entry.sha256 !== pin.sha256 ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > (pin.maximum ?? pin.bytes) ||
          (pin.bytes && entry.bytes !== pin.bytes)) fail('SPEECH_ASSET_INVALID');
      // In a signed app the program carries its code signature, which changes its bytes. The reviewed build is still
      // named by the unsigned fingerprint above; the file must match the fingerprint recorded after signing, and the
      // app's own signature seals this manifest.
      const effective = signedProgramPin(pin, entry);
      const file = files.get(pin.role);
      if ((await fs.lstat(file)).size !== (effective.bytes ?? entry.bytes)) fail('SPEECH_ASSET_INVALID');
      const previous = signatures.get(pin.role);
      signatures.set(pin.role, await verifyPinned(file, effective, previous));
      if (effective !== pin && previous !== signatures.get(pin.role)) await verifyCodeSignature(file);
    }
  };
  await refresh();
  return Object.freeze({ modelId: MODEL_ID, executable: files.get('program'), refresh,
    arguments: (input, output) => ['-m', files.get('model'), '-f', input, '-t', '2', '-l', 'en', '-ng', '-nt', '-np', '-otxt', '-of', output],
    wordArguments: (input, output) => wordArguments(files.get('model'), input, output) });
}

function wav(pcm) {
  const output = Buffer.alloc(44 + pcm.length);
  output.write('RIFF', 0); output.writeUInt32LE(36 + pcm.length, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16000, 24); output.writeUInt32LE(32000, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(pcm.length, 40); pcm.copy(output, 44);
  return output;
}

function copyAudio(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > MAX_AUDIO_BYTES || value.byteLength % 2 ||
      (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) fail('SPEECH_AUDIO_INVALID');
  return Buffer.from(value);
}

async function groupQuiescent(pid) {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-g', String(pid), '-o', 'stat='], { timeout: 2000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }, (error, stdout, stderr) => {
      if (stderr?.trim() || (error && error.code !== 1)) return resolve(false);
      const states = stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (error?.code === 1) return resolve(states.length === 0);
      resolve(states.length > 0 && states.every(s => /^Z[A-Za-z+<>NLRsXl-]*$/.test(s)));
    });
  });
}

async function stopGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM' && await groupQuiescent(child.pid)) return;
    fail('SPEECH_CLEANUP_FAILED');
  }
  // The group may briefly consist of reaped/awaiting-reap zombies.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { process.kill(-child.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      if (error.code === 'EPERM' && await groupQuiescent(child.pid)) return;
      fail('SPEECH_CLEANUP_FAILED');
    }
    if (await groupQuiescent(child.pid)) return;
    await pause(25);
  }
  fail('SPEECH_CLEANUP_FAILED');
}

/** Trusted-main worker only. Process output is counted and discarded, never logged. */
async function runWorker({ executable, args, cwd, outputFile, signal, timeoutMs }) {
  if (signal?.aborted) fail('SPEECH_CANCELLED');
  let child, failure, outputBytes = 0, termination, closed = false, closeResolve;
  const closePromise = new Promise(resolve => { closeResolve = resolve; });
  const terminate = () => {
    if (!termination) termination = stopGroup(child);
    termination.catch(() => {});
    return termination;
  };
  const cancel = code => {
    if (!failure) failure = code;
    void terminate();
  };
  child = spawn(executable, args, { cwd, detached: true, windowsHide: true,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', TMPDIR: cwd, OMP_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const count = chunk => { outputBytes += chunk.length; if (outputBytes > MAX_PROCESS_OUTPUT) cancel('SPEECH_OUTPUT_LIMIT'); };
  child.stdout.on('data', count);
  child.stderr.on('data', count);
  child.once('error', () => { failure ??= 'SPEECH_WORKER_FAILED'; closed = true; closeResolve(); });
  child.once('exit', code => {
    if (code !== 0) failure ??= 'SPEECH_WORKER_FAILED';
    // Also terminate ordinary descendants whose parent exited successfully.
    void terminate();
  });
  child.once('close', () => { closed = true; closeResolve(); });
  const onAbort = () => cancel('SPEECH_CANCELLED');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => cancel('SPEECH_TIMEOUT'), timeoutMs);
  let inspecting = false;
  const fileTimer = setInterval(async () => {
    if (inspecting || closed) return;
    inspecting = true;
    try { if ((await fs.lstat(outputFile)).size > MAX_TEXT_BYTES) cancel('SPEECH_OUTPUT_LIMIT'); }
    catch (error) { if (error.code !== 'ENOENT') cancel('SPEECH_OUTPUT_INVALID'); }
    finally { inspecting = false; }
  }, 50);
  let deadlineTimer;
  const hardDeadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => { failure ??= 'SPEECH_CLEANUP_FAILED'; resolve(); }, timeoutMs + 5000);
  });
  try {
    await Promise.race([closePromise, hardDeadline]);
    await terminate();
    if (!closed) fail('SPEECH_CLEANUP_FAILED');
    if (failure) fail(failure);
    if (signal?.aborted) fail('SPEECH_CANCELLED');
  } finally {
    clearTimeout(timer); clearTimeout(deadlineTimer); clearInterval(fileTimer);
    signal?.removeEventListener('abort', onAbort);
    child.stdout.destroy(); child.stderr.destroy();
  }
}

async function transcript(file) {
  const handle = await fs.open(file, C.O_RDONLY | C.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_TEXT_BYTES) fail('SPEECH_OUTPUT_INVALID');
    bytes = await handle.readFile();
    if (bytes.length > MAX_TEXT_BYTES) fail('SPEECH_OUTPUT_LIMIT');
    const text = bytes.toString('utf8').trim();
    if (text.length > 16_384 || text.includes('\0')) fail('SPEECH_OUTPUT_LIMIT');
    return text;
  } finally { bytes?.fill(0); await handle.close(); }
}

/** whisper-cli CSV: a `start,end,text` header, then `ms,ms,"text"` rows with quotes doubled. Anything else fails closed. */
function parseWords(text) {
  const lines = text.split('\n').filter(line => line !== '');
  if (lines[0] !== 'start,end,text' || lines.length > MAX_WORDS + 1) fail('SPEECH_OUTPUT_INVALID');
  const words = [];
  for (const line of lines.slice(1)) {
    const match = /^(\d{1,9}),(\d{1,9}),"((?:[^"]|"")*)"$/.exec(line);
    if (!match) fail('SPEECH_OUTPUT_INVALID');
    const startMs = Number(match[1]), endMs = Number(match[2]), word = match[3].replace(/""/g, '"');
    if (endMs < startMs) fail('SPEECH_OUTPUT_INVALID');
    if (word.trim()) words.push(Object.freeze({ startMs, endMs, text: word.slice(0, 256) }));
  }
  return { text: words.map(item => item.text).join('').replace(/\s+/g, ' ').trim(), words: Object.freeze(words) };
}

function construct({ assets, temporaryRoot, privacy, timeoutMs, unavailableReason = null }) {
  if (!privacy?.registerObserver || !privacy?.assertCapture) fail('SPEECH_INTEGRATION_REQUIRED');
  let active = null, closed = false, reason = unavailableReason, closing = null, cleanupFailure = null;
  const status = () => Object.freeze({ available: !!assets && !reason && !closed, busy: !!active,
    reason: closed ? 'SPEECH_CLOSED' : reason, model: assets?.modelId ?? MODEL_ID, local: true, maxDurationMs: 60_000, sampleRate: 16_000, channels: 1 });
  function authority(job) {
    if (closed || job.controller.signal.aborted || job.signal?.aborted) fail('SPEECH_CANCELLED');
    privacy.assertCapture(job.binding);
    if (job.assertCurrent) {
      const accepted = job.assertCurrent(job.binding);
      if (accepted === false || accepted?.then) fail('SPEECH_CAPTURE_STALE');
    }
  }
  async function transcribe(input, { signal, assertCurrent, words: timed = false, prompt = '' } = {}) {
    assertKeys(input, ['workspaceId', 'captureId', 'capturePrivacyEpoch', 'pcm16'], ['workspaceId', 'captureId', 'capturePrivacyEpoch', 'pcm16']);
    assertId(input.workspaceId); assertId(input.captureId);
    assertInteger(input.capturePrivacyEpoch, 'capturePrivacyEpoch');
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') fail('SPEECH_INTEGRATION_REQUIRED');
    if (typeof timed !== 'boolean' || (timed && typeof assets?.wordArguments !== 'function')) fail('SPEECH_INTEGRATION_REQUIRED');
    if (closed) fail('SPEECH_CLOSED');
    if (!assets || reason) fail(reason ?? 'SPEECH_UNAVAILABLE');
    if (active) fail('SPEECH_BUSY');
    const binding = Object.freeze({ workspaceId: input.workspaceId, captureId: input.captureId, capturePrivacyEpoch: input.capturePrivacyEpoch });
    const job = { binding, signal, assertCurrent, controller: new AbortController(), pcm: null, directory: null, observer: null, observerAbort: null };
    authority(job);
    job.pcm = copyAudio(input.pcm16);
    let finishResolve, finishReject;
    job.finished = new Promise((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
    job.finished.catch(() => {});
    active = job;
    const abort = () => job.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let text = null, result = null, error = null, cleanupError = null;
    try {
      job.observer = privacy.registerObserver({ workspaceIds: [binding.workspaceId], connectionId: binding.captureId,
        ambientAudio: true, stop: async () => { abort(); await job.finished; return { stopped: true }; } });
      job.observerAbort = abort;
      job.observer.signal.addEventListener('abort', abort, { once: true });
      authority(job);
      await assets.refresh(); authority(job);
      await directory(temporaryRoot, { privateMode: true }); authority(job);
      job.directory = await fs.mkdtemp(path.join(temporaryRoot, 'speech-'));
      job.directoryIdentity = await fs.stat(job.directory);
      await fs.chmod(job.directory, 0o700); authority(job);
      const audioPath = path.join(job.directory, 'audio.wav'), prefix = path.join(job.directory, 'transcript');
      const wave = wav(job.pcm);
      try { await fs.writeFile(audioPath, wave, { flag: 'wx', mode: 0o600 }); }
      finally { wave.fill(0); }
      const outputFile = prefix + (timed ? '.csv' : '.txt');
      await fs.writeFile(outputFile, '', { flag: 'wx', mode: 0o600 });
      authority(job);
      const hint = speechPrompt(prompt);
      await runWorker({ executable: assets.executable, args: [...(timed ? assets.wordArguments : assets.arguments)(audioPath, prefix), ...(hint ? ['--prompt', hint] : [])], cwd: job.directory,
        outputFile, signal: job.controller.signal, timeoutMs });
      authority(job);
      text = await transcript(outputFile); authority(job);
      const timing = timed ? parseWords(text) : null;
      result = Object.freeze({ ...binding, text: timing ? timing.text : text, ...(timing ? { words: timing.words } : {}),
        language: 'en', model: assets.modelId, local: true, audioMs: job.pcm.length / 32 });
    } catch (caught) {
      error = caught instanceof CaddiError ? caught : new CaddiError('SPEECH_UNAVAILABLE', 'Local transcription failed. Typed feedback remains available.');
      if (error.code === 'SPEECH_CLEANUP_FAILED') cleanupError = error;
      if (error.code.startsWith('SPEECH_ASSET')) reason = error.code;
    } finally {
      job.pcm?.fill(0);
      if (job.directory && !cleanupError) {
        try {
          const current = await fs.lstat(job.directory);
          if (!current.isDirectory() || current.dev !== job.directoryIdentity?.dev || current.ino !== job.directoryIdentity?.ino || await fs.realpath(job.directory) !== job.directory) fail('SPEECH_CLEANUP_FAILED');
          await fs.rm(job.directory, { recursive: true, force: false });
        } catch { cleanupError = new CaddiError('SPEECH_CLEANUP_FAILED', 'Local transcription cleanup did not complete.'); }
      }
      signal?.removeEventListener('abort', abort);
      // Recheck after async deletion; a barrier during deletion must drop this text.
      if (!error && !cleanupError) { try { authority(job); } catch (caught) { error = caught; } }
      if (job.observer) {
        job.observer.signal.removeEventListener('abort', job.observerAbort);
        if (!cleanupError) job.observer.unregister();
      }
      text = null;
      if (active === job) active = null;
      if (cleanupError) { reason = 'SPEECH_CLEANUP_FAILED'; cleanupFailure = cleanupError; finishReject(cleanupError); }
      else finishResolve();
    }
    if (cleanupError) throw cleanupError;
    if (error) throw error;
    return result;
  }
  return Object.freeze({
    status, transcribe,
    async cancel(captureId) {
      assertId(captureId);
      if (cleanupFailure) throw cleanupFailure;
      if (!active || active.binding.captureId !== captureId) return { stopped: true };
      const job = active; job.controller.abort(); await job.finished; return { stopped: true };
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => { if (active) { const job = active; job.controller.abort(); await job.finished; } if (cleanupFailure) throw cleanupFailure; return { stopped: true }; })();
      return closing;
    },
  });
}

/** Trusted desktop-main API: receives a project root, never renderer-supplied paths. */
export async function createLocalSpeechBridge({ projectRoot, temporaryRoot, privacy, timeoutMs = 30_000 } = {}) {
  assertInteger(timeoutMs, 'timeoutMs', { min: 1000, max: 90_000 });
  let assets = null, unavailableReason = null;
  try { await directory(temporaryRoot, { privateMode: true }); assets = await discover(projectRoot); }
  catch (error) { unavailableReason = error instanceof CaddiError ? error.code : 'SPEECH_ASSETS_UNAVAILABLE'; }
  return construct({ assets, temporaryRoot, privacy, timeoutMs, unavailableReason });
}

/** Packaged trusted-main entry only; never accepts a renderer-selected root. */
export async function createBundledSpeechBridge({ resourceRoot, temporaryRoot, privacy, timeoutMs = 30_000 } = {}) {
  assertInteger(timeoutMs, 'timeoutMs', { min: 1000, max: 90_000 });
  let assets = null, unavailableReason = null;
  try { await directory(temporaryRoot, { privateMode: true }); assets = await discoverBundled(resourceRoot); }
  catch (error) { unavailableReason = error instanceof CaddiError ? error.code : 'SPEECH_ASSETS_UNAVAILABLE'; }
  return construct({ assets, temporaryRoot, privacy, timeoutMs, unavailableReason });
}

// Main-process-only test hooks. Never included in a preload/contextBridge surface.
export const speechTestHooks = Object.freeze({ copyAudio, wav, verifyPinned, ctimeOnlyDrift, discoverBundled, runWorker, construct, parseWords });
