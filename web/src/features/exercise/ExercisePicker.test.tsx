import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '../../test-utils';
import { ExercisePicker } from './ExercisePicker';
import { api } from '../../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('free play explicitly describes rather than judges correctness', async () => {
  vi.spyOn(api, 'exercises').mockResolvedValue([]);
  const onSelect = vi.fn();
  const { userEvent } = render(<ExercisePicker onSelect={onSelect} />);
  await userEvent.selectOptions(screen.getByLabelText('Practice mode'), 'free');
  expect(screen.getByText(/No reference/)).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Continue to capture' }));
  expect(onSelect).toHaveBeenCalledWith({ mode: 'free', bpm: 80, tuning: 'standard' });
});
