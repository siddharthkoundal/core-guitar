import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectCoverage, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const STANDARD_OPEN: Record<string, number> = { '6': 40, '5': 45, '4': 50, '3': 55, '2': 59, '1': 64 };

async function openRoom(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Practice rooms' }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
}

test('tuner and note finder rooms stay accessible at desktop and mobile widths', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Tuner', 'Note finder']) {
      await openRoom(page, name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  }
});

test('tuner listens to the selected input, validates A4 and switches targets', async ({ page }) => {
  await page.goto('/');
  await openRoom(page, 'Tuner');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tune up. Then play.');
  const a4 = page.getByLabel('Reference A4 (Hz)');
  await a4.fill('460');
  await expect(a4).toHaveAttribute('aria-invalid', 'true');
  await a4.fill('442');
  await expect(a4).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('combobox', { name: /^Tuning/ }).selectOption('dropD');
  const targets = page.getByRole('group', { name: 'Tuning target' });
  await targets.getByRole('button', { name: 'String 6, D2' }).click();
  await expect(targets.getByRole('button', { name: 'String 6, D2' })).toHaveAttribute('aria-pressed', 'true');
  await targets.getByRole('button', { name: 'Auto string' }).click();
  await page.getByRole('button', { name: 'Start tuner' }).click();
  await expect(page.getByRole('button', { name: 'Stop tuner' })).toBeVisible();
  await expect(page.getByLabel('Audio input')).toBeDisabled();
  await expect(page.locator('.tuner-readout')).toContainText(' Hz · target ', { timeout: 10000 });
  await targets.getByRole('button', { name: 'Chromatic' }).click();
  await expect(page.locator('.tuner-readout')).toContainText(' Hz · target ', { timeout: 10000 });
  await targets.getByRole('button', { name: 'String 1, E4' }).click();
  await expect(page.locator('.tuner-readout')).toContainText('(string 1)', { timeout: 10000 });
  await page.getByRole('button', { name: 'Stop tuner' }).click();
  await expect(page.getByText('Tuner is off.')).toBeVisible();
  await collectCoverage(page);
  await page.reload();
  await openRoom(page, 'Tuner');
  await expect(page.getByLabel('Reference A4 (Hz)')).toHaveValue('442');
});

test('note finder plays click-the-fret rounds in every mode and keeps a resettable heatmap', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto('/');
  await openRoom(page, 'Note finder');
  await page.getByLabel('Answer with').selectOption('click');
  const board = page.getByRole('region', { name: 'Note finder fretboard' });
  const prompt = page.locator('.note-finder-prompt');
  const feedback = page.locator('.note-finder-feedback');

  await page.getByRole('button', { name: 'Start round' }).click();
  await board.getByRole('button', { name: 'String 1, fret 1', exact: true }).click();
  await expect(feedback).toContainText('not it. Try again.');
  await board.getByRole('button', { name: 'String 1, fret 1', exact: true }).focus();
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Shift']) await page.keyboard.press(key);
  await expect(board.getByRole('button', { name: 'String 1, fret 1', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(board.getByRole('button', { name: 'String 2, fret 1', exact: true })).toBeFocused();
  for (let index = 0; index < 10; index++) {
    await expect(page.getByText(`PROMPT ${index + 1} / 10`, { exact: false })).toBeVisible();
    const match = /^Play (\S+) on string (\d)$/.exec((await prompt.textContent()) ?? '');
    expect(match).not.toBeNull();
    const pitchClass = NAMES.indexOf(match?.[1] ?? '');
    const open = STANDARD_OPEN[match?.[2] ?? ''] ?? 0;
    const fret = (pitchClass - (open % 12) + 12) % 12;
    await board.getByRole('button', { name: `String ${match?.[2] ?? ''}, fret ${fret}`, exact: true }).click();
  }
  await expect(page.getByText('/ 10 first-try correct', { exact: false })).toBeVisible();
  const heatmap = page.getByRole('region', { name: 'Fretboard statistics' });
  await expect(heatmap.getByText('100%').first()).toBeVisible();

  await page.getByLabel('Game mode').selectOption('name');
  await page.getByRole('button', { name: 'Start round' }).click();
  const highlighted = board.getByRole('img', { name: /highlighted/ });
  const label = (await highlighted.getAttribute('aria-label')) ?? '';
  const [, string = '', fret = '0'] = /String (\d), fret (\d+)/.exec(label) ?? [];
  const note = NAMES[((STANDARD_OPEN[string] ?? 0) + Number(fret)) % 12] ?? 'C';
  await page.getByRole('group', { name: 'Note choices' }).getByRole('button', { name: note === 'C' ? 'D' : 'C', exact: true }).click();
  await expect(feedback).toContainText('not it. Try again.');
  await page.getByRole('group', { name: 'Note choices' }).getByRole('button', { name: note, exact: true }).click();
  await expect(feedback).toContainText('Correct');
  await page.getByRole('button', { name: 'Skip prompt' }).click();
  await expect(feedback).toContainText('Skipped');
  await page.getByRole('button', { name: 'End round' }).click();

  const strings = page.getByRole('group', { name: 'Strings' });
  for (const number of [1, 2, 3, 4, 5]) await strings.getByRole('checkbox', { name: new RegExp(`^String ${number} `) }).uncheck();
  await strings.getByRole('checkbox', { name: /^String 6 / }).click();
  await expect(strings.getByRole('checkbox', { name: /^String 6 / })).toBeChecked();
  for (const number of [1, 2, 3, 4, 5]) await strings.getByRole('checkbox', { name: new RegExp(`^String ${number} `) }).check();
  await page.getByLabel('Round length').selectOption('20');
  await page.getByLabel('Notes').selectOption('all');
  await page.getByLabel('Game mode').selectOption('octaves');
  await page.getByLabel('From fret').fill('3');
  await page.getByLabel('From fret').fill('0');
  await page.getByLabel('To fret').fill('5');
  await page.getByRole('button', { name: 'Start round' }).click();
  const octave = /^Play every (\S+) /.exec((await prompt.textContent()) ?? '');
  const pitchClass = NAMES.indexOf(octave?.[1] ?? '');
  for (const [number, open] of Object.entries(STANDARD_OPEN)) {
    const target = (pitchClass - (open % 12) + 12) % 12;
    if (target > 5) continue;
    if (!(await page.getByText('PROMPT 1 / 20', { exact: false }).isVisible())) break;
    await board.getByRole('button', { name: new RegExp(`^String ${number}, fret ${target}(,|$)`) }).click();
  }
  await expect(page.getByText('PROMPT 2 / 20', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Skip prompt' }).click();
  await expect(feedback).toContainText('still missing');
  await page.getByRole('button', { name: 'End round' }).click();

  await page.getByRole('button', { name: 'Reset stats' }).click();
  await page.getByRole('button', { name: 'Keep stats' }).click();
  await page.getByRole('button', { name: 'Reset stats' }).click();
  await page.getByRole('button', { name: 'Confirm reset stats' }).click();
  await expect(heatmap.getByText(/^\d+%$/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset stats' })).toBeDisabled();
  await collectCoverage(page);
  await page.reload();
  await openRoom(page, 'Note finder');
  await expect(page.getByLabel('Game mode')).toHaveValue('octaves');
  await expect(page.getByLabel('Round length')).toHaveValue('20');
});

test('note finder recovers from corrupt storage and offers live answers with a device picker', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('coreguitar.fretgame.v1', '{"version":1,"stats":{"bad":{"attempts":-1}}}');
    }
  });
  await page.goto('/');
  await openRoom(page, 'Note finder');
  await expect(page.getByRole('alert').filter({ hasText: 'could not be restored' })).toBeVisible();
  await page.getByLabel('Time per prompt').selectOption('5');
  await page.getByLabel('Game mode').selectOption('name');
  await page.getByLabel('Answer with').selectOption('live');
  await expect(page.getByLabel('Audio input')).toBeVisible();
  await page.getByRole('button', { name: 'Start round' }).click();
  await expect(page.getByText(/Hearing:/)).toBeVisible();
  await expect(page.getByText('PROMPT 2 / 10', { exact: false })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'End round' }).click();
  await collectCoverage(page);
});

test('both rooms explain a denied audio input and keep the click fallback usable', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await page.goto('/');
  await openRoom(page, 'Tuner');
  await page.getByRole('button', { name: 'Start tuner' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Permission denied' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start tuner' })).toBeEnabled();
  await openRoom(page, 'Note finder');
  await page.getByLabel('Answer with').selectOption('live');
  await page.getByRole('button', { name: 'Start round' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Use fretboard clicks instead.' })).toBeVisible();
  await page.getByRole('button', { name: 'Restart input' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Use fretboard clicks instead.' })).toBeVisible();
  await page.getByRole('button', { name: 'End round' }).click();
  await page.getByLabel('Answer with').selectOption('click');
  await page.getByRole('button', { name: 'Start round' }).click();
  await expect(page.getByRole('region', { name: 'Note finder fretboard' }).getByRole('button').first()).toBeVisible();
});
