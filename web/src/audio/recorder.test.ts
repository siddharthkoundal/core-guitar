import { expect, it } from 'vitest';
import { initialRecorder, recorderReducer } from './recorder';

it('records only after the first worklet buffer and preserves partial interruption', () => {
  let state = recorderReducer(initialRecorder, { type: 'permission' });
  expect(state.phase).toBe('requesting_permission');
  state = recorderReducer(state, { type: 'armed' });
  state = recorderReducer(state, { type: 'start' });
  expect(state.phase).toBe('starting');
  state = recorderReducer(state, { type: 'buffer' });
  expect(state.phase).toBe('recording');
  state = recorderReducer(state, { type: 'interrupt' });
  expect(state.phase).toBe('interrupted');
  state = recorderReducer(state, { type: 'recorded', partial: true });
  expect(state).toEqual({ phase: 'recorded', partial: true });
});

it('cancel resets capture and handles permission and device failure states', () => {
  expect(recorderReducer(initialRecorder, { type: 'denied' }).phase).toBe('permission_denied');
  expect(recorderReducer(initialRecorder, { type: 'no_device' }).phase).toBe('no_device');
  expect(recorderReducer({ phase: 'recording', partial: false }, { type: 'cancel' }))
    .toEqual(initialRecorder);
});
