import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '../../test-utils';
import { ExercisePicker } from './ExercisePicker';
import { api } from '../../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('free play explicitly describes rather than judges correctness', async () => {
  vi.spyOn(api, 'exercises').mockResolvedValue([]);
  const onSelect = vi.fn();
  const { userEvent } = render(<ExercisePicker onSelect={onSelect} onDemo={vi.fn()} />);
  await userEvent.selectOptions(screen.getByLabelText('Practice mode'), 'free');
  expect(screen.getByText(/No reference/)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Try a demo take' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Continue to capture' }));
  expect(onSelect).toHaveBeenCalledWith({ mode: 'free', bpm: 80, tuning: 'standard' });
});

it('defaults to the practice library and offers a demo take for the chosen riff', async () => {
  vi.spyOn(api, 'exercises').mockResolvedValue([{
    id: 'major_scale_g', name: 'G major scale', description: 'One octave', tuning: 'standard',
    bpm: 90, time_signature: [4, 4], default_duration: '8', notes_text: '', total_beats: 8,
  }]);
  const onDemo = vi.fn();
  const { userEvent } = render(<ExercisePicker onSelect={vi.fn()} onDemo={onDemo} />);
  expect(screen.getByText('More options: custom riff or free play').closest('details')?.open).toBe(false);
  await userEvent.click(await screen.findByRole('button', { name: 'Try a demo take' }));
  expect(onDemo).toHaveBeenCalledWith({ mode: 'reference', exercise_id: 'major_scale_g', bpm: 90 });
});
