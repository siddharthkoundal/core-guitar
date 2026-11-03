import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '../../test-utils';
import { Coach } from './Coach';
import * as client from './client';
import { DEFAULT_SETTINGS, saveSettings } from '../scales/settings';
import { TUNINGS } from '../scales/theory';
import { saveHistory } from '../chords/history';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(client, 'coachStatus').mockResolvedValue({ available: true, models: ['llama3.2'] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('generates, saves, restores and follows up using local history', async () => {
  const ask = vi.spyOn(client, 'askCoach').mockResolvedValue({ text: 'Practise G major slowly.', model: 'llama3.2' });
  const { userEvent, unmount } = render(<Coach context="G major selected" />);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Learn G major');
  await userEvent.selectOptions(screen.getByLabelText('Experience level'), 'intermediate');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  expect(await screen.findByText('Practise G major slowly.')).toBeDefined();
  expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({
    level: 'intermediate', context: expect.stringContaining('G major selected'),
  }), expect.any(AbortSignal));
  await userEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  unmount();
  const next = render(<Coach />);
  await next.userEvent.click(screen.getByRole('button', { name: /Load Learn G major/ }));
  await next.userEvent.type(screen.getByLabelText('Follow-up question'), 'What tempo?');
  await next.userEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({
    prompt: 'What tempo?', messages: [
      { role: 'user', content: 'Learn G major' },
      { role: 'assistant', content: 'Practise G major slowly.' },
    ],
  }), expect.any(AbortSignal));
});

it('cancels work and ignores a late completion', async () => {
  let resolve: ((value: { text: string; model: string }) => void) | undefined;
  const ask = vi.spyOn(client, 'askCoach').mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { userEvent } = render(<Coach />);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
  expect(ask.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => { resolve?.({ text: 'Late answer', model: 'm' }); });
  expect(screen.queryByText('Late answer')).toBeNull();
  expect(screen.getByText(/Generation cancelled/)).toBeDefined();
});

it('surfaces generation and unavailable setup errors', async () => {
  vi.mocked(client.coachStatus).mockResolvedValue({ available: false, models: [] });
  vi.spyOn(client, 'askCoach').mockRejectedValue(new Error('Model missing. Run ollama pull llama3.2.'));
  const { userEvent } = render(<Coach />);
  expect(await screen.findByText(/Ollama is not running/)).toBeDefined();
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Model missing'));
});

it('rejects invalid saved history without crashing', async () => {
  localStorage.setItem('coreguitar.coach.plans.v1', JSON.stringify([{ text: '<img src=x>', level: 'root' }]));
  render(<Coach />);
  expect(await screen.findByText(/Saved plans could not be loaded/)).toBeDefined();
  expect(screen.queryByRole('img')).toBeNull();
});

it('reports storage failure rather than claiming a plan was saved', async () => {
  vi.spyOn(client, 'askCoach').mockResolvedValue({ text: 'Plan', model: 'm' });
  const { userEvent } = render(<Coach />);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  await screen.findByText('Plan');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  await userEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('could not be saved'));
});

it('opens only catalog-validated scale suggestions and renders HTML as plain text', async () => {
  vi.spyOn(client, 'askCoach').mockResolvedValue({
    text: '<img src=x onerror=alert(1)> [scale:major:7] [scale:major:7] [scale:fake:2] [scale:dorian:99]',
    model: 'llama3.2',
  });
  const onOpenScale = vi.fn();
  const { userEvent } = render(<Coach onOpenScale={onOpenScale} />);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  const button = await screen.findByRole('button', { name: /on fretboard/ });
  expect(screen.getAllByRole('button', { name: /on fretboard/ })).toHaveLength(1);
  await userEvent.click(button);
  expect(onOpenScale).toHaveBeenCalledWith('major', 7);
  expect(screen.queryByRole('img')).toBeNull();
});

it('removes saved plans and resets corrupt history', async () => {
  vi.spyOn(client, 'askCoach').mockResolvedValue({ text: 'Plan', model: 'm' });
  const { userEvent } = render(<Coach />);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Save plan' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete Scales' }));
  expect(screen.queryByRole('button', { name: 'Load Scales' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Save plan' }));
  await userEvent.click(screen.getByRole('button', { name: 'Clear saved plans' }));
  expect(localStorage.getItem('coreguitar.coach.plans.v1')).toBeNull();
});

it('refreshes status after a transport failure and aborts generation on unmount', async () => {
  vi.mocked(client.coachStatus).mockRejectedValueOnce(new Error('Status failed'));
  const ask = vi.spyOn(client, 'askCoach').mockImplementation(() => new Promise(() => {}));
  const { userEvent, unmount } = render(<Coach />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Status failed');
  await userEvent.click(screen.getByRole('button', { name: 'Refresh local status' }));
  await screen.findByText(/Ollama is running/);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  unmount();
  expect(ask.mock.calls[0]?.[1].aborted).toBe(true);
});

it('personalizes only with validated local tuning and experimental chord metadata', async () => {
  const tuning = TUNINGS[1] ?? TUNINGS[0];
  if (!tuning) throw new Error('Missing local tuning catalog');
  saveSettings({ ...DEFAULT_SETTINGS, tuningId: tuning.id, bpm: 75 });
  saveHistory([{ root: 7, quality: 'major', name: 'G', similarity: 0.9, detectedAt: '2026-01-01T12:00:00.000Z' }]);
  const ask = vi.spyOn(client, 'askCoach').mockResolvedValue({ text: 'Plan', model: 'm' });
  const { userEvent } = render(<Coach context={'x'.repeat(10000)} />);
  await userEvent.type(screen.getByLabelText('Practice goal'), 'Scales');
  await userEvent.click(screen.getByRole('button', { name: 'Generate practice plan' }));
  await screen.findByText('Plan');
  const context = ask.mock.calls[0]?.[0].context;
  expect(context).toContain(`Saved tuning: ${tuning.name}`);
  expect(context).toContain('75 BPM');
  expect(context).toContain('experimental, not verified): G');
  expect(context?.length).toBeLessThanOrEqual(8000);
});
