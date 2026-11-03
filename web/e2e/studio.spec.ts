import { expect } from '@playwright/test';
import { test } from './fixtures';
import type { Page, Response } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvelope } from '../src/api';
import type { Envelope } from '../src/api';

async function select(page: Page) {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Exercise', exact: true }).selectOption('chromatic_1234');
  await page.getByRole('button', { name: 'Continue to capture' }).click();
}
async function mode(page: Page, value: 'custom' | 'free') {
  await page.getByText('More options: custom riff or free play').click();
  await page.getByRole('combobox', { name: 'Practice mode' }).selectOption(value);
}
async function upload(page: Page, filename = 'findings.wav') {
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByLabel('Audio file').setInputFiles(resolve('e2e/.generated', filename));
}
function done(page: Page): Promise<Response> {
  return page.waitForResponse(async response => {
    if (!response.url().includes('/api/analyses/') || response.request().method() !== 'GET') return false;
    const data: unknown = await response.json();
    return typeof data === 'object' && data !== null && 'status' in data && data.status === 'done';
  });
}
async function envelope(response: Response): Promise<Envelope> {
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !('result' in data)) throw new Error('Missing result');
  return parseEnvelope(data.result);
}
async function submit(page: Page): Promise<Envelope> {
  const response = done(page);
  await page.getByRole('button', { name: 'Submit for analysis' }).click();
  const result = await envelope(await response);
  await expect(page.getByRole('heading', { name: 'Input quality' })).toBeVisible();
  return result;
}
function confident(envelope: Envelope) {
  return envelope.result.findings.filter(finding => finding.confidence >= 0.5 && !finding.experimental)
    .map(finding => [finding.type, finding.ref_indices]);
}
function expected() {
  return parseEnvelope({
    analysis_id: 'expected', take_id: 'expected', source: 'upload', request: {},
    track_settings: {}, lossy: false, result: JSON.parse(readFileSync(resolve('e2e/.generated/expected.json'), 'utf8')),
  });
}

test('accessibility baseline has no axe violations', async ({ page }) => {
  await select(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('rock studio stays accessible and fits desktop and mobile without page overflow', async ({ page }) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Play a riff. Get feedback.');
    await expect(page.getByRole('complementary', { name: 'Before you hit record' })).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await mode(page, 'custom');
    await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('link', { name: 'Skip to practice' }).focus();
  await expect(page.getByRole('link', { name: 'Skip to practice' })).toBeVisible();
});

test('demo take reaches results from the first screen without a guitar', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Exercise', exact: true }).selectOption('chromatic_1234');
  const response = done(page);
  await page.getByRole('button', { name: 'Try a demo take' }).click();
  const result = await envelope(await response);
  await expect(page.getByRole('heading', { name: 'Your next step' })).toBeVisible();
  expect(confident(result).map(([type]) => type)).toEqual(['timing_late']);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('upload findings match direct analyze and evidence seeks normalized audio', async ({ page }) => {
  await select(page);
  await upload(page);
  const result = await submit(page);
  expect(confident(result)).toEqual(confident(expected()));
  const finding = result.result.findings.find(finding => finding.type === 'timing_late');
  if (!finding) throw new Error('Missing timing finding');
  await page.getByText('Full analysis details').click();
  await page.locator('[data-finding-type="timing_late"]').click();
  await expect.poll(() => page.getByLabel('Evidence playback').evaluate(audio =>
    audio instanceof HTMLAudioElement ? audio.currentTime : -1)).toBeGreaterThanOrEqual(finding.evidence.play_from_s);
  expect(await page.getByLabel('Evidence playback').evaluate(audio =>
    audio instanceof HTMLAudioElement && !audio.paused)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('PCM browser recording has the same confident findings as the synthetic WAV', async ({ page }) => {
  await select(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('heading', { name: 'Listen before you submit' })).toBeVisible({ timeout: 25000 });
  const result = await submit(page);
  expect(result.source).toBe('recording');
  expect(result.lossy).toBe(false);
  expect(confident(result)).toEqual(confident(expected()));
});

test('Free mode has a warm-up click and an audible recording count-in', async ({ page }) => {
  await page.goto('/');
  await mode(page, 'free');
  await page.getByRole('button', { name: 'Continue to capture' }).click();
  await page.getByRole('button', { name: 'Start warm-up metronome' }).click();
  await expect(page.getByText('Warm-up metronome is running.')).toBeVisible();
  await page.getByRole('button', { name: 'Mute warm-up click' }).click();
  await expect(page.getByRole('button', { name: 'Unmute warm-up click' })).toBeVisible();
  const volume = page.getByRole('slider', { name: /click volume/i });
  await volume.press('ArrowDown');
  await expect(volume).toHaveValue('65');
  await page.getByRole('button', { name: 'Stop warm-up metronome' }).click();

  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByText('COUNT-IN')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('heading', { name: 'Listen before you submit' })).toBeVisible();
});

for (const [name, message] of [['NotAllowedError', 'Microphone permission was denied'],
  ['NotFoundError', 'No microphone is available']] as const) {
  test(`${name} offers upload and download-click paths`, async ({ page }) => {
    await page.addInitScript(name => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: () => Promise.reject(new DOMException('Test device failure', name)),
      });
    }, name);
    await select(page);
    await page.getByRole('button', { name: 'Enable microphone' }).click();
    await expect(page.getByText(message, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload instead' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download click WAV' })).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download click WAV' }).click();
    expect((await downloaded).suggestedFilename()).toBe('click.wav');
  });
}

test('invalid upload returns to capture with a specific reason', async ({ page }) => {
  await select(page);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByLabel('Audio file').setInputFiles({
    name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio'),
  });
  await page.getByRole('button', { name: 'Submit for analysis' }).click();
  await expect(page.getByText(/not a supported audio format/)).toBeVisible();
});

for (const filename of ['silent.wav', 'clipped.wav']) {
  test(`${filename} requests re-recording without musical findings`, async ({ page }) => {
    await select(page);
    await upload(page, filename);
    const result = await submit(page);
    expect(result.result.re_record.requested).toBe(true);
    expect(result.result.findings).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Please re-record' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Findings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record again' })).toBeVisible();
  });
}

test('cancel during recording uploads nothing', async ({ page }) => {
  let uploads = 0;
  page.on('request', request => { if (request.url().endsWith('/api/takes') && request.method() === 'POST') uploads++; });
  await select(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel recording' }).click();
  await expect(page.getByRole('button', { name: 'Enable microphone' })).toBeVisible();
  expect(uploads).toBe(0);
});

test('cancel analysis returns to capture and keeps the take', async ({ page, request }) => {
  await select(page);
  await upload(page);
  const analysis = page.waitForResponse(response =>
    response.url().endsWith('/analyses') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit for analysis' }).click();
  const response = await analysis;
  const takePath = response.url().replace(/\/analyses$/, '/audio');
  await page.getByRole('button', { name: 'Cancel analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Listen before you submit' })).toBeVisible();
  expect((await request.get(takePath)).status()).toBe(200);
});

test('AudioContext interruption produces a playable partial take warning', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    class CaptureContext extends Original {
      constructor() {
        super();
        Object.defineProperty(window, 'testContext', { value: this, configurable: true });
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: CaptureContext });
  });
  await select(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.evaluate(async () => {
    if ('testContext' in window && window.testContext instanceof AudioContext) {
      await window.testContext.suspend();
    }
  });
  await expect(page.getByText(/This partial take is playable/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit for analysis' })).toBeVisible();
});

test('custom riff preview and free-play capture remain distinct', async ({ page }) => {
  await page.goto('/');
  await mode(page, 'custom');
  await page.getByRole('textbox', { name: 'Notes' }).fill('E2:4 G2:4');
  await expect(page.getByText('#1: G2, bar 1 beat 2')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to capture' }).click();
  await expect(page.getByRole('heading', { name: '80 BPM / reference mode' })).toBeVisible();
  await page.getByRole('button', { name: 'Pick another exercise' }).click();
  await mode(page, 'free');
  await page.getByRole('button', { name: 'Continue to capture' }).click();
  await upload(page);
  const result = await submit(page);
  expect(result.result.mode).toBe('free');
  expect(result.result.priorities).toEqual([]);
  await expect(page.getByText('No reference: describes playing, does not judge correctness.')).toBeVisible();
});

test('three consecutive rejections show a setup checklist and preserve explicit tempo choices', async ({ page }) => {
  await select(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await upload(page, 'silent.wav');
    await submit(page);
    if (attempt < 2) await page.getByRole('button', { name: 'Record again' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Setup checklist: 3 consecutive rejected takes' })).toBeVisible();
  await page.getByRole('button', { name: '+5 BPM', exact: true }).click();
  await expect(page.getByRole('heading', { name: '85 BPM / reference mode' })).toBeVisible();
});

test('review discard and both deletion actions remove only saved app takes', async ({ page, request }) => {
  page.on('dialog', dialog => void dialog.accept());
  await select(page);
  await upload(page);
  await page.getByRole('button', { name: 'Discard / Re-record' }).click();
  await expect(page.getByLabel('Audio file')).toBeVisible();
  await upload(page);
  const first = await submit(page);
  await page.getByRole('button', { name: 'Delete this take' }).click();
  await expect(page.getByRole('button', { name: 'Continue to capture' })).toBeVisible();
  expect((await request.get(`/api/takes/${first.take_id}/audio`)).status()).toBe(404);
  await page.getByRole('button', { name: 'Continue to capture' }).click();
  await upload(page);
  const second = await submit(page);
  await page.getByRole('button', { name: 'Delete all saved takes' }).click();
  await expect(page.getByRole('button', { name: 'Continue to capture' })).toBeVisible();
  expect((await request.get(`/api/takes/${second.take_id}/audio`)).status()).toBe(404);
});

test('missing remembered device can be reset, selected, stopped, and retried explicitly', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('coreguitar.deviceId', 'missing-device'));
  await select(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByText(/No microphone is available/)).toBeVisible();
  await page.getByRole('button', { name: 'Use system default microphone' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
  const device = await page.getByRole('combobox', { name: 'Microphone' }).evaluate(select => {
    if (!(select instanceof HTMLSelectElement)) throw new Error('Missing device picker');
    return Array.from(select.options).find(option => option.value)?.value ?? '';
  });
  await page.getByRole('combobox', { name: 'Microphone' }).selectOption(device);
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('heading', { name: 'Listen before you submit' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard / Re-record' }).click();
  await expect(page.getByRole('button', { name: 'Enable microphone' })).toBeVisible();
});

test('invalid custom notes are explained and cannot be submitted until corrected', async ({ page }) => {
  await page.goto('/');
  await mode(page, 'custom');
  await page.getByRole('textbox', { name: 'Notes' }).fill('not-a-note');
  await expect(page.getByRole('button', { name: 'Continue to capture' })).toBeDisabled();
  await expect(page.getByText(/Invalid note/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Tuning' }).selectOption('drop_d');
  await page.getByRole('spinbutton', { name: 'Beats per bar' }).fill('3');
  await page.getByRole('combobox', { name: 'Beat unit' }).selectOption('8');
  await page.getByRole('combobox', { name: 'Default duration' }).selectOption('8t');
  await page.getByRole('spinbutton', { name: 'BPM' }).fill('90');
  await page.getByRole('textbox', { name: 'Notes' }).fill('6/0:4 5/0:4');
  await expect(page.getByText('#0: D2, bar 1 beat 1')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to capture' }).click();
  await expect(page.getByRole('heading', { name: '90 BPM / reference mode' })).toBeVisible();
});

test('generic microphone failures are surfaced rather than silently falling back', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    value: () => Promise.reject(new DOMException('Device is busy.', 'NotReadableError')),
  }));
  await select(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByText('Device is busy.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable microphone' })).toBeVisible();
});

test('reported audio processing on produces a setup warning', async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await getUserMedia(constraints);
      for (const track of stream.getAudioTracks()) {
        const original = track.getSettings.bind(track);
        track.getSettings = () => ({ ...original(), echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      }
      return stream;
    };
  });
  await select(page);
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(page.getByText(/processing is still on/)).toBeVisible();
});

test('failed analysis response is surfaced and retry reuses the retained take', async ({ page }) => {
  await select(page);
  await upload(page);
  let uploads = 0;
  page.on('request', request => { if (request.url().endsWith('/api/takes') && request.method() === 'POST') uploads++; });
  await page.route('**/api/analyses/*', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { status: 'failed', error: 'Deliberate analysis failure.' } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Submit for analysis' }).click();
  await expect(page.getByText('Deliberate analysis failure.')).toBeVisible();
  await page.unroute('**/api/analyses/*');
  const result = await submit(page);
  expect(result.result.quality.verdict).toBe('ok');
  expect(uploads).toBe(1);
  await page.getByRole('button', { name: '-10 BPM', exact: true }).click();
  await expect(page.getByRole('heading', { name: '70 BPM / reference mode' })).toBeVisible();
});
