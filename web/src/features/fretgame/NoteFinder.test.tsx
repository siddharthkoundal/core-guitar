import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '../../test-utils';
import { midiToFrequency } from '../../audio/pitch';
import type { PitchHandlers, PitchSource } from '../../audio/pitch';
import { NoteFinder } from './NoteFinder';
import { DEFAULT_SETTINGS, STORE_KEY } from './game';
import type { GameSettings } from './game';

const OPEN = [40, 45, 50, 55, 59, 64];
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
let handlers: PitchHandlers | null = null;
const source = { start: vi.fn(), stop: vi.fn() };
function fakeInput(): PitchSource {
  return {
    start: (deviceId: string, value: PitchHandlers) => { handlers = value; return source.start(deviceId) as Promise<void>; },
    stop: () => source.stop(),
  };
}
function store(change: Partial<GameSettings>, stats: Record<string, unknown> = {}): void {
  localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, settings: { ...DEFAULT_SETTINGS, ...change }, stats }));
}
function findTarget(): { string: number; fret: number } {
  const text = screen.getByRole('heading', { level: 3, name: /^Play / }).textContent ?? '';
  const match = /^Play (\S+) on string (\d)$/.exec(text);
  const string = 6 - Number(match?.[2]);
  const pitchClass = NAMES.indexOf(match?.[1] ?? '');
  const fret = Array.from({ length: 13 }, (_, index) => index).find(index => ((OPEN[string] ?? 0) + index) % 12 === pitchClass) ?? -1;
  return { string, fret };
}

beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); source.start.mockResolvedValue(undefined); });
afterEach(() => {
  cleanup(); vi.useRealTimers(); localStorage.clear(); vi.restoreAllMocks();
  source.start.mockReset(); source.stop.mockReset(); handlers = null;
});

it('plays a full click-the-fret round, records stats in a heatmap and resets them only after confirmation', async () => {
  const complete = vi.fn();
  const { userEvent } = render(<NoteFinder createInput={fakeInput} onComplete={complete} />);
  expect(screen.getByRole('heading', { name: 'Note finder' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Reset stats' })).toHaveProperty('disabled', true);
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(screen.getByRole('heading', { level: 3, name: 'Play E on string 6' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'String 5, fret 0' }));
  expect(screen.getByRole('status').textContent).toBe('Chose A2 — not it. Try again.');
  for (let index = 0; index < 10; index++) {
    expect(screen.getByText(`PROMPT ${index + 1} / 10`, { exact: false })).toBeDefined();
    const target = findTarget();
    await userEvent.click(screen.getByRole('button', { name: `String ${6 - target.string}, fret ${target.fret}` }));
  }
  expect(complete).toHaveBeenCalledExactlyOnceWith(9, 10);
  expect(screen.getByText(/9 \/ 10 first-try correct · average/)).toBeDefined();
  expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as { stats: Record<string, { attempts: number; correct: number }> };
  expect(saved.stats['standard:0:0']?.attempts).toBeGreaterThan(saved.stats['standard:0:0']?.correct ?? 0);
  await userEvent.click(screen.getByRole('button', { name: 'Reset stats' }));
  await userEvent.click(screen.getByRole('button', { name: 'Keep stats' }));
  expect(screen.getAllByText(/^\d+%$/).length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('button', { name: 'Reset stats' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirm reset stats' }));
  expect(screen.queryAllByText(/^\d+%$/)).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')).toMatchObject({ stats: {} });
});

it('supports keyboard navigation of the answer fretboard', async () => {
  const { userEvent } = render(<NoteFinder createInput={fakeInput} />);
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  const first = screen.getByRole('button', { name: 'String 1, fret 0' });
  expect(first.getAttribute('tabindex')).toBe('0');
  first.focus();
  await userEvent.keyboard('{ArrowRight}{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'String 2, fret 1' }));
  await userEvent.keyboard('{ArrowLeft}{ArrowUp}{Enter}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'String 1, fret 0' }));
  await userEvent.keyboard('{a}');
  expect(screen.getByRole('status').textContent).toBe('Chose E4 — not it. Try again.');
  await userEvent.click(screen.getByRole('button', { name: 'End round' }));
  expect(screen.getByRole('button', { name: 'Start round' })).toBeDefined();
});

it('names a highlighted position with note buttons and ticks off every octave', async () => {
  const { userEvent } = render(<NoteFinder createInput={fakeInput} />);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Game mode' }), 'name');
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(screen.getByRole('heading', { level: 3, name: 'Name the highlighted note' })).toBeDefined();
  expect(screen.getByRole('img', { name: 'String 6, fret 0, highlighted' })).toBeDefined();
  await userEvent.click(screen.getByRole('group', { name: 'Note choices' }).querySelector('button') as HTMLButtonElement);
  expect(screen.getByRole('status').textContent).toBe('Chose C — not it. Try again.');
  await userEvent.click(screen.getByRole('button', { name: 'E' }));
  expect(screen.getByRole('status').textContent).toMatch(/^Correct — E2 at string 6, fret 0/);
  await userEvent.click(screen.getByRole('button', { name: 'Skip prompt' }));
  expect(screen.getByRole('status').textContent).toMatch(/^Skipped — /);
  await userEvent.click(screen.getByRole('button', { name: 'End round' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Game mode' }), 'octaves');
  for (const string of [5, 4, 3, 2, 1]) await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`^String ${string} `) }));
  expect(screen.getByRole('checkbox', { name: 'String 6 (E)' })).toHaveProperty('checked', true);
  await userEvent.click(screen.getByRole('checkbox', { name: 'String 6 (E)' }));
  expect(screen.getByRole('checkbox', { name: 'String 6 (E)' })).toHaveProperty('checked', true);
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(screen.getByRole('heading', { level: 3, name: 'Play every E (2 pitches)' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'String 6, fret 12' }));
  expect(screen.getByRole('button', { name: 'String 6, fret 12, found E3' })).toBeDefined();
  expect(screen.getByText(/1 of 2 found/)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'String 6, fret 0' }));
  expect(screen.getByRole('status').textContent).toMatch(/^Correct — all Es found in \d+\.\d s\.$/);
});

it('scores stable live pitches from the selected input and recovers from input errors', async () => {
  localStorage.setItem('coreguitar.deviceId', 'usb-pedal');
  const { userEvent, unmount } = render(<NoteFinder createInput={fakeInput} />);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Answer with' }), 'live');
  expect(screen.getByRole('combobox', { name: 'Audio input' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(source.start).toHaveBeenCalledWith('usb-pedal');
  expect(await screen.findByText('Hearing: —')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'String 6, fret 0' })).toBeNull();
  const play = (midi: number, frames = 3) => {
    for (let frame = 0; frame < frames; frame++) act(() => handlers?.onPitch({ frequency: midiToFrequency(midi), clarity: 0.95, rms: 0.1 }));
  };
  play(45);
  expect(screen.getByText('Hearing: A2')).toBeDefined();
  expect(screen.getByRole('status').textContent).toBe('Heard A2 — not it. Try again.');
  act(() => handlers?.onPitch(null));
  play(40);
  expect(screen.getByRole('status').textContent).toMatch(/^Correct — E2 at string 6, fret 0/);
  act(() => handlers?.onError(new Error('Audio input disconnected.')));
  expect(screen.getByText(/Audio input disconnected\. Switch “Answer with” to fretboard clicks/)).toBeDefined();
  source.start.mockRejectedValueOnce(new Error('Permission denied'));
  await userEvent.click(screen.getByRole('button', { name: 'Restart input' }));
  expect(await screen.findByText(/Permission denied Use fretboard clicks instead\./)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Restart input' }));
  expect(await screen.findByText('Hearing: —')).toBeDefined();
  unmount();
  expect(source.stop).toHaveBeenCalled();
});

it('times out prompts when a timer is set', () => {
  vi.useFakeTimers();
  store({ timerSeconds: 5 });
  render(<NoteFinder createInput={fakeInput} />);
  fireEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(screen.getByText(/5 S LIMIT/)).toBeDefined();
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.getByRole('status').textContent).toBe("Time's up — E2 is at string 6, fret 0.");
  expect(screen.getByText(/PROMPT 2 \/ 10/)).toBeDefined();
});

it('restores and edits settings, reports corrupt storage and impossible settings', async () => {
  localStorage.setItem(STORE_KEY, '{');
  const first = render(<NoteFinder createInput={fakeInput} />);
  expect(screen.getByText(/statistics could not be restored/)).toBeDefined();
  first.unmount();
  store({ strings: [0], minFret: 2, maxFret: 2, tuningId: 'standard' }, { 'standard:0:2': { attempts: 2, correct: 0, totalMs: 0 } });
  const { userEvent } = render(<NoteFinder createInput={fakeInput} />);
  expect(screen.getByText('2×')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(screen.getByText(/No notes match these settings/)).toBeDefined();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Notes' }), 'all');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Round length' }), '20');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Time per prompt' }), '10');
  const from = screen.getByRole('spinbutton', { name: 'From fret' });
  const to = screen.getByRole('spinbutton', { name: 'To fret' });
  fireEvent.change(to, { target: { value: '24' } });
  fireEvent.change(from, { target: { value: '5' } });
  fireEvent.change(to, { target: { value: '3' } });
  fireEvent.change(to, { target: { value: '99' } });
  expect(from).toHaveProperty('value', '3');
  expect(to).toHaveProperty('value', '3');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tuning' }), '8string');
  expect(screen.getByRole('checkbox', { name: 'String 8 (F♯)' })).toBeDefined();
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as { settings: GameSettings };
  expect(saved.settings).toMatchObject({ naturalsOnly: false, roundLength: 20, timerSeconds: 10, minFret: 3, maxFret: 3, tuningId: '8string', strings: [0] });
  await userEvent.click(screen.getByRole('button', { name: 'Start round' }));
  expect(screen.getByText(/PROMPT 1 \/ 20/)).toBeDefined();
});
