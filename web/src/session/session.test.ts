import { expect, it } from 'vitest';
import { initialSession, sessionReducer } from './session';

it('preserves exercise settings and the take when analysis is cancelled', () => {
  const selection = { mode: 'free', bpm: 80 } as const;
  let state = sessionReducer(initialSession, { type: 'select', selection });
  state = sessionReducer(state, { type: 'upload' });
  state = sessionReducer(state, { type: 'validating' });
  state = sessionReducer(state, { type: 'analyzing', take: {
    take_id: 'take', duration_s: 3, sample_rate: 44100, channels: 1,
    codec: 'pcm_s16le', lossy: false, source: 'upload',
  }, analysisId: 'analysis' });
  state = sessionReducer(state, { type: 'cancel' });
  expect(state.phase).toBe('capture');
  expect(state.selection).toEqual(selection);
  expect(state.take?.take_id).toBe('take');
});

it('returns validation failures to capture with their reason', () => {
  let state = sessionReducer(initialSession, { type: 'select', selection: { mode: 'free' } });
  state = sessionReducer(state, { type: 'upload' });
  state = sessionReducer(state, { type: 'error', message: 'The take is too short.' });
  expect(state.phase).toBe('capture');
  expect(state.error).toBe('The take is too short.');
});
