import { expect, it } from 'vitest';
import { emptyProgress, recordAttempt, recordQuiz, parseProgress, practiceStreak } from './progress';

const attempt = { scaleId: 'major', root: 0, bpm: 120, clean: true, durationSeconds: 30 };

it('requires three consecutive clean runs at 120 BPM and keeps mastery after a miss', () => {
  const first = recordAttempt(emptyProgress(), attempt, '2026-10-30');
  const second = recordAttempt(first, attempt, '2026-10-31');
  expect(second.mastery[0]?.learned).toBe(false);
  const third = recordAttempt(second, attempt, '2026-11-01');
  expect(third.mastery[0]).toMatchObject({ learned: true, consecutive: 3 });
  const missed = recordAttempt(third, { ...attempt, clean: false }, '2026-11-01');
  expect(missed.mastery[0]).toMatchObject({ learned: true, consecutive: 0 });
  expect(practiceStreak(third, '2026-11-02')).toBe(3);
  expect(practiceStreak(third, '2026-11-04')).toBe(0);
  expect(recordAttempt(third, attempt, '2026-11-05').bestStreak).toBe(3);
});

it('does not count slower runs or another root toward a mastery streak', () => {
  let progress = recordAttempt(emptyProgress(), attempt, '2026-11-01');
  progress = recordAttempt(progress, { ...attempt, bpm: 119 }, '2026-11-01');
  progress = recordAttempt(progress, { ...attempt, root: 2 }, '2026-11-01');
  expect(progress.mastery.map(item => item.consecutive)).toEqual([0, 1]);
});

it('caps session history but retains earned mastery and XP', () => {
  let progress = emptyProgress();
  for (let index = 0; index < 105; index++) progress = recordAttempt(progress, attempt, '2026-11-01');
  expect(progress.sessions).toHaveLength(100);
  expect(progress.mastery[0]?.learned).toBe(true);
  expect(progress.mastery[0]?.attempts).toBe(105);
  expect(progress.xp).toBe(1050);
  const quiz = recordQuiz(progress, 'intervals', 8, '2026-11-02');
  expect(quiz.xp).toBe(1090);
  expect(quiz.sessions[0]).toMatchObject({ kind: 'quiz', correct: 8 });
  expect(parseProgress(JSON.stringify(quiz))).toEqual(quiz);
  let perfect = recordQuiz(emptyProgress(), 'notes', 10);
  for (let index = 0; index < 101; index++) perfect = recordQuiz(perfect, 'notes', 0);
  expect(perfect.perfectQuiz).toBe(true);
});

it('rejects corrupt, unversioned and unbounded stored progress instead of trusting it', () => {
  for (const data of ['bad', '{}', '{"version":99}', JSON.stringify({ ...emptyProgress(), xp: -1 }),
    JSON.stringify({ ...emptyProgress(), mastery: [{ scaleId: 'x', root: 99 }] })]) {
    expect(() => parseProgress(data)).toThrow(/progress/i);
  }
  expect(() => recordQuiz(emptyProgress(), 'notes', 11)).toThrow();
  expect(() => recordAttempt(emptyProgress(), { ...attempt, bpm: NaN })).toThrow();
});

it('keeps streak counters beyond the bounded calendar history', () => {
  let progress = emptyProgress();
  for (let index = 0; index < 400; index++) {
    const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
    progress = recordAttempt(progress, attempt, date);
  }
  expect(progress.days).toHaveLength(366);
  expect(progress.bestStreak).toBe(400);
  expect(practiceStreak(progress, progress.lastPracticeDate ?? '')).toBe(400);
  expect(practiceStreak(progress, '2027-01-01')).toBe(0);
});

it('migrates earlier v1 saves without discarding earned progress', () => {
  let progress = recordQuiz(emptyProgress(), 'notes', 10, '2026-10-30');
  progress = recordAttempt(progress, attempt, '2026-10-31');
  progress = recordAttempt(progress, attempt, '2026-11-01');
  const { currentStreak, lastPracticeDate, ...legacy } = progress;
  expect(currentStreak).toBe(3);
  expect(lastPracticeDate).toBe('2026-11-01');
  expect(parseProgress(JSON.stringify(legacy))).toEqual(progress);
});
