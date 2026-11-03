import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export async function collectCoverage(page: Page): Promise<void> {
  const data = await page.evaluate(() => '__coverage__' in window ? JSON.stringify(window.__coverage__) : null);
  if (data) {
    mkdirSync('coverage/e2e', { recursive: true });
    writeFileSync(`coverage/e2e/${randomUUID()}.json`, data);
  }
}

export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [async ({ page }, use) => {
    await use();
    await collectCoverage(page);
  }, { auto: true }],
});
