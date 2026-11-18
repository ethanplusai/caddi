import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalSpeechBridge, createBundledSpeechBridge, speechTestHooks } from '../src/caddi/desktop/speech.mjs';
import { SPEECH_MODEL_ID, SPEECH_SOURCE_COMMIT, SPEECH_PROVENANCE, BUNDLED_SPEECH_PINS } from '../src/caddi/desktop/speech-pins.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(projectRoot, '.test-artifacts', 'caddi-desktop-speech-tests');
const pcm = () => Buffer.alloc(3200);
const input = (captureId = 'capture-a', workspaceId = 'workspace-a') => ({ workspaceId, captureId, capturePrivacyEpoch: 0, pcm16: pcm() });
const codeIs = expected => error => expected.includes(error.code);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function eventually(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Timed out waiting for synthetic worker');
}
async function root(t) {
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const value = await fs.realpath(await fs.mkdtemp(path.join(base, 'case-')));
  await fs.chmod(value, 0o700);
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}
const fixtureSource = `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [mode,input,prefix] = process.argv.slice(2);
const write = value => fs.writeFileSync(prefix + '.txt', value);
if (mode === 'ok') { write('Move the title above the list.'); process.stdout.write('synthetic private output, discarded'); }
else if (mode === 'slow') { fs.writeFileSync(prefix + '.started', 'started'); setInterval(() => {}, 1000); }
else if (mode === 'flood') { process.stdout.write(Buffer.alloc(262144, 'x')); setInterval(() => {}, 1000); }
else if (mode === 'badtext') write(Buffer.alloc(70000, 'x'));
else if (mode === 'words') fs.writeFileSync(prefix + '.csv', 'start,end,text\\n0,0,""\\n0,280," Make"\\n280,510," this"\\n510,900," \"\"big\"\"."\\n');
else if (mode === 'badwords') fs.writeFileSync(prefix + '.csv', 'start,end,text\\n0,280,Make\\n');
else if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
  fs.writeFileSync(prefix + '.pid', String(child.pid));
  write('Synthetic result'); process.exit(0);
}
else process.exit(2);
`;
async function fixture(t, mode = 'ok', refresh = async () => {}) {
  const temporaryRoot = await root(t);
  const program = path.join(temporaryRoot, 'worker.mjs');
  await fs.writeFile(program, fixtureSource, { mode: 0o600 });
  const assets = { modelId: 'synthetic-worker', executable: process.execPath, refresh,
    arguments: (audio, prefix) => [program, mode, audio, prefix] };
  const privacy = createControlCoordinator();
  const bridge = speechTestHooks.construct({ assets, temporaryRoot, privacy, timeoutMs: 1000 });
  t.after(async () => { await bridge.close(); privacy.dispose(); });
  return { temporaryRoot, assets, privacy, bridge };
}
async function workerFiles(t, mode) {
  const data = await fixture(t, mode);
  const output = path.join(data.temporaryRoot, 'result');
  await fs.writeFile(output + '.txt', '', { mode: 0o600 });
  return { ...data, options: { executable: data.assets.executable, args: data.assets.arguments('unused', output),
    cwd: data.temporaryRoot, outputFile: output + '.txt', timeoutMs: 1000 }, output };
}
function waveData(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), name = bytes.toString('ascii', offset, offset + 4);
    if (name === 'data') return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('No PCM data in synthetic WAV');
}

test('PCM bounds and the exact mono 16 kHz WAV wrapper', () => {
  for (const value of [null, [], Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(1_920_002), new Uint8Array(new SharedArrayBuffer(4))]) {
    assert.throws(() => speechTestHooks.copyAudio(value), codeIs(['SPEECH_AUDIO_INVALID']));
  }
  const source = Buffer.from([0, 0, 255, 127, 0, 128]);
  const owned = speechTestHooks.copyAudio(source), wav = speechTestHooks.wav(owned);
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16); assert.deepEqual(waveData(wav), source);
  owned.fill(0); assert.equal(source[2], 255);
});

test('asset verification detects altered bytes, hard links and symlinks', async t => {
  const dir = await root(t), file = path.join(dir, 'asset');
  await fs.writeFile(file, 'abcdefgh', { mode: 0o600 });
  const pin = { bytes: 8, sha256: createHash('sha256').update('abcdefgh').digest('hex') };
  const cached = await speechTestHooks.verifyPinned(file, pin);
  assert.equal(await speechTestHooks.verifyPinned(file, pin, cached), cached);
  await fs.writeFile(file, 'abcdEfgh');
  await assert.rejects(speechTestHooks.verifyPinned(file, pin, cached), codeIs(['SPEECH_ASSET_INVALID']));
  await fs.writeFile(file, 'abcdefgh');
  await fs.link(file, path.join(dir, 'hard'));
  await assert.rejects(speechTestHooks.verifyPinned(file, pin), codeIs(['SPEECH_ASSET_INVALID']));
  await fs.unlink(path.join(dir, 'hard'));
  await fs.symlink(file, path.join(dir, 'link'));
  await assert.rejects(speechTestHooks.verifyPinned(path.join(dir, 'link'), pin), codeIs(['SPEECH_ASSET_INVALID']));
});

test('only matching path and descriptor ctime drift may get one pinned rehash', () => {
  const before = { dev:1n, ino:2n, mode:0o100600n, uid:501n, gid:20n, nlink:1n,
    size:77n, mtimeNs:1000n, ctimeNs:1000n };
  const later = { ...before, ctimeNs:1001n };
  assert.equal(speechTestHooks.ctimeOnlyDrift(before, later, later), true);
  for (const changed of [
    { ...later, ino:3n }, { ...later, mtimeNs:1001n }, { ...later, size:78n },
    { ...later, mode:0o100644n }, { ...later, nlink:2n }, { ...later, dev:2n },
  ]) assert.equal(speechTestHooks.ctimeOnlyDrift(before, changed, changed), false);
  assert.equal(speechTestHooks.ctimeOnlyDrift(before, later, { ...later, ino:3n }), false);
  assert.equal(speechTestHooks.ctimeOnlyDrift(before, before, before), false);
});

test('missing local assets produce unavailable status without starting a worker', async t => {
  const temporaryRoot = await root(t), privacy = createControlCoordinator();
  const bridge = await createLocalSpeechBridge({ projectRoot: temporaryRoot, temporaryRoot, privacy });
  assert.equal(bridge.status().available, false);
  assert.equal(bridge.status().local, true);
  assert.equal(bridge.status().busy, false);
  await assert.rejects(bridge.transcribe(input()), error => error.code.startsWith('SPEECH_'));
  await bridge.close(); privacy.dispose();
});

test('successful local worker result preserves capture ownership and removes all temporary audio', async t => {
  const { bridge, temporaryRoot } = await fixture(t);
  const source = input();
  const result = await bridge.transcribe(source, { assertCurrent: binding => binding.captureId === 'capture-a' });
  assert.equal(result.text, 'Move the title above the list.');
  assert.equal(result.workspaceId, 'workspace-a'); assert.equal(result.captureId, 'capture-a');
  assert.equal(result.audioMs, 100); assert.equal(result.local, true);
  assert.deepEqual(await fs.readdir(temporaryRoot), ['worker.mjs']);
  assert.equal(bridge.status().busy, false);
  assert.equal(source.pcm16.byteLength, 3200);
});

test('concurrent submission is rejected and cancellation before spawn drains the observer', async t => {
  const entered = deferred(), resume = deferred();
  const { bridge, privacy, temporaryRoot } = await fixture(t, 'ok', async () => { entered.resolve(); await resume.promise; });
  const pending = bridge.transcribe(input());
  const rejected = assert.rejects(pending, codeIs(['SPEECH_CANCELLED']));
  await entered.promise;
  await assert.rejects(bridge.transcribe(input('capture-b')), codeIs(['SPEECH_BUSY']));
  const cancelled = bridge.cancel('capture-a');
  resume.resolve();
  assert.deepEqual(await cancelled, { stopped: true }); await rejected;
  assert.deepEqual(await fs.readdir(temporaryRoot), ['worker.mjs']);
  const barrier = await privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a', timeoutMs: 1000 });
  assert.equal(barrier.barrierReady, true);
});

test('a privacy barrier in another workspace cancels ambient audio processing and waits for cleanup', async t => {
  const { bridge, privacy, temporaryRoot } = await fixture(t, 'slow');
  const pending = bridge.transcribe(input());
  const rejected = assert.rejects(pending, codeIs(['SPEECH_CANCELLED', 'PRIVACY_BLOCKED']));
  await eventually(async () => {
    const entries = await fs.readdir(temporaryRoot);
    const job = entries.find(name => name.startsWith('speech-'));
    return job && (await fs.readdir(path.join(temporaryRoot, job))).includes('transcript.started');
  });
  const barrier = await privacy.beginPrivacyBarrier({ workspaceId: 'workspace-b', timeoutMs: 2500 });
  assert.equal(barrier.barrierReady, true); await rejected;
  assert.deepEqual(await fs.readdir(temporaryRoot), ['worker.mjs']);
  assert.equal(bridge.status().busy, false);
});

test('revoked host capture binding drops a delayed transcript and async guards are rejected', async t => {
  const entered = deferred(), resume = deferred(); let valid = true;
  const { bridge, temporaryRoot } = await fixture(t, 'ok', async () => { entered.resolve(); await resume.promise; });
  const pending = bridge.transcribe(input(), { assertCurrent: () => valid });
  const rejected = assert.rejects(pending, codeIs(['SPEECH_CAPTURE_STALE']));
  await entered.promise; valid = false; resume.resolve(); await rejected;
  assert.deepEqual(await fs.readdir(temporaryRoot), ['worker.mjs']);
  await assert.rejects(bridge.transcribe(input('capture-b'), { assertCurrent: async () => true }), codeIs(['SPEECH_CAPTURE_STALE']));
  await assert.rejects(bridge.transcribe({ ...input('capture-b'), executable: '/bin/sh' }), codeIs(['INVALID_ARGUMENT']));
});

test('worker deadline and process output bounds terminate the owned process group', async t => {
  const slow = await workerFiles(t, 'slow');
  await assert.rejects(speechTestHooks.runWorker({ ...slow.options, timeoutMs: 100 }), codeIs(['SPEECH_TIMEOUT']));
  const flood = await workerFiles(t, 'flood');
  await assert.rejects(speechTestHooks.runWorker(flood.options), codeIs(['SPEECH_OUTPUT_LIMIT']));
});

test('oversized transcript is refused and its transient files are removed', async t => {
  const { bridge, temporaryRoot } = await fixture(t, 'badtext');
  await assert.rejects(bridge.transcribe(input()), codeIs(['SPEECH_OUTPUT_INVALID', 'SPEECH_OUTPUT_LIMIT']));
  assert.deepEqual(await fs.readdir(temporaryRoot), ['worker.mjs']);
});

test('successful parent cannot leave an ordinary background descendant alive', async t => {
  const data = await workerFiles(t, 'descendant');
  await speechTestHooks.runWorker(data.options);
  const pid = Number(await fs.readFile(data.output + '.pid', 'utf8'));
  await eventually(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});

test('word timing uses the fixed word arguments and returns each word with its start and end', async t => {
  const { temporaryRoot, assets, privacy } = await fixture(t);
  const program = assets.arguments('a', 'b')[0];
  const timed = speechTestHooks.construct({ assets: { ...assets, wordArguments: (audio, prefix) => [program, 'words', audio, prefix] }, temporaryRoot, privacy, timeoutMs: 1000 });
  t.after(() => timed.close());
  const result = await timed.transcribe(input(), { words: true });
  assert.equal(result.text, 'Make this "big".');
  assert.deepEqual(result.words.map(word => [word.startMs, word.endMs, word.text]), [[0, 280, ' Make'], [280, 510, ' this'], [510, 900, ' "big".']]);
  assert.deepEqual(await fs.readdir(temporaryRoot), ['worker.mjs'], 'the private audio directory is removed');
  const plain = await timed.transcribe(input('capture-b'));
  assert.equal(plain.words, undefined); assert.equal(plain.text, 'Move the title above the list.');
  const bad = speechTestHooks.construct({ assets: { ...assets, wordArguments: (audio, prefix) => [program, 'badwords', audio, prefix] }, temporaryRoot, privacy, timeoutMs: 1000 });
  t.after(() => bad.close());
  await assert.rejects(bad.transcribe(input('capture-c'), { words: true }), codeIs(['SPEECH_OUTPUT_INVALID']));
  const untimed = speechTestHooks.construct({ assets, temporaryRoot, privacy, timeoutMs: 1000 });
  t.after(() => untimed.close());
  await assert.rejects(untimed.transcribe(input('capture-d'), { words: true }), codeIs(['SPEECH_INTEGRATION_REQUIRED']));
  await assert.rejects(timed.transcribe(input('capture-e'), { words: 'yes' }), codeIs(['SPEECH_INTEGRATION_REQUIRED']));
});

test('the word timing parser accepts only whisper CSV rows', () => {
  const { parseWords } = speechTestHooks;
  assert.deepEqual(parseWords('start,end,text\n'), { text: '', words: [] });
  for (const bad of ['', 'start,end\n', 'start,end,text\n1,2,"a"b"\n', 'start,end,text\n5,2,"a"\n', 'start,end,text\n-1,2,"a"\n', 'start,end,text\n1,2,"a",3\n'])
    assert.throws(() => parseWords(bad), codeIs(['SPEECH_OUTPUT_INVALID']), JSON.stringify(bad));
  assert.throws(() => parseWords('start,end,text\n' + '1,2," a"\n'.repeat(2001)), codeIs(['SPEECH_OUTPUT_INVALID']));
});

test('close fences a pending capture and permanently closes the bridge', async t => {
  const entered = deferred(), resume = deferred();
  const { bridge } = await fixture(t, 'ok', async () => { entered.resolve(); await resume.promise; });
  const pending = bridge.transcribe(input());
  const rejected = assert.rejects(pending, codeIs(['SPEECH_CANCELLED']));
  await entered.promise;
  const close = bridge.close(); resume.resolve(); await close; await rejected;
  assert.equal(bridge.status().available, false);
  await assert.rejects(bridge.transcribe(input('capture-b')), codeIs(['SPEECH_CLOSED']));
});

test('pinned native whisper transcribes one already-existing synthetic clip through the new bridge', { skip: process.env.CADDI_SPEECH_NATIVE !== '1' }, async t => {
  const temporaryRoot = await root(t), privacy = createControlCoordinator();
  const bridge = await createLocalSpeechBridge({ projectRoot, temporaryRoot, privacy });
  t.after(async () => { await bridge.close(); privacy.dispose(); });
  assert.equal(bridge.status().available, true, bridge.status().reason);
  const wav = await fs.readFile(path.join(projectRoot, '.test-artifacts/caddi-speech/evaluation-o27f1wjf/audio/samantha-layout.wav'));
  const result = await bridge.transcribe({ ...input(), pcm16: waveData(wav) });
  assert.match(result.text, /search field above the project list/i);
  assert.equal(result.local, true); assert.equal(result.model, 'whisper-cpp-1_9_5-tiny-en');
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
  const timed = await bridge.transcribe({ ...input('capture-words'), pcm16: waveData(wav) }, { words: true });
  assert.match(timed.text, /search field above the project list/i);
  assert.ok(timed.words.length >= 10, 'one entry per word');
  for (let index = 1; index < timed.words.length; index++) assert.ok(timed.words[index].startMs >= timed.words[index - 1].startMs);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});

test('a signed app\'s speech program is checked against its recorded signed fingerprint and its code signature',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' ? 'macOS arm64 only' :
      BUNDLED_SPEECH_PINS.some(pin => !existsSync(path.join(projectRoot, pin.development ?? 'assets/caddi-speech/' + pin.bundled))) ?
      'local speech assets are not built in this checkout' : false }, async t => {
    const temporaryRoot = await root(t), resources = path.join(temporaryRoot, 'Resources'), bundle = path.join(resources, 'caddi-speech');
    await fs.mkdir(bundle, { recursive: true, mode: 0o700 });
    const assets = [];
    for (const pin of BUNDLED_SPEECH_PINS) {
      const to = path.join(bundle, pin.bundled);
      await fs.copyFile(path.join(projectRoot, pin.development ?? 'assets/caddi-speech/' + pin.bundled), to);
      await fs.chmod(to, pin.role === 'program' ? 0o700 : 0o600);
      assets.push({ role: pin.role, path: pin.bundled, bytes: (await fs.stat(to)).size, sha256: pin.sha256 });
    }
    const program = path.join(bundle, BUNDLED_SPEECH_PINS.find(pin => pin.role === 'program').bundled);
    // An ad-hoc signature stands in for the Developer ID one: it rewrites the file the same way and verifies offline.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', program]);
    const signed = await fs.readFile(program), entry = assets.find(item => item.role === 'program');
    const manifestFile = path.join(bundle, 'manifest.json');
    const writeManifest = () => fs.writeFile(manifestFile, JSON.stringify({ format: 'caddi-local-speech-v1', sourceCommit: SPEECH_SOURCE_COMMIT, provenance: SPEECH_PROVENANCE,
      modelId: SPEECH_MODEL_ID, assets }), { mode: 0o600 });
    const discover = () => speechTestHooks.discoverBundled(bundle);
    await writeManifest();
    await assert.rejects(discover(), 'without a signed fingerprint, a signed program does not match the reviewed pin');
    Object.assign(entry, { signedBytes: signed.length, signedSha256: createHash('sha256').update(signed).digest('hex') });
    await writeManifest();
    assert.equal((await discover()).modelId, SPEECH_MODEL_ID);
    entry.signedSha256 = '0'.repeat(64); await writeManifest(); await assert.rejects(discover(), 'wrong signed fingerprint');
    entry.signedSha256 = createHash('sha256').update(signed).digest('hex');
    entry.sha256 = '1'.repeat(64); await writeManifest(); await assert.rejects(discover(), 'the reviewed build must still be the pinned one');
    entry.sha256 = BUNDLED_SPEECH_PINS.find(pin => pin.role === 'program').sha256;
    const license = assets.find(item => item.role === 'license');
    Object.assign(license, { signedBytes: license.bytes + 1, signedSha256: '2'.repeat(64) }); await writeManifest();
    await assert.rejects(discover(), 'only the program may carry a signed fingerprint');
  });

test('bundled loader verifies fixed pins and fails closed on missing, linked, oversized, changed and manifest assets',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' ? 'macOS arm64 only' :
      BUNDLED_SPEECH_PINS.some(pin => !existsSync(path.join(projectRoot, pin.development ?? 'assets/caddi-speech/' + pin.bundled))) ?
      'local speech assets are not built in this checkout' : false }, async t => {
    const temporaryRoot = await root(t), resources = path.join(temporaryRoot, 'Resources'), bundle = path.join(resources, 'caddi-speech');
    await fs.mkdir(bundle, { recursive: true, mode: 0o700 });
    const assets = [];
    for (const pin of BUNDLED_SPEECH_PINS) {
      const from = path.join(projectRoot, pin.development ?? 'assets/caddi-speech/' + pin.bundled);
      const to = path.join(bundle, pin.bundled);
      await fs.copyFile(from, to); await fs.chmod(to, pin.role === 'program' ? 0o700 : 0o600);
      assets.push({ role: pin.role, path: pin.bundled, bytes: (await fs.stat(to)).size, sha256: pin.sha256 });
    }
    const manifestFile = path.join(bundle, 'manifest.json');
    const writeManifest = () => fs.writeFile(manifestFile, JSON.stringify({ format: 'caddi-local-speech-v1', sourceCommit: SPEECH_SOURCE_COMMIT, provenance: SPEECH_PROVENANCE,
      modelId: SPEECH_MODEL_ID, assets }), { mode: 0o600 });
    await writeManifest();
    const privacy = createControlCoordinator(); t.after(() => privacy.dispose());
    const bridge = await createBundledSpeechBridge({ resourceRoot: bundle, temporaryRoot, privacy });
    t.after(() => bridge.close());
    assert.equal(bridge.status().available, true, bridge.status().reason);
    const discover = () => speechTestHooks.discoverBundled(bundle);
    const license = path.join(bundle, 'ggml-LICENSE'), original = await fs.readFile(license);
    await fs.rm(license); await assert.rejects(discover());
    await fs.writeFile(license, original, { mode: 0o600 });
    await fs.rm(license); await fs.symlink(path.join(projectRoot, BUNDLED_SPEECH_PINS[0].development), license);
    await assert.rejects(discover()); await fs.rm(license);
    await fs.writeFile(license, original, { mode: 0o600 });
    await fs.link(license, path.join(bundle, 'extra-link')); await assert.rejects(discover()); await fs.rm(path.join(bundle, 'extra-link'));
    await fs.appendFile(license, Buffer.alloc(20_000)); await assert.rejects(discover());
    await fs.writeFile(license, original); await fs.truncate(license, original.length); await fs.chmod(license, 0o600);
    const changed = Buffer.from(original); changed[0] ^= 1; await fs.writeFile(license, changed);
    await assert.rejects(discover()); await fs.writeFile(license, original);
    assets[0].sha256 = '0'.repeat(64); await writeManifest(); await assert.rejects(discover());
    assets[0].sha256 = BUNDLED_SPEECH_PINS[0].sha256; await writeManifest();
    assert.equal((await discover()).modelId, SPEECH_MODEL_ID);
  });
