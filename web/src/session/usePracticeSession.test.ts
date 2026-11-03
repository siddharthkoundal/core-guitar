import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '../test-utils';
import { api, ApiError } from '../api';
import type { Envelope, Take } from '../api/types';
import type { Recording } from '../audio/types';
import { usePracticeSession, withInputProfile } from './usePracticeSession';

const take: Take = {
  take_id: 'take', duration_s: 5, sample_rate: 48000, channels: 1,
  codec: 'wav', lossy: false, source: 'upload',
};
const envelope: Envelope = {
  analysis_id: 'analysis', take_id: 'take', source: 'upload', request: {},
  track_settings: {}, lossy: false,
  result: {
    mode: 'free', quality: { verdict: 'accept', metrics: {}, issues: [] },
    re_record: { requested: false, reasons: [] }, summary: null,
    notes: [], note_table: [], findings: [], priorities: [],
    listening_points: [], uncertainty: [],
  },
};
const recording: Recording = {
  blob: new Blob(['audio'], { type: 'audio/wav' }), name: 'take.wav',
  source: 'upload', partial: false, settings: {},
};

beforeEach(() => {
  vi.spyOn(api, 'upload').mockResolvedValue(take);
  vi.spyOn(api, 'analyze').mockResolvedValue({ analysis_id: 'analysis' });
  vi.spyOn(api, 'status').mockResolvedValue({ status: 'done', result: envelope });
  vi.spyOn(api, 'cancel').mockResolvedValue();
  vi.spyOn(api, 'deleteTake').mockResolvedValue();
  vi.spyOn(api, 'deleteAll').mockResolvedValue();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function ready() {
  const hook = renderHook(usePracticeSession);
  act(() => {
    hook.result.current.select({ mode: 'free', bpm: 80 });
    hook.result.current.setRecording(recording);
  });
  return hook;
}

it('uploads metadata once, polls to completion and ignores duplicate submissions', async () => {
  vi.useFakeTimers();
  vi.mocked(api.status).mockResolvedValueOnce({ status: 'queued' });
  const { result } = ready();
  await act(async () => {
    const first = result.current.submit();
    await result.current.submit();
    await vi.advanceTimersByTimeAsync(250);
    await first;
  });
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(api.upload).toHaveBeenCalledWith(recording.blob, {
    source: 'upload', client_mime: 'audio/wav', original_name: 'take.wav',
    track_settings: {}, interrupted: false,
  }, expect.any(AbortSignal));
  expect(api.analyze).toHaveBeenCalledTimes(1);
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(result.current.session.envelope).toEqual(envelope);
});

it('keeps a validated take after analysis failure and reuses it when resubmitted', async () => {
  vi.mocked(api.status).mockResolvedValueOnce({ status: 'failed', error: 'Analysis failed.' });
  const { result } = ready();
  await act(() => result.current.submit());
  expect(result.current.session.error).toBe('Analysis failed.');
  await act(() => result.current.submit());
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(api.analyze).toHaveBeenCalledTimes(2);
  expect(result.current.session.phase).toBe('results');
});

it('surfaces upload advice and uploads a new recording after discard', async () => {
  vi.mocked(api.upload).mockRejectedValueOnce(new ApiError('invalid', 'Invalid audio.', 'Record again.'));
  const { result } = ready();
  await act(() => result.current.submit());
  expect(result.current.session.error).toBe('Invalid audio. Record again.');
  act(() => {
    result.current.discard();
    result.current.setRecording({ ...recording, name: 'new.wav' });
  });
  await act(() => result.current.submit());
  expect(api.upload).toHaveBeenCalledTimes(2);
});

it('cancels polling, keeps the take, and does not surface an aborted request as an error', async () => {
  vi.useFakeTimers();
  vi.mocked(api.status).mockResolvedValueOnce({ status: 'running' });
  const { result } = ready();
  let submission: Promise<void>;
  await act(async () => {
    submission = result.current.submit();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => { await result.current.cancel(); await submission; });
  expect(api.cancel).toHaveBeenCalledWith('analysis');
  expect(result.current.session.phase).toBe('capture');
  expect(result.current.recording).toBe(recording);
  expect(result.current.session.take).toEqual(take);
  expect(result.current.session.error).toBeNull();
  await act(() => result.current.submit());
  expect(api.upload).toHaveBeenCalledTimes(1);
});

it('ignores an upload reply arriving after deletion instead of starting stale analysis', async () => {
  let finishUpload: (value: Take) => void = () => { throw new Error('Upload not started'); };
  vi.mocked(api.upload).mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
  const { result } = ready();
  let submission: Promise<void>;
  act(() => { submission = result.current.submit(); });
  await act(() => result.current.remove(true));
  await act(async () => { finishUpload(take); await submission; });
  expect(api.analyze).not.toHaveBeenCalled();
  expect(result.current.session.phase).toBe('select_exercise');
  expect(result.current.recording).toBeNull();
});

it('cancels an analysis created after unmount without polling it', async () => {
  let finishAnalysis: (value: { analysis_id: string }) => void = () => {
    throw new Error('Analysis not started');
  };
  vi.mocked(api.analyze).mockImplementation(() => new Promise(resolve => { finishAnalysis = resolve; }));
  const { result, unmount } = ready();
  let submission: Promise<void>;
  act(() => { submission = result.current.submit(); });
  await waitFor(() => expect(api.analyze).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => { finishAnalysis({ analysis_id: 'late' }); await submission; });
  expect(api.cancel).toHaveBeenCalledWith('late');
  expect(api.status).not.toHaveBeenCalled();
});

it('aborts and cancels a known analysis on unmount', async () => {
  vi.useFakeTimers();
  vi.mocked(api.status).mockResolvedValue({ status: 'running' });
  const { result, unmount } = ready();
  let submission: Promise<void> | undefined;
  await act(async () => {
    submission = result.current.submit();
    await vi.advanceTimersByTimeAsync(0);
  });
  unmount();
  if (!submission) throw new Error('Submission not started');
  await submission;
  expect(api.cancel).toHaveBeenCalledWith('analysis');
});

it('resets capture and adjusts only tempo when retrying', async () => {
  const { result } = ready();
  act(() => result.current.setMethod('upload'));
  await act(() => result.current.submit());
  act(() => result.current.retry(5));
  expect(result.current.session.selection).toEqual({ mode: 'free', bpm: 85 });
  expect(result.current.session.phase).toBe('capture');
  expect(result.current.recording).toBeNull();
  expect(result.current.method).toBe('record');
  act(() => result.current.setRecording(recording));
  await act(() => result.current.submit());
  expect(api.upload).toHaveBeenCalledTimes(2);
});

it('requires confirmation for deletion and reports deletion errors', async () => {
  const { result } = ready();
  await act(() => result.current.submit());
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await act(() => result.current.remove(false));
  expect(api.deleteTake).not.toHaveBeenCalled();
  vi.mocked(api.deleteTake).mockRejectedValueOnce(new Error('Delete failed.'));
  await act(() => result.current.remove(false));
  expect(result.current.session.error).toBe('Delete failed.');
  await act(() => result.current.remove(false));
  expect(api.deleteTake).toHaveBeenCalledWith('take');
  expect(result.current.session.phase).toBe('select_exercise');
});

it('sends the click offset only for timed direct-input takes', () => {
  const direct: Recording = { ...recording, inputProfile: 'direct', clickOffsetS: 2.123456 };
  expect(withInputProfile({ mode: 'free', bpm: 80 }, direct))
    .toEqual({ mode: 'free', bpm: 80, input_profile: 'direct', click_offset_s: 2.1235 });
  expect(withInputProfile({ mode: 'free' }, direct)).toEqual({ mode: 'free', input_profile: 'direct' });
  expect(withInputProfile({ mode: 'reference', exercise_id: 'x' }, { ...direct, clickOffsetS: 61 }))
    .toEqual({ mode: 'reference', exercise_id: 'x', input_profile: 'direct' });
  expect(withInputProfile({ mode: 'free', bpm: 80 }, { ...direct, inputProfile: 'mic' }))
    .toEqual({ mode: 'free', bpm: 80, input_profile: 'mic' });
});
