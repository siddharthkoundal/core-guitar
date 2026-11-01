import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, parseEnvelope } from './index';

afterEach(() => vi.unstubAllGlobals());

it('rejects invalid result contracts instead of rendering success-shaped defaults', () => {
  expect(() => parseEnvelope(null)).toThrow('Invalid analysis envelope');
  expect(() => parseEnvelope({ result: { mode: ['reference'] } })).toThrow();
});

it('rejects a shipped exercise with an unsupported tuning at the API boundary', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{
    id: 'test', name: 'test', description: '', tuning: 'unknown',
    default_duration: '8', notes_text: 'E2', bpm: 80, total_beats: 1, time_signature: [4, 4],
  }]))));
  await expect(api.exercises()).rejects.toThrow('invalid response');
});

it('preserves server validation errors and advice', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    code: 'too_short', message: 'Audio is too short.', advice: 'Record again.',
  }), { status: 422 })));
  await expect(api.exercises()).rejects.toEqual(new ApiError('too_short', 'Audio is too short.', 'Record again.'));
});

it('reports a readable HTTP error when an error reply is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('proxy failure', { status: 502 })));
  await expect(api.exercises()).rejects.toThrow('Local server returned HTTP 502.');
});
