import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { collectCoverage, test } from './fixtures';

async function openScales(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Fretboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scale & fretboard studio' })).toBeVisible();
}

test('scale catalog, fretboard, authentic pattern options and mobile accessibility', async ({ page }) => {
  await openScales(page);
  await expect(page.getByRole('combobox', { name: 'Scale', exact: true }).locator('option')).toHaveCount(55);
  await expect(page.getByRole('combobox', { name: 'Tuning', exact: true }).locator('option')).toHaveCount(12);
  await expect(page.getByRole('columnheader')).toHaveCount(26);
  for (const display of ['dots', 'intervals', 'notes']) await page.getByRole('combobox', { name: 'Labels', exact: true }).selectOption(display);
  await page.getByRole('combobox', { name: 'Pattern system', exact: true }).selectOption('caged');
  await expect(page.getByRole('combobox', { name: 'Position', exact: true }).locator('option')).toHaveCount(5);
  for (const form of ['C', 'A', 'G', 'E', 'D']) await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption(form);
  await page.getByRole('combobox', { name: 'Pattern system', exact: true }).selectOption('3nps');
  await expect(page.getByRole('combobox', { name: 'Position', exact: true }).locator('option')).toHaveCount(7);
  for (let i = 1; i <= 7; i++) await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption(`3nps-${i}`);
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption('minor-pentatonic');
  await expect(page.getByText(/Seven 3NPS patterns require/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Pattern system', exact: true }).selectOption('caged');
  for (const scale of ['minor-pentatonic', 'major-pentatonic', 'natural-minor']) {
    await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption(scale);
    await expect(page.getByRole('combobox', { name: 'Position', exact: true }).locator('option')).toHaveCount(5);
  }
  await expect(page.getByText(/These are the relative-major chord forms/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption('harmonic-minor');
  await expect(page.getByText(/CAGED chord-form fingerings support/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption('major');
  await page.getByRole('combobox', { name: 'Tuning', exact: true }).selectOption('DADGAD');
  await expect(page.getByText(/CAGED shapes support standard/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Tuning', exact: true }).selectOption('8string');
  await expect(page.getByRole('rowheader')).toHaveCount(8);
  await page.getByRole('combobox', { name: 'Tuning', exact: true }).selectOption('standard');
  const first = page.getByRole('button', { name: /^String 6, fret 0,/ });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: /^String 6, fret 1,/ })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: /^String 5, fret 24,/ })).toBeFocused();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('scale audio, accented meters, sound settings, related scales and preference restoration', async ({ page }) => {
  await openScales(page);
  await page.getByRole('spinbutton', { name: 'Tempo (BPM)', exact: true }).fill('240');
  await page.getByText('Sound settings', { exact: true }).click();
  for (const tone of ['sine', 'square', 'triangle']) await page.getByRole('combobox', { name: 'Tone', exact: true }).selectOption(tone);
  await page.getByRole('slider', { name: 'Volume', exact: true }).focus();
  await page.keyboard.press('Home');
  for (let step = 0; step < 8; step++) await page.keyboard.press('ArrowRight');
  for (const signature of ['3/4', '6/8', '5/4', '7/8', '4/4']) await page.getByRole('combobox', { name: 'Time signature', exact: true }).selectOption(signature);
  for (const direction of ['ascending', 'descending', 'both']) {
    await page.getByRole('combobox', { name: 'Direction', exact: true }).selectOption(direction);
    await page.getByRole('button', { name: 'Play scale', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Playing scale…' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop audio', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Play scale', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play scale', exact: true })).toBeEnabled({ timeout: 6000 });
  await page.getByRole('button', { name: 'Start metronome', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop metronome' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Stop metronome' }).click();
  await page.getByRole('button', { name: /shared tones/ }).first().click();
  await page.getByRole('combobox', { name: 'Root', exact: true }).selectOption('7');
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption('lydian');
  await page.getByRole('combobox', { name: 'Tuning', exact: true }).selectOption('DADGAD');
  await page.getByRole('combobox', { name: 'Labels', exact: true }).selectOption('intervals');
  await page.getByRole('combobox', { name: 'Pattern system', exact: true }).selectOption('3nps');
  await collectCoverage(page);
  await page.reload();
  await page.getByRole('button', { name: 'Fretboard', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Root', exact: true })).toHaveValue('7');
  await expect(page.getByRole('combobox', { name: 'Scale', exact: true })).toHaveValue('lydian');
  await expect(page.getByRole('combobox', { name: 'Tuning', exact: true })).toHaveValue('DADGAD');
  await expect(page.getByRole('spinbutton', { name: 'Tempo (BPM)', exact: true })).toHaveValue('240');
  await expect(page.getByRole('combobox', { name: 'Labels', exact: true })).toHaveValue('intervals');
  await expect(page.getByRole('combobox', { name: 'Pattern system', exact: true })).toHaveValue('3nps');
});

test('sequence completion, wrong notes, random/free modes and cancellation remain honest', async ({ page }) => {
  await openScales(page);
  await page.clock.install();
  await page.getByRole('combobox', { name: 'Run duration', exact: true }).selectOption('15');
  await page.getByRole('button', { name: 'Start practice', exact: true }).click();
  for (const fret of [8, 10, 12, 13, 15, 17, 19, 20]) {
    await page.getByRole('button', { name: new RegExp(`^String 6, fret ${fret},`) }).click();
  }
  await page.clock.fastForward(15000);
  await expect(page.getByText('Clean run complete — full target cycle, no wrong notes.')).toBeVisible();
  await page.getByRole('button', { name: 'Start practice', exact: true }).click();
  await page.getByRole('button', { name: /^String 6, fret 1,/ }).click();
  await page.clock.fastForward(15000);
  await expect(page.getByText(/Run complete — repeat/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Practice mode', exact: true }).selectOption('random');
  await page.getByRole('button', { name: 'Start practice', exact: true }).click();
  await page.getByRole('button', { name: /^String 6, fret 8,/ }).click();
  await page.getByRole('button', { name: 'Cancel practice', exact: true }).click();
  await expect(page.getByText('Practice cancelled. No attempt saved.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Practice mode', exact: true }).selectOption('free');
  await page.getByRole('button', { name: 'Start practice', exact: true }).click();
  await page.getByRole('button', { name: /^String 6, fret 1,/ }).click();
  await expect(page.getByText('1 notes explored')).toBeVisible();
  await page.clock.fastForward(15000);
  await expect(page.getByText('Free practice complete — ungraded.')).toBeVisible();
  await page.getByRole('button', { name: 'Start practice', exact: true }).click();
  await page.getByRole('combobox', { name: 'Root', exact: true }).selectOption('2');
  await expect(page.getByText(/Practice cancelled because settings changed/)).toBeVisible();
});

test('storage/audio/microphone failures are visible and do not claim capture', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('Storage blocked'); } });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
      value: async () => { throw new Error('Permission denied'); } });
  });
  await openScales(page);
  await expect(page.getByText('Scale settings could not be saved: Storage blocked')).toBeVisible();
  await page.getByRole('button', { name: 'Play scale', exact: true }).click();
  await expect(page.getByText(/Audio: Web Audio is unavailable/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Note input', exact: true }).selectOption('microphone');
  await page.getByRole('button', { name: 'Enable microphone', exact: true }).click();
  await expect(page.getByText(/Microphone: Live microphone input is unavailable/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start practice', exact: true })).toBeDisabled();
});

test('denied microphone permission is actionable and capture can be retried', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } });
  });
  await openScales(page);
  await page.getByRole('combobox', { name: 'Note input', exact: true }).selectOption('microphone');
  await page.getByRole('button', { name: 'Enable microphone', exact: true }).click();
  await expect(page.getByText(/Microphone: Permission denied/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable microphone', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Note input', exact: true }).selectOption('clicks');
  await expect(page.getByRole('button', { name: 'Start practice', exact: true })).toBeEnabled();
});

interface SyntheticMic {
  note: (midi: number) => void;
  close: () => Promise<void>;
  state: () => MediaStreamTrackState | undefined;
}

test('experimental live input follows real synthetic tones and releases capture after a clean run', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      (window as Window & { scaleSyntheticMic?: SyntheticMic }).scaleSyntheticMic = {
        note: midi => {
          oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), context.currentTime);
          gain.gain.setValueAtTime(0.2, context.currentTime);
        },
        close: async () => { oscillator.stop(); await context.close(); },
        state: () => destination.stream.getAudioTracks()[0]?.readyState,
      };
      return destination.stream;
    } });
  });
  await openScales(page);
  await page.getByRole('combobox', { name: 'Run duration', exact: true }).selectOption('15');
  await page.getByRole('combobox', { name: 'Note input', exact: true }).selectOption('microphone');
  await page.getByRole('button', { name: 'Enable microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop microphone', exact: true })).toBeVisible();
  await expect(page.getByText(/No signal — play one clear note/)).toBeVisible();
  await page.getByRole('button', { name: 'Start practice', exact: true }).click();
  const notes = [60, 62, 64, 65, 67, 69, 71, 72];
  for (const [index, midi] of notes.entries()) {
    await page.evaluate(note => {
      const input = (window as Window & { scaleSyntheticMic?: SyntheticMic }).scaleSyntheticMic;
      if (!input) throw new Error('Synthetic microphone not initialized');
      input.note(note);
    }, midi);
    await expect(page.getByText(new RegExp(`Target:.*${index + 1} correct · 0 wrong notes`))).toBeVisible();
  }
  await expect(page.getByText('Clean run complete — full target cycle, no wrong notes.')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Enable microphone', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { scaleSyntheticMic?: SyntheticMic }).scaleSyntheticMic?.state())).toBe('ended');
  await page.evaluate(async () => { await (window as Window & { scaleSyntheticMic?: SyntheticMic }).scaleSyntheticMic?.close(); });
});
