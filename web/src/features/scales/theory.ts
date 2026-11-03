export interface Scale {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly intervals: readonly number[];
}
export interface Tuning {
  readonly id: string;
  readonly name: string;
  readonly midi: readonly number[];
}
export interface FretNote {
  /** Zero-based, low string first. */
  readonly string: number;
  readonly fret: number;
  readonly midi: number;
}

function modes(category: string, parent: readonly number[], names: readonly (readonly [string, string])[]): Scale[] {
  return names.map(([id, name], index) => {
    const tonic = parent[index] ?? 0;
    return { id, name, category,
      intervals: parent.map(n => (n - tonic + 12) % 12).sort((a, b) => a - b) };
  });
}
function scales(category: string, entries: readonly (readonly [string, string, readonly number[]])[]): Scale[] {
  return entries.map(([id, name, intervals]) => ({ id, name, intervals, category }));
}

export const SCALE_CATALOG: readonly Scale[] = [
  ...modes("Major modes", [0, 2, 4, 5, 7, 9, 11], [
    ["major", "Major (Ionian)"], ["dorian", "Dorian"], ["phrygian", "Phrygian"],
    ["lydian", "Lydian"], ["mixolydian", "Mixolydian"], ["natural-minor", "Natural minor (Aeolian)"],
    ["locrian", "Locrian"],
  ]),
  ...modes("Harmonic minor modes", [0, 2, 3, 5, 7, 8, 11], [
    ["harmonic-minor", "Harmonic minor"], ["locrian-natural6", "Locrian ♮6"],
    ["ionian-sharp5", "Ionian augmented (♯5)"], ["dorian-sharp4", "Dorian ♯4"],
    ["phrygian-dominant", "Phrygian dominant"], ["lydian-sharp2", "Lydian ♯2"],
    ["ultralocrian", "Super Locrian ♭♭7 (Ultralocrian)"],
  ]),
  ...modes("Melodic minor modes", [0, 2, 3, 5, 7, 9, 11], [
    ["melodic-minor", "Melodic minor (jazz)"], ["dorian-flat2", "Dorian ♭2 (Phrygian ♮6)"],
    ["lydian-augmented", "Lydian augmented"], ["lydian-dominant", "Lydian dominant"],
    ["mixolydian-flat6", "Mixolydian ♭6"], ["locrian-natural2", "Locrian ♮2"],
    ["altered", "Altered (super Locrian)"],
  ]),
  ...scales("Pentatonic", [
    ["major-pentatonic", "Major pentatonic", [0, 2, 4, 7, 9]],
    ["minor-pentatonic", "Minor pentatonic", [0, 3, 5, 7, 10]],
    ["egyptian", "Egyptian pentatonic", [0, 2, 5, 7, 10]],
    ["hirajoshi", "Hirajoshi", [0, 2, 3, 7, 8]],
  ]),
  ...scales("Blues", [
    ["minor-blues", "Minor blues", [0, 3, 5, 6, 7, 10]],
    ["major-blues", "Major blues", [0, 2, 3, 4, 7, 9]],
    ["dominant-blues", "Dominant blues", [0, 2, 3, 4, 7, 9, 10]],
  ]),
  ...scales("Hexatonic", [
    ["augmented", "Augmented", [0, 3, 4, 7, 8, 11]],
    ["prometheus", "Prometheus", [0, 2, 4, 6, 9, 10]],
    ["tritone", "Tritone", [0, 1, 4, 6, 7, 10]],
  ]),
  ...scales("Bebop", [
    ["bebop-dominant", "Bebop dominant", [0, 2, 4, 5, 7, 9, 10, 11]],
    ["bebop-major", "Bebop major", [0, 2, 4, 5, 7, 8, 9, 11]],
    ["bebop-dorian", "Bebop Dorian", [0, 2, 3, 4, 5, 7, 9, 10]],
    ["bebop-minor", "Bebop minor (Dorian + major 7)", [0, 2, 3, 5, 7, 9, 10, 11]],
    ["bebop-melodic-minor", "Bebop melodic minor", [0, 2, 3, 5, 7, 8, 9, 11]],
  ]),
  ...scales("Symmetrical", [
    ["whole-tone", "Whole tone", [0, 2, 4, 6, 8, 10]],
    ["diminished-half-whole", "Diminished half–whole", [0, 1, 3, 4, 6, 7, 9, 10]],
    ["diminished-whole-half", "Diminished whole–half", [0, 2, 3, 5, 6, 8, 9, 11]],
    ["chromatic", "Chromatic", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  ]),
  ...scales("World", [
    ["hungarian-minor", "Hungarian minor", [0, 2, 3, 6, 7, 8, 11]],
    ["hungarian-major", "Hungarian major", [0, 3, 4, 6, 7, 9, 10]],
    ["double-harmonic", "Double harmonic major", [0, 1, 4, 5, 7, 8, 11]],
    ["persian", "Persian", [0, 1, 4, 5, 6, 8, 11]],
    ["in-sen", "In sen", [0, 1, 5, 7, 10]],
    ["iwato", "Iwato", [0, 1, 5, 6, 10]],
    ["in-scale", "In scale", [0, 1, 5, 7, 8]],
    ["yo-scale", "Yo scale", [0, 2, 5, 7, 9]],
    ["chinese-scale", "Chinese scale", [0, 4, 6, 7, 11]],
    ["balinese", "Balinese", [0, 1, 3, 7, 8]],
    ["arabian", "Arabian (major Locrian)", [0, 2, 4, 5, 6, 8, 10]],
  ]),
  ...scales("Other heptatonic", [
    ["neapolitan-minor", "Neapolitan minor", [0, 1, 3, 5, 7, 8, 11]],
    ["neapolitan-major", "Neapolitan major", [0, 1, 3, 5, 7, 9, 11]],
    ["enigmatic", "Enigmatic", [0, 1, 4, 6, 8, 10, 11]],
    ["harmonic-major", "Harmonic major", [0, 2, 4, 5, 7, 8, 11]],
  ]),
];

/** Equivalent names only; differently spelled/variant pitch sets remain separate entries. */
export const SCALE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ionian: "major",
  aeolian: "natural-minor",
  "ionian-augmented": "ionian-sharp5",
  "super-locrian-bb7": "ultralocrian",
  "super-locrian": "altered",
  "phrygian-sharp6": "dorian-flat2",
  "blues-scale": "minor-blues",
});

export function resolveScaleId(id: string): string | null {
  const canonical = Object.hasOwn(SCALE_ALIASES, id) ? SCALE_ALIASES[id] : id;
  return SCALE_CATALOG.find(scale => scale.id === canonical)?.id ?? null;
}

export const TUNINGS: readonly Tuning[] = [
  { id: "standard", name: "Standard — E A D G B E", midi: [40, 45, 50, 55, 59, 64] },
  { id: "dropD", name: "Drop D — D A D G B E", midi: [38, 45, 50, 55, 59, 64] },
  { id: "dropC", name: "Drop C — C G C F A D", midi: [36, 43, 48, 53, 57, 62] },
  { id: "DADGAD", name: "DADGAD — D A D G A D", midi: [38, 45, 50, 55, 57, 62] },
  { id: "openG", name: "Open G — D G D G B D", midi: [38, 43, 50, 55, 59, 62] },
  { id: "openD", name: "Open D — D A D F♯ A D", midi: [38, 45, 50, 54, 57, 62] },
  { id: "openE", name: "Open E — E B E G♯ B E", midi: [40, 47, 52, 56, 59, 64] },
  { id: "openA", name: "Open A — E A E A C♯ E", midi: [40, 45, 52, 57, 61, 64] },
  { id: "halfdown", name: "Half step down", midi: [39, 44, 49, 54, 58, 63] },
  { id: "wholedown", name: "Whole step down", midi: [38, 43, 48, 53, 57, 62] },
  { id: "7string", name: "7-string — B E A D G B E", midi: [35, 40, 45, 50, 55, 59, 64] },
  { id: "8string", name: "8-string — F♯ B E A D G B E", midi: [30, 35, 40, 45, 50, 55, 59, 64] },
];

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;
export function validMidi(midi: number): boolean {
  return Number.isInteger(midi) && midi >= 0 && midi <= 127;
}
export function noteName(midi: number): string {
  if (!validMidi(midi)) throw new Error("MIDI note must be an integer from 0 to 127.");
  return NOTE_NAMES[midi % 12] ?? "C";
}
export function validateRoot(root: number): void {
  if (!Number.isInteger(root) || root < 0 || root > 11) throw new Error("Root must be a pitch class from 0 to 11.");
}
export function fretboard(tuning: Pick<Tuning, "midi">): FretNote[] {
  if (!tuning.midi.length || tuning.midi.some(n => !validMidi(n) || !validMidi(n + 24))) {
    throw new Error("Tuning must contain MIDI notes with room for 24 frets.");
  }
  return tuning.midi.flatMap((open, string) => Array.from({ length: 25 }, (_, fret) => ({
    string, fret, midi: open + fret,
  })));
}
export function scaleNotes(scale: Scale, root: number): number[] {
  validateRoot(root);
  return [...scale.intervals.map(n => 60 + root + n), 72 + root];
}
/** Semitone labels deliberately avoid claiming enharmonic/diatonic spelling. */
export function intervalName(interval: number): string {
  return ["R", "♭2", "2", "♭3", "3", "4", "♯4/♭5", "5", "♭6", "6", "♭7", "7"][interval] ?? "";
}
