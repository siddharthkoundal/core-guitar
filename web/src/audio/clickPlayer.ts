const START_DELAY_S = 0.05;
/** Silence before the first click in the server's click WAV (`LEAD_SILENCE_S`). */
export const CLICK_LEAD_IN_S = 2;

export class ClickPlayer {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private timers: number[] = [];
  constructor(private readonly context: AudioContext, private readonly buffer: AudioBuffer) {}
  start(
    bpm: number,
    beatsPerBar: number,
    volume: number,
    onBeat: (beat: number, section: "count-in" | "playing") => void,
    onEnd: () => void,
  ): number {
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = this.buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(this.context.destination);
    source.onended = () => {
      this.clearTimers();
      onEnd();
    };
    // An explicit start time puts the click on the same audio clock as the recording.
    const when = this.context.currentTime + START_DELAY_S;
    source.start(when);
    this.source = source;
    this.gain = gain;

    const beatDuration = 60 / bpm;
    const leadInSeconds = CLICK_LEAD_IN_S;
    const tailSeconds = 2.5;
    const clickCount = Math.floor((this.buffer.duration - leadInSeconds - tailSeconds) / beatDuration + 0.001);
    for (let index = 0; index < clickCount; index++) {
      this.timers.push(window.setTimeout(() => {
        const beat = index % beatsPerBar + 1;
        onBeat(beat, index < beatsPerBar ? "count-in" : "playing");
      }, (START_DELAY_S + leadInSeconds + index * beatDuration) * 1000));
    }
    return when;
  }
  setVolume(volume: number): void {
    this.gain?.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
  }
  stop() {
    this.clearTimers();
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
    this.gain?.disconnect();
    this.gain = null;
  }
  private clearTimers(): void {
    this.timers.forEach(timer => window.clearTimeout(timer));
    this.timers = [];
  }
}
