import { inputConstraints } from "./inputProfile";

export interface PitchReading {
  frequency: number;
  /** NSDF peak height (0–1): how periodic the signal is, not an accuracy score. */
  clarity: number;
  rms: number;
}
export interface PitchOptions {
  minFrequency?: number;
  maxFrequency?: number;
  minRms?: number;
  minClarity?: number;
  /** McLeod's k: the first key maximum at or above k × highest key maximum wins. */
  cutoff?: number;
}
export interface NearestNote {
  midi: number;
  cents: number;
}

const DEFAULTS = { minFrequency: 30, maxFrequency: 1400, minRms: 0.004, minClarity: 0.8, cutoff: 0.9 } as const;

/**
 * McLeod Pitch Method ("A Smarter Way to Find Pitch", McLeod & Wyvill 2005):
 * normalized square difference n'(τ) = 2r'(τ) / m'(τ), positive-lobe key maxima,
 * first key maximum ≥ k × highest, parabolic interpolation.
 */
function at(values: ArrayLike<number>, index: number): number {
  return values[index] ?? 0;
}

export function detectMpm(samples: Float32Array, sampleRate: number, options: PitchOptions = {}): PitchReading | null {
  const minFrequency = options.minFrequency ?? DEFAULTS.minFrequency;
  const maxFrequency = options.maxFrequency ?? DEFAULTS.maxFrequency;
  const minRms = options.minRms ?? DEFAULTS.minRms;
  const minClarity = options.minClarity ?? DEFAULTS.minClarity;
  const cutoff = options.cutoff ?? DEFAULTS.cutoff;
  const size = samples.length;
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || size < 256) return null;
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= size;
  if (!Number.isFinite(mean)) return null;
  const x = Float32Array.from(samples, n => n - mean);
  let energy = 0;
  for (const sample of x) energy += sample * sample;
  const rms = Math.sqrt(energy / size);
  if (!Number.isFinite(rms) || rms < minRms) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(Math.ceil(sampleRate / minFrequency) + 1, Math.floor(size / 2));
  if (maxLag <= minLag + 2) return null;
  const nsdf = new Float64Array(maxLag + 1);
  let m = 2 * energy;
  for (let lag = 0; lag <= maxLag; lag++) {
    if (lag > 0) {
      const head = at(x, lag - 1);
      const tail = at(x, size - lag);
      m -= head * head + tail * tail;
    }
    let r = 0;
    for (let i = 0; i < size - lag; i++) r += at(x, i) * at(x, i + lag);
    nsdf[lag] = m > 0 ? 2 * r / m : 0;
  }

  const keyMaxima: number[] = [];
  let lag = 1;
  // Skip the zero-lag lobe: start after the first negative-going zero crossing.
  while (lag < maxLag && at(nsdf, lag) > 0) lag++;
  let best = -1;
  for (; lag < maxLag; lag++) {
    const value = at(nsdf, lag);
    const previous = at(nsdf, lag - 1);
    if (value > 0 && previous <= 0) best = -1;
    if (value > 0 && (best < 0 || value > at(nsdf, best))) best = lag;
    if (value <= 0 && previous > 0 && best >= 0) { keyMaxima.push(best); best = -1; }
  }
  // A lobe still positive at the window edge only counts when its maximum is interior.
  if (best >= 0 && best < maxLag - 1) keyMaxima.push(best);
  const candidates = keyMaxima.filter(n => n >= minLag);
  if (!candidates.length) return null;
  const highest = Math.max(...candidates.map(n => at(nsdf, n)));
  const chosen = candidates.find(n => at(nsdf, n) >= cutoff * highest);
  if (chosen === undefined) return null;
  const a = at(nsdf, chosen - 1);
  const b = at(nsdf, chosen);
  const c = at(nsdf, chosen + 1);
  const divisor = a - 2 * b + c;
  const offset = divisor === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * divisor)));
  const clarity = Math.min(1, b - (a - c) * offset / 4);
  const frequency = sampleRate / (chosen + offset);
  if (!Number.isFinite(frequency) || clarity < minClarity) return null;
  if (frequency < minFrequency * 0.97 || frequency > maxFrequency * 1.03) return null;
  return { frequency, clarity, rms };
}

export function frequencyToMidi(frequency: number, a4 = 440): number {
  return 69 + 12 * Math.log2(frequency / a4);
}
export function midiToFrequency(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12);
}
/** Positive when sharp of the target note. */
export function centsOff(frequency: number, targetMidi: number, a4 = 440): number {
  return 1200 * Math.log2(frequency / midiToFrequency(targetMidi, a4));
}
export function nearestNote(frequency: number, a4 = 440): NearestNote {
  const midi = Math.round(frequencyToMidi(frequency, a4));
  return { midi, cents: centsOff(frequency, midi, a4) };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? NaN;
  return ((sorted[middle - 1] ?? NaN) + (sorted[middle] ?? NaN)) / 2;
}

export interface PitchHandlers {
  onPitch: (reading: PitchReading | null) => void;
  onError: (error: Error) => void;
}
/** Anything that can stream pitch readings; components accept a factory so tests can inject a fake. */
export interface PitchSource {
  start: (deviceId: string, handlers: PitchHandlers) => Promise<void>;
  stop: () => void;
}
export interface LivePitchOptions {
  intervalMs?: number;
  maxDurationMs?: number;
  smoothingFrames?: number;
  pitch?: PitchOptions;
}
interface Capture {
  context: AudioContext;
  handlers: PitchHandlers;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  timer: ReturnType<typeof setInterval> | null;
  ended: (() => void) | null;
  stopped: boolean;
}
function asError(error: unknown): Error {
  return error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
}

export const LIVE_PITCH_LIMIT_MS = 600000;

/** Transient in-memory analysis only: nothing is recorded, monitored or uploaded. */
export class LivePitchInput implements PitchSource {
  private capture: Capture | null = null;
  private readonly intervalMs: number;
  private readonly maxDurationMs: number;
  private readonly smoothingFrames: number;
  private readonly pitchOptions: PitchOptions;

  public constructor(options: LivePitchOptions = {}) {
    this.intervalMs = options.intervalMs ?? 60;
    this.maxDurationMs = options.maxDurationMs ?? LIVE_PITCH_LIMIT_MS;
    this.smoothingFrames = Math.max(1, options.smoothingFrames ?? 5);
    this.pitchOptions = options.pitch ?? {};
  }

  public get active(): boolean { return this.capture !== null; }

  public stop(): void {
    const capture = this.capture;
    if (!capture || capture.stopped) return;
    capture.stopped = true;
    this.capture = null;
    if (capture.timer !== null) clearInterval(capture.timer);
    if (capture.stream) {
      for (const track of capture.stream.getTracks()) {
        if (capture.ended) track.removeEventListener("ended", capture.ended);
        track.stop();
      }
    }
    capture.source?.disconnect();
    capture.analyser?.disconnect();
    if (capture.context.state !== "closed") {
      void capture.context.close().catch(error => capture.handlers.onError(asError(error)));
    }
  }

  public async start(deviceId: string, handlers: PitchHandlers): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext !== "function") {
      throw new Error("Live audio input is unavailable in this browser context.");
    }
    const context = new AudioContext();
    const capture: Capture = { context, handlers, stream: null, source: null, analyser: null,
      timer: null, ended: null, stopped: false };
    this.capture = capture;
    // Resume inside the user gesture, before awaiting the permission prompt.
    const ready = context.state === "suspended" ? context.resume() : Promise.resolve();
    const resumed = ready.then(() => null, error => asError(error));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: inputConstraints(deviceId) });
      if (capture.stopped) {
        stream.getTracks().forEach(track => track.stop());
        throw new DOMException("Audio input request cancelled.", "AbortError");
      }
      capture.stream = stream;
      const resumeError = await resumed;
      if (capture.stopped) throw new DOMException("Audio input request cancelled.", "AbortError");
      if (resumeError) throw resumeError;
      if (context.state !== "running") throw new Error("Audio input is suspended. Try again from a button click.");
      const analyser = context.createAnalyser();
      analyser.fftSize = 4096;
      const source = context.createMediaStreamSource(stream);
      capture.analyser = analyser;
      capture.source = source;
      source.connect(analyser);
      // Intentionally not connected to destination: never monitor or amplify the input.
      const buffer = new Float32Array(analyser.fftSize);
      const factor = Math.max(1, Math.round(context.sampleRate / 24000));
      const reduced = new Float32Array(Math.floor(buffer.length / factor));
      const history: number[] = [];
      const started = performance.now();
      capture.ended = () => {
        if (capture.stopped) return;
        this.stop();
        handlers.onError(new Error("Audio input disconnected. Reconnect the device and start again."));
      };
      stream.getTracks().forEach(track => track.addEventListener("ended", capture.ended!));
      const tick = () => {
        if (capture.stopped) return;
        try {
          if (performance.now() - started >= this.maxDurationMs) {
            throw new Error(`Listening stopped after the ${Math.round(this.maxDurationMs / 60000)}-minute safety limit.`);
          }
          if (context.state !== "running") throw new Error("Audio input was interrupted.");
          analyser.getFloatTimeDomainData(buffer);
          for (let i = 0; i < reduced.length; i++) {
            let total = 0;
            for (let j = 0; j < factor; j++) total += at(buffer, i * factor + j);
            reduced[i] = total / factor;
          }
          const reading = detectMpm(reduced, context.sampleRate / factor, this.pitchOptions);
          if (!reading) {
            history.length = 0;
            handlers.onPitch(null);
            return;
          }
          history.push(reading.frequency);
          if (history.length > this.smoothingFrames) history.shift();
          handlers.onPitch({ ...reading, frequency: median(history) });
        } catch (error) {
          this.stop();
          handlers.onError(asError(error));
        }
      };
      capture.timer = setInterval(tick, this.intervalMs);
      tick();
    } catch (error) {
      if (!capture.stopped) this.stop();
      throw asError(error);
    }
  }
}
