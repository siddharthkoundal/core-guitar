import { expect } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { collectCoverage, test } from './fixtures';

const KEY = 'coreguitar.coach.plans.v1';

async function openCoach(page: Page, status: unknown = { available: true, models: ['llama3.2:latest'] }): Promise<Locator> {
  await page.route('**/api/coach/status', route => route.fulfill({ json: status }));
  await collectCoverage(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Coach', exact: true }).click();
  return page.getByRole('region', { name: 'Your local practice coach' });
}

async function generate(coach: Locator, goal = 'Learn G major'): Promise<void> {
  await coach.getByLabel('Practice goal', { exact: true }).fill(goal);
  await coach.getByRole('button', { name: 'Generate practice plan' }).click();
}

test('local status, personalized plan, follow-up, save, reload, delete and clear', async ({ page }) => {
  const requests: unknown[] = [];
  await page.route('**/api/coach', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      text: requests.length === 1 ? 'Warm up, play G major, then improvise for five minutes.' : 'Try a comfortable 60 BPM.',
      model: 'llama3.2',
    } });
  });
  const coach = await openCoach(page);
  await expect(coach.getByRole('status')).toContainText('Ollama is running');
  await coach.getByText('Install and configure Ollama locally').click();
  await expect(coach.getByText(/Model downloads require internet during setup/)).toBeVisible();
  await coach.getByRole('button', { name: 'Refresh local status' }).click();
  await expect(coach.getByRole('status')).toContainText('llama3.2:latest');
  await coach.getByLabel('Experience level').selectOption('intermediate');
  await generate(coach);
  await expect(coach.getByText('Warm up, play G major, then improvise for five minutes.', { exact: true })).toBeVisible();
  expect(requests[0]).toMatchObject({
    kind: 'plan', prompt: 'Learn G major', level: 'intermediate',
    context: expect.stringContaining('Local catalog'),
  });
  await coach.getByLabel('Follow-up question').fill('What tempo?');
  await coach.getByRole('button', { name: 'Ask follow-up' }).click();
  await expect(coach.getByText('Try a comfortable 60 BPM.', { exact: true })).toBeVisible();
  expect(requests[1]).toMatchObject({
    prompt: 'What tempo?', messages: [
      { role: 'user', content: 'Learn G major' },
      { role: 'assistant', content: 'Warm up, play G major, then improvise for five minutes.' },
    ],
  });
  await coach.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(coach.getByText('Plan saved on this browser only.')).toBeVisible();
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await page.getByRole('button', { name: 'Coach', exact: true }).click();
  await coach.getByRole('button', { name: 'Load Learn G major', exact: true }).click();
  await expect(coach.getByText('Try a comfortable 60 BPM.', { exact: true })).toBeVisible();
  await coach.getByText('Earlier conversation (latest answer shown above)').click();
  await expect(coach.getByText('What tempo?', { exact: true })).toBeVisible();
  await coach.getByRole('button', { name: 'Delete Learn G major', exact: true }).click();
  await expect(coach.getByRole('button', { name: 'Load Learn G major' })).toHaveCount(0);
  await coach.getByRole('button', { name: 'Save plan', exact: true }).click();
  await coach.getByRole('button', { name: 'Clear saved plans', exact: true }).click();
  await expect(coach.getByText('Saved plans cleared.')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBeNull();
});

test('cancellation and leaving the room abort pending generation without showing late output', async ({ page }) => {
  let pending: Route | undefined;
  async function abortPending(): Promise<void> {
    await pending?.abort();
  }
  await page.route('**/api/coach', route => { pending = route; });
  const coach = await openCoach(page);
  await generate(coach);
  await expect.poll(() => pending !== undefined).toBe(true);
  await coach.getByRole('button', { name: 'Cancel generation' }).click();
  await expect(coach.getByText(/Generation cancelled/)).toBeVisible();
  await expect(coach.getByRole('button', { name: 'Generate practice plan' })).toBeEnabled();
  await abortPending();
  await expect(coach.getByRole('heading', { name: 'Practice plan (suggestion)' })).toHaveCount(0);
  pending = undefined;
  await generate(coach, 'Try again');
  await expect.poll(() => pending !== undefined).toBe(true);
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await abortPending();
  await page.getByRole('button', { name: 'Coach', exact: true }).click();
  await expect(coach.getByRole('heading', { name: 'Practice plan (suggestion)' })).toHaveCount(0);
});

test('unavailable service, model setup advice, malformed generation and status errors are explicit', async ({ page }) => {
  await page.route('**/api/coach', route => route.fulfill({
    status: 503, json: {
      code: 'coach_model_missing', message: 'Local model is not installed.',
      advice: 'Run ollama pull llama3.2.',
    },
  }));
  const coach = await openCoach(page, { available: false, models: [] });
  await expect(coach.getByText(/Ollama is not running/)).toBeVisible();
  await generate(coach);
  await expect(coach.getByRole('alert')).toContainText('ollama pull llama3.2');
  await page.route('**/api/coach', route => route.fulfill({ json: { text: 10, model: 'bad' } }));
  await generate(coach, 'Retry locally');
  await expect(coach.getByRole('alert')).toContainText('invalid answer');
  await page.route('**/api/coach', route => route.fulfill({ status: 502, body: 'not JSON' }));
  await generate(coach, 'Another try');
  await expect(coach.getByRole('alert')).toContainText('invalid JSON');
  await page.route('**/api/coach/status', route => route.fulfill({ json: { available: 'yes', models: [] } }));
  await coach.getByRole('button', { name: 'Refresh local status' }).click();
  await expect(coach.getByText('The local coach returned an invalid status.')).toBeVisible();
});

test('empty local model list and failed follow-up retain the earlier plan', async ({ page }) => {
  await page.route('**/api/coach', route => route.fulfill({ json: { text: 'Keep this plan.', model: 'llama3.2' } }));
  const coach = await openCoach(page, { available: true, models: [] });
  await expect(coach.getByRole('status')).toContainText('none installed');
  await generate(coach);
  await expect(coach.getByText('Keep this plan.', { exact: true })).toBeVisible();
  await page.route('**/api/coach', route => route.fulfill({
    status: 503, json: { code: 'coach_unavailable', message: 'Ollama stopped.', advice: 'Start it locally.' },
  }));
  await coach.getByLabel('Follow-up question').fill('What next?');
  await coach.getByRole('button', { name: 'Ask follow-up' }).click();
  await expect(coach.getByRole('alert')).toContainText('Ollama stopped');
  await expect(coach.getByText('Keep this plan.', { exact: true })).toBeVisible();
});

test('invalid service errors, storage metadata and status recover without cloud fallback', async ({ page }) => {
  let context = '';
  await page.addInitScript(() => {
    localStorage.setItem('coreguitar.scales.settings.v1', '{invalid');
    localStorage.setItem('coreguitar.chords.v1', '{invalid');
  });
  await page.route('**/api/coach', route => {
    const body: unknown = route.request().postDataJSON();
    if (typeof body === 'object' && body !== null && 'context' in body && typeof body.context === 'string') {
      context = body.context;
    }
    return route.fulfill({ status: 503, json: {} });
  });
  const coach = await openCoach(page);
  await generate(coach);
  await expect(coach.getByRole('alert')).toContainText('invalid error');
  expect(context).toContain('Chord history status:');
  expect(context).toContain('Tuning settings status:');
  await page.route('**/api/coach', route => route.fulfill({
    status: 503, json: { code: 'coach_busy', message: 'Already generating locally.' },
  }));
  await generate(coach, 'Wait for local model');
  await expect(coach.getByRole('alert')).toContainText('Already generating locally.');
  await page.route('**/api/coach/status', route => route.fulfill({ status: 500, body: 'not JSON' }));
  await coach.getByRole('button', { name: 'Refresh local status' }).click();
  await expect(coach.getByText('The local coach returned invalid JSON.')).toBeVisible();
});

test('model output stays plain text and only validated scale suggestions open the fretboard', async ({ page }) => {
  await page.route('**/api/coach', route => route.fulfill({ json: {
    text: '<img src=x onerror=alert(1)> [scale:major:7] [scale:major:7] [scale:invalid:3] [scale:dorian:99] ' +
      '[scale:dorian:2] [scale:natural-minor:9] [scale:major-pentatonic:0] [scale:minor-pentatonic:0]',
    model: 'llama3.2',
  } }));
  const coach = await openCoach(page);
  await generate(coach);
  await expect(coach.getByRole('button', { name: /on fretboard/ })).toHaveCount(4);
  await expect(coach.locator('img')).toHaveCount(0);
  await expect(coach.getByText(/<img src=x/)).toBeVisible();
  await coach.getByRole('button', { name: /Open G .* on fretboard/ }).click();
  await expect(page.getByRole('button', { name: 'Fretboard', exact: true })).toHaveAttribute('aria-current', 'page');
});

for (const raw of ['not JSON', JSON.stringify([{ text: 'bad', level: 'root' }]), ' '.repeat(2_000_001)]) {
  test(`invalid local history is recoverable (${raw.length} characters)`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: KEY, value: raw });
    const coach = await openCoach(page);
    await expect(coach.getByRole('alert')).toContainText('Saved plans could not be loaded');
    await coach.getByRole('button', { name: 'Clear saved plans' }).click();
    await expect(coach.getByText('Saved plans cleared.')).toBeVisible();
    await expect(coach.getByRole('alert')).toHaveCount(0);
  });
}

test('storage quota and deletion permission errors never claim success', async ({ page }) => {
  await page.route('**/api/coach', route => route.fulfill({ json: { text: 'A saved routine.', model: 'llama3.2' } }));
  const coach = await openCoach(page);
  await generate(coach);
  await expect(coach.getByText('A saved routine.', { exact: true })).toBeVisible();
  await coach.getByRole('button', { name: 'Save plan', exact: true }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Quota full', 'QuotaExceededError'); };
    Storage.prototype.removeItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
  });
  await coach.getByRole('button', { name: 'Save plan', exact: true }).click();
  await expect(coach.getByRole('alert')).toContainText('could not be saved');
  await coach.getByRole('button', { name: 'Delete Learn G major', exact: true }).click();
  await expect(coach.getByRole('alert')).toContainText('could not be saved');
  await coach.getByRole('button', { name: 'Clear saved plans' }).click();
  await expect(coach.getByRole('alert')).toContainText('could not be cleared');
});

test('local history keeps at most ten plans', async ({ page }) => {
  await page.route('**/api/coach', route => route.fulfill({ json: { text: 'A short routine.', model: 'llama3.2' } }));
  const coach = await openCoach(page);
  await generate(coach);
  await expect(coach.getByText('A short routine.', { exact: true })).toBeVisible();
  for (let i = 0; i < 11; i += 1) {
    await coach.getByRole('button', { name: 'Save plan', exact: true }).click();
  }
  await expect(coach.getByRole('button', { name: 'Load Learn G major', exact: true })).toHaveCount(10);
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await page.getByRole('button', { name: 'Coach', exact: true }).click();
  await expect(coach.getByRole('button', { name: 'Load Learn G major', exact: true })).toHaveCount(10);
});
