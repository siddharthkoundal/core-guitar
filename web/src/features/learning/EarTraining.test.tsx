import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '../../test-utils';
import { EarTraining, makeQuestion } from './EarTraining';
import { quizModes } from './progress';
import { playNotes, stopNotes } from '../scales/sound';

vi.mock('../scales/sound', () => ({ playNotes: vi.fn().mockResolvedValue(undefined), stopNotes: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('provides four distinct answers with exactly one correct answer in every quiz mode', () => {
  for (const mode of quizModes) {
    for (let index = 0; index < 10; index++) {
      const question = makeQuestion(mode, () => index / 10);
      expect(new Set(question.options).size).toBe(4);
      expect(question.options.filter(option => option === question.answer)).toHaveLength(1);
      expect(question.notes.length).toBeGreaterThan(0);
    }
  }
});

it('plays a question, records exactly ten answers and persists only a finished quiz', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const complete = vi.fn();
  const { userEvent } = render(<EarTraining onComplete={complete} />);
  await userEvent.click(screen.getByRole('button', { name: 'Start 10-question quiz' }));
  for (let index = 0; index < 10; index++) {
    await userEvent.click(screen.getByRole('button', { name: 'Play question' }));
    await userEvent.click(screen.getByRole('button', { name: 'Minor second' }));
    expect(screen.getByText('Correct. Minor second.')).toBeDefined();
    expect(complete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: index === 9 ? 'Finish quiz' : 'Next question' }));
  }
  expect(playNotes).toHaveBeenCalledTimes(10);
  expect(complete).toHaveBeenCalledExactlyOnceWith('intervals', 10);
  expect(screen.getByText('10 / 10 correct')).toBeDefined();
});

it('shows playback errors and allows cancelling without awarding progress', async () => {
  vi.mocked(playNotes).mockRejectedValueOnce(new Error('Audio unavailable'));
  const complete = vi.fn();
  const { userEvent, unmount } = render(<EarTraining onComplete={complete} />);
  await userEvent.click(screen.getByRole('button', { name: 'Start 10-question quiz' }));
  await userEvent.click(screen.getByRole('button', { name: 'Play question' }));
  expect(await screen.findByText('Audio unavailable')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel quiz' }));
  expect(complete).not.toHaveBeenCalled();
  unmount();
  expect(stopNotes).toHaveBeenCalled();
});
