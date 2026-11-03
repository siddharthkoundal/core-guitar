import { describe, expect, it } from 'vitest';
import { SCALE_CATALOG, TUNINGS, fretboard, noteName, resolveScaleId, scaleNotes } from './theory';
import { getPatterns } from './patterns';

describe('scale theory', () => {
  it('preserves the original scales and covers the reference with 55 entries in ten categories', () => {
    expect(SCALE_CATALOG).toHaveLength(55);
    expect(new Set(SCALE_CATALOG.map(s => s.id)).size).toBe(55);
    expect(new Set(SCALE_CATALOG.map(s => s.category)).size).toBe(10);
    for (const scale of SCALE_CATALOG) {
      expect(scale.intervals[0]).toBe(0);
      expect([...new Set(scale.intervals)].sort((a, b) => a - b)).toEqual(scale.intervals);
      expect(scale.intervals.every(n => Number.isInteger(n) && n >= 0 && n < 12)).toBe(true);
    }
  });

  it('covers every reference scale, resolving only genuinely equivalent aliases', () => {
    const reference: readonly (readonly [string, readonly number[]])[] = [
      ['major', [0, 2, 4, 5, 7, 9, 11]], ['natural-minor', [0, 2, 3, 5, 7, 8, 10]],
      ['harmonic-minor', [0, 2, 3, 5, 7, 8, 11]], ['locrian-natural6', [0, 1, 3, 5, 6, 9, 10]],
      ['ionian-augmented', [0, 2, 4, 5, 8, 9, 11]], ['dorian-sharp4', [0, 2, 3, 6, 7, 9, 10]],
      ['phrygian-dominant', [0, 1, 4, 5, 7, 8, 10]], ['lydian-sharp2', [0, 3, 4, 6, 7, 9, 11]],
      ['super-locrian-bb7', [0, 1, 3, 4, 6, 8, 9]], ['melodic-minor', [0, 2, 3, 5, 7, 9, 11]],
      ['phrygian-sharp6', [0, 1, 3, 5, 7, 9, 10]], ['lydian-augmented', [0, 2, 4, 6, 8, 9, 11]],
      ['lydian-dominant', [0, 2, 4, 6, 7, 9, 10]], ['mixolydian-flat6', [0, 2, 4, 5, 7, 8, 10]],
      ['locrian-natural2', [0, 2, 3, 5, 6, 8, 10]], ['super-locrian', [0, 1, 3, 4, 6, 8, 10]],
      ['major-pentatonic', [0, 2, 4, 7, 9]], ['minor-pentatonic', [0, 3, 5, 7, 10]],
      ['ionian', [0, 2, 4, 5, 7, 9, 11]], ['dorian', [0, 2, 3, 5, 7, 9, 10]],
      ['phrygian', [0, 1, 3, 5, 7, 8, 10]], ['lydian', [0, 2, 4, 6, 7, 9, 11]],
      ['mixolydian', [0, 2, 4, 5, 7, 9, 10]], ['aeolian', [0, 2, 3, 5, 7, 8, 10]],
      ['locrian', [0, 1, 3, 5, 6, 8, 10]], ['blues-scale', [0, 3, 5, 6, 7, 10]],
      ['major-blues', [0, 2, 3, 4, 7, 9]], ['bebop-dominant', [0, 2, 4, 5, 7, 9, 10, 11]],
      ['bebop-major', [0, 2, 4, 5, 7, 8, 9, 11]], ['bebop-minor', [0, 2, 3, 5, 7, 9, 10, 11]],
      ['diminished-whole-half', [0, 2, 3, 5, 6, 8, 9, 11]], ['diminished-half-whole', [0, 1, 3, 4, 6, 7, 9, 10]],
      ['whole-tone', [0, 2, 4, 6, 8, 10]], ['hungarian-minor', [0, 2, 3, 6, 7, 8, 11]],
      ['hungarian-major', [0, 3, 4, 6, 7, 9, 10]], ['double-harmonic', [0, 1, 4, 5, 7, 8, 11]],
      ['persian', [0, 1, 4, 5, 6, 8, 11]], ['hirajoshi', [0, 2, 3, 7, 8]],
      ['in-scale', [0, 1, 5, 7, 8]], ['yo-scale', [0, 2, 5, 7, 9]],
      ['chinese-scale', [0, 4, 6, 7, 11]], ['egyptian', [0, 2, 5, 7, 10]],
      ['balinese', [0, 1, 3, 7, 8]], ['enigmatic', [0, 1, 4, 6, 8, 10, 11]],
      ['neapolitan-major', [0, 1, 3, 5, 7, 9, 11]], ['neapolitan-minor', [0, 1, 3, 5, 7, 8, 11]],
      ['prometheus', [0, 2, 4, 6, 9, 10]], ['arabian', [0, 2, 4, 5, 6, 8, 10]],
    ];
    expect(reference).toHaveLength(48);
    for (const [id, intervals] of reference) {
      expect(SCALE_CATALOG.find(scale => scale.id === resolveScaleId(id))?.intervals, id).toEqual(intervals);
    }
    expect(resolveScaleId('not-a-scale')).toBeNull();
    expect(resolveScaleId('constructor')).toBeNull();
  });

  it('provides twelve low-to-high tunings and inclusive frets 0–24', () => {
    expect(TUNINGS).toHaveLength(12);
    expect(new Set(TUNINGS.map(t => t.id)).size).toBe(12);
    expect(TUNINGS.find(t => t.id === 'standard')?.midi).toEqual([40, 45, 50, 55, 59, 64]);
    expect(TUNINGS.find(t => t.id === 'dropD')?.midi).toEqual([38, 45, 50, 55, 59, 64]);
    expect(TUNINGS.find(t => t.id === '8string')?.midi).toEqual([30, 35, 40, 45, 50, 55, 59, 64]);
    for (const tuning of TUNINGS) {
      expect([...tuning.midi].sort((a, b) => a - b)).toEqual(tuning.midi);
      const board = fretboard(tuning);
      expect(board).toHaveLength(tuning.midi.length * 25);
      expect(board.every(n => n.midi === (tuning.midi[n.string] ?? 0) + n.fret)).toBe(true);
    }
    expect(noteName(60)).toBe('C');
    expect(noteName(61)).toBe('C♯');
    expect(scaleNotes(SCALE_CATALOG[0]!, 0)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it('rejects invalid MIDI/fret inputs', () => {
    expect(() => noteName(NaN)).toThrow();
    expect(() => scaleNotes(SCALE_CATALOG[0]!, 12)).toThrow();
    expect(() => fretboard({ midi: [128] })).toThrow();
  });
});

describe('guitar patterns', () => {
  const major = SCALE_CATALOG[0]!;
  const standard = TUNINGS[0]!;
  it('uses the five CAGED chord forms and seven distinct 3NPS fingerings in every key', () => {
    for (let root = 0; root < 12; root++) {
      const caged = getPatterns(major, root, standard, 'caged');
      expect(caged.patterns.map(p => p.name)).toEqual(['C form', 'A form', 'G form', 'E form', 'D form']);
      expect(getPatterns(major, root, standard, '3nps').patterns).toHaveLength(7);
      for (const kind of ['caged', '3nps'] as const) {
        const { patterns, reason } = getPatterns(major, root, standard, kind);
        expect(reason).toBeNull();
        expect(new Set(patterns.map(p => p.notes.map(n => `${n.string}:${n.fret}`).join(','))).size).toBe(patterns.length);
        for (const pattern of patterns) {
          expect(pattern.notes.every(n => n.fret >= 0 && n.fret <= 24
            && major.intervals.includes((n.midi - root + 120) % 12))).toBe(true);
          expect(new Set(pattern.notes.map(n => n.string)).size).toBe(6);
          if (kind === '3nps') {
            for (let string = 0; string < 6; string++) {
              expect(pattern.notes.filter(n => n.string === string)).toHaveLength(3);
            }
          }
        }
      }
    }
  });

  it('anchors CAGED E form to the actual tonic major chord, not arbitrary fret windows', () => {
    const shape = getPatterns(major, 0, standard, 'caged').patterns.find(p => p.name === 'E form')!;
    for (const [string, fret] of [[0, 8], [1, 10], [2, 10], [3, 9], [4, 8], [5, 8]]) {
      expect(shape.notes.some(n => n.string === string && n.fret === fret)).toBe(true);
    }
  });

  it('explicitly refuses unsupported shapes instead of relabelling arbitrary boxes', () => {
    expect(getPatterns(major, 0, TUNINGS[1]!, 'caged').reason).toMatch(/standard/i);
    expect(getPatterns(SCALE_CATALOG.find(s => s.id === 'minor-pentatonic')!, 0, standard, '3nps').reason).toMatch(/seven/i);
    expect(getPatterns(SCALE_CATALOG.find(s => s.id === 'dorian')!, 0, standard, 'caged').reason).toMatch(/major/i);
  });

  it('uses authentic CAGED subsets for pentatonics and clearly named relative-major forms for minor', () => {
    for (const id of ['major-pentatonic', 'minor-pentatonic', 'natural-minor']) {
      const scale = SCALE_CATALOG.find(s => s.id === id)!;
      for (let root = 0; root < 12; root++) {
        const { patterns, reason } = getPatterns(scale, root, standard, 'caged');
        expect(reason).toBeNull();
        expect(patterns).toHaveLength(5);
        for (const pattern of patterns) {
          expect(pattern.notes.every(n => n.fret >= 0 && n.fret <= 24
            && scale.intervals.includes((n.midi - root + 120) % 12))).toBe(true);
          for (let string = 0; string < 6; string++) {
            const count = pattern.notes.filter(n => n.string === string).length;
            if (id.includes('pentatonic')) expect(count).toBe(2);
            else expect(count).toBeGreaterThanOrEqual(2);
          }
          if (id !== 'major-pentatonic') expect(pattern.name).toMatch(/relative major/);
        }
      }
    }
  });

  it('keeps every heptatonic 3NPS pattern ascending, playable, and entirely in its scale', () => {
    for (const scale of SCALE_CATALOG.filter(s => s.intervals.length === 7)) {
      for (let root = 0; root < 12; root++) {
        const result = getPatterns(scale, root, standard, '3nps');
        if (result.reason) {
          expect(result.patterns).toHaveLength(0);
          expect(result.reason).toMatch(/consecutive.*24-fret/);
          continue;
        }
        expect(result.patterns).toHaveLength(7);
        for (const pattern of result.patterns) {
          expect(pattern.notes).toHaveLength(18);
          expect(pattern.notes.every((n, i) => n.fret >= 0 && n.fret <= 24
            && scale.intervals.includes((n.midi - root + 120) % 12)
            && (!i || n.midi > (pattern.notes[i - 1]?.midi ?? 0)))).toBe(true);
          for (let i = 1; i < pattern.notes.length; i++) {
            const previous = pattern.notes[i - 1]!.midi;
            const expected = Array.from({ length: 12 }, (_, semitone) => previous + semitone + 1)
              .find(midi => scale.intervals.includes((midi - root + 120) % 12));
            expect(pattern.notes[i]?.midi, `${scale.id}, root ${root}, ${pattern.name}, note ${i}`).toBe(expected);
          }
        }
      }
    }
  });

  it('shifts C Persian pattern 3 instead of skipping A♭ between the low E and A strings', () => {
    const persian = SCALE_CATALOG.find(scale => scale.id === 'persian')!;
    const { patterns, reason } = getPatterns(persian, 0, standard, '3nps');
    expect(reason).toBeNull();
    expect(patterns[2]?.notes.slice(0, 6).map(note => note.midi)).toEqual([52, 53, 54, 56, 59, 60]);
  });
});
