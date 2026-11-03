import { ChromaWindow, fftToChroma } from "./detector";
import type { DetectionResult } from "./detector";

export type MicrophoneStatus =
  | { state: "idle" | "permission" | "listening" }
  | { state: "error"; message: string };
export interface MicrophoneCallbacks {
  onStatus: (status: MicrophoneStatus) => void;
  onResult: (result: DetectionResult) => void;
}

/** One user-started browser capture session, with cancellation of late permission grants. */
export class ChordMicrophone {
  private generation = 0;
  private disposed = false;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly window = new ChromaWindow();
  private readonly ended = (): void => this.fail("Microphone disconnected. Reconnect it and try again.");

  public constructor(private readonly callbacks: MicrophoneCallbacks) {}

  public async start(): Promise<void> {
    if (this.disposed) return;
    this.stop();
    const generation = ++this.generation;
    this.callbacks.onStatus({ state: "permission" });
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
        throw new Error("Microphone capture is unavailable. Use a secure localhost browser or select a chord manually.");
      }
      const context = new AudioContext();
      this.context = context;
      await context.resume();
      if (this.disposed || generation !== this.generation) return;
      if (context.state !== "running") throw new Error("Audio is suspended. Stop and enable the microphone again.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
      if (this.disposed || generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      if (!stream.getAudioTracks().length) throw new Error("No microphone audio track was provided.");
      stream.getAudioTracks().forEach(track => track.addEventListener("ended", this.ended));
      const analyser = context.createAnalyser();
      this.analyser = analyser;
      analyser.fftSize = 32768;
      analyser.smoothingTimeConstant = 0;
      const source = context.createMediaStreamSource(stream);
      this.source = source;
      source.connect(analyser);
      const bins = new Float32Array(analyser.frequencyBinCount);
      this.callbacks.onStatus({ state: "listening" });
      this.timer = setInterval(() => {
        try {
          if (context.state !== "running") throw new Error("Audio input was interrupted. Stop and try again.");
          analyser.getFloatFrequencyData(bins);
          const result = this.window.push(fftToChroma(bins, context.sampleRate, analyser.fftSize), performance.now());
          if (result) this.callbacks.onResult(result);
        } catch (error) {
          this.fail(error instanceof Error ? error.message : "Audio input failed. Try again.");
        }
      }, 100);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      this.fail(denied ? "Microphone permission denied. Allow access or select a chord manually."
        : error instanceof Error ? error.message : "Could not start the microphone. Select a chord manually.");
    }
  }

  public stop(): void {
    const generation = ++this.generation;
    let cleanupFailed = false;
    const release = (action: () => void): void => {
      try { action(); } catch { cleanupFailed = true; }
    };
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.window.reset();
    this.stream?.getAudioTracks().forEach(track => release(() => track.removeEventListener("ended", this.ended)));
    this.stream?.getTracks().forEach(track => release(() => track.stop()));
    this.stream = null;
    const source = this.source;
    if (source) release(() => source.disconnect());
    this.source = null;
    const analyser = this.analyser;
    if (analyser) release(() => analyser.disconnect());
    this.analyser = null;
    const context = this.context;
    this.context = null;
    const reportCleanupFailure = (): void => {
      if (!this.disposed && generation === this.generation) this.callbacks.onStatus({
        state: "error", message: "Audio context cleanup failed. Reload this page before trying again.",
      });
    };
    if (context && context.state !== "closed") {
      release(() => { void context.close().catch(reportCleanupFailure); });
    }
    if (!this.disposed) this.callbacks.onStatus({ state: "idle" });
    if (cleanupFailed) reportCleanupFailure();
  }

  public dispose(): void { this.disposed = true; this.stop(); }

  private fail(message: string): void {
    this.stop();
    if (!this.disposed) this.callbacks.onStatus({ state: "error", message });
  }
}
