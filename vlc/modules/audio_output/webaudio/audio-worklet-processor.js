// AudioWorklet processor for VLC WASM emworklet_audio output.
// Receives decoded PCM samples from VLC and outputs them to the audio device.

class WorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'audio') {
        this._buffer.push(e.data.samples);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (output && output.length > 0) {
      // If we have buffered audio, play it; otherwise output silence
      if (this._buffer.length > 0) {
        const samples = this._buffer.shift();
        for (let ch = 0; ch < output.length; ch++) {
          const channel = output[ch];
          if (samples && samples[ch]) {
            channel.set(samples[ch].subarray(0, channel.length));
          }
        }
      }
    }
    return true;
  }
}

registerProcessor('worklet-processor', WorkletProcessor);
