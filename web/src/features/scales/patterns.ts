import { noteName, validateRoot } from "./theory";
import type { FretNote, Scale, Tuning } from "./theory";

export type PatternSystem = "caged" | "3nps";
export interface ScalePattern {
  readonly id: string;
  readonly name: string;
  readonly notes: readonly FretNote[];
}
export interface PatternResult {
  readonly patterns: readonly ScalePattern[];
  readonly reason: string | null;
}

// C-major scale fingerings around the five actual chord forms, low E to high E.
// Transposition preserves the G–B major-third offset; these are not fret windows.
const CAGED: readonly (readonly [string, readonly (readonly number[])[]])[] = [
  ["C", [[0, 1, 3], [0, 2, 3], [0, 2, 3], [0, 2], [0, 1, 3], [0, 1, 3]]],
  ["A", [[3, 5], [2, 3, 5], [2, 3, 5], [2, 4, 5], [3, 5], [3, 5]]],
  ["G", [[5, 7, 8], [5, 7], [5, 7], [4, 5, 7], [5, 6, 8], [5, 7, 8]]],
  ["E", [[7, 8, 10], [7, 8, 10], [7, 9, 10], [7, 9, 10], [8, 10], [7, 8, 10]]],
  ["D", [[10, 12, 13], [10, 12], [9, 10, 12], [9, 10, 12], [10, 12, 13], [10, 12, 13]]],
];

export function getPatterns(scale: Scale, root: number, tuning: Tuning, system: PatternSystem): PatternResult {
  validateRoot(root);
  const standard = [40, 45, 50, 55, 59, 64];
  if (tuning.midi.length !== 6 || tuning.midi.some((n, i) => n !== standard[i])) {
    return { patterns: [], reason: `${system === "caged" ? "CAGED" : "3NPS"} shapes support standard six-string tuning only. The full fretboard remains available.` };
  }
  if (system === "caged") {
    if (!["major", "natural-minor", "major-pentatonic", "minor-pentatonic"].includes(scale.id)) {
      return { patterns: [], reason: "CAGED chord-form fingerings support major, natural minor and their pentatonics only; other scales are not approximated." };
    }
    const relativeMinor = scale.id === "natural-minor" || scale.id === "minor-pentatonic";
    const formRoot = relativeMinor ? (root + 3) % 12 : root;
    const suffix = relativeMinor ? ` · relative major (${noteName(formRoot)})`
      : scale.id === "major-pentatonic" ? " · major pentatonic" : "";
    return { reason: null, patterns: CAGED.map(([name, strings]) => ({
      id: name, name: `${name} form${suffix}`,
      notes: strings.flatMap((frets, string) => frets.map(fret => ({
        string, fret: fret + formRoot, midi: (standard[string] ?? 40) + fret + formRoot,
      }))).filter(note => scale.intervals.includes((note.midi - root + 120) % 12)),
    })) };
  }
  if (scale.intervals.length !== 7) {
    return { patterns: [], reason: "Seven 3NPS patterns require a seven-note scale. No authentic seven-pattern set is claimed for this scale." };
  }
  const lowTonic = (root - 4 + 12) % 12;
  const patterns = scale.intervals.map((degree, index): ScalePattern => {
    const first = (lowTonic + degree) % 12;
    const pitches = Array.from({ length: 60 }, (_, semitone) => 40 + first + semitone)
      .filter(midi => scale.intervals.includes((midi - root + 120) % 12)).slice(0, 18);
    // Generate the complete musical sequence first, then assign exactly three tones
    // per string. A higher open string must never silently omit the next scale tone.
    for (const shift of [0, 12]) {
      const notes = pitches.map((midi, i) => {
        const string = Math.floor(i / 3);
        return { string, midi: midi + shift, fret: midi + shift - (standard[string] ?? 40) };
      });
      if (notes.every(note => note.fret >= 0 && note.fret <= 24)) {
        return { id: `3nps-${index + 1}`,
          name: `Pattern ${index + 1} — degree ${index + 1}${shift ? " · upper octave" : ""}`, notes };
      }
    }
    return { id: `3nps-${index + 1}`, name: `Pattern ${index + 1} — degree ${index + 1}`, notes: [] };
  });
  if (patterns.some(p => p.notes.length !== 18)) {
    return { patterns: [], reason: "Seven consecutive 3NPS fingerings do not all fit the 24-fret board for this scale/key. Use the full fretboard; no tones are skipped." };
  }
  return { reason: null, patterns };
}
