// Created: 2026-09-14. Input and output use the AudioContext's 16 kHz sample rate.
class VoiceAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.offset = 0; this.capture = new Int16Array(320); this.used = 0;
    this.queued = 0;
    this.playedSamples = 0; this.voicedSamples = 0; this.reportSamples = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'flush') { this.queue = []; this.offset = 0; this.queued = 0; }
      else if (data.type === 'audio') {
        const audio = new Int16Array(data.buffer);
        if (this.queued + audio.length > 32000) {
          this.queue = []; this.offset = 0; this.queued = 0; this.port.postMessage({ type: 'overflow' }); return;
        }
        this.queue.push(audio); this.queued += audio.length;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0]; const output = outputs[0]?.[0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      const sample = Math.max(-1, Math.min(1, input?.[i] || 0));
      this.capture[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      if (this.used === 320) {
        this.port.postMessage({ type: 'input', buffer: this.capture.buffer }, [this.capture.buffer]);
        this.capture = new Int16Array(320); this.used = 0;
      }
      if (this.queue.length) {
        output[i] = this.queue[0][this.offset++] / 32768; this.queued--;
        this.playedSamples++; if (Math.abs(output[i]) > 0.002) this.voicedSamples++;
        if (this.offset >= this.queue[0].length) { this.queue.shift(); this.offset = 0; }
      } else output[i] = 0;
    }
    this.reportSamples += output.length;
    if (this.reportSamples >= sampleRate) {
      this.port.postMessage({ type: 'playback-stats', playedSamples: this.playedSamples, voicedSamples: this.voicedSamples, queuedSamples: this.queued, sampleRate });
      this.reportSamples = 0;
    }
    return true;
  }
}
registerProcessor('voice-audio', VoiceAudio);
