export interface MetronomeSettings {
  bpm: number;
  beatsPerBar: number;
  volume: number;
}

export interface MetronomeBeat {
  beat: number;
  section: "count-in" | "playing";
}

interface MetronomeOptions {
  leadInSeconds: number;
  countInBeats: number;
  onBeat: (beat: MetronomeBeat) => void;
}

const CLICK_FREQUENCY_HZ = 4000;
const CLICK_DURATION_SECONDS = 0.025;
const CLICK_ATTACK_SECONDS = 0.003;
const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_AHEAD_SECONDS = 0.1;

function clickBuffer(context: AudioContext, accent: boolean): AudioBuffer {
  const sampleCount = Math.round(CLICK_DURATION_SECONDS * context.sampleRate);
  const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
  const samples = buffer.getChannelData(0);
  const rampSamples = Math.max(1, Math.floor(CLICK_ATTACK_SECONDS * context.sampleRate));
  const amplitude = accent ? 0.9 : 0.6;
  for (let index = 0; index < samples.length; index++) {
    const time = index / context.sampleRate;
    const envelope = Math.exp(-time / (CLICK_DURATION_SECONDS / 4));
    const ramp = index < rampSamples
      ? 0.5 - 0.5 * Math.cos(Math.PI * index / (rampSamples - 1 || 1))
      : 1;
    samples[index] = amplitude * envelope * ramp
      * Math.sin(2 * Math.PI * CLICK_FREQUENCY_HZ * time);
  }
  return buffer;
}

export class MetronomePlayer {
  private readonly gain: GainNode;
  private readonly regularClick: AudioBuffer;
  private readonly accentedClick: AudioBuffer;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly timers = new Set<number>();
  private scheduler: number | null = null;
  private nextBeat = 0;
  private firstBeatAt = 0;
  private stopped = true;
  private settings: MetronomeSettings | null = null;
  private options: MetronomeOptions | null = null;

  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.regularClick = clickBuffer(context, false);
    this.accentedClick = clickBuffer(context, true);
  }

  start(settings: MetronomeSettings, options: MetronomeOptions): void {
    this.stop();
    this.settings = settings;
    this.options = options;
    this.nextBeat = 0;
    this.firstBeatAt = this.context.currentTime + options.leadInSeconds;
    this.stopped = false;
    this.setVolume(settings.volume);
    this.scheduler = window.setInterval(() => this.schedule(), SCHEDULER_INTERVAL_MS);
    this.schedule();
  }

  setVolume(volume: number): void {
    this.gain.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
  }

  stop(): void {
    this.stopped = true;
    if (this.scheduler !== null) window.clearInterval(this.scheduler);
    this.scheduler = null;
    this.timers.forEach(timer => window.clearTimeout(timer));
    this.timers.clear();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  }

  private schedule(): void {
    const settings = this.settings;
    const options = this.options;
    if (this.stopped || !settings || !options) return;
    const interval = 60 / settings.bpm;
    const horizon = this.context.currentTime + SCHEDULER_AHEAD_SECONDS;
    while (this.firstBeatAt + this.nextBeat * interval <= horizon) {
      const beatIndex = this.nextBeat;
      const at = this.firstBeatAt + beatIndex * interval;
      const source = this.context.createBufferSource();
      source.buffer = beatIndex % settings.beatsPerBar === 0
        ? this.accentedClick : this.regularClick;
      source.connect(this.gain);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
      source.start(at);
      this.sources.add(source);

      const delay = Math.max(0, (at - this.context.currentTime) * 1000);
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        if (this.stopped) return;
        const beat = beatIndex % settings.beatsPerBar + 1;
        options.onBeat({
          beat,
          section: beatIndex < options.countInBeats ? "count-in" : "playing",
        });
      }, delay);
      this.timers.add(timer);
      this.nextBeat++;
    }
  }
}
