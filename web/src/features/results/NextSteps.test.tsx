import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '../../test-utils';
import { NextSteps } from './NextSteps';

afterEach(cleanup);

it.each([30, 39, 40, 235, 236, 240])('keeps tempo buttons within 30-240 BPM at %i BPM', bpm => {
  render(<NextSteps bpm={bpm} rejections={0} onRetry={vi.fn()} onPick={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.getByRole('button', { name: '+5 BPM' }).hasAttribute('disabled')).toBe(bpm + 5 > 240);
  expect(screen.getByRole('button', { name: '-10 BPM' }).hasAttribute('disabled')).toBe(bpm - 10 < 30);
});

it('delegates retries, picking and deletion without changing settings automatically', async () => {
  const onRetry = vi.fn(), onPick = vi.fn(), onDelete = vi.fn();
  const { userEvent } = render(
    <NextSteps bpm={80} rejections={2} onRetry={onRetry} onPick={onPick} onDelete={onDelete} />,
  );
  expect(onRetry).not.toHaveBeenCalled();
  for (const name of ['Record again', 'Retry same settings', '+5 BPM', '-10 BPM']) {
    await userEvent.click(screen.getByRole('button', { name }));
  }
  expect(onRetry.mock.calls).toEqual([[], [], [5], [-10]]);
  await userEvent.click(screen.getByRole('button', { name: 'Pick another exercise' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete this take' }));
  expect(onPick).toHaveBeenCalledOnce();
  expect(onDelete).toHaveBeenCalledOnce();
  expect(screen.queryByRole('heading', { name: /Setup checklist/ })).toBeNull();
});

it('shows the setup checklist after three consecutive rejections', () => {
  render(<NextSteps bpm={80} rejections={3} onRetry={vi.fn()} onPick={vi.fn()} onDelete={vi.fn()} />);
  expect(screen.getByRole('heading', { name: /Setup checklist/ })).toBeDefined();
});
