import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '../../test-utils';
import { api, ApiError } from '../../api';
import type { GuitarProImport } from '../../api/types';
import { GuitarProImporter } from './GuitarProImporter';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const converted: GuitarProImport = {
  title: 'Riff', artist: 'Band', source_bpm: 120, measure_count: 12, start: 1, end: 8, track: 1,
  tracks: [
    { index: 0, name: 'Drums', strings: 6, tuning: null, percussion: true },
    { index: 1, name: 'Lead', strings: 6, tuning: 'standard', percussion: false },
  ],
  exercise: { notes: '5/0:8 5/3:8', bpm: 120, tuning: 'standard', time_signature: [4, 4], default_duration: '8' },
  warnings: ['Chords keep only their highest note.'], total_beats: 32, note_count: 2,
};
const file = new File(['gp'], 'riff.gp5');

it('converts a file, lets the range be changed and hands the riff to the picker', async () => {
  const importGp = vi.spyOn(api, 'importGuitarPro').mockResolvedValue(converted);
  const onImport = vi.fn();
  const { userEvent } = render(<GuitarProImporter onImport={onImport} />);
  await userEvent.upload(screen.getByLabelText('Guitar Pro file'), file);
  expect(importGp).toHaveBeenCalledWith(file, { start: 1, tempo_percent: 100 });
  expect(await screen.findByLabelText('Converted notes')).toHaveProperty('textContent', '5/0:8 5/3:8');
  expect(screen.getByRole('option', { name: 'Drums (drums)' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('list', { name: 'Import warnings' }).textContent).toContain('highest note');

  await userEvent.clear(screen.getByLabelText('From bar'));
  await userEvent.type(screen.getByLabelText('From bar'), '3');
  await userEvent.clear(screen.getByLabelText('Tempo %'));
  await userEvent.type(screen.getByLabelText('Tempo %'), '75');
  await userEvent.click(screen.getByRole('button', { name: 'Convert again' }));
  expect(importGp).toHaveBeenLastCalledWith(file, { start: 3, end: 8, track: 1, tempo_percent: 75 });

  await userEvent.click(screen.getByRole('button', { name: 'Use as custom riff' }));
  expect(onImport).toHaveBeenCalledWith(converted.exercise);
});

it('shows the server error and advice when a file cannot be converted', async () => {
  vi.spyOn(api, 'importGuitarPro').mockRejectedValue(
    new ApiError('invalid_request', 'Not a Guitar Pro 3-5 file.', 'Export it as .gp5.'));
  const { userEvent } = render(<GuitarProImporter onImport={vi.fn()} />);
  await userEvent.upload(screen.getByLabelText('Guitar Pro file'), file);
  expect((await screen.findByRole('alert')).textContent).toBe('Not a Guitar Pro 3-5 file. Export it as .gp5.');
  expect(screen.queryByRole('button', { name: 'Use as custom riff' })).toBeNull();
});
