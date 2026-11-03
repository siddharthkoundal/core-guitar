import { describe, expect, it } from 'vitest';
import { CHORD_TEMPLATES, ChromaWindow, detectChord, fftToChroma } from './detector';

function spectrum(pitches: readonly number[], sampleRate = 48000, fftSize = 32768): Float32Array<ArrayBuffer> {
  const bins = new Float32Array(fftSize / 2).fill(-Infinity);
  for (const pitch of pitches) {
    const frequency = 440 * 2 ** ((pitch - 69) / 12);
    bins[Math.round(frequency * fftSize / sampleRate)] = -24;
  }
  return bins;
}

describe('original chroma template detector', () => {
  it('contains all nine qualities in all twelve roots', () => {
    expect(CHORD_TEMPLATES).toHaveLength(108);
    expect(new Set(CHORD_TEMPLATES.map(t => `${t.root}:${t.quality}`)).size).toBe(108);
  });

  it.each(CHORD_TEMPLATES)('tests synthetic FFT for $name', template => {
    const pitches = template.intervals.map(interval => 48 + template.root + interval);
    const chroma = fftToChroma(spectrum(pitches), 48000, 32768);
    for (const pitch of pitches) expect(chroma[pitch % 12]).toBeGreaterThan(0);
    const result = detectChord(chroma);
    // Chroma cannot distinguish augmented inversions or sus2/sus4 aliases.
    if (['aug', 'sus2', 'sus4'].includes(template.quality)) {
      expect(result.state).toBe('ambiguous');
    } else {
      expect(result).toMatchObject({ state: 'detected', chord: {
        root: template.root, quality: template.quality, name: template.name,
      } });
      if (result.state === 'detected') expect(result.chord.similarity).toBeCloseTo(1);
    }
  });

  it('gates silence, nonfinite bins, out-of-band audio and bins at or below -80dB', () => {
    const bins = new Float32Array(16384).fill(-Infinity);
    bins[1] = -10;
    bins[4000] = -10;
    bins[200] = -80;
    bins[300] = NaN;
    bins[400] = Infinity;
    expect(detectChord(fftToChroma(bins, 48000, 32768)).state).toBe('no-signal');
    expect(detectChord(Array<number>(12).fill(0)).state).toBe('no-signal');
  });

  it('rejects broadband noise, single notes, invalid vectors and ambiguous blends', () => {
    expect(detectChord(Array<number>(12).fill(1)).state).toBe('ambiguous');
    expect(detectChord([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).state).toBe('ambiguous');
    expect(detectChord([NaN]).state).toBe('no-signal');
    expect(detectChord([1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0]).state).toBe('ambiguous');
    expect(detectChord(fftToChroma(new Float32Array(16384).fill(-30), 48000, 32768)).state)
      .not.toBe('detected');
  });

  it('averages a full 2.5 seconds, requires enough frames and resets each window', () => {
    const window = new ChromaWindow();
    const chroma = fftToChroma(spectrum([48, 52, 55]), 48000, 32768);
    for (let time = 0; time < 2500; time += 100) expect(window.push(chroma, time)).toBeNull();
    expect(window.push(chroma, 2500)).toMatchObject({ state: 'detected', chord: { name: 'C' } });
    expect(window.push(chroma, 2600)).toBeNull();
    window.reset();
    expect(window.push(chroma, 0)).toBeNull();
    expect(window.push(chroma, 2500)).toBeNull();
  });

  it('discards pre-background frames and requires a fresh contiguous 2.5-second window', () => {
    const window = new ChromaWindow();
    const chord = fftToChroma(spectrum([48, 52, 55]), 48000, 32768);
    const silence = Array<number>(12).fill(0);
    for (let time = 0; time <= 800; time += 100) expect(window.push(chord, time)).toBeNull();
    expect(window.push(silence, 60000)).toBeNull();
    for (let time = 60100; time < 62500; time += 100) expect(window.push(silence, time)).toBeNull();
    expect(window.push(silence, 62500)).toEqual({ state: 'no-signal' });
    for (let time = 62600; time < 65100; time += 100) expect(window.push(chord, time)).toBeNull();
    expect(window.push(chord, 65100)).toMatchObject({ state: 'detected', chord: { name: 'C' } });
  });

  it('allows modest sampling jitter but resets gaps longer than 250 milliseconds', () => {
    const window = new ChromaWindow();
    const chord = fftToChroma(spectrum([48, 52, 55]), 48000, 32768);
    for (let time = 0; time < 2500; time += 250) expect(window.push(chord, time)).toBeNull();
    expect(window.push(chord, 2500)).toMatchObject({ state: 'detected', chord: { name: 'C' } });
    window.reset();
    for (let time = 0; time <= 2250; time += 250) expect(window.push(chord, time)).toBeNull();
    expect(window.push(chord, 2501)).toBeNull();
  });

  it('does not turn a short strum followed by silence into a sustained detection', () => {
    const window = new ChromaWindow();
    const chord = fftToChroma(spectrum([48, 52, 55]), 48000, 32768);
    for (let time = 0; time < 2500; time += 100) {
      window.push(time < 500 ? chord : Array<number>(12).fill(0), time);
    }
    expect(window.push(Array<number>(12).fill(0), 2500)?.state).toBe('no-signal');
  });

  it('rejects mixed chord windows even if their average resembles a seventh chord', () => {
    const window = new ChromaWindow();
    const c = fftToChroma(spectrum([48, 52, 55]), 48000, 32768);
    const em = fftToChroma(spectrum([52, 55, 59]), 48000, 32768);
    for (let time = 0; time < 2500; time += 100) window.push(time < 1300 ? c : em, time);
    expect(window.push(em, 2500)?.state).toBe('ambiguous');
  });

  it('supports 44.1kHz input and safely rejects invalid FFT metadata', () => {
    expect(detectChord(fftToChroma(spectrum([48, 52, 55], 44100), 44100, 32768)))
      .toMatchObject({ state: 'detected', chord: { name: 'C' } });
    for (const [sampleRate, size] of [[0, 32768], [NaN, 32768], [48000, 1], [48000, 64]]) {
      expect(fftToChroma(spectrum([]), sampleRate ?? 0, size ?? 0)).toEqual(Array<number>(12).fill(0));
    }
  });
});
