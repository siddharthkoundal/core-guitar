import { afterEach, expect, it, vi } from 'vitest';
import { ChordMicrophone } from './microphone';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = { fftSize: 32768, frequencyBinCount: 16384, smoothingTimeConstant: 0,
    disconnect: vi.fn(), getFloatFrequencyData: vi.fn((bins: Float32Array) => bins.fill(-Infinity)) };
  const context = { sampleRate: 48000, state: 'running', resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined), createAnalyser: () => analyser,
    createMediaStreamSource: () => source };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const onStatus = vi.fn();
  const onResult = vi.fn();
  const microphone = new ChordMicrophone({ onStatus, onResult });
  return { microphone, onStatus, onResult, getUserMedia, stream, track, context, source, analyser };
}

it('never requests permission before start and reports denial explicitly', async () => {
  const fake = setup();
  expect(fake.getUserMedia).not.toHaveBeenCalled();
  fake.getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  await fake.microphone.start();
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/denied/i) });
  expect(fake.context.close).toHaveBeenCalledOnce();
});

it('stops late streams after permission is cancelled or disposed', async () => {
  const fake = setup();
  let grant: ((stream: unknown) => void) | undefined;
  fake.getUserMedia.mockReturnValue(new Promise(resolve => { grant = resolve; }));
  const pending = fake.microphone.start();
  await Promise.resolve();
  fake.microphone.dispose();
  grant?.(fake.stream);
  await pending;
  expect(fake.track.stop).toHaveBeenCalledOnce();
  expect(fake.source.connect).not.toHaveBeenCalled();
  expect(fake.context.close).toHaveBeenCalledOnce();
});

it('reports no signal and releases nodes, streams, context and timers', async () => {
  vi.useFakeTimers();
  const fake = setup();
  await fake.microphone.start();
  expect(fake.getUserMedia).toHaveBeenCalledWith({ audio: {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  } });
  vi.advanceTimersByTime(2700);
  expect(fake.onResult).toHaveBeenCalledWith({ state: 'no-signal' });
  fake.microphone.stop();
  expect(fake.track.stop).toHaveBeenCalledOnce();
  expect(fake.source.disconnect).toHaveBeenCalledOnce();
  expect(fake.analyser.disconnect).toHaveBeenCalledOnce();
  expect(fake.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports FFT errors and still releases the microphone', async () => {
  vi.useFakeTimers();
  const fake = setup();
  fake.analyser.getFloatFrequencyData.mockImplementation(() => { throw new Error('device lost'); });
  await fake.microphone.start();
  vi.advanceTimersByTime(100);
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringContaining('device lost') });
  expect(fake.track.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports unavailable capture, suspended audio and missing audio tracks explicitly', async () => {
  const fake = setup();
  vi.stubGlobal('navigator', {});
  await fake.microphone.start();
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/unavailable/i) });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: fake.getUserMedia } });
  fake.context.state = 'suspended';
  await fake.microphone.start();
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/suspended/i) });
  fake.context.state = 'running';
  fake.getUserMedia.mockResolvedValue({ ...fake.stream, getAudioTracks: () => [] });
  await fake.microphone.start();
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/No microphone audio track/) });
  expect(fake.track.stop).toHaveBeenCalledOnce();
});

it('handles interruption and device-ended callbacks with cleanup', async () => {
  vi.useFakeTimers();
  const fake = setup();
  await fake.microphone.start();
  fake.context.state = 'suspended';
  vi.advanceTimersByTime(100);
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/interrupted/) });
  fake.context.state = 'running';
  await fake.microphone.start();
  const callback: unknown = fake.track.addEventListener.mock.calls[0]?.[1];
  if (typeof callback !== 'function') throw new Error('Expected ended listener');
  callback();
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/disconnected/) });
  expect(fake.track.stop).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports close failures, but suppresses all late callbacks after disposal', async () => {
  const fake = setup();
  await fake.microphone.start();
  fake.context.close.mockRejectedValue(new Error('close failed'));
  fake.microphone.stop();
  await Promise.resolve();
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/cleanup failed/) });
  fake.microphone.dispose();
  fake.onStatus.mockClear();
  await fake.microphone.start();
  await Promise.resolve();
  expect(fake.onStatus).not.toHaveBeenCalled();
});

it('releases all other resources even if an audio node disconnect throws', async () => {
  vi.useFakeTimers();
  const fake = setup();
  await fake.microphone.start();
  fake.source.disconnect.mockImplementation(() => { throw new Error('Already disconnected'); });
  expect(() => fake.microphone.stop()).not.toThrow();
  expect(fake.track.stop).toHaveBeenCalledOnce();
  expect(fake.analyser.disconnect).toHaveBeenCalledOnce();
  expect(fake.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'error', message: expect.stringMatching(/cleanup failed/) });
});

it('does not request permission after disposal during a pending context resume', async () => {
  const fake = setup();
  let resumed: (() => void) | undefined;
  fake.context.resume.mockReturnValue(new Promise<void>(resolve => { resumed = resolve; }));
  const pending = fake.microphone.start();
  fake.microphone.dispose();
  resumed?.();
  await pending;
  expect(fake.getUserMedia).not.toHaveBeenCalled();
  expect(fake.context.close).toHaveBeenCalledOnce();
});

it('ignores a stale rejected permission request after a newer listening session starts', async () => {
  vi.useFakeTimers();
  const fake = setup();
  let rejectOld: ((error: Error) => void) | undefined;
  fake.getUserMedia.mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject; }));
  const old = fake.microphone.start();
  await Promise.resolve();
  await fake.microphone.start();
  rejectOld?.(new DOMException('Denied', 'NotAllowedError'));
  await old;
  expect(fake.onStatus).toHaveBeenLastCalledWith({ state: 'listening' });
  expect(vi.getTimerCount()).toBe(1);
  fake.microphone.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
