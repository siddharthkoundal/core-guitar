import { expect } from '@playwright/test';
import { collectCoverage, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

test('learning rooms retain accessible local studio design at desktop and mobile widths', async ({ page }) => {
  test.setTimeout(120000);
  await page.route('**/api/coach/status', route => route.fulfill({ json: { available: false, models: [] } }));
  await page.goto('/');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Fretboard', 'Ear training', 'ChordAI', 'Coach', 'Library', 'Progress', 'Takes & feedback']) {
      await page.getByRole('navigation', { name: 'Practice rooms' }).getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  }
});

test('library search and root open the fretboard and handle empty results', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByLabel('Find a scale').fill('no such scale');
  await expect(page.getByText('No scales match.', { exact: false })).toBeVisible();
  await page.getByLabel('Find a scale').fill('pentatonic');
  await page.getByLabel('Library root').selectOption('2');
  await page.getByRole('button', { name: /Open .*Pentatonic.* on fretboard/i }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Learn the neck. Find your sound.');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByLabel('Scale category').selectOption({ index: 1 });
  await expect(page.getByRole('status')).toContainText('scales shown');
});

test('all four ear-training modes finish quizzes, persist progress and reset only after confirmation', async ({ page }) => {
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ear training', exact: true }).click();
  await page.getByRole('button', { name: 'Start 10-question quiz' }).click();
  await page.getByRole('button', { name: 'Play question', exact: true }).click();
  await page.getByRole('button', { name: 'Stop audio', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel quiz', exact: true }).click();
  for (const mode of ['intervals', 'notes', 'scales', 'sequence']) {
    await page.getByLabel('Ear-training mode').selectOption(mode);
    await page.getByRole('button', { name: 'Start 10-question quiz' }).click();
    if (mode === 'notes') {
      await page.getByRole('button', { name: 'Replay reference C' }).click();
      await page.getByRole('button', { name: 'Stop audio', exact: true }).click();
    }
    for (let index = 0; index < 10; index++) {
      const choices = page.getByRole('group', { name: 'Answer choices' });
      await (mode === 'intervals' ? choices.getByRole('button', { name: 'Minor second', exact: true })
        : choices.getByRole('button').first()).click();
      await page.getByRole('button', { name: index === 9 ? 'Finish quiz' : 'Next question', exact: true }).click();
    }
    await expect(page.getByText('/ 10 correct', { exact: false })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.getByText('First steps', { exact: true })).toBeVisible();
  await expect(page.getByText('Open ears', { exact: true })).toBeVisible();
  await collectCoverage(page);
  await page.reload();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.getByText('0 XP', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Reset learning progress' }).click();
  await page.getByRole('button', { name: 'Keep progress' }).click();
  await expect(page.getByText('0 XP', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Reset learning progress' }).click();
  await page.getByRole('button', { name: 'Confirm reset progress' }).click();
  await expect(page.getByText('0 XP', { exact: true })).toBeVisible();
});

test('corrupt learning storage is reported and reset explicitly', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('coreguitar.learning.v1', '{'));
  await collectCoverage(page);
  await page.reload();
  await expect(page.getByText('Saved progress is not valid JSON.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await page.getByRole('button', { name: 'Reset learning progress' }).click();
  await page.getByRole('button', { name: 'Confirm reset progress' }).click();
  await expect(page.getByText('Saved progress is not valid JSON.', { exact: false })).not.toBeVisible();
});

test('earlier saved progress migrates with mastery, streaks and practice-again links intact', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const today = new Date();
    const day = (offset: number): string => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    localStorage.setItem('coreguitar.learning.v1', JSON.stringify({
      version: 1, xp: 130, bestStreak: 3, perfectQuiz: false,
      mastery: [
        { scaleId: 'major', root: 0, attempts: 3, consecutive: 3, learned: true },
        { scaleId: 'natural-minor', root: 2, attempts: 2, consecutive: 1, learned: false },
      ],
      sessions: [
        { kind: 'scale', scaleId: 'major', root: 0, bpm: 120, clean: true, durationSeconds: 30, date: day(0) },
        { kind: 'scale', scaleId: 'natural-minor', root: 2, bpm: 100, clean: false, durationSeconds: 30, date: day(1) },
      ],
      days: [day(2), day(1), day(0)],
    }));
  });
  await collectCoverage(page);
  await page.reload();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(page.getByText('130 XP', { exact: true })).toBeVisible();
  await expect(page.getByText('3 days', { exact: true })).toBeVisible();
  await expect(page.getByText('1 learned', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Practice .* again/ }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Learn the neck. Find your sound.');
});

test('simultaneous quiz saves in two tabs retain both sessions and XP', async ({ page, context }) => {
  await context.addInitScript(() => { Math.random = () => 0; });
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await tab.goto('/');
    await tab.getByRole('button', { name: 'Ear training', exact: true }).click();
    await tab.getByRole('button', { name: 'Start 10-question quiz' }).click();
    for (let index = 0; index < 10; index++) {
      await tab.getByRole('group', { name: 'Answer choices' }).getByRole('button', { name: 'Minor second', exact: true }).click();
      if (index < 9) await tab.getByRole('button', { name: 'Next question', exact: true }).click();
    }
  }
  await Promise.all([page, second].map(tab => tab.getByRole('button', { name: 'Finish quiz', exact: true }).click()));
  for (const tab of [page, second]) {
    await tab.getByRole('button', { name: 'Progress', exact: true }).click();
    await expect(tab.getByText('100 XP', { exact: true })).toBeVisible();
  }
  await collectCoverage(second);
  await second.close();
});
