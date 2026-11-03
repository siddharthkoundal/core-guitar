import { afterEach, expect, it, vi } from 'vitest';
import { askCoach, coachStatus } from './client';

afterEach(() => { vi.unstubAllGlobals(); });

const request = { kind: 'plan', prompt: 'Learn scales', level: 'beginner', context: '' } as const;

it('uses only same-origin local endpoints and supports cancellation', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'Slow practice', model: 'llama3.2' })));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(await askCoach(request, signal)).toEqual({ text: 'Slow practice', model: 'llama3.2' });
  expect(fetcher).toHaveBeenCalledWith('/api/coach', expect.objectContaining({
    method: 'POST', signal, redirect: 'error', body: JSON.stringify(request),
  }));
});

it.each([{}, { text: 1, model: 'm' }, { text: 'x', model: 4 }, { text: 'x'.repeat(12001), model: 'm' }])(
  'rejects malformed success payloads %#', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(askCoach(request, new AbortController().signal)).rejects.toThrow(/invalid/i);
  },
);

it('reports explicit local setup errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    code: 'coach_model_missing', message: 'Model is not installed.', advice: 'Run ollama pull llama3.2.',
  }), { status: 503 })));
  await expect(askCoach(request, new AbortController().signal)).rejects.toThrow(/ollama pull/);
});

it('validates status and malformed error JSON', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ available: true, models: ['llama3.2'] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ available: 'yes', models: [] })))
    .mockResolvedValueOnce(new Response('oops', { status: 502 }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(await coachStatus(signal)).toEqual({ available: true, models: ['llama3.2'] });
  await expect(coachStatus(signal)).rejects.toThrow(/invalid/i);
  await expect(askCoach(request, signal)).rejects.toThrow(/invalid/i);
});
