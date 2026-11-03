import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '../../test-utils';
import { PcmCapture } from '../../audio/recorder';
import type * as CaptureModule from '../../audio/recorder';
import type * as WarningsModule from '../../components/ProcessingWarnings';
import { Recorder } from './Recorder';

let callbacks: ConstructorParameters<typeof PcmCapture>[0];
const warningsRendered = vi.hoisted(() => vi.fn());
vi.mock('../../audio/metronome', () => ({
  MetronomePlayer: class {
    start() {}
    stop() {}
    setVolume() {}
  },
}));
vi.mock('../../audio/recorder', async importOriginal => {
  const actual = await importOriginal<typeof CaptureModule>();
  return {
    ...actual,
    PcmCapture: class extends actual.PcmCapture {
      constructor(value: ConstructorParameters<typeof actual.PcmCapture>[0]) {
        super(value);
        callbacks = value;
      }
    },
  };
});
vi.mock('../../components/ProcessingWarnings', async importOriginal => {
  const actual = await importOriginal<typeof WarningsModule>();
  return {
    ProcessingWarnings: (props: Parameters<typeof actual.ProcessingWarnings>[0]) => {
      warningsRendered();
      return <actual.ProcessingWarnings {...props} />;
    },
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  warningsRendered.mockClear();
});

it('updates elapsed time, input level and sticky clipping without rerendering recorder controls', () => {
  render(<Recorder selection={{ mode: 'free', bpm: 80 }} onRecorded={vi.fn()} onUpload={vi.fn()} />);
  act(() => callbacks.event({ type: 'buffer' }));
  warningsRendered.mockClear();
  for (let index = 1; index <= 10; index++) {
    act(() => callbacks.level(0.2, index === 1 ? 1 : 0.4, index / 10));
  }
  expect(screen.getByText('1.0 s / 180 s')).toBeDefined();
  expect(Number(screen.getByRole('meter').getAttribute('value'))).toBeCloseTo(0.6);
  expect(screen.getByText('Clipping detected: lower the input or amp level.')).toBeDefined();
  expect(warningsRendered).not.toHaveBeenCalled();
});

it('resets meter and clipping for the next microphone attempt and disposes on unmount', async () => {
  const arm = vi.spyOn(PcmCapture.prototype, 'arm').mockResolvedValue();
  const dispose = vi.spyOn(PcmCapture.prototype, 'dispose').mockResolvedValue();
  const { userEvent, unmount } = render(
    <Recorder selection={{ mode: 'free' }} onRecorded={vi.fn()} onUpload={vi.fn()} />,
  );
  act(() => {
    callbacks.event({ type: 'buffer' });
    callbacks.level(1, 1, 5);
    callbacks.event({ type: 'cancel' });
  });
  expect(screen.queryByRole('meter')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Enable microphone' }));
  expect(arm).toHaveBeenCalled();
  act(() => callbacks.event({ type: 'buffer' }));
  expect(screen.getByText('0.0 s / 180 s')).toBeDefined();
  expect(screen.getByText('No clipping observed yet.')).toBeDefined();
  unmount();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('plays a Free-mode click at the selected BPM and the chosen recording-safe volume', async () => {
  const start = vi.spyOn(PcmCapture.prototype, 'start').mockResolvedValue();
  const { userEvent } = render(
    <Recorder selection={{ mode: 'free', bpm: 96 }} onRecorded={vi.fn()} onUpload={vi.fn()} />,
  );
  fireEvent.change(screen.getByRole('slider', { name: /click volume/i }), { target: { value: '55' } });
  act(() => callbacks.event({ type: 'armed' }));
  await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));

  expect(start).toHaveBeenCalledWith(null, { bpm: 96, beatsPerBar: 4, volume: 0.55 });
  expect(screen.getByText('Recording click is running.')).toBeDefined();
  expect(screen.queryByRole('button', { name: /mute warm-up/i })).toBeNull();
  expect(screen.getByRole('slider', { name: /click volume/i }).getAttribute('min')).toBe('20');
});

it('offers a standalone warm-up click that can be muted', async () => {
  class TestAudioContext {
    resume = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal('AudioContext', TestAudioContext);
  const { userEvent } = render(
    <Recorder selection={{ mode: 'reference', bpm: 90 }} onRecorded={vi.fn()} onUpload={vi.fn()} />,
  );
  expect(screen.getByRole('group', { name: 'Metronome · 90 BPM' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Start warm-up metronome' }));
  expect(screen.getByText('Warm-up metronome is running.')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Mute warm-up click' }));
  expect(screen.getByRole('button', { name: 'Unmute warm-up click' })).toBeDefined();
  expect(screen.getByText(/two-second lead-in and count-in/i)).toBeDefined();
});

it('surfaces an audio context startup failure', async () => {
  class FailingAudioContext {
    resume = vi.fn().mockRejectedValue(new Error('Audio playback is unavailable.'));
    close = vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal('AudioContext', FailingAudioContext);
  const { userEvent } = render(
    <Recorder selection={{ mode: 'free', bpm: 80 }} onRecorded={vi.fn()} onUpload={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Start warm-up metronome' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Audio playback is unavailable.'));
});

it('switches to processor input, persists the latency correction and explains headphone use', async () => {
  const { userEvent } = render(<Recorder selection={{ mode: 'free', bpm: 80 }} onRecorded={vi.fn()} onUpload={vi.fn()} />);
  expect(screen.queryByLabelText(/Latency correction/)).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'Processor (USB)' }));
  expect(screen.getByRole('heading', { name: /through your processor/ })).toBeDefined();
  expect(screen.getByText(/Headphones are fine/)).toBeDefined();
  fireEvent.change(screen.getByLabelText(/Latency correction/), { target: { value: '40' } });
  expect(localStorage.getItem('coreguitar.inputKind')).toBe('direct');
  expect(localStorage.getItem('coreguitar.latencyOffsetMs')).toBe('40');
  await userEvent.click(screen.getByRole('radio', { name: 'Mic + amp' }));
  expect(screen.getByText(/Use speakers, not headphones/)).toBeDefined();
  localStorage.clear();
});
