import { afterEach, expect, it, vi } from 'vitest';
import { midiToFrequency } from '../../audio/pitch';
import {
  A4_KEY, AnnouncementThrottle, describeCents, direction, InTuneHold, loadA4, nearestString, needlePercent, readout, saveA4,
} from './tunerMath';

const STANDARD = [40, 45, 50, 55, 59, 64];
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('persists only valid integer reference pitches between 430 and 450 Hz', () => {
  expect(loadA4()).toBe(440);
  expect(saveA4(442)).toBeNull();
  expect(localStorage.getItem(A4_KEY)).toBe('442');
  expect(loadA4()).toBe(442);
  expect(saveA4(429)).toMatch(/430 to 450/);
  expect(saveA4(440.5)).toMatch(/whole number/);
  for (const raw of ['abc', '460', '', '441.2']) {
    localStorage.setItem(A4_KEY, raw);
    expect(loadA4()).toBe(440);
  }
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(saveA4(441)).toMatch(/could not be saved/);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  expect(loadA4()).toBe(440);
});

it('reads chromatic, auto-string and fixed-string targets with the chosen reference', () => {
  const lowE = midiToFrequency(40) * 2 ** (-12 / 1200);
  expect(nearestString(lowE, STANDARD)).toBe(0);
  expect(nearestString(midiToFrequency(59), STANDARD)).toBe(4);
  expect(readout(lowE, 'chromatic', STANDARD)).toMatchObject({ midi: 40, targetMidi: 40, string: null });
  const auto = readout(lowE, 'auto', STANDARD);
  expect(auto).toMatchObject({ midi: 40, targetMidi: 40, string: 0 });
  expect(auto.cents).toBeCloseTo(-12, 6);
  const fixed = readout(midiToFrequency(57), 2, STANDARD);
  expect(fixed).toMatchObject({ midi: 57, targetMidi: 50, string: 2 });
  expect(fixed.cents).toBeCloseTo(700, 6);
  expect(readout(midiToFrequency(69, 432), 'chromatic', STANDARD, 432).cents).toBeCloseTo(0, 6);
  expect(readout(110, 'auto', [])).toMatchObject({ string: null, midi: 45 });
  expect(readout(110, 99, STANDARD).string).toBe(5);
});

it('describes direction, clamps the needle and words cents for screen readers', () => {
  expect(direction(4.9)).toBe('in-tune');
  expect(direction(-5)).toBe('in-tune');
  expect(direction(-6)).toBe('flat');
  expect(direction(6)).toBe('sharp');
  expect(needlePercent(0)).toBe(50);
  expect(needlePercent(-80)).toBe(0);
  expect(needlePercent(25)).toBe(75);
  expect(describeCents(3)).toBe('in tune (+3 cents)');
  expect(describeCents(-0.2)).toBe('in tune (0 cents)');
  expect(describeCents(-12)).toBe('12 cents flat — tune up');
  expect(describeCents(80)).toBe('more than 50 cents sharp — tune down');
});

it('requires a brief in-tune hold and throttles repeated announcements', () => {
  const hold = new InTuneHold(300);
  expect(hold.update(2, 0)).toBe(false);
  expect(hold.update(-3, 200)).toBe(false);
  expect(hold.update(1, 320)).toBe(true);
  expect(hold.update(9, 400)).toBe(false);
  expect(hold.update(null, 500)).toBe(false);
  expect(hold.update(0, 600)).toBe(false);
  const throttle = new AnnouncementThrottle(1000);
  expect(throttle.next('E2 in tune', 0)).toBe('E2 in tune');
  expect(throttle.next('E2 flat', 500)).toBeNull();
  expect(throttle.next('E2 in tune', 1500)).toBeNull();
  expect(throttle.next('E2 flat', 1600)).toBe('E2 flat');
  throttle.reset();
  expect(throttle.next('E2 flat', 1700)).toBe('E2 flat');
});
