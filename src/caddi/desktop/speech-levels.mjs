// Evens out the loudness of one utterance before it is transcribed. The small local model skips quiet
// stretches (a phrase that trails off, a soft aside), so quiet parts are brought up towards a target level
// with a smoothed gain, never past a ceiling, and silence is not amplified into noise. Pure and synchronous.
export const LEVEL_DEFAULTS = Object.freeze({ sampleRate: 16000, windowMs: 50, targetRms: 0.08, maxGain: 8, gateRms: 0.004, attack: 0.5, release: 0.15 });

/** PCM16 little-endian in, PCM16 little-endian out (a new buffer). */
export function evenLevels(pcm16, options = {}) {
  const o = { ...LEVEL_DEFAULTS, ...options };
  if (!(pcm16 instanceof Uint8Array) || pcm16.length % 2) throw new TypeError('PCM16 bytes are required');
  const input = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), count = pcm16.length / 2;
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index++) samples[index] = input.getInt16(index * 2, true) / 32768;
  const window = Math.max(1, Math.round(o.sampleRate * o.windowMs / 1000)), windows = Math.ceil(count / window);
  // Target gain per window from its RMS; a gate keeps near-silence near its own level.
  const gains = new Float32Array(windows);
  for (let w = 0; w < windows; w++) {
    let sum = 0; const from = w * window, to = Math.min(count, from + window);
    for (let index = from; index < to; index++) sum += samples[index] * samples[index];
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    gains[w] = rms < o.gateRms ? 1 : Math.max(1, Math.min(o.maxGain, o.targetRms / rms));
  }
  // Smooth: fall quickly when it gets loud (attack), rise slowly when it gets quiet (release), both directions.
  const smooth = new Float32Array(windows);
  let current = gains[0] ?? 1;
  for (let w = 0; w < windows; w++) { current += (gains[w] - current) * (gains[w] < current ? o.attack : o.release); smooth[w] = current; }
  current = smooth[windows - 1] ?? 1;
  for (let w = windows - 1; w >= 0; w--) { current += (smooth[w] - current) * (smooth[w] < current ? o.attack : o.release); smooth[w] = Math.min(smooth[w], current); }
  const output = new Uint8Array(pcm16.length), view = new DataView(output.buffer);
  for (let index = 0; index < count; index++) {
    // Interpolate between window gains so there are no steps.
    const position = index / window - 0.5, w = Math.max(0, Math.min(windows - 1, Math.floor(position))), next = Math.min(windows - 1, w + 1);
    const t = Math.max(0, Math.min(1, position - w)), gain = smooth[w] + (smooth[next] - smooth[w]) * t;
    const value = Math.max(-1, Math.min(1, samples[index] * gain));
    view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  samples.fill(0);
  return output;
}
