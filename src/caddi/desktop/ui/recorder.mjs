export function createRecorder({ onStatus = () => {}, onStopped = async () => {} } = {}) {
  let current = null;
  async function release(item) {
    item.stream?.getTracks().forEach(track => track.stop());
    item.source?.disconnect(); item.node?.disconnect(); item.gain?.disconnect();
    if (item.context && item.context.state !== 'closed') await item.context.close();
    item.node?.port.close();
  }
  async function finish(item, discard) {
    if (item.finished) return item.finished;
    item.cancelled ||= discard;
    item.finished = (async () => {
      // An unresolved media request can later acquire a device. Its eventual
      // tracks must be stopped before the native privacy barrier is acknowledged.
      await item.preparing.catch(() => {});
      item.stream?.getTracks().forEach(track => track.stop());
      if (item.node && !item.workletStopped) {
        item.node.port.postMessage({ type: 'stop' });
        await Promise.race([item.workletDone, new Promise(resolve => setTimeout(resolve, 300))]);
      }
      await release(item);
      clearTimeout(item.timer);
      const length = item.cancelled ? 0 : item.count;
      const pcm = new Uint8Array(length * 2), view = new DataView(pcm.buffer);
      if (!item.cancelled) {
        let offset = 0;
        for (const chunk of item.chunks) for (const sample of chunk) {
          if (offset >= length) break;
          const value = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
          view.setInt16(offset++ * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        }
      }
      for (const chunk of item.chunks) chunk.fill(0);
      item.chunks.length = 0;
      await onStopped({ captureId: item.captureId });
      if (current === item) current = null;
      onStatus('idle');
      return pcm;
    })();
    return item.finished;
  }
  function start({ captureId, maxDurationMs = 60000 }) {
    if (current) throw new Error('Recording already active');
    const item = { captureId, chunks: [], count: 0, cancelled: false, workletStopped: false };
    let resolveWorklet;
    item.workletDone = new Promise(resolve => { resolveWorklet = resolve; });
    current = item; onStatus('permission');
    item.preparing = (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('Microphone recording is unavailable. You can type your feedback.');
      item.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (item.cancelled) { item.stream.getTracks().forEach(track => track.stop()); return; }
      item.context = new AudioContext({ sampleRate: 16000 });
      if (item.context.sampleRate !== 16000) throw new Error('This audio device cannot provide the local recording format.');
      await item.context.audioWorklet.addModule('/audio-worklet.mjs');
      if (item.cancelled) return;
      item.source = item.context.createMediaStreamSource(item.stream);
      item.node = new AudioWorkletNode(item.context, 'caddi-capture', { channelCount: 1 });
      item.gain = item.context.createGain(); item.gain.gain.value = 0;
      item.node.port.onmessage = event => {
        const value = event.data;
        if (value?.type === 'stopped') { item.workletStopped = true; resolveWorklet(); return; }
        if (value?.type !== 'pcm' || item.cancelled || !(value.samples instanceof Float32Array)) return;
        if (value.samples.length > 2048 || item.count + value.samples.length > 960000) { item.cancelled = true; void finish(item, true); return; }
        item.count += value.samples.length; item.chunks.push(value.samples);
      };
      item.source.connect(item.node); item.node.connect(item.gain); item.gain.connect(item.context.destination);
      await item.context.resume();
      if (item.cancelled) return;
      onStatus('recording');
      item.timer = setTimeout(() => onStatus('limit'), Math.min(60000, maxDurationMs));
      for (const track of item.stream.getTracks()) track.addEventListener('ended', () => { if (!item.finished) onStatus('device-ended'); }, { once: true });
    })();
    return item.preparing.catch(async error => { await finish(item, true); throw error; });
  }
  return Object.freeze({
    start,
    active: () => current?.captureId ?? null,
    stop: captureId => current?.captureId === captureId ? finish(current, false) : Promise.resolve(new Uint8Array()),
    cancel: captureId => current?.captureId === captureId ? finish(current, true) : Promise.resolve(new Uint8Array()),
  });
}
