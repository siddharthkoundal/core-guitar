import { expect } from '@playwright/test';
import { test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { resolve } from 'node:path';

test('a Guitar Pro file becomes a custom riff that can be practised', async ({ page }) => {
  await page.goto('/');
  await page.getByText('More options: custom riff or free play').click();
  await page.getByRole('combobox', { name: 'Practice mode' }).selectOption('custom');
  await page.getByLabel('Guitar Pro file').setInputFiles(resolve('e2e/.generated', 'riff.gp5'));
  await expect(page.getByLabel('Converted notes')).toHaveText('5/0:4 5/2:4 5/3:4 5/5:4 | 4/5:4 5/3:4 5/2:4 5/0:4');
  await expect(page.getByRole('list', { name: 'Import warnings' })).toContainText('highest note');
  await page.getByLabel('To bar').fill('1');
  await page.getByLabel('Tempo %').fill('50');
  await page.getByRole('button', { name: 'Convert again' }).click();
  await expect(page.getByLabel('Converted notes')).toHaveText('5/0:4 5/2:4 5/3:4 5/5:4');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Use as custom riff' }).click();
  await expect(page.getByRole('textbox', { name: 'Notes' })).toHaveValue('5/0:4 5/2:4 5/3:4 5/5:4');
  await expect(page.getByRole('spinbutton', { name: 'BPM' })).toHaveValue('45');
  await expect(page.getByText('4 beats')).toBeVisible();

  await page.getByLabel('Guitar Pro file').setInputFiles({ name: 'bad.gp5', mimeType: 'application/octet-stream',
    buffer: Buffer.from('not guitar pro') });
  await expect(page.getByRole('alert').filter({ hasText: /Guitar Pro/ })).toBeVisible();
});

test('processor input records without an audible click and shows the tone check', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Exercise', exact: true }).selectOption('chromatic_1234');
  await page.getByRole('button', { name: 'Continue to capture' }).click();
  await page.getByRole('radio', { name: 'Processor (USB)' }).check();
  await expect(page.getByText(/Headphones are fine/)).toBeVisible();
  await page.getByLabel(/Latency correction/).fill('10');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('heading', { name: 'Listen before you submit' })).toBeVisible({ timeout: 25000 });
  const request = page.waitForRequest(req => req.url().includes('/analyses') && req.method() === 'POST');
  await page.getByRole('button', { name: 'Submit for analysis' }).click();
  const body: unknown = (await request).postDataJSON();
  expect(body).toMatchObject({ input_profile: 'direct', click_offset_s: expect.any(Number) });
  const tone = page.getByRole('region', { name: /Tone check/ });
  await expect(tone).toBeVisible({ timeout: 30000 });
  await expect(tone).toContainText('Processor (USB) input');
});
