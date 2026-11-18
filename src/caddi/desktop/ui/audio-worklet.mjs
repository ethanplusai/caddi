// Only instantiated following the user's Record action, or while Live listens. No idle audio processing.
class CaddiCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.running = true; this.samples = 0; this.buffer = new Float32Array(2048); this.used = 0;
    // A voice note stops at 60 s. Live listens continuously, bounded by its one-hour session.
    this.limit = options?.processorOptions?.continuous === true ? 16000 * 3600 : 960000;
    this.port.onmessage = event => { if (event.data?.type === 'stop') this.finish(); };
  }
  flush() {
    if (!this.used) return;
    const chunk = this.buffer.slice(0, this.used); this.used = 0;
    this.port.postMessage({ type: 'pcm', samples: chunk }, [chunk.buffer]);
  }
  finish() {
    if (!this.running) return;
    this.running = false; this.flush(); this.port.postMessage({ type: 'stopped' });
  }
  process(inputs) {
    if (!this.running) return false;
    const samples = inputs[0]?.[0];
    if (samples) for (const value of samples) {
      if (this.samples >= this.limit) { this.finish(); return false; }
      this.buffer[this.used++] = value; this.samples++;
      if (this.used === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('caddi-capture', CaddiCaptureProcessor);
