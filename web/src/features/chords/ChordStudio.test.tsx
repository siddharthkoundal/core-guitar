import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '../../test-utils';
import { askCoach } from '../coach/client';
import { ChordStudio } from './ChordStudio';
import { HISTORY_KEY } from './history';

vi.mock('../coach/client', () => ({ askCoach: vi.fn() }));
beforeEach(() => { localStorage.clear(); vi.mocked(askCoach).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses manual root-quality fallback with parent persistence and no automatic microphone', async () => {
  const getUserMedia = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const onDetected = vi.fn();
  const { userEvent } = render(<ChordStudio onDetected={onDetected} />);
  expect(getUserMedia).not.toHaveBeenCalled();
  await userEvent.selectOptions(screen.getByLabelText('Root'), '9');
  await userEvent.selectOptions(screen.getByLabelText('Quality'), 'min7');
  await userEvent.click(screen.getByRole('button', { name: 'Add manual chord' }));
  expect(onDetected).toHaveBeenCalledWith({
    name: 'Am7', root: 9, quality: 'min7', similarity: 0, detectedAt: expect.any(String),
  });
  expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
  expect(screen.getByText(/manual selection; similarity not measured/i)).toBeDefined();
});

it('persists manual chords locally and can clear history', async () => {
  const { userEvent } = render(<ChordStudio />);
  await userEvent.click(screen.getByRole('button', { name: 'Add manual chord' }));
  expect(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Clear chord history' }));
  expect(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')).toEqual([]);
});

it('includes recent chords in coach context and can use validated suggestions manually', async () => {
  vi.mocked(askCoach).mockResolvedValue({ text: '```json\n{"chords":[{"root":7,"quality":"dom7"}]}\n```', model: 'local' });
  const { userEvent } = render(<ChordStudio />);
  await userEvent.click(screen.getByRole('button', { name: 'Add manual chord' }));
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  expect(askCoach).toHaveBeenCalledWith(expect.objectContaining({
    context: expect.stringContaining('Recent chords: C'),
  }), expect.any(AbortSignal));
  await userEvent.click(await screen.findByRole('button', { name: 'Use G7 suggestion 1' }));
  expect(screen.getByText(/G7 — manual selection/)).toBeDefined();
  const entries: unknown[] = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  expect(entries).toHaveLength(2);
});

it('validates empty prompts, changes level and reports storage quota failures', async () => {
  const { userEvent } = render(<ChordStudio />);
  await userEvent.clear(screen.getByLabelText('Progression prompt'));
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  expect(screen.getByText(/Enter a progression prompt/)).toBeDefined();
  expect(askCoach).not.toHaveBeenCalled();
  vi.mocked(askCoach).mockResolvedValue({ text: 'Try a progression.', model: 'local' });
  await userEvent.type(screen.getByLabelText('Progression prompt'), 'A slow ballad');
  await userEvent.selectOptions(screen.getByLabelText('Playing level'), 'advanced');
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  await screen.findByText('Try a progression.');
  expect(askCoach).toHaveBeenCalledWith(expect.objectContaining({ level: 'advanced' }), expect.any(AbortSignal));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await userEvent.click(screen.getByRole('button', { name: 'Add manual chord' }));
  expect(screen.getByText(/Chord history was not saved/)).toBeDefined();
});

it('sends local progression requests, renders plain text and supports followups', async () => {
  vi.mocked(askCoach).mockResolvedValue({ text: '<img src=x onerror=alert(1)>\n```json\n{"chords":[{"root":0,"quality":"major"}]}\n```', model: 'local' });
  const { userEvent, container } = render(<ChordStudio context="Recent practice: C" />);
  await userEvent.type(screen.getByLabelText('Progression prompt'), 'A gentle turnaround');
  await userEvent.selectOptions(screen.getByLabelText('Genre'), 'Jazz');
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  await screen.findByText(/<img src=x/);
  expect(container.querySelector('img')).toBeNull();
  expect(askCoach).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'progression', prompt: expect.stringContaining('A gentle turnaround'),
    level: 'beginner', context: expect.stringContaining('Recent practice: C'),
  }), expect.any(AbortSignal));
  expect(vi.mocked(askCoach).mock.calls[0]?.[0].prompt).toContain('Jazz');
  await userEvent.type(screen.getByLabelText('Follow-up question'), 'Simplify it');
  await userEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
  await waitFor(() => expect(askCoach).toHaveBeenCalledTimes(2));
  expect(askCoach).toHaveBeenLastCalledWith(expect.objectContaining({
    messages: expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
  }), expect.any(AbortSignal));
});

it('shows progression errors and allows retry', async () => {
  vi.mocked(askCoach).mockRejectedValue(new Error('Ollama is unavailable'));
  const { userEvent } = render(<ChordStudio />);
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  expect((await screen.findByText('Ollama is unavailable')).closest('[role="alert"]')).not.toBeNull();
  vi.mocked(askCoach).mockResolvedValue({ text: 'Try C then F.', model: 'local' });
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  expect(await screen.findByText('Try C then F.')).toBeDefined();
});

it('cancels requests, ignores late replies and aborts on unmount', async () => {
  let resolve: ((response: { text: string; model: string }) => void) | undefined;
  vi.mocked(askCoach).mockImplementation(() => new Promise(done => { resolve = done; }));
  const { userEvent, unmount } = render(<ChordStudio />);
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  const signal = vi.mocked(askCoach).mock.calls[0]?.[1];
  await userEvent.click(screen.getByRole('button', { name: 'Cancel ChordAI' }));
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve?.({ text: 'stale answer', model: 'local' }); });
  expect(screen.queryByText('stale answer')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  const nextSignal = vi.mocked(askCoach).mock.calls[1]?.[1];
  unmount();
  expect(nextSignal?.aborted).toBe(true);
});

it('bounds follow-up history to the server limit and always includes recent local chords', async () => {
  vi.mocked(askCoach).mockResolvedValue({ text: 'Try C then F.', model: 'local' });
  const { userEvent } = render(<ChordStudio context={'practice '.repeat(1000)} />);
  await userEvent.click(screen.getByRole('button', { name: 'Add manual chord' }));
  await userEvent.click(screen.getByRole('button', { name: 'Ask ChordAI' }));
  await screen.findByText('Try C then F.');
  for (let index = 0; index < 7; index++) {
    await userEvent.type(screen.getByLabelText('Follow-up question'), `Variation ${index}`);
    await userEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await waitFor(() => expect(askCoach).toHaveBeenCalledTimes(index + 2));
  }
  const request = vi.mocked(askCoach).mock.calls.at(-1)?.[0];
  expect(request?.messages).toHaveLength(12);
  expect(request?.context).toContain('Recent chords: C');
  expect(request?.context.length).toBeLessThanOrEqual(6000);
});
