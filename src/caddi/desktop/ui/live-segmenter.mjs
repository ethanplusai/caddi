// Energy-based voice activity detection for Live mode. Pure and synchronous:
// the chrome renderer feeds it the microphone samples it already captures, and
// it hands back one finished utterance at a time. Nothing here stores or sends
// audio; the caller decides what to do with an utterance and then drops it.
export const LIVE_SEGMENTER_DEFAULTS = Object.freeze({
  sampleRate: 16000, frameMs: 20, silenceMs: 700, maxMs: 20000, minSpeechMs: 250, preRollMs: 200, keepTailMs: 300,
  startFrames: 3, minRms: 0.012, floorRatio: 3, holdRatio: 0.6,
});
const bad = message => { throw new TypeError(message); };
const bounded = (value, name, min, max) => {
  if (!Number.isFinite(value) || value < min || value > max) bad(name + ' is out of range');
  return value;
};

/** `onUtterance({ samples, startMs, endMs, speechEndMs, speechMs, trailingMs, forced })`, times from the first sample pushed. */
export function createUtteranceSegmenter(options = {}) {
  const o = { ...LIVE_SEGMENTER_DEFAULTS, ...options };
  if (typeof o.onUtterance !== 'function') bad('onUtterance is required');
  bounded(o.sampleRate, 'sampleRate', 8000, 48000); bounded(o.silenceMs, 'silenceMs', 200, 5000);
  bounded(o.maxMs, 'maxMs', 1000, 60000); bounded(o.minSpeechMs, 'minSpeechMs', 0, 5000);
  bounded(o.preRollMs, 'preRollMs', 0, 1000); bounded(o.keepTailMs, 'keepTailMs', 0, 2000);
  const frameSize = Math.round(o.sampleRate * o.frameMs / 1000), frameMs = frameSize * 1000 / o.sampleRate;
  const preFrames = Math.round(o.preRollMs / frameMs), silenceFrames = Math.ceil(o.silenceMs / frameMs);
  const maxSamples = Math.round(o.maxMs * o.sampleRate / 1000), tailSamples = Math.round(o.keepTailMs * o.sampleRate / 1000);
  const ms = sample => sample * 1000 / o.sampleRate;
  let partial = new Float32Array(frameSize), used = 0, position = 0, floor = null, ring = [], run = 0, active = null;

  function finish(forced, endSample) {
    const item = active; active = null;
    if (!item || item.speechFrames * frameMs < o.minSpeechMs) return;
    const end = forced ? endSample : Math.min(endSample, item.speechEnd + tailSamples);
    const samples = new Float32Array(end - item.start);
    for (const frame of item.frames) {
      const offset = frame.start - item.start;
      if (offset >= samples.length) break;
      samples.set(frame.samples.subarray(0, samples.length - offset), offset);
    }
    for (const frame of item.frames) frame.samples.fill(0);
    o.onUtterance({ samples, startMs: ms(item.start), endMs: ms(end), speechEndMs: ms(Math.min(item.speechEnd, end)),
      speechMs: item.speechFrames * frameMs, trailingMs: ms(end - Math.min(item.speechEnd, end)), forced });
  }
  function frame(samples, start) {
    let sum = 0;
    for (const value of samples) sum += Number.isFinite(value) ? value * value : 0;
    const rms = Math.sqrt(sum / samples.length);
    if (floor === null) floor = Math.min(0.05, Math.max(0.001, rms));
    const threshold = Math.max(o.minRms, floor * o.floorRatio);
    if (!active) {
      const loud = rms > threshold;
      ring.push({ samples, start });
      if (ring.length > preFrames + o.startFrames) ring.shift().samples.fill(0);
      run = loud ? run + 1 : 0;
      // The noise floor follows quiet frames: down quickly, up slowly.
      if (!loud) floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.995 + rms * 0.005;
      if (run >= o.startFrames) {
        active = { start: ring[0].start, frames: ring, speechFrames: run, speechEnd: start + samples.length, silent: 0 };
        ring = []; run = 0;
      }
      return;
    }
    active.frames.push({ samples, start });
    if (rms > threshold * o.holdRatio) { active.speechFrames++; active.silent = 0; active.speechEnd = start + samples.length; }
    else active.silent++;
    const end = start + samples.length;
    if (active.silent >= silenceFrames) finish(false, end);
    else if (end - active.start >= maxSamples) {
      finish(true, end);
      // Speech that runs past the cap continues in the next utterance, without a gap.
      active = { start: end, frames: [], speechFrames: 0, speechEnd: end, silent: 0 };
    }
  }
  return Object.freeze({
    push(chunk) {
      if (!(chunk instanceof Float32Array)) bad('Samples must be a Float32Array');
      if (chunk.length > 16384) bad('Sample chunk is too large');
      for (let index = 0; index < chunk.length;) {
        const take = Math.min(frameSize - used, chunk.length - index);
        partial.set(chunk.subarray(index, index + take), used); used += take; index += take;
        if (used === frameSize) { const full = partial; partial = new Float32Array(frameSize); used = 0; frame(full, position); position += frameSize; }
      }
    },
    /** Ends a phrase in progress, for example when Live stops. */
    flush() {
      if (active && used) { const rest = partial.slice(0, used); active.frames.push({ samples: rest, start: position }); position += used; used = 0; }
      if (active) finish(false, active.frames.length ? active.frames.at(-1).start + active.frames.at(-1).samples.length : active.start);
    },
    reset() {
      for (const item of [...ring, ...(active?.frames ?? [])]) item.samples.fill(0);
      partial.fill(0); used = 0; ring = []; run = 0; active = null;
    },
  });
}
