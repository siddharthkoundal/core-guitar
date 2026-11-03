import { afterEach, expect, it, vi } from 'vitest';
import { detectPitch, MicrophoneInput } from './microphone';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('detects monophonic guitar-range notes and rejects silence/noise', () => {
  for (const [frequency, midi] of [[440, 69], [82.407, 40], [46.249, 30], [1318.51, 88]]) {
    const signal = Float32Array.from({ length: 2048 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * frequency! * i / 12000));
    const pitch = detectPitch(signal, 12000);
    expect(pitch?.midi).toBe(midi);
    expect(pitch?.confidence).toBeGreaterThan(0.85);
  }
  expect(detectPitch(new Float32Array(2048), 12000)).toBeNull();
  let seed = 7;
  const noise = Float32Array.from({ length: 2048 }, () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  });
  expect(detectPitch(noise, 12000)).toBeNull();
  expect(detectPitch(new Float32Array(4), 0)).toBeNull();
});

function micEnvironment() {
  const track = { stop: vi.fn(),
    addEventListener: vi.fn<(_event: string, handler: () => void) => void>(),
    removeEventListener: vi.fn<(_event: string, handler: () => void) => void>() };
  const stream = { getTracks: () => [track] };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = { fftSize: 8192, disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((buffer: Float32Array) => {
      for (let i = 0; i < buffer.length; i++) buffer[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000);
    }) };
  const context = { state: 'running', sampleRate: 48000,
    close: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    createMediaStreamSource: vi.fn(() => source), createAnalyser: vi.fn(() => analyser) };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('AudioContext', vi.fn(function () { return context; }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { track, stream, source, analyser, context, getUserMedia };
}

it('releases a stream granted after cancellation without connecting it', async () => {
  const env = micEnvironment();
  let grant: ((stream: typeof env.stream) => void) | undefined;
  env.getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const input = new MicrophoneInput();
  const starting = input.start({ onNote: vi.fn(), onStatus: vi.fn(), onError: vi.fn() });
  const cancelled = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
  input.stop();
  grant?.(env.stream);
  await cancelled;
  expect(env.track.stop).toHaveBeenCalledOnce();
  expect(env.source.connect).not.toHaveBeenCalled();
  expect(env.context.close).toHaveBeenCalledOnce();
});

it('emits stable notes once per attack and clears every capture resource', async () => {
  vi.useFakeTimers();
  const env = micEnvironment();
  const input = new MicrophoneInput();
  const onNote = vi.fn();
  await input.start({ onNote, onStatus: vi.fn(), onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(500);
  expect(onNote).toHaveBeenCalledExactlyOnceWith(69);
  env.analyser.getFloatTimeDomainData.mockImplementation(buffer => buffer.fill(0));
  await vi.advanceTimersByTimeAsync(300);
  env.analyser.getFloatTimeDomainData.mockImplementation(buffer => {
    for (let i = 0; i < buffer.length; i++) buffer[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000);
  });
  await vi.advanceTimersByTimeAsync(300);
  expect(onNote).toHaveBeenCalledTimes(2);
  input.stop();
  expect(env.track.stop).toHaveBeenCalledOnce();
  expect(env.source.disconnect).toHaveBeenCalledOnce();
  expect(env.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports permission/unsupported errors instead of claiming to listen', async () => {
  const env = micEnvironment();
  env.getUserMedia.mockRejectedValue(new Error('Permission denied'));
  const input = new MicrophoneInput();
  await expect(input.start({ onNote: vi.fn(), onStatus: vi.fn(), onError: vi.fn() })).rejects.toThrow('Permission denied');
  expect(env.context.close).toHaveBeenCalledOnce();
  vi.stubGlobal('navigator', {});
  await expect(input.start({ onNote: vi.fn(), onStatus: vi.fn(), onError: vi.fn() })).rejects.toThrow(/microphone/i);
});

it('rejects detuned, nonfinite, and weak signals rather than scoring uncertain notes', () => {
  const wave = (frequency: number, amplitude: number) => Float32Array.from({ length: 2048 },
    (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / 12000));
  expect(detectPitch(wave(440 * 2 ** (0.45 / 12), 0.2), 12000)).toBeNull();
  expect(detectPitch(wave(440, 0.003), 12000)).toBeNull();
  expect(detectPitch(new Float32Array(2048).fill(NaN), 12000)).toBeNull();
});

it('handles device loss and context interruption without keeping capture timers alive', async () => {
  vi.useFakeTimers();
  const env = micEnvironment();
  const input = new MicrophoneInput();
  const onError = vi.fn();
  await input.start({ onNote: vi.fn(), onStatus: vi.fn(), onError });
  env.track.addEventListener.mock.calls[0]?.[1]();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('disconnected') }));
  expect(vi.getTimerCount()).toBe(0);
  await input.start({ onNote: vi.fn(), onStatus: vi.fn(), onError });
  env.context.state = 'suspended';
  await vi.advanceTimersByTimeAsync(100);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('interrupted') }));
  expect(vi.getTimerCount()).toBe(0);
});

it('gives uncertain/no-signal feedback and automatically stops at the safety limit', async () => {
  vi.useFakeTimers();
  const env = micEnvironment();
  const onStatus = vi.fn();
  const onError = vi.fn();
  env.analyser.getFloatTimeDomainData.mockImplementation(buffer => {
    let seed = 7;
    for (let i = 0; i < buffer.length; i++) {
      seed = seed * 16807 % 2147483647;
      buffer[i] = seed / 2147483647 - 0.5;
    }
  });
  const input = new MicrophoneInput();
  await input.start({ onNote: vi.fn(), onStatus, onError });
  expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('Uncertain'));
  env.analyser.getFloatTimeDomainData.mockImplementation(buffer => buffer.fill(0));
  await vi.advanceTimersByTimeAsync(180100);
  expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('No signal'));
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('3-minute') }));
  expect(env.track.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
