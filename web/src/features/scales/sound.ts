import { validMidi } from "./theory";

interface Voice { oscillator: OscillatorNode; gain: GainNode }
export interface SoundOptions {
  waveform?: "triangle" | "sine" | "square";
  volume?: number;
}
export interface MetronomeOptions extends SoundOptions {
  beatsPerBar?: number;
  beatUnit?: 4 | 8;
}
interface AudioSession {
  context: AudioContext;
  voices: Set<Voice>;
  timer: ReturnType<typeof setInterval> | null;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

function audioError(error: unknown): Error {
  return error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
}
export function isAudioCancellation(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === "AbortError";
}

/** Owns one context and lookahead scheduler. stop() rejects pending work with AbortError. */
export class AudioPlayer {
  private session: AudioSession | null = null;

  public play(notes: readonly number[], bpm = 90, options: SoundOptions = {}): Promise<void> {
    return this.start(notes, bpm, false, options);
  }
  public metronome(bpm = 90, options: MetronomeOptions = {}): Promise<void> {
    return this.start([], bpm, true, options);
  }
  public stop(): void {
    if (this.session) {
      this.finish(this.session, new DOMException("Playback stopped.", "AbortError"));
    }
  }
  private finish(session: AudioSession, error?: Error): void {
    if (session.settled) return;
    session.settled = true;
    if (this.session === session) this.session = null;
    if (session.timer !== null) clearInterval(session.timer);
    let failure = error;
    for (const voice of session.voices) {
      try {
        voice.oscillator.onended = null;
        voice.oscillator.stop();
        voice.oscillator.disconnect();
        voice.gain.disconnect();
      } catch (cleanupError) {
        failure = audioError(cleanupError);
      }
    }
    session.voices.clear();
    const settle = () => { if (failure) session.reject(failure); else session.resolve(); };
    try {
      void session.context.close().then(settle, closeError => session.reject(audioError(closeError)));
    } catch (closeError) {
      session.reject(audioError(closeError));
    }
  }
  private voice(session: AudioSession, midi: number, when: number, duration: number,
    click: boolean, options: MetronomeOptions, accent: boolean): void {
    const { context } = session;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const voice = { oscillator, gain };
    session.voices.add(voice);
    oscillator.type = click ? "square" : options.waveform ?? "triangle";
    oscillator.frequency.setValueAtTime(click ? (accent ? 1200 : 800) : 440 * 2 ** ((midi - 69) / 12), when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, (click ? 0.075 : 0.3) * (options.volume ?? 0.6)), when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      session.voices.delete(voice);
    };
    oscillator.start(when);
    oscillator.stop(when + duration + 0.01);
  }
  private async start(notes: readonly number[], bpm: number, metronome: boolean, options: MetronomeOptions): Promise<void> {
    this.stop();
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) throw new Error("Tempo must be between 30 and 300 BPM.");
    if (!metronome && (!notes.length || notes.length > 512 || notes.some(n => !validMidi(n)))) {
      throw new Error("Provide 1–512 valid MIDI notes (0–127).");
    }
    if (options.volume !== undefined && (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 1)) {
      throw new Error("Audio volume must be between 0 and 1.");
    }
    if (options.beatsPerBar !== undefined && (!Number.isInteger(options.beatsPerBar) || options.beatsPerBar < 1 || options.beatsPerBar > 12)) {
      throw new Error("Metronome beats per bar must be between 1 and 12.");
    }
    if (options.beatUnit !== undefined && options.beatUnit !== 4 && options.beatUnit !== 8) {
      throw new Error("Metronome beat unit must be 4 or 8.");
    }
    if (options.waveform !== undefined && !["triangle", "sine", "square"].includes(options.waveform)) {
      throw new Error("Unsupported audio tone.");
    }
    if (typeof globalThis.AudioContext !== "function") throw new Error("Web Audio is unavailable in this browser.");
    const sequence = [...notes];
    const context = new AudioContext();
    return new Promise<void>((resolve, reject) => {
      const session: AudioSession = { context, voices: new Set(), timer: null, settled: false, resolve, reject };
      this.session = session;
      const schedule = async () => {
        try {
          if (context.state === "suspended") await context.resume();
          if (session.settled) return;
          if (context.state !== "running") throw new Error("Audio could not start. Enable audio and try again.");
          const beat = 60 / bpm * (metronome ? 4 / (options.beatUnit ?? 4) : 1);
          const start = context.currentTime + 0.035;
          let index = 0;
          let next = start;
          const tick = () => {
            if (session.settled) return;
            try {
              if (context.state !== "running") throw new Error("Audio was interrupted; playback stopped.");
              if (next < context.currentTime - 1) throw new Error("Audio scheduling was interrupted; restart playback.");
              // Small lookahead, never queue an entire exercise; stopping cancels every voice.
              let scheduled = 0;
              while (next < context.currentTime + 0.12 && (metronome || index < sequence.length)) {
                if (scheduled++ >= 8) { next = context.currentTime + 0.035; break; }
                this.voice(session, sequence[index] ?? 60, Math.max(next, context.currentTime + 0.005),
                  metronome ? 0.035 : Math.min(0.45, beat * 0.8), metronome, options,
                  index % (options.beatsPerBar ?? 4) === 0);
                index++;
                next = start + index * beat;
              }
              if (!metronome && index === sequence.length && context.currentTime >= start + sequence.length * beat) {
                this.finish(session);
              }
            } catch (error) { this.finish(session, audioError(error)); }
          };
          session.timer = setInterval(tick, 25);
          tick();
        } catch (error) {
          if (!session.settled) this.finish(session, audioError(error));
        }
      };
      void schedule();
    });
  }
}

const sharedPlayer = new AudioPlayer();
/** Plays one note per beat; a new call cancels the previous shared sequence. */
export async function playNotes(notes: readonly number[], bpm = 90): Promise<void> {
  await sharedPlayer.play(notes, bpm);
}
export function stopNotes(): void { sharedPlayer.stop(); }
