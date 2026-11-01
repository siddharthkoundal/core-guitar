import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    {
      name: 'local-e2e-coverage',
      enforce: 'pre',
      transform(code, id) {
        if (process.env['COREGUITAR_COVERAGE'] !== '1' || !id.startsWith(resolve('src') + '/')
          || !/\.(ts|tsx)$/.test(id) || id.includes('.test.') || id.includes('.worklet.') || id.endsWith('/main.tsx')
          || id.endsWith('/test-utils.tsx')) return;
        return createInstrumenter({ esModules: true, parserPlugins: ['typescript', 'jsx'] })
          .instrumentSync(code, id);
      },
    },
    react(),
  ],
  // Keep the browser's Host so the backend's same-origin check matches the dev Origin.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false } } },
  test: {
    environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'],
    coverage: { provider: 'v8', reporter: ['text', 'json'],
      include: ['src/**/*.{ts,tsx}'], exclude: ['src/**/*.test.*', 'src/test-utils.tsx', 'src/main.tsx',
        'src/audio/pcm-recorder.worklet.ts'] },
  },
});
