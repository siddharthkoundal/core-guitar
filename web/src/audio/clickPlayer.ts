export class ClickPlayer {
  private source: AudioBufferSourceNode | null = null;
  constructor(private readonly context: AudioContext, private readonly buffer: AudioBuffer) {}
  start(onEnd: () => void) {
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.context.destination);
    source.onended = onEnd;
    source.start();
    this.source = source;
  }
  stop() {
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }
}
