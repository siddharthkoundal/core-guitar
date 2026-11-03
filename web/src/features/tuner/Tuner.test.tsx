import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '../../test-utils';
import { midiToFrequency } from '../../audio/pitch';
import type { PitchHandlers, PitchSource } from '../../audio/pitch';
import { Tuner } from './Tuner';

let handlers: PitchHandlers | null = null;
let clock = 0;
const source = { start: vi.fn(), stop: vi.fn() };
function fakeInput(): PitchSource {
  return {
    start: (deviceId: string, value: PitchHandlers) => { handlers = value; return source.start(deviceId) as Promise<void>; },
    stop: () => source.stop(),
  };
}
function pitch(frequency: number | null, advanceMs = 100): void {
  clock += advanceMs;
  act(() => handlers?.onPitch(frequency === null ? null : { frequency, clarity: 0.97, rms: 0.1 }));
}

beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  source.start.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); source.start.mockReset(); source.stop.mockReset(); handlers = null; });

it('shows the note, cents and an in-tune verdict after a brief hold, with throttled announcements', async () => {
  localStorage.setItem('coreguitar.deviceId', 'usb-pedal');
  const { userEvent, unmount } = render(<Tuner createInput={fakeInput} />);
  expect(screen.getByRole('heading', { name: 'Tuner' })).toBeDefined();
  expect(screen.getByText('Tuner is off.')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Start tuner' }));
  expect(source.start).toHaveBeenCalledWith('usb-pedal');
  expect(await screen.findByRole('button', { name: 'Stop tuner' })).toBeDefined();
  expect(screen.getByRole('combobox', { name: 'Audio input' })).toHaveProperty('disabled', true);
  pitch(null);
  expect(screen.getByRole('status').textContent).toBe('No signal — pluck one string and let it ring.');
  pitch(midiToFrequency(40) * 2 ** (-20 / 1200));
  expect(screen.getByText('▲ Tune up')).toBeDefined();
  expect(screen.getByText(/target E2 \(string 6\) · 20 cents flat — tune up/)).toBeDefined();
  expect(screen.getByRole('status').textContent).toBe('No signal — pluck one string and let it ring.');
  pitch(midiToFrequency(40) * 2 ** (2 / 1200), 1600);
  expect(screen.getByText('Hold steady…')).toBeDefined();
  expect(screen.getByRole('status').textContent).toBe('E2, string 6 target E2: in tune (+2 cents)');
  pitch(midiToFrequency(40) * 2 ** (1 / 1200), 400);
  expect(screen.getByText('✓ In tune')).toBeDefined();
  pitch(midiToFrequency(40) * 2 ** (30 / 1200));
  expect(screen.getByText('▼ Tune down')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Stop tuner' }));
  expect(source.stop).toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toBe('Tuner stopped.');
  unmount();
});

it('switches tuning, chromatic and fixed-string targets', async () => {
  const { userEvent } = render(<Tuner createInput={fakeInput} />);
  await userEvent.click(screen.getByRole('button', { name: 'Start tuner' }));
  await screen.findByRole('button', { name: 'Stop tuner' });
  await userEvent.click(screen.getByRole('button', { name: 'String 5, A2' }));
  expect(screen.getByRole('button', { name: 'String 5, A2' }).getAttribute('aria-pressed')).toBe('true');
  pitch(midiToFrequency(47));
  expect(screen.getByText(/target A2 \(string 5\) · more than 50 cents sharp/)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Chromatic' }));
  pitch(midiToFrequency(47));
  expect(screen.getByText(/target B2 · in tune/)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'String 5, A2' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tuning' }), 'dropD');
  expect(screen.getByRole('button', { name: 'Auto string' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'String 6, D2' })).toBeDefined();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tuning' }), '7string');
  expect(screen.getByRole('button', { name: 'String 7, B1' })).toBeDefined();
});

it('validates and persists the reference pitch', async () => {
  const { userEvent } = render(<Tuner createInput={fakeInput} />);
  const input = screen.getByRole('spinbutton', { name: 'Reference A4 (Hz)' });
  await userEvent.clear(input);
  await userEvent.type(input, '460');
  expect(screen.getByText(/Enter a whole number from 430 to 450. Using 440 Hz./)).toBeDefined();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  await userEvent.clear(input);
  await userEvent.type(input, '432');
  expect(localStorage.getItem('coreguitar.tunerA4')).toBe('432');
  expect(screen.getByText('Concert pitch is 440 Hz. Saved in this browser.')).toBeDefined();
});

it('reports start failures, device loss and cancels a pending permission request', async () => {
  source.start.mockRejectedValueOnce(new Error('Permission denied'));
  const { userEvent } = render(<Tuner createInput={fakeInput} />);
  await userEvent.click(screen.getByRole('button', { name: 'Start tuner' }));
  expect(await screen.findByText('Permission denied')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Start tuner' }));
  await screen.findByRole('button', { name: 'Stop tuner' });
  act(() => handlers?.onError(new Error('Audio input disconnected.')));
  expect(screen.getByText('Audio input disconnected.')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Start tuner' })).toBeDefined();
  source.start.mockImplementationOnce(() => new Promise(() => {}));
  await userEvent.click(screen.getByRole('button', { name: 'Start tuner' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel input request' }));
  expect(screen.getByRole('button', { name: 'Start tuner' })).toBeDefined();
});

it('warns direct USB users that effects make tracking less reliable', () => {
  localStorage.setItem('coreguitar.inputKind', 'direct');
  render(<Tuner createInput={fakeInput} />);
  expect(screen.getByText(/heavy drive, delay or reverb/)).toBeDefined();
});
