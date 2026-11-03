import { noteName } from "./theory";

export interface DetectedPitch {
  midi: number;
  frequency: number;
  confidence: number;
  rms: number;
}

/** Normalized autocorrelation, gated for a single sustained 40–1400 Hz tone. */
export function detectPitch(samples: Float32Array, sampleRate: number): DetectedPitch | null {
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || samples.length < 512) return null;
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  const centered = Float32Array.from(samples, n => n - mean);
  let energy = 0;
  for (const sample of centered) energy += sample * sample;
  const rms = Math.sqrt(energy / centered.length);
  if (!Number.isFinite(rms) || rms < 0.008) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / 1400));
  const maxLag = Math.min(Math.floor(sampleRate / 40), Math.floor(centered.length / 2));
  const correlation = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let cross = 0;
    let norm = 0;
    for (let i = 0; i < centered.length - lag; i++) {
      const a = centered[i] ?? 0;
      const b = centered[i + lag] ?? 0;
      cross += a * b;
      norm += a * a + b * b;
    }
    correlation[lag] = norm ? 2 * cross / norm : 0;
  }
  const peaks: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const value = correlation[lag] ?? 0;
    if (value >= (correlation[lag - 1] ?? 0) && value > (correlation[lag + 1] ?? 0)) peaks.push(lag);
  }
  const strongest = Math.max(0, ...peaks.map(lag => correlation[lag] ?? 0));
  if (strongest < 0.88) return null;
  const lag = peaks.find(n => (correlation[n] ?? 0) >= Math.max(0.88, strongest * 0.96));
  if (lag === undefined) return null;
  const left = correlation[lag - 1] ?? 0;
  const center = correlation[lag] ?? 0;
  const right = correlation[lag + 1] ?? 0;
  const divisor = left - 2 * center + right;
  const offset = divisor === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (left - right) / (2 * divisor)));
  const frequency = sampleRate / (lag + offset);
  const exact = 69 + 12 * Math.log2(frequency / 440);
  const midi = Math.round(exact);
  if (midi < 28 || midi > 89 || Math.abs(exact - midi) > 0.35) return null;
  return { midi, frequency, confidence: center, rms };
}

export interface MicrophoneHandlers {
  onNote: (midi: number) => void;
  onStatus: (status: string) => void;
  onError: (error: Error) => void;
}
interface Capture {
  context: AudioContext;
  handlers: MicrophoneHandlers;
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

/** No recordings or network uploads: only transient waveform/pitch data in memory. */
export class MicrophoneInput {
  private capture: Capture | null = null;

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
  public async start(handlers: MicrophoneHandlers): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext !== "function") {
      throw new Error("Live microphone input is unavailable; use a secure browser context or fretboard clicks.");
    }
    const context = new AudioContext();
    const capture: Capture = { context, handlers, stream: null, source: null, analyser: null,
      timer: null, ended: null, stopped: false };
    this.capture = capture;
    // Resume inside the user gesture, before awaiting the permission prompt.
    const ready = context.state === "suspended" ? context.resume() : Promise.resolve();
    // Attach a rejection handler immediately while the permission prompt is pending.
    const resumed = ready.then(() => null, error => asError(error));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      if (capture.stopped) {
        stream.getTracks().forEach(track => track.stop());
        throw new DOMException("Microphone request cancelled.", "AbortError");
      }
      capture.stream = stream;
      const resumeError = await resumed;
      if (capture.stopped) throw new DOMException("Microphone request cancelled.", "AbortError");
      if (resumeError) throw resumeError;
      if (context.state !== "running") throw new Error("Microphone audio is suspended. Try again from a button click.");
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      const source = context.createMediaStreamSource(stream);
      capture.analyser = analyser;
      capture.source = source;
      source.connect(analyser);
      // Intentionally not connected to destination: never monitor/amplify the microphone.
      const buffer = new Float32Array(analyser.fftSize);
      const factor = Math.max(1, Math.round(context.sampleRate / 12000));
      const reduced = new Float32Array(Math.floor(buffer.length / factor));
      let candidate: number | null = null;
      let stable = 0;
      let lastSent: number | null = null;
      let quietFrames = 0;
      let lastStatus = "";
      const started = performance.now();
      const status = (text: string) => {
        if (text !== lastStatus) { lastStatus = text; handlers.onStatus(text); }
      };
      capture.ended = () => {
        if (capture.stopped) return;
        this.stop();
        handlers.onError(new Error("Microphone disconnected. Reconnect it or use fretboard clicks."));
      };
      stream.getTracks().forEach(track => track.addEventListener("ended", capture.ended!));
      const tick = () => {
        if (capture.stopped) return;
        try {
          if (performance.now() - started >= 180000) throw new Error("Microphone stopped after the 3-minute safety limit.");
          if (context.state !== "running") throw new Error("Microphone audio was interrupted.");
          analyser.getFloatTimeDomainData(buffer);
          for (let i = 0; i < reduced.length; i++) {
            let total = 0;
            for (let j = 0; j < factor; j++) total += buffer[i * factor + j] ?? 0;
            reduced[i] = total / factor;
          }
          const pitch = detectPitch(reduced, context.sampleRate / factor);
          if (!pitch) {
            let energy = 0;
            for (const sample of reduced) energy += sample * sample;
            const quiet = Math.sqrt(energy / reduced.length) < 0.008;
            quietFrames = quiet ? quietFrames + 1 : 0;
            candidate = null;
            stable = 0;
            if (quietFrames >= 2) lastSent = null;
            status(quiet ? "No signal — play one clear note." : "Uncertain pitch — play one sustained note, no chords.");
            return;
          }
          quietFrames = 0;
          stable = candidate === pitch.midi ? stable + 1 : 1;
          candidate = pitch.midi;
          status(`${noteName(pitch.midi)}${Math.floor(pitch.midi / 12) - 1} · ${Math.round(pitch.confidence * 100)}% periodicity${stable < 3 ? " · stabilizing" : ""}`);
          if (stable >= 3 && lastSent !== pitch.midi) {
            lastSent = pitch.midi;
            handlers.onNote(pitch.midi);
          }
        } catch (error) {
          this.stop();
          handlers.onError(asError(error));
        }
      };
      capture.timer = setInterval(tick, 70);
      status("Listening — play one clear note.");
      tick();
    } catch (error) {
      if (!capture.stopped) this.stop();
      throw asError(error);
    }
  }
}
