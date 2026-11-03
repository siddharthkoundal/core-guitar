export const ROOT_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"] as const;
export const QUALITIES = ["major", "minor", "dom7", "maj7", "min7", "dim", "aug", "sus2", "sus4"] as const;
export type ChordQuality = typeof QUALITIES[number];
export interface ChordShape { root: number; quality: ChordQuality }
export interface DetectedChord {
  name: string;
  root: number;
  quality: string;
  similarity: number;
  detectedAt: string;
}
interface ChordTemplate extends ChordShape { name: string; intervals: readonly number[]; chroma: readonly number[] }
export type DetectionResult =
  | { state: "no-signal" }
  | { state: "ambiguous" }
  | { state: "detected"; chord: DetectedChord };

const INTERVALS: Record<ChordQuality, readonly number[]> = {
  major: [0, 4, 7], minor: [0, 3, 7], dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dim: [0, 3, 6],
  aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
};
const SUFFIXES: Record<ChordQuality, string> = {
  major: "", minor: "m", dom7: "7", maj7: "maj7", min7: "m7",
  dim: "dim", aug: "aug", sus2: "sus2", sus4: "sus4",
};

export function isQuality(value: unknown): value is ChordQuality {
  return typeof value === "string" && QUALITIES.some(quality => quality === value);
}

export function chordName(root: number, quality: ChordQuality): string {
  return `${ROOT_NAMES[root] ?? "?"}${SUFFIXES[quality]}`;
}

export const CHORD_TEMPLATES: readonly ChordTemplate[] = ROOT_NAMES.flatMap((_, root) =>
  QUALITIES.map(quality => ({
    root, quality, name: chordName(root, quality), intervals: INTERVALS[quality],
    chroma: Array.from({ length: 12 }, (_, pitch) =>
      INTERVALS[quality].some(interval => (root + interval) % 12 === pitch) ? 1 : 0),
  })));

/**
 * Maps local FFT peaks (linear amplitudes) into equal-tempered pitch classes.
 * The -80 dB gate is per bin; no audio or spectrum leaves the browser.
 */
export function fftToChroma(bins: Float32Array, sampleRate: number, fftSize: number): number[] {
  const chroma = Array<number>(12).fill(0);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || fftSize < 2 || bins.length !== fftSize / 2) return chroma;
  for (let index = 1; index < bins.length - 1; index++) {
    const frequency = index * sampleRate / fftSize;
    const db = bins[index] ?? -Infinity;
    if (frequency < 60 || frequency > 5000 || !Number.isFinite(db) || db <= -80) continue;
    // Peak picking avoids treating broadband energy and FFT leakage as notes.
    if (db <= (bins[index - 1] ?? -Infinity) || db < (bins[index + 1] ?? -Infinity)) continue;
    const midi = 69 + 12 * Math.log2(frequency / 440);
    if (Math.abs(midi - Math.round(midi)) > 0.4) continue;
    const pitch = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pitch] = (chroma[pitch] ?? 0) + 10 ** (Math.min(db, 0) / 20);
  }
  return chroma;
}

export function detectChord(chroma: readonly number[]): DetectionResult {
  if (chroma.length !== 12 || chroma.some(value => !Number.isFinite(value) || value < 0)) {
    return { state: "no-signal" };
  }
  const norm = Math.hypot(...chroma);
  if (norm < 0.0001) return { state: "no-signal" };
  const peak = Math.max(...chroma);
  if (chroma.filter(value => value >= peak * 0.18).length < 3) return { state: "ambiguous" };
  const ranked = CHORD_TEMPLATES.map(template => ({
    template,
    similarity: template.chroma.reduce((sum, value, pitch) => sum + value * (chroma[pitch] ?? 0), 0)
      / (norm * Math.sqrt(template.intervals.length)),
  })).sort((a, b) => b.similarity - a.similarity);
  const best = ranked[0];
  const next = ranked[1];
  // Similarity is a template fit, never a calibrated probability or accuracy.
  // Exact aliases (augmented inversions, sus2/sus4) deliberately stay ambiguous.
  if (!best || !next || best.similarity < 0.9 || best.similarity - next.similarity < 0.045) {
    return { state: "ambiguous" };
  }
  return { state: "detected", chord: {
    name: best.template.name, root: best.template.root, quality: best.template.quality,
    similarity: Math.min(1, best.similarity), detectedAt: new Date().toISOString(),
  } };
}

export class ChromaWindow {
  private frames: { time: number; chroma: readonly number[] }[] = [];

  public reset(): void { this.frames = []; }

  public push(chroma: readonly number[], time: number): DetectionResult | null {
    const previous = this.frames.at(-1);
    // At a nominal 100 ms cadence, longer gaps cannot count as sustained audio.
    if (previous && (time <= previous.time || time - previous.time > 250)) this.reset();
    this.frames.push({ time, chroma: [...chroma] });
    const start = this.frames[0]?.time ?? time;
    if (time - start < 2500) return null;
    const frames = this.frames;
    this.reset();
    const sounding = frames.filter(frame => Math.hypot(...frame.chroma) >= 0.0001);
    if (frames.length < 10 || sounding.length < frames.length * 0.7) return { state: "no-signal" };
    const averaged = Array.from({ length: 12 }, (_, pitch) =>
      frames.reduce((sum, frame) => sum + (frame.chroma[pitch] ?? 0), 0) / frames.length);
    const result = detectChord(averaged);
    if (result.state !== "detected") return result;
    const stable = sounding.filter(frame => {
      const current = detectChord(frame.chroma);
      return current.state === "detected" && current.chord.name === result.chord.name;
    });
    return stable.length >= sounding.length * 0.7 ? result : { state: "ambiguous" };
  }
}
