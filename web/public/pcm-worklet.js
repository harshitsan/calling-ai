// Captures mic audio from the input port and emits Int16 PCM frames
// (100ms each at the AudioContext's sample rate) over postMessage as
// transferable ArrayBuffers — ready to ship to Deepgram Flux as linear16.

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.frameSize = 960; // 60ms at 16kHz — lower-latency frames to the server
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) this.buffer.push(channel[i]);

    while (this.buffer.length >= this.frameSize) {
      const chunk = this.buffer.splice(0, this.frameSize);
      const pcm = new Int16Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
