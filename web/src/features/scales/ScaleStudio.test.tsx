import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '../../test-utils';
import { ScaleStudio } from './ScaleStudio';
import type { MicrophoneHandlers } from './microphone';

const audio = vi.hoisted(() => ({
  play: vi.fn(async () => {}),
  metronome: vi.fn(async () => {}),
  stop: vi.fn(),
}));
const mic = vi.hoisted(() => {
  const state: { handlers: MicrophoneHandlers | null } = { handlers: null };
  return { state, stop: vi.fn(), start: vi.fn(async (handlers: MicrophoneHandlers) => { state.handlers = handlers; }) };
});

vi.mock('./microphone', () => ({
  MicrophoneInput: class { start = mic.start; stop = mic.stop; },
}));

vi.mock('./sound', () => ({
  isAudioCancellation: (error: unknown) => error instanceof Error && error.name === 'AbortError',
  AudioPlayer: class {
    play = audio.play;
    metronome = audio.metronome;
    stop = audio.stop;
  },
}));
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('renders an accessible, playable 25-fret board with display and pattern controls', async () => {
  const { userEvent } = render(<ScaleStudio initialScaleId="major" initialRoot={0} />);
  expect(screen.getAllByRole('columnheader')).toHaveLength(26);
  expect(screen.getByText(/Input source: fretboard clicks/)).toBeDefined();
  await userEvent.selectOptions(screen.getByLabelText('Pattern system'), 'caged');
  expect(screen.getByLabelText('Position').querySelectorAll('option')).toHaveLength(5);
  await userEvent.selectOptions(screen.getByLabelText('Tuning'), 'dropD');
  expect(screen.getByText(/CAGED.*standard/i)).toBeDefined();
  await userEvent.selectOptions(screen.getByLabelText('Labels'), 'intervals');
  expect(screen.getByRole('button', { name: /String 6, fret 0, D/ })).toBeDefined();
});

it('resolves equivalent initial scale names and gives a tonic inside the selected shape', async () => {
  const { userEvent } = render(<ScaleStudio initialScaleId="aeolian" initialRoot={0} />);
  expect((screen.getByLabelText('Scale') as HTMLSelectElement).value).toBe('natural-minor');
  await userEvent.selectOptions(screen.getByLabelText('Pattern system'), 'caged');
  expect(screen.getByText(/These are the relative-major chord forms/)).toBeDefined();
  expect(screen.getByText(/lowest tonic in this pattern/)).toBeDefined();
});

it('completes one timed clean click run exactly once and cancels all timers on unmount', () => {
  vi.useFakeTimers();
  const onAttempt = vi.fn();
  const { unmount } = render(<ScaleStudio onAttempt={onAttempt} />);
  fireEvent.change(screen.getByLabelText('Run duration'), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
  for (const fret of [8, 10, 12, 13, 15, 17, 19, 20]) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^String 6, fret ${fret},`) }));
  }
  act(() => { vi.advanceTimersByTime(15000); });
  expect(onAttempt).toHaveBeenCalledExactlyOnceWith({
    scaleId: 'major', root: 0, bpm: 90, clean: true, durationSeconds: 15,
  });
  act(() => { vi.advanceTimersByTime(15000); });
  expect(onAttempt).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels runs on settings changes and never awards clean status after wrong notes', () => {
  vi.useFakeTimers();
  const onAttempt = vi.fn();
  render(<ScaleStudio onAttempt={onAttempt} />);
  fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
  fireEvent.change(screen.getByLabelText('Root'), { target: { value: '2' } });
  act(() => { vi.advanceTimersByTime(60000); });
  expect(onAttempt).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Run duration'), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
  fireEvent.click(screen.getByRole('button', { name: /^String 6, fret 1,/ }));
  act(() => { vi.advanceTimersByTime(15000); });
  expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ clean: false }));
});

it('stops audio on unmount and visibly reports audio failures', async () => {
  audio.play.mockRejectedValueOnce(new Error('Audio unavailable'));
  const { unmount } = render(<ScaleStudio initialScaleId="missing" initialRoot={99} />);
  fireEvent.click(screen.getByRole('button', { name: 'Play scale' }));
  expect(await screen.findByText('Audio: Audio unavailable')).toBeDefined();
  const before = audio.stop.mock.calls.length;
  unmount();
  expect(audio.stop.mock.calls.length).toBe(before + 3);
});

it('does not send random or free exploration runs to the mastery callback', () => {
  vi.useFakeTimers();
  const onAttempt = vi.fn();
  render(<ScaleStudio onAttempt={onAttempt} />);
  fireEvent.change(screen.getByLabelText('Run duration'), { target: { value: '15' } });
  for (const mode of ['random', 'free']) {
    fireEvent.change(screen.getByLabelText('Practice mode'), { target: { value: mode } });
    fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
    act(() => { vi.advanceTimersByTime(15000); });
  }
  expect(onAttempt).not.toHaveBeenCalled();
});

it('restores settings, displays storage failures, and moves on the fretboard by keyboard', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const { userEvent } = render(<ScaleStudio />);
  expect(screen.getByText(/Scale settings could not be saved: Storage blocked/)).toBeDefined();
  const first = screen.getByRole('button', { name: /^String 6, fret 0,/ });
  first.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^String 6, fret 1,/ }));
  await userEvent.keyboard('{ArrowUp}{End}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^String 5, fret 24,/ }));
});

it('matches only microphone notes for live sequence runs and releases capture on completion', async () => {
  vi.useFakeTimers();
  const onAttempt = vi.fn();
  render(<ScaleStudio onAttempt={onAttempt} />);
  fireEvent.change(screen.getByLabelText('Run duration'), { target: { value: '15' } });
  fireEvent.change(screen.getByLabelText('Note input'), { target: { value: 'microphone' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enable microphone' })); });
  expect(screen.getByRole('button', { name: 'Play scale' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Start practice' }));
  fireEvent.click(screen.getByRole('button', { name: /^String 6, fret 1,/ }));
  for (const midi of [60, 62, 64, 65, 67, 69, 71, 72]) act(() => { mic.state.handlers?.onNote(midi); });
  act(() => { vi.advanceTimersByTime(15000); });
  expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ clean: true }));
  expect(screen.getByRole('button', { name: 'Enable microphone' })).toBeDefined();
  expect(mic.stop).toHaveBeenCalled();
});

it('makes microphone errors visible, cancels capture, and never saves an interrupted run', async () => {
  mic.start.mockRejectedValueOnce(new Error('Permission denied'));
  const { userEvent, unmount } = render(<ScaleStudio />);
  await userEvent.selectOptions(screen.getByLabelText('Note input'), 'microphone');
  await userEvent.click(screen.getByRole('button', { name: 'Enable microphone' }));
  expect(await screen.findByText('Microphone: Permission denied')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Enable microphone' }));
  act(() => { mic.state.handlers?.onError(new Error('Device lost')); });
  expect(screen.getByText('Microphone: Device lost')).toBeDefined();
  const before = mic.stop.mock.calls.length;
  unmount();
  expect(mic.stop.mock.calls.length).toBe(before + 1);
});

it('plays directions, sound preferences and accented meters while handling metronome errors', async () => {
  const { userEvent } = render(<ScaleStudio />);
  await userEvent.selectOptions(screen.getByLabelText('Direction'), 'both');
  await userEvent.click(screen.getByRole('button', { name: 'Play scale' }));
  expect(audio.play).toHaveBeenCalledWith([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60],
    90, { waveform: 'triangle', volume: 0.6 });
  await userEvent.selectOptions(screen.getByLabelText('Direction'), 'descending');
  await userEvent.click(screen.getByText('Sound settings'));
  await userEvent.selectOptions(screen.getByLabelText('Tone'), 'sine');
  fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.4' } });
  fireEvent.change(screen.getByLabelText('Tempo (BPM)'), { target: { value: '120' } });
  await userEvent.click(screen.getByRole('button', { name: 'Play scale' }));
  expect(audio.play).toHaveBeenLastCalledWith([72, 71, 69, 67, 65, 64, 62, 60], 120, { waveform: 'sine', volume: 0.4 });
  await userEvent.selectOptions(screen.getByLabelText('Time signature'), '7/8');
  await userEvent.click(screen.getByRole('button', { name: 'Start metronome' }));
  expect(audio.metronome).toHaveBeenCalledWith(120, { waveform: 'sine', volume: 0.4, beatsPerBar: 7, beatUnit: 8 });
  await userEvent.click(screen.getByRole('button', { name: 'Stop metronome' }));
  audio.metronome.mockRejectedValueOnce(new Error('Clock interrupted'));
  await userEvent.click(screen.getByRole('button', { name: 'Start metronome' }));
  expect(await screen.findByText('Audio: Clock interrupted')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Stop audio' }));
  await userEvent.click(screen.getAllByRole('button', { name: /shared tones/ })[0]!);
});

it('stops pending microphone requests and practice when switching note sources', async () => {
  let ready: (() => void) | undefined;
  mic.start.mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
  const { userEvent } = render(<ScaleStudio />);
  await userEvent.selectOptions(screen.getByLabelText('Note input'), 'microphone');
  await userEvent.click(screen.getByRole('button', { name: 'Enable microphone' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel microphone request' }));
  await act(async () => { ready?.(); });
  expect(screen.queryByRole('button', { name: 'Stop microphone' })).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText('Note input'), 'clicks');
  await userEvent.click(screen.getByRole('button', { name: 'Start practice' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel practice' }));
  expect(screen.getByText('Practice cancelled. No attempt saved.')).toBeDefined();
});
