import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { collectCoverage, test } from './fixtures';

type AudioMode = 'chord' | 'silence' | 'noise' | 'error' | 'denied' | 'pending' | 'missing' | 'suspended';
interface ChordAudioHarness {
  mode: AudioMode;
  pitches: number[];
  requests: number;
  stops: number;
  closes: number;
  disconnects: number;
  grant: () => void;
  end: () => void;
}

declare global {
  interface Window { __chordAudio: ChordAudioHarness }
}

async function openChords(page: Page): Promise<void> {
  await collectCoverage(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Practice rooms' })
    .getByRole('button', { name: 'ChordAI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chords & ChordAI', exact: true })).toBeVisible();
}

/** Boundary fake: the production FFT/chroma/window/template pipeline still runs in the browser. */
async function installAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const track = new EventTarget();
    const state: ChordAudioHarness = {
      mode: 'chord', pitches: [48, 52, 55], requests: 0, stops: 0, closes: 0, disconnects: 0,
      grant: () => { throw new Error('No microphone permission request is pending'); },
      end: () => { track.dispatchEvent(new Event('ended')); },
    };
    window.__chordAudio = state;
    const audioTrack = Object.assign(track, { stop: () => { state.stops++; } });
    const stream = {
      getTracks: () => [audioTrack],
      getAudioTracks: () => state.mode === 'missing' ? [] : [audioTrack],
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        state.requests++;
        if (state.mode === 'denied') throw new DOMException('Denied by test', 'NotAllowedError');
        if (state.mode === 'pending') return new Promise(resolve => { state.grant = () => resolve(stream); });
        return stream;
      },
    } });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {
      sampleRate = 48000;
      state = state.mode === 'suspended' ? 'suspended' : 'running';
      async resume() { return; }
      async close() { this.state = 'closed'; state.closes++; }
      createMediaStreamSource() {
        return { connect: () => { return; }, disconnect: () => { state.disconnects++; } };
      }
      createAnalyser() {
        return {
          fftSize: 32768, frequencyBinCount: 16384, smoothingTimeConstant: 0,
          disconnect: () => { state.disconnects++; },
          getFloatFrequencyData: (bins: Float32Array) => {
            if (state.mode === 'error') throw new Error('FFT input unavailable');
            bins.fill(state.mode === 'noise' ? -30 : -Infinity);
            if (state.mode !== 'chord') return;
            for (const pitch of state.pitches) {
              const frequency = 440 * 2 ** ((pitch - 69) / 12);
              bins[Math.round(frequency * 32768 / 48000)] = -24;
            }
          },
        };
      }
    } });
  });
}

async function startListening(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start chord microphone', exact: true }).click();
  await expect(page.getByText('Listening — averaging 2.5 seconds of audio…')).toBeVisible();
}

test('chord studio manual fallback is accessible and history persists without microphone permission', async ({ page }) => {
  await installAudio(page);
  await openChords(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => window.__chordAudio.requests)).toBe(0);
  await page.getByRole('combobox', { name: 'Root', exact: true }).selectOption('9');
  await page.getByRole('combobox', { name: 'Quality', exact: true }).selectOption('min7');
  await page.getByRole('button', { name: 'Add manual chord' }).click();
  await expect(page.getByText('Am7 — manual selection; similarity not measured.')).toBeVisible();
  const history = page.getByRole('region', { name: 'Chord history' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => window.__chordAudio.requests)).toBe(0);
  await openChords(page);
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history.getByRole('listitem')).toContainText('Am7');
  await page.getByRole('button', { name: 'Clear chord history' }).click();
  await expect(history.getByText('No chords saved yet.')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('coreguitar.chords.v1') ?? '[]'))).toEqual([]);
});

test('live microphone averages frames, rejects silence/noise/aliases and cleans up on stop and room exit', async ({ page }) => {
  await installAudio(page);
  await page.clock.install();
  await openChords(page);
  await startListening(page);
  const live = page.getByRole('status').filter({ hasText: /averaging|Cosine similarity|No signal|Ambiguous chord/ });
  await page.clock.runFor(2700);
  await expect(live).toContainText('Cosine similarity 1.000 (not accuracy)');
  await expect(page.getByRole('region', { name: 'Chord history' }).getByRole('listitem')).toHaveCount(1);
  await page.clock.runFor(2700);
  await expect(page.getByRole('region', { name: 'Chord history' }).getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => { window.__chordAudio.mode = 'silence'; });
  await page.clock.runFor(5400);
  await expect(live).toContainText('No signal:');
  await page.evaluate(() => { window.__chordAudio.mode = 'noise'; });
  await page.clock.runFor(5400);
  await expect(live).toContainText('No signal:');
  await page.evaluate(() => { window.__chordAudio.mode = 'chord'; window.__chordAudio.pitches = [48, 52, 56]; });
  await page.clock.runFor(5400);
  await expect(live).toContainText('Ambiguous chord:');
  await page.evaluate(() => { window.__chordAudio.pitches = [48, 50, 55]; });
  await page.clock.runFor(5400);
  await expect(live).toContainText('Ambiguous chord:');
  await page.evaluate(() => { window.__chordAudio.pitches = [48]; });
  await page.clock.runFor(5400);
  await expect(live).toContainText('Ambiguous chord:');
  await page.getByRole('button', { name: 'Stop chord microphone' }).click();
  await expect(page.getByText('Microphone off. Select a chord manually or start listening.')).toBeVisible();
  expect(await page.evaluate(() => ({
    stops: window.__chordAudio.stops, closes: window.__chordAudio.closes, disconnects: window.__chordAudio.disconnects,
  }))).toEqual({ stops: 1, closes: 1, disconnects: 2 });
  await startListening(page);
  await page.getByRole('navigation', { name: 'Practice rooms' }).getByRole('button', { name: 'Library', exact: true }).click();
  expect(await page.evaluate(() => ({ stops: window.__chordAudio.stops, closes: window.__chordAudio.closes })))
    .toEqual({ stops: 2, closes: 2 });
});

test('live recognition supports every root for major/minor/sevenths/diminished without fabricated accuracy', async ({ page }) => {
  test.setTimeout(120000);
  await installAudio(page);
  await page.clock.install();
  await openChords(page);
  const voicings = [
    { intervals: [0, 4, 7], quality: 'major' }, { intervals: [0, 3, 7], quality: 'minor' },
    { intervals: [0, 4, 7, 10], quality: 'dom7' }, { intervals: [0, 4, 7, 11], quality: 'maj7' },
    { intervals: [0, 3, 7, 10], quality: 'min7' }, { intervals: [0, 3, 6], quality: 'dim' },
  ];
  for (const voicing of voicings) {
    for (let root = 0; root < 12; root++) {
      await page.evaluate(pitches => { window.__chordAudio.pitches = pitches; },
        voicing.intervals.map(interval => 48 + root + interval));
      await startListening(page);
      await page.clock.runFor(2700);
      await expect(page.getByText('Cosine similarity 1.000 (not accuracy)', { exact: false })).toBeVisible();
      const saved: unknown = await page.evaluate(() => {
        const history: unknown = JSON.parse(localStorage.getItem('coreguitar.chords.v1') ?? '[]');
        return Array.isArray(history) ? history.at(-1) : null;
      });
      expect(saved).toMatchObject({ root, quality: voicing.quality, similarity: expect.any(Number) });
      if (typeof saved !== 'object' || saved === null || !('similarity' in saved)
        || typeof saved.similarity !== 'number') throw new Error('Missing detected chord similarity');
      expect(saved.similarity).toBeCloseTo(1);
      await page.getByRole('button', { name: 'Stop chord microphone' }).click();
    }
  }
});

test('microphone denied, device errors, pending cancellation and late permission grants are explicit and safe', async ({ page }) => {
  await installAudio(page);
  await page.clock.install();
  await openChords(page);
  await page.evaluate(() => { window.__chordAudio.mode = 'denied'; });
  await page.getByRole('button', { name: 'Start chord microphone' }).click();
  await expect(page.getByText('Microphone permission denied. Allow access or select a chord manually.')).toBeVisible();
  await page.evaluate(() => { window.__chordAudio.mode = 'pending'; });
  await page.getByRole('button', { name: 'Start chord microphone' }).click();
  await expect(page.getByText('Waiting for microphone permission. You can cancel this request.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel microphone request' }).click();
  await page.evaluate(() => window.__chordAudio.grant());
  await expect.poll(() => page.evaluate(() => window.__chordAudio.stops)).toBe(1);
  await expect(page.getByText('Microphone off. Select a chord manually or start listening.')).toBeVisible();
  await page.evaluate(() => { window.__chordAudio.mode = 'chord'; });
  await startListening(page);
  await page.evaluate(() => window.__chordAudio.end());
  await expect(page.getByText('Microphone disconnected. Reconnect it and try again.')).toBeVisible();
  await page.evaluate(() => { window.__chordAudio.mode = 'missing'; });
  await page.getByRole('button', { name: 'Start chord microphone' }).click();
  await expect(page.getByText('No microphone audio track was provided.')).toBeVisible();
  await page.evaluate(() => { window.__chordAudio.mode = 'suspended'; });
  await page.getByRole('button', { name: 'Start chord microphone' }).click();
  await expect(page.getByText('Audio is suspended. Stop and enable the microphone again.')).toBeVisible();
  await page.evaluate(() => { window.__chordAudio.mode = 'chord'; });
  await startListening(page);
  await page.evaluate(() => { window.__chordAudio.mode = 'error'; });
  await page.clock.runFor(100);
  await expect(page.getByText('FFT input unavailable')).toBeVisible();
});

test('cancelled pending permission is also cleaned up when leaving the chord room', async ({ page }) => {
  await installAudio(page);
  await openChords(page);
  await page.evaluate(() => { window.__chordAudio.mode = 'pending'; });
  await page.getByRole('button', { name: 'Start chord microphone' }).click();
  await expect(page.getByRole('button', { name: 'Cancel microphone request' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Practice rooms' }).getByRole('button', { name: 'Library', exact: true }).click();
  await page.evaluate(() => window.__chordAudio.grant());
  await expect.poll(() => page.evaluate(() => window.__chordAudio.stops)).toBe(1);
  expect(await page.evaluate(() => window.__chordAudio.closes)).toBe(1);
});

test('progression assistant uses local chord context, validated suggestions and bounded follow-up chat', async ({ page }) => {
  const requests: unknown[] = [];
  await page.route('**/api/coach', async route => {
    const request: unknown = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({ json: { model: 'local-guitar',
      text: '<img src=x onerror=alert(1)>\nTry this turnaround.\n```json\n{"chords":[{"root":0,"quality":"major"},{"root":7,"quality":"dom7"}]}\n```' } });
  });
  await openChords(page);
  await page.getByRole('combobox', { name: 'Root', exact: true }).selectOption('9');
  await page.getByRole('combobox', { name: 'Quality', exact: true }).selectOption('minor');
  await page.getByRole('button', { name: 'Add manual chord' }).click();
  await page.getByRole('combobox', { name: 'Genre', exact: true }).selectOption('Jazz');
  await page.getByRole('combobox', { name: 'Playing level', exact: true }).selectOption('intermediate');
  await page.getByLabel('Progression prompt').fill('A gentle turnaround');
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await expect(page.getByText('Local model: local-guitar')).toBeVisible();
  expect(requests[0]).toMatchObject({
    kind: 'progression', prompt: expect.stringContaining('Genre: Jazz. A gentle turnaround'),
    level: 'intermediate', context: expect.stringContaining('Recent chords: Am'),
  });
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Use G7 suggestion 2' }).click();
  await expect(page.getByText('G7 — manual selection; similarity not measured.')).toBeVisible();
  await page.getByLabel('Follow-up question').fill('Make the rhythm simpler');
  await page.getByRole('button', { name: 'Send follow-up' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    prompt: expect.stringContaining('Make the rhythm simpler'),
    context: expect.stringContaining('Recent chords: Am, G7'),
    messages: [
      { role: 'user', content: expect.stringContaining('A gentle turnaround') },
      { role: 'assistant', content: expect.stringContaining('Try this turnaround.') },
    ],
  });
  await expect(page.getByLabel('Follow-up question')).toHaveValue('');
  for (let index = 0; index < 6; index++) {
    await page.getByLabel('Follow-up question').fill(`Another variation ${index}`);
    await page.getByRole('button', { name: 'Send follow-up' }).click();
    await expect(page.getByLabel('Follow-up question')).toHaveValue('');
  }
  const last = requests.at(-1);
  if (typeof last !== 'object' || last === null || !('messages' in last)
    || !Array.isArray(last.messages)) throw new Error('Missing follow-up conversation');
  expect(last.messages).toHaveLength(12);
});

test('progression errors, invalid model JSON and unsupported chord shapes are recoverable', async ({ page }) => {
  let response = 0;
  await page.route('**/api/coach', async route => {
    response++;
    if (response === 1) {
      await route.fulfill({ status: 503, json: {
        code: 'ollama_unavailable', message: 'Local Ollama is unavailable.', advice: 'Start Ollama and try again.',
      } });
    } else if (response === 2) {
      await route.fulfill({ contentType: 'application/json', body: '{invalid' });
    } else if (response === 3) {
      await route.fulfill({ json: { model: 'local', text: '```json\n{"chords":[{"root":12,"quality":"major"}]}\n```' } });
    } else {
      await route.fulfill({ json: { model: 'local', text: 'Try a simple C chord.' } });
    }
  });
  await openChords(page);
  await page.getByLabel('Progression prompt').fill('');
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await expect(page.getByText('Enter a progression prompt or a follow-up question.')).toBeVisible();
  expect(response).toBe(0);
  await page.getByLabel('Progression prompt').fill('A simple progression');
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await expect(page.getByText('Local Ollama is unavailable. Start Ollama and try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await expect(page.getByText('The local coach returned invalid JSON.')).toBeVisible();
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await expect(page.getByText('Local model: local')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Use .* suggestion/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await expect(page.getByText('Try a simple C chord.')).toBeVisible();
});

test('progression requests can be cancelled and are aborted when changing practice rooms', async ({ page }) => {
  await page.route('**/api/coach', () => { /* Deliberately pending until the browser aborts it. */ });
  await openChords(page);
  const firstRequest = page.waitForRequest(request => request.url().endsWith('/api/coach'));
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await firstRequest;
  await expect(page.getByText('Waiting for your local Ollama…')).toBeVisible();
  const cancelled = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/coach'));
  await page.getByRole('button', { name: 'Cancel ChordAI' }).click();
  await cancelled;
  await expect(page.getByText('ChordAI request cancelled.')).toBeVisible();
  const requested = page.waitForEvent('request', request => request.url().endsWith('/api/coach'));
  await page.getByRole('button', { name: 'Ask ChordAI' }).click();
  await requested;
  const unmounted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/coach'));
  await page.getByRole('navigation', { name: 'Practice rooms' }).getByRole('button', { name: 'Library', exact: true }).click();
  await unmounted;
  await page.getByRole('navigation', { name: 'Practice rooms' }).getByRole('button', { name: 'ChordAI', exact: true }).click();
  await expect(page.getByText('Waiting for your local Ollama…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask ChordAI' })).toBeEnabled();
});

test('saved history is capped and malformed entries/storage are reported without crashing', async ({ page }) => {
  await openChords(page);
  await page.evaluate(() => {
    const chord = { name: 'C', root: 0, quality: 'major', similarity: 0.96, detectedAt: '2026-11-02T12:00:00.000Z' };
    localStorage.setItem('coreguitar.chords.v1', JSON.stringify([
      ...Array.from({ length: 205 }, () => chord), { ...chord, root: 99 }, { ...chord, name: '<img>' },
    ]));
  });
  await openChords(page);
  await expect(page.getByRole('region', { name: 'Chord history' }).getByRole('listitem')).toHaveCount(200);
  await expect(page.getByText('Invalid saved chord entries were ignored.')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('coreguitar.chords.v1', '{broken'));
  await openChords(page);
  await expect(page.getByText('Saved chord history could not be read.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add manual chord' }).click();
  await expect(page.getByRole('region', { name: 'Chord history' }).getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('Quota exceeded'); } });
  });
  await page.getByRole('button', { name: 'Add manual chord' }).click();
  await expect(page.getByText('Chord history was not saved on this device.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Chord history' }).getByRole('listitem')).toHaveCount(2);
});
