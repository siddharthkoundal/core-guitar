import { expect, it } from 'vitest';
import { beginPractice, hitNote, finishPractice } from './practice';

it('requires a complete correct cycle for a clean timed sequence', () => {
  let state = beginPractice('sequence', [60, 62, 64], 1000, 15, () => 0);
  for (const note of [60, 62, 64]) state = hitNote(state, note, () => 0);
  expect(finishPractice(state, 15999)).toBeNull();
  expect(finishPractice(state, 16000)).toEqual({ clean: true, durationSeconds: 15 });
  expect(finishPractice(beginPractice('sequence', [60], 0, 15), 15000)?.clean).toBe(false);
});

it('keeps mistakes sticky, accepts octave equivalents and gives random targets', () => {
  let state = beginPractice('random', [60, 62], 0, 15, () => 0);
  state = hitNote(state, 61, () => 0.9);
  expect(state.errors).toBe(1);
  state = hitNote(state, 72, () => 0.9);
  expect(state.target).toBe(62);
  state = hitNote(state, 62, () => 0);
  expect(finishPractice(state, 15000)?.clean).toBe(false);
});

it('free practice is explicitly ungraded and rejects invalid runs', () => {
  expect(finishPractice(hitNote(beginPractice('free', [60], 0, 15), 61), 15000)?.clean).toBe(false);
  expect(() => beginPractice('sequence', [], 0, 15)).toThrow();
  expect(() => beginPractice('sequence', [60], 0, 0)).toThrow();
});
