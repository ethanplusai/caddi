#!/usr/bin/env node
// Live speech recall: how much of what a person says reaches the agent.
//
// Builds spoken scenarios with macOS `say` (voices, rates, pauses, soft trailing words, background
// noise, quiet and loud microphones), feeds them through the real utterance segmenter in 128-sample
// chunks the way the audio worklet does, transcribes each utterance with the pinned whisper program
// through the real speech bridge, applies the same noise filter as Live, and scores word recall
// against the script. Nothing leaves this Mac; audio lives in a private temporary folder.
//
//   node scripts/evaluate-live-recall.mjs [--resources /Applications/Caddi.app/Contents/Resources/caddi-speech]
//                                         [--only name] [--json] [--segmenter '{"silenceMs":900}']
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createUtteranceSegmenter } from '../src/caddi/desktop/ui/live-segmenter.mjs';
import * as levels from '../src/caddi/desktop/speech-levels.mjs';
import { createBundledSpeechBridge, createLocalSpeechBridge } from '../src/caddi/desktop/speech.mjs';
import { isNoiseTranscript } from '../src/caddi/desktop/live.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const RATE = 16000;

// Each scenario: phrases said one after another. pause: silence after the phrase (ms); volume: 0..1 for say.
export const SCENARIOS = [
  { name: 'steady talk', voice: 'Samantha', rate: 190, phrases: [
    { text: 'Alright, I am looking at the hero section now and the headline feels a little too big on this screen.' },
    { text: 'Can you make the paragraph under it a bit narrower so it reads more easily.' },
    { text: 'And the download button should be the first thing people notice.' }] },
  { name: 'thinking pauses', voice: 'Samantha', rate: 175, phrases: [
    { text: 'So the eyebrow up here', pause: 1100 }, { text: 'the menu with features agents security and docs', pause: 1400 },
    { text: 'and then the download buttons', pause: 2200 }, { text: 'scrolling down there is this vault section', pause: 900 },
    { text: 'which I think needs a better picture' }] },
  { name: 'trailing off', voice: 'Daniel', rate: 185, phrases: [
    { text: 'This card should have more space around it,' }, { text: 'maybe twice as much', volume: 0.35, pause: 1200 },
    { text: 'and the title in the card is too light,' }, { text: 'try the darker one', volume: 0.3 }] },
  { name: 'fast talker', voice: 'Samantha', rate: 245, phrases: [
    { text: 'Okay so this whole row of logos looks cramped, spread them out, make them grey, and drop the one on the far right because it is not a customer anymore.' }] },
  { name: 'quiet microphone', voice: 'Samantha', rate: 185, gain: 0.25, phrases: [
    { text: 'I want the footer links in two columns instead of four.' }, { text: 'And remove the line about chat.', pause: 900 },
    { text: 'That feature is gone.' }] },
  { name: 'noisy room', voice: 'Daniel', rate: 185, noise: 0.012, phrases: [
    { text: 'Look at this screenshot here, the toolbar in it is out of date.', pause: 800 },
    { text: 'Replace it with the new one that has the Live button.' }] },
  { name: 'starts mid-speech', voice: 'Samantha', rate: 190, leadIn: 0, phrases: [
    { text: 'Right away when I turn this on I am already talking about the navigation bar and how it overlaps the logo.' }] },
  { name: 'room noise only', voice: 'Samantha', rate: 185, noise: 0.02, phrases: [], tailMs: 8000 },
  { name: 'stops mid-sentence', voice: 'Samantha', rate: 185, stopEarlyMs: 400, phrases: [
    { text: 'One more thing before I stop, make the footer text a little larger please.' }] },
  { name: 'long monologue', voice: 'Samantha', rate: 180, phrases: [
    { text: 'Let me walk you through everything on this page from top to bottom so you have the full picture before you change anything, starting with the header which is fine, then the hero where the headline wraps badly on smaller screens, then the three feature cards which need equal heights, and finally the pricing table which is missing the yearly toggle that we talked about last week.' }] },
];

function run(command, argv) { return execFileSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

/** Float32 mono 16 kHz samples for one scenario, with lead-in silence, pauses, gain and noise. */
async function synthesize(scenario, folder) {
  const parts = [], silence = ms => new Float32Array(Math.round(ms * RATE / 1000));
  parts.push(silence(scenario.leadIn ?? 600));
  for (const [index, phrase] of scenario.phrases.entries()) {
    const file = path.join(folder, scenario.name.replace(/\W+/g, '-') + '-' + index + '.wav');
    const text = (phrase.volume !== undefined ? '[[volm ' + phrase.volume + ']] ' : '') + phrase.text;
    run('/usr/bin/say', ['-v', scenario.voice, '-r', String(scenario.rate), '--data-format=LEF32@16000', '--file-format=WAVE', '-o', file, text]);
    parts.push(readWav(await fs.readFile(file)));
    parts.push(silence(phrase.pause ?? 250));
  }
  parts.push(silence(scenario.stopEarlyMs !== undefined ? 0 : scenario.tailMs ?? 1500));
  const total = parts.reduce((sum, part) => sum + part.length, 0), samples = new Float32Array(total);
  let offset = 0; for (const part of parts) { samples.set(part, offset); offset += part.length; }
  const gain = scenario.gain ?? 1;
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  let brown = 0;
  for (let index = 0; index < samples.length; index++) {
    brown = brown * 0.98 + random() * 0.2;
    samples[index] = Math.max(-1, Math.min(1, samples[index] * gain + (scenario.noise ?? 0.002) * brown * 3.5));
  }
  return samples;
}
/** The data chunk of a 32-bit float WAVE file. */
function readWav(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return new Float32Array(buffer.buffer.slice(buffer.byteOffset + offset + 8, buffer.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error('No data chunk');
}
function pcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
const words = text => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
/** Words of the script found in order in the heard text (longest common subsequence). */
export function recall(expected, heard) {
  const a = words(expected), b = words(heard), table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const missing = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; } else if (table[i + 1][j] >= table[i][j + 1]) missing.push(a[i++]); else j++; }
  missing.push(...a.slice(i));
  return { total: a.length, found: table[0][0], ratio: a.length ? table[0][0] / a.length : 1, missing };
}

export async function evaluate({ resources, only = null, segmenter = {} } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'caddi-recall-')));
  await fs.chmod(temporary, 0o700);
  const privacy = createControlCoordinator();
  await fs.mkdir(path.join(temporary, 'speech'), { mode: 0o700 });
  const bridge = resources ? await createBundledSpeechBridge({ resourceRoot: resources, temporaryRoot: path.join(temporary, 'speech'), privacy })
    : await createLocalSpeechBridge({ projectRoot: ROOT, temporaryRoot: path.join(temporary, 'speech'), privacy });
  const results = [];
  try {
    if (!bridge.status().available) throw new Error('Speech unavailable: ' + bridge.status().reason);
    for (const scenario of SCENARIOS.filter(item => !only || item.name === only)) {
      const samples = await synthesize(scenario, temporary), utterances = [];
      const cutter = createUtteranceSegmenter({ ...segmenter, onUtterance: utterance => utterances.push(utterance) });
      // Live stops (the owner clicks Stop) this long before the speech ends, when the scenario says so.
      const stopAt = scenario.stopEarlyMs !== undefined ? samples.length - Math.round(scenario.stopEarlyMs * RATE / 1000) : samples.length;
      for (let index = 0; index < stopAt; index += 2048) cutter.push(samples.slice(index, Math.min(stopAt, index + 2048)));
      if (segmenter.stop === 'reset') cutter.reset(); else cutter.flush();
      const heard = [];
      for (const utterance of utterances) {
        const audio = segmenter.level === false ? pcm16(utterance.samples) : levels.evenLevels(pcm16(utterance.samples));
        const result = await bridge.transcribe({ workspaceId: 'recall', captureId: 'u-' + randomUUID(), capturePrivacyEpoch: 0, pcm16: audio }, { words: true });
        const text = result.text ?? '';
        heard.push({ startMs: Math.round(utterance.startMs), endMs: Math.round(utterance.endMs), forced: utterance.forced, text, dropped: isNoiseTranscript(text) });
      }
      const script = scenario.phrases.map(phrase => phrase.text).join(' ');
      const score = recall(script, heard.filter(item => !item.dropped).map(item => item.text).join(' '));
      const kept = heard.filter(item => !item.dropped).map(item => item.text).join(' ');
      const extra = Math.max(0, kept.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean).length - score.found);
      results.push({ name: scenario.name, utterances: heard.length, recall: Math.round(score.ratio * 1000) / 10, extra, missing: score.missing, heard });
    }
  } finally { await bridge.close?.(); privacy.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await evaluate({ resources: option('--resources'), only: option('--only'), segmenter: JSON.parse(option('--segmenter') ?? '{}') });
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else {
    for (const item of results) {
      console.log(`${item.recall.toFixed(1).padStart(5)}%  ${item.name}  (${item.utterances} utterance${item.utterances === 1 ? '' : 's'})` +
        (item.extra ? '  invented: ' + item.extra + ' words' : '') + (item.missing.length ? '  missing: ' + item.missing.join(' ') : ''));
      if (args.includes('--verbose')) for (const heard of item.heard) console.log(`        ${heard.startMs}-${heard.endMs}ms${heard.forced ? ' (cut)' : ''}${heard.dropped ? ' (dropped)' : ''}: ${heard.text}`);
    }
    const mean = results.reduce((sum, item) => sum + item.recall, 0) / Math.max(1, results.length);
    console.log(`Mean recall ${mean.toFixed(1)}%`);
  }
}
