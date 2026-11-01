import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8767',
    actionTimeout: 10000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('e2e/.generated/findings.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ] },
  },
  webServer: {
    command: '../.venv/bin/python ../tests/e2e_server.py',
    url: 'http://127.0.0.1:8767/api/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
