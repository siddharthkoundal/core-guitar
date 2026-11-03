import { afterEach, expect, it, vi } from 'vitest';
import { HISTORY_KEY, loadHistory, saveHistory } from './history';
import { parseProgression } from './progression';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const chord = { name: 'C', root: 0, quality: 'major', similarity: 0.96, detectedAt: '2026-11-02T12:00:00.000Z' };

it('validates storage records and caps history at the newest 200 entries', () => {
  saveHistory(Array.from({ length: 205 }, () => chord));
  expect(loadHistory().entries).toHaveLength(200);
  localStorage.setItem(HISTORY_KEY, JSON.stringify([chord, { ...chord, root: 12 },
    { ...chord, quality: 'fake' }, { ...chord, similarity: null },
    { ...chord, detectedAt: 'yesterday' }, { ...chord, name: '<img>' }]));
  expect(loadHistory().entries).toEqual([chord]);
});

it('reports malformed or unavailable storage without throwing', () => {
  localStorage.setItem(HISTORY_KEY, '{bad');
  expect(loadHistory()).toMatchObject({ entries: [], warning: expect.any(String) });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(saveHistory([chord])).toMatch(/not saved/i);
});

it('only parses fenced JSON with bounded validated chord shapes', () => {
  expect(parseProgression('C G Am F')).toEqual([]);
  expect(parseProgression('```json\n{"chords":[{"root":0,"quality":"major"},{"root":9,"quality":"minor"}]}\n```'))
    .toEqual([{ root: 0, quality: 'major' }, { root: 9, quality: 'minor' }]);
  for (const value of [
    '{bad', '{"chords":["C"]}', '{"chords":[{"root":12,"quality":"major"}]}',
    '{"chords":[{"root":0,"quality":"fake"}]}', '{"chords":[{"root":0.5,"quality":"major"}]}',
    '{"chords":[{"root":0,"quality":"major","script":"bad"}]}',
  ]) expect(parseProgression(`\`\`\`json\n${value}\n\`\`\``)).toEqual([]);
});
