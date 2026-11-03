import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '../../test-utils';
import { LearningLibrary, ProgressDashboard } from './LearningViews';
import { emptyProgress, recordAttempt } from './progress';
import { SCALE_CATALOG } from '../scales/theory';
import { useProgress } from './useProgress';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it('filters the library and opens a scale in the selected key', async () => {
  const open = vi.fn();
  const { userEvent } = render(<LearningLibrary progress={emptyProgress()} onOpen={open} />);
  await userEvent.type(screen.getByLabelText('Find a scale'), 'pentatonic');
  const buttons = screen.getAllByRole('button', { name: /Open .* on fretboard/ });
  expect(buttons.length).toBeGreaterThan(1);
  expect(screen.getAllByRole('listitem').every(item => /pentatonic/i.test(item.textContent ?? ''))).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText('Library root'), '2');
  const first = buttons[0];
  if (!first) throw new Error('Expected a pentatonic scale');
  await userEvent.click(first);
  expect(open).toHaveBeenCalledWith(expect.any(String), 2);
});

it('shows learned scales and the mastery rule without changing the existing analysis scoring', () => {
  let progress = emptyProgress();
  const id = SCALE_CATALOG[0]?.id ?? 'major';
  for (let count = 0; count < 3; count++) progress = recordAttempt(progress,
    { scaleId: id, root: 0, bpm: 120, clean: true, durationSeconds: 30 });
  render(<ProgressDashboard progress={progress} onReset={vi.fn()} onOpen={vi.fn()} />);
  expect(screen.getByText('30 XP')).toBeDefined();
  expect(screen.getByText('First steps')).toBeDefined();
  expect(screen.getByRole('button', { name: /Practice .* again/ })).toBeDefined();
});

function StorageHarness() {
  const learning = useProgress();
  return <><p role="alert">{learning.error}</p><p>{learning.progress.xp} XP</p>
    <button onClick={() => learning.quiz('notes', 4)}>Save quiz</button>
    <button onClick={learning.reset}>Reset</button></>;
}
it('surfaces corrupt storage and saves or resets explicit progress', async () => {
  localStorage.setItem('coreguitar.learning.v1', '{');
  const { userEvent } = render(<StorageHarness />);
  expect(screen.getByRole('alert').textContent).toContain('not valid JSON');
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.getByText('0 XP')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Save quiz' }));
  expect(screen.getByText('20 XP')).toBeDefined();
  expect(screen.getByRole('alert').textContent).toBe('');
});

it('keeps unsaved progress in memory and reports storage denial', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const { userEvent } = render(<StorageHarness />);
  await userEvent.click(screen.getByRole('button', { name: 'Save quiz' }));
  expect(screen.getByText('20 XP')).toBeDefined();
  expect(screen.getByRole('alert').textContent).toContain('could not save');
});

it('rebases saves onto the latest persisted progress and synchronizes other tabs', async () => {
  const first = renderHook(() => useProgress());
  const second = renderHook(() => useProgress());
  act(() => first.result.current.quiz('notes', 4));
  act(() => second.result.current.attempt({ scaleId: 'major', root: 0, bpm: 120, clean: true, durationSeconds: 30 }));
  await waitFor(() => expect(second.result.current.progress.xp).toBe(30));
  const raw = localStorage.getItem('coreguitar.learning.v1');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'coreguitar.learning.v1', newValue: raw })));
  expect(first.result.current.progress.xp).toBe(30);
  expect(first.result.current.progress.mastery[0]?.attempts).toBe(1);
});
