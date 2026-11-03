declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare const currentFrame: number;

class PcmRecorder extends AudioWorkletProcessor {
  private started = false;
  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const first = channels?.[0];
    if (channels && first) {
      // The context frame of the first captured sample lets the main thread place the click on the recording's timeline.
      if (!this.started) { this.started = true; this.port.postMessage({ firstFrame: currentFrame }); }
      const mono = new Float32Array(first.length);
      for (const channel of channels) for (let index = 0; index < channel.length; index++) {
        mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
