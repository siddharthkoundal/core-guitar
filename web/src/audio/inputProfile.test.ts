import { afterEach, expect, it } from 'vitest';
import { loadInputProfile, saveInputProfile, tagRecording } from './inputProfile';
import type { Recording } from './types';

afterEach(() => localStorage.clear());

const recording: Recording = {
  blob: new Blob(['audio']), name: 'take.wav', source: 'recording', partial: false, settings: {},
  clickOffsetS: 2.1,
};

it('persists the profile and clamps the latency correction', () => {
  expect(loadInputProfile()).toEqual({ kind: 'mic', deviceId: '', latencyOffsetMs: 0 });
  saveInputProfile({ kind: 'direct', deviceId: 'usb-1', latencyOffsetMs: 900 });
  expect(loadInputProfile()).toEqual({ kind: 'direct', deviceId: 'usb-1', latencyOffsetMs: 250 });
});

it('applies the latency correction to direct takes only and never goes negative', () => {
  expect(tagRecording(recording, { kind: 'mic', deviceId: '', latencyOffsetMs: 100 }))
    .toEqual({ ...recording, inputProfile: 'mic' });
  expect(tagRecording(recording, { kind: 'direct', deviceId: '', latencyOffsetMs: 100 }).clickOffsetS)
    .toBeCloseTo(2.2);
  expect(tagRecording({ ...recording, clickOffsetS: 0.1 }, { kind: 'direct', deviceId: '', latencyOffsetMs: -250 })
    .clickOffsetS).toBe(0);
  const untimed = { ...recording };
  delete untimed.clickOffsetS;
  expect(tagRecording(untimed, { kind: 'direct', deviceId: '', latencyOffsetMs: 50 })).not.toHaveProperty('clickOffsetS');
});
