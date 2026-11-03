import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioPlayer, isAudioCancellation, playNotes, stopNotes } from './sound';

let contexts: FakeContext[] = [];
class FakeContext {
  destination = {};
  state = 'running';
  get currentTime() { return Date.now() / 1000; }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  voices: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  constructor() { contexts.push(this); }
  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: {
      setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(),
    } };
  }
  createOscillator() {
    const voice = { frequency: { setValueAtTime: vi.fn() }, type: 'sine',
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.voices.push(voice);
    return voice;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  contexts = [];
  vi.stubGlobal('AudioContext', FakeContext);
});
afterEach(async () => {
  stopNotes();
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('schedules ahead, completes, and closes all audio resources', async () => {
  const done = playNotes([60, 64, 67], 120);
  await vi.advanceTimersByTimeAsync(2000);
  await done;
  expect(contexts[0]?.voices).toHaveLength(3);
  expect(contexts[0]?.close).toHaveBeenCalledOnce();
  expect(contexts[0]?.voices.every(v => v.disconnect.mock.calls.length > 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('stopping cancels queued playback and settles its promise', async () => {
  const done = playNotes([60, 62, 64], 60);
  const cancelled = expect(done).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(30);
  stopNotes();
  await cancelled;
  expect(contexts[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('cannot resurrect an audio session cancelled while resume is pending', async () => {
  let resume: (() => void) | undefined;
  const player = new AudioPlayer();
  const suspended = new FakeContext();
  suspended.state = 'suspended';
  suspended.resume = vi.fn(() => new Promise<void>(resolve => { resume = resolve; }));
  vi.stubGlobal('AudioContext', vi.fn(function () { return suspended; }));
  const done = player.play([60], 120);
  const cancelled = expect(done).rejects.toMatchObject({ name: 'AbortError' });
  player.stop();
  resume?.();
  await cancelled;
  expect(suspended.voices).toHaveLength(0);
  expect(suspended.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels the older shared call without stopping the newer playback', async () => {
  const first = playNotes([60, 62], 120);
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = playNotes([67], 120);
  await cancelled;
  await vi.advanceTimersByTimeAsync(1000);
  await second;
  expect(contexts).toHaveLength(2);
  expect(contexts.every(context => context.close.mock.calls.length === 1)).toBe(true);
  expect(isAudioCancellation(new DOMException('Stopped', 'AbortError'))).toBe(true);
  expect(isAudioCancellation(new Error('Failure'))).toBe(false);
  expect(isAudioCancellation(null)).toBe(false);
});

it('reports failed resume, interrupted contexts, scheduling stalls, and failed close', async () => {
  const player = new AudioPlayer();
  const suspended = new FakeContext();
  suspended.state = 'suspended';
  suspended.resume.mockRejectedValue(new Error('Resume blocked'));
  vi.stubGlobal('AudioContext', vi.fn(function () { return suspended; }));
  await expect(player.play([60], 120)).rejects.toThrow('Resume blocked');
  vi.stubGlobal('AudioContext', FakeContext);
  const interrupted = player.play([60, 62], 120);
  const failed = expect(interrupted).rejects.toThrow('interrupted');
  const context = contexts.at(-1)!;
  context.state = 'suspended';
  await vi.advanceTimersByTimeAsync(30);
  await failed;
  const stalled = player.play([60, 62], 120);
  const stallFailed = expect(stalled).rejects.toThrow('scheduling');
  vi.setSystemTime(Date.now() + 5000);
  await vi.advanceTimersByTimeAsync(30);
  await stallFailed;
  const closing = player.play([60], 240);
  const closeFailed = expect(closing).rejects.toThrow('Close failed');
  contexts.at(-1)!.close.mockRejectedValue(new Error('Close failed'));
  await vi.advanceTimersByTimeAsync(500);
  await closeFailed;
  expect(vi.getTimerCount()).toBe(0);
});

it('validates sound preferences and uses eighth-note accented metronome settings', async () => {
  const player = new AudioPlayer();
  await expect(player.play([], 120)).rejects.toThrow('MIDI');
  await expect(player.play([60], 120, { volume: 2 })).rejects.toThrow('volume');
  await expect(player.metronome(120, { beatsPerBar: 0 })).rejects.toThrow('beats');
  const done = player.metronome(120, { beatsPerBar: 7, beatUnit: 8, waveform: 'sine', volume: 0.4 });
  const cancelled = expect(done).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(contexts[0]?.voices.length).toBeGreaterThanOrEqual(4);
  player.stop();
  await cancelled;
});

it('runs a cancellable lookahead metronome and rejects unsupported audio/invalid input', async () => {
  const player = new AudioPlayer();
  const done = player.metronome(120);
  const cancelled = expect(done).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1050);
  expect(contexts[0]?.voices.length).toBeGreaterThanOrEqual(3);
  player.stop();
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
  await expect(playNotes([NaN])).rejects.toThrow(/MIDI/);
  await expect(playNotes([60], 0)).rejects.toThrow(/tempo/i);
  vi.stubGlobal('AudioContext', undefined);
  await expect(playNotes([60])).rejects.toThrow(/audio/i);
});
