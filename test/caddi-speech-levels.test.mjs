import test from 'node:test';
import assert from 'node:assert/strict';
import { evenLevels } from '../src/caddi/desktop/speech-levels.mjs';
import { speechPrompt } from '../src/caddi/desktop/speech.mjs';

const tone = (seconds, amplitude) => Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => amplitude * Math.sin(2 * Math.PI * 220 * i / 16000));
const pcm = samples => { const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer); samples.forEach((v, i) => view.setInt16(i * 2, Math.round(v * 32767), true)); return bytes; };
const rms = (bytes, from, to) => { const view = new DataView(bytes.buffer); let sum = 0; for (let i = from; i < to; i++) { const v = view.getInt16(i * 2, true) / 32768; sum += v * v; } return Math.sqrt(sum / (to - from)); };

test('quiet speech is brought up towards the loud part, loud speech is left alone, silence stays silent', () => {
  const loud = tone(1, 0.3), quiet = tone(1, 0.02), silence = new Float32Array(16000);
  const joined = new Float32Array(48000); joined.set(loud, 0); joined.set(quiet, 16000); joined.set(silence, 32000);
  const out = evenLevels(pcm(joined));
  assert.ok(Math.abs(rms(out, 2000, 14000) - rms(pcm(joined), 2000, 14000)) < 0.01, 'loud part unchanged');
  assert.ok(rms(out, 20000, 30000) > rms(pcm(joined), 20000, 30000) * 3, 'quiet part raised');
  assert.equal(rms(out, 36000, 48000), 0, 'silence not amplified');
  assert.equal(out.length, 96000);
});

test('the gain never clips', () => {
  const out = evenLevels(pcm(tone(0.5, 0.01)), { maxGain: 1000, targetRms: 0.9 });
  const view = new DataView(out.buffer);
  for (let i = 0; i < out.length / 2; i++) assert.ok(Math.abs(view.getInt16(i * 2, true)) <= 32768);
});

test('the transcription hint keeps words and light punctuation only, bounded, and is never a flag', () => {
  assert.equal(speechPrompt('--model /etc/passwd | Caddi; $(rm -rf)'), 'model etc passwd Caddi rm -rf');
  assert.equal(speechPrompt('a'.repeat(1000)).length, 240);
  assert.equal(speechPrompt(42), '');
  assert.equal(speechPrompt('Features, Agents & Docs.'), 'Features, Agents & Docs.');
});
