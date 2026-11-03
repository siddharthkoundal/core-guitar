import { afterEach, expect, it, vi } from 'vitest';
import { centsOff, detectMpm, frequencyToMidi, LivePitchInput, median, midiToFrequency, nearestNote } from './pitch';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const RATE = 44100;
function tone(frequency: number, harmonics: readonly number[] = [1], length = 4096, rate = RATE, amplitude = 0.3): Float32Array {
  return Float32Array.from({ length }, (_, i) => harmonics.reduce((total, weight, index) =>
    total + amplitude * weight * Math.sin(2 * Math.PI * frequency * (index + 1) * i / rate + index), 0));
}
function noise(length = 4096): Float32Array {
  let seed = 11;
  return Float32Array.from({ length }, () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  });
}
const cents = (actual: number, expected: number) => Math.abs(1200 * Math.log2(actual / expected));

it('finds sine pitches within one cent across the guitar range', () => {
  for (const frequency of [41.2, 82.41, 110, 196, 329.63, 659.25, 1318.51]) {
    const reading = detectMpm(tone(frequency), RATE);
    expect(reading).not.toBeNull();
    expect(cents(reading!.frequency, frequency)).toBeLessThan(1);
    expect(reading!.clarity).toBeGreaterThan(0.9);
  }
});

it('finds the fundamental of harmonic-rich tones without octave errors', () => {
  for (const frequency of [82.41, 110, 146.83, 329.63]) {
    const reading = detectMpm(tone(frequency, [1, 0.8, 0.6, 0.4, 0.3]), RATE);
    expect(cents(reading!.frequency, frequency)).toBeLessThan(1);
  }
  const weakFundamental = detectMpm(tone(110, [0.4, 1, 0.5]), RATE);
  expect(cents(weakFundamental!.frequency, 110)).toBeLessThan(1);
});

it('reaches down to 7/8-string and drop tunings at a downsampled rate', () => {
  const reading = detectMpm(tone(30.87, [1, 0.5], 2048, 24000), 24000);
  expect(cents(reading!.frequency, 30.87)).toBeLessThan(1);
});

it('returns null for silence, quiet input, noise and invalid buffers', () => {
  expect(detectMpm(new Float32Array(4096), RATE)).toBeNull();
  expect(detectMpm(tone(110, [1], 4096, RATE, 0.001), RATE)).toBeNull();
  expect(detectMpm(noise(), RATE)).toBeNull();
  expect(detectMpm(new Float32Array(4096).fill(NaN), RATE)).toBeNull();
  expect(detectMpm(new Float32Array(100), RATE)).toBeNull();
  expect(detectMpm(tone(110), 0)).toBeNull();
  expect(detectMpm(tone(110), RATE, { minFrequency: 2000, maxFrequency: 2100 })).toBeNull();
});

it('converts between frequency, MIDI and cents for any reference pitch', () => {
  expect(frequencyToMidi(440)).toBe(69);
  expect(frequencyToMidi(432, 432)).toBe(69);
  expect(midiToFrequency(40)).toBeCloseTo(82.407, 3);
  expect(centsOff(440 * 2 ** (10 / 1200), 69)).toBeCloseTo(10, 6);
  expect(nearestNote(82.41)).toMatchObject({ midi: 40 });
  expect(nearestNote(452, 440).midi).toBe(69);
  expect(nearestNote(452, 440).cents).toBeCloseTo(46.6, 1);
  expect(nearestNote(445, 445).cents).toBeCloseTo(0, 6);
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

function audioEnvironment(frequency = 110) {
  const track = { stop: vi.fn(),
    addEventListener: vi.fn<(_event: string, handler: () => void) => void>(),
    removeEventListener: vi.fn<(_event: string, handler: () => void) => void>() };
  const stream = { getTracks: () => [track] };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const fill = (value: number) => (buffer: Float32Array) => {
    for (let i = 0; i < buffer.length; i++) buffer[i] = value ? 0.3 * Math.sin(2 * Math.PI * value * i / 48000) : 0;
  };
  const analyser = { fftSize: 4096, disconnect: vi.fn(), getFloatTimeDomainData: vi.fn(fill(frequency)) };
  const context = { state: 'running', sampleRate: 48000,
    close: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    createMediaStreamSource: vi.fn(() => source), createAnalyser: vi.fn(() => analyser) };
  const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<typeof stream>>(async () => stream);
  vi.stubGlobal('AudioContext', vi.fn(function () { return context; }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { track, stream, source, analyser, context, getUserMedia, fill };
}

it('streams smoothed readings from the chosen device and releases everything on stop', async () => {
  vi.useFakeTimers();
  const env = audioEnvironment(110);
  const input = new LivePitchInput();
  const onPitch = vi.fn();
  await input.start('usb-pedal', { onPitch, onError: vi.fn() });
  expect(input.active).toBe(true);
  expect(env.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({
    deviceId: { exact: 'usb-pedal' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }) });
  await vi.advanceTimersByTimeAsync(200);
  const reading = onPitch.mock.calls.at(-1)?.[0] as { frequency: number } | null;
  expect(cents(reading!.frequency, 110)).toBeLessThan(1);
  env.analyser.getFloatTimeDomainData.mockImplementation(env.fill(0));
  await vi.advanceTimersByTimeAsync(70);
  expect(onPitch).toHaveBeenLastCalledWith(null);
  expect(env.source.connect).toHaveBeenCalledOnce();
  input.stop();
  input.stop();
  expect(input.active).toBe(false);
  expect(env.track.stop).toHaveBeenCalledOnce();
  expect(env.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('stops at the safety limit, on device loss and on context interruption', async () => {
  vi.useFakeTimers();
  const env = audioEnvironment(0);
  const onError = vi.fn();
  const input = new LivePitchInput({ maxDurationMs: 600000 });
  await input.start('', { onPitch: vi.fn(), onError });
  await vi.advanceTimersByTimeAsync(600100);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('10-minute') }));
  expect(vi.getTimerCount()).toBe(0);
  await input.start('', { onPitch: vi.fn(), onError });
  env.track.addEventListener.mock.calls.at(-1)?.[1]();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('disconnected') }));
  await input.start('', { onPitch: vi.fn(), onError });
  env.context.state = 'suspended';
  await vi.advanceTimersByTimeAsync(100);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('interrupted') }));
  expect(vi.getTimerCount()).toBe(0);
});

it('releases a stream granted after cancellation and reports unsupported or denied input', async () => {
  const env = audioEnvironment();
  let grant: ((stream: typeof env.stream) => void) | undefined;
  env.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const input = new LivePitchInput();
  const starting = input.start('', { onPitch: vi.fn(), onError: vi.fn() });
  const cancelled = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
  input.stop();
  grant?.(env.stream);
  await cancelled;
  expect(env.track.stop).toHaveBeenCalledOnce();
  expect(env.source.connect).not.toHaveBeenCalled();
  env.getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(input.start('', { onPitch: vi.fn(), onError: vi.fn() })).rejects.toThrow('Permission denied');
  env.context.state = 'suspended';
  env.context.resume.mockRejectedValueOnce(new Error('resume blocked'));
  await expect(input.start('', { onPitch: vi.fn(), onError: vi.fn() })).rejects.toThrow('resume blocked');
  env.context.resume.mockResolvedValueOnce(undefined);
  await expect(input.start('', { onPitch: vi.fn(), onError: vi.fn() })).rejects.toThrow(/suspended/);
  vi.stubGlobal('navigator', {});
  await expect(input.start('', { onPitch: vi.fn(), onError: vi.fn() })).rejects.toThrow(/unavailable/);
});
