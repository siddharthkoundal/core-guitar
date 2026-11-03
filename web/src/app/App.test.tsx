import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor } from '../test-utils';
import { api, parseEnvelope } from '../api';
import { App } from './App';

beforeEach(() => {
  vi.spyOn(api, 'exercises').mockResolvedValue([]);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:review');
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('introduces the rock practice room with an honest signal checklist and current step', async () => {
  render(<App />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Play a riff. Get feedback.');
  expect(screen.getByRole('complementary', { name: 'Before you hit record' })).toBeDefined();
  expect(screen.getByText('Clean channel. No distortion.')).toBeDefined();
  expect(screen.getByText('Choose your riff').getAttribute('aria-current')).toBe('step');
  await waitFor(() => expect(api.exercises).toHaveBeenCalled());
});

it('opens learning tools without changing the existing recording workflow', async () => {
  const { userEvent } = render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Library' }));
  expect(screen.getByRole('heading', { name: 'Scale library' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Progress' }));
  expect(screen.getByRole('heading', { name: 'Your progress' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Takes & feedback' }));
  expect(await screen.findByRole('heading', { name: 'Pick a riff and a tempo' })).toBeDefined();
});

it('consumes library navigation without overriding later fretboard preferences', async () => {
  const { userEvent } = render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Library' }));
  const first = screen.getAllByRole('button', { name: /Open .* on fretboard/ })[0];
  if (!first) throw new Error('Expected a scale in the library');
  await userEvent.click(first);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Root' }), '2');
  await userEvent.click(screen.getByRole('button', { name: 'Ear training' }));
  await userEvent.click(screen.getByRole('button', { name: 'Fretboard' }));
  const root = screen.getByRole('combobox', { name: 'Root' });
  expect(root instanceof HTMLSelectElement && root.value).toBe('2');
});

async function uploadTake() {
  const view = render(<App />);
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  await view.userEvent.selectOptions(screen.getByLabelText('Practice mode'), 'free');
  await view.userEvent.click(screen.getByRole('button', { name: 'Continue to capture' }));
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  expect(screen.getByText('Capture a take').getAttribute('aria-current')).toBe('step');
  expect(screen.getByText('Choose your riff').hasAttribute('aria-current')).toBe(false);
  await view.userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await view.userEvent.upload(screen.getByLabelText('Audio file'),
    new File(['audio'], 'take.wav', { type: 'audio/wav' }));
  return view;
}

it('preserves upload mode after discard and clears capture when picking another exercise', async () => {
  const { userEvent } = await uploadTake();
  expect(screen.getByRole('heading', { name: 'Listen before you submit' })).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Discard / Re-record' }));
  expect(screen.getByRole('button', { name: 'Upload' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByLabelText('Audio file')).toBeDefined();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:review');
  await userEvent.click(screen.getByRole('button', { name: 'Pick another exercise' }));
  expect(screen.getByRole('heading', { name: 'Pick a riff and a tempo' })).toBeDefined();
  expect(screen.queryByRole('heading', { name: 'Listen before you submit' })).toBeNull();
});

it('wires upload, results and tempo retry while preserving phase focus and clearing the take', async () => {
  const envelope = parseEnvelope({
    analysis_id: 'analysis', take_id: 'take', source: 'upload', request: {},
    track_settings: {}, lossy: false,
    result: JSON.parse(readFileSync(resolve(process.cwd(), '../tests/golden/clean.json'), 'utf8')),
  });
  vi.spyOn(api, 'upload').mockResolvedValue({
    take_id: 'take', duration_s: 5, sample_rate: 48000, channels: 1,
    codec: 'wav', lossy: false, source: 'upload',
  });
  vi.spyOn(api, 'analyze').mockResolvedValue({ analysis_id: 'analysis' });
  vi.spyOn(api, 'status').mockResolvedValue({ status: 'done', result: envelope });
  const { userEvent } = await uploadTake();
  await userEvent.click(screen.getByRole('button', { name: 'Submit for analysis' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your next step' })).toBeDefined());
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Your take.');
  expect(screen.queryByRole('list', { name: 'Practice progress' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: 'Before you hit record' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  await userEvent.click(screen.getByRole('button', { name: '+5 BPM' }));
  expect(screen.getByRole('heading', { name: '85 BPM / free mode' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Record' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('heading', { name: 'Listen before you submit' })).toBeNull();
});

it('demo take goes from the first screen straight to results without a guitar', async () => {
  const envelope = parseEnvelope({
    analysis_id: 'analysis', take_id: 'take', source: 'upload', request: {},
    track_settings: {}, lossy: false,
    result: JSON.parse(readFileSync(resolve(process.cwd(), '../tests/golden/late.json'), 'utf8')),
  });
  vi.mocked(api.exercises).mockResolvedValue([{
    id: 'chromatic_1234', name: 'Chromatic 1-2-3-4', description: 'Warm-up', tuning: 'standard',
    bpm: 72, time_signature: [4, 4], default_duration: '8', notes_text: '', total_beats: 12,
  }]);
  const demoTake = vi.spyOn(api, 'demoTake').mockResolvedValue(new Blob(['RIFF'], { type: 'audio/wav' }));
  const upload = vi.spyOn(api, 'upload').mockResolvedValue({
    take_id: 'take', duration_s: 5, sample_rate: 44100, channels: 1,
    codec: 'wav', lossy: false, source: 'upload',
  });
  vi.spyOn(api, 'analyze').mockResolvedValue({ analysis_id: 'analysis' });
  vi.spyOn(api, 'status').mockResolvedValue({ status: 'done', result: envelope });
  const { userEvent } = render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: 'Try a demo take' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your next step' })).toBeDefined());
  expect(screen.getByRole('region', { name: 'First thing to work on' })).toBeDefined();
  const nextStep = screen.getByRole('region', { name: 'Your next step' });
  const details = screen.getByText('Full analysis details');
  expect(nextStep.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Practice progress' })).toBeNull();
  const selection = { mode: 'reference', exercise_id: 'chromatic_1234', bpm: 72 };
  expect(demoTake).toHaveBeenCalledWith(selection, expect.any(AbortSignal));
  expect(upload.mock.calls[0]?.[1]).toMatchObject({ source: 'upload', original_name: 'demo-take.wav' });
  expect(api.analyze).toHaveBeenCalledWith('take', expect.objectContaining(selection));
});
