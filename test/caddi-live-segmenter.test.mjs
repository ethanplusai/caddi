import test from 'node:test';
import assert from 'node:assert/strict';
import { createUtteranceSegmenter, LIVE_SEGMENTER_DEFAULTS } from '../src/caddi/desktop/ui/live-segmenter.mjs';

const RATE = 16000;
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const silence = (ms, level = 0.002) => Float32Array.from({ length: ms * RATE / 1000 }, () => (random() * 2 - 1) * level);
const voice = (ms, level = 0.3) => Float32Array.from({ length: ms * RATE / 1000 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / RATE) * level + (random() * 2 - 1) * 0.01);
const join = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
function run(samples, options = {}, chunk = 128) {
  const found = [];
  const segmenter = createUtteranceSegmenter({ ...options, onUtterance: value => found.push(value) });
  for (let i = 0; i < samples.length; i += chunk) segmenter.push(samples.subarray(i, i + chunk));
  return { found, segmenter };
}

test('defaults follow the live annotation brief', () => {
  assert.equal(LIVE_SEGMENTER_DEFAULTS.silenceMs, 700);
  assert.equal(LIVE_SEGMENTER_DEFAULTS.maxMs, 20000);
  assert.equal(LIVE_SEGMENTER_DEFAULTS.sampleRate, 16000);
});

test('one spoken phrase between silences becomes one utterance with its time span', () => {
  const { found } = run(join(silence(500), voice(1200), silence(1000)));
  assert.equal(found.length, 1);
  const [u] = found;
  // Speech started at 500 ms. The pre-roll reaches back at most 200 ms.
  assert.ok(u.startMs >= 280 && u.startMs <= 500, 'start ' + u.startMs);
  assert.ok(u.speechEndMs >= 1650 && u.speechEndMs <= 1760, 'speech end ' + u.speechEndMs);
  assert.ok(u.speechMs >= 1100 && u.speechMs <= 1300, 'speech ' + u.speechMs);
  assert.equal(u.forced, false);
  assert.equal(u.samples.length, Math.round((u.endMs - u.startMs) * RATE / 1000));
  assert.ok(u.trailingMs <= 300, 'only a short tail of silence is kept: ' + u.trailingMs);
});

test('an utterance ends only after about 700 ms of silence, so short pauses stay inside it', () => {
  const { found } = run(join(silence(300), voice(600), silence(400), voice(600), silence(1000)));
  assert.equal(found.length, 1, 'a 400 ms pause does not split the sentence');
  const split = run(join(silence(300), voice(600), silence(900), voice(600), silence(1000))).found;
  assert.equal(split.length, 2, 'a 900 ms pause does');
  assert.ok(split[0].speechEndMs < split[1].startMs);
});

test('nothing is emitted before the silence has lasted long enough', () => {
  const { found, segmenter } = run(join(silence(300), voice(800), silence(500)));
  assert.equal(found.length, 0);
  segmenter.push(silence(300));
  assert.equal(found.length, 1);
});

test('a long monologue is cut at the 20 s cap and continues in the next utterance', () => {
  const { found, segmenter } = run(join(silence(200), voice(45000)), {}, 2048);
  assert.equal(found.length, 2);
  for (const u of found) { assert.equal(u.forced, true); assert.ok(u.endMs - u.startMs <= 20000 + 1, 'capped ' + (u.endMs - u.startMs)); }
  assert.ok(Math.abs(found[1].startMs - found[0].endMs) < 1, 'no audio is lost between capped parts');
  segmenter.flush();
  assert.equal(found.length, 3, 'flush ends the remainder');
  assert.equal(found[2].forced, false);
});

test('clicks, breaths and steady background noise are not utterances', () => {
  const blip = voice(80);
  assert.equal(run(join(silence(500), blip, silence(1500))).found.length, 0, 'an 80 ms click');
  assert.equal(run(silence(4000, 0.008)).found.length, 0, 'steady quiet noise');
  // A loud steady hum raises the noise floor instead of counting as speech forever.
  const hum = Float32Array.from({ length: 4 * RATE }, (_, i) => Math.sin(i * 2 * Math.PI * 60 / RATE) * 0.02);
  assert.equal(run(hum).found.length, 0, 'a steady hum');
});

test('speech louder than the background noise is still found', () => {
  const noisy = (ms, level) => Float32Array.from({ length: ms * RATE / 1000 }, () => (random() * 2 - 1) * level);
  const { found } = run(join(noisy(1500, 0.01), voice(1000, 0.25), noisy(1500, 0.01)));
  assert.equal(found.length, 1);
});

test('flush emits a phrase in progress and reset discards it', () => {
  let { found, segmenter } = run(join(silence(200), voice(900)));
  segmenter.flush();
  assert.equal(found.length, 1);
  ({ found, segmenter } = run(join(silence(200), voice(900))));
  segmenter.reset(); segmenter.flush();
  assert.equal(found.length, 0);
});

test('input is validated and bounded', () => {
  const segmenter = createUtteranceSegmenter({ onUtterance: () => {} });
  assert.throws(() => segmenter.push([0.1, 0.2]), /Float32Array/);
  assert.throws(() => segmenter.push(new Float32Array(16385)), /chunk/);
  assert.throws(() => createUtteranceSegmenter({ onUtterance: () => {}, silenceMs: 50 }), /silenceMs/);
  assert.throws(() => createUtteranceSegmenter({ onUtterance: () => {}, maxMs: 120000 }), /maxMs/);
  assert.throws(() => createUtteranceSegmenter({}), /onUtterance/);
  // Non-finite samples count as silence instead of poisoning the noise floor.
  const found = [];
  const quiet = createUtteranceSegmenter({ onUtterance: value => found.push(value) });
  quiet.push(new Float32Array(1600).fill(Number.NaN)); quiet.flush();
  assert.equal(found.length, 0);
});
