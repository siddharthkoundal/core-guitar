import { useEffect, useReducer, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { AnalysisRequest, Take } from '../api/types';
import type { Recording } from '../audio/types';
import { initialSession, sessionReducer } from './session';
import type { CaptureMethod } from './types';
export type { CaptureMethod } from './types';
interface Operation {
  controller: AbortController;
  analysisId: string | null;
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 250);
    function abort() {
      window.clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function usePracticeSession() {
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [method, setMethod] = useState<CaptureMethod>('record');
  const [recording, updateRecording] = useState<Recording | null>(null);
  const active = useRef<Operation | null>(null);
  const uploaded = useRef<{ recording: Recording; take: Take } | null>(null);

  useEffect(() => () => {
    const operation = active.current;
    operation?.controller.abort();
    if (operation?.analysisId)
      void api.cancel(operation.analysisId)
        .catch(error => console.error('Analysis cleanup failed:', error));
  }, []);

  function setRecording(value: Recording | null) {
    uploaded.current = null;
    updateRecording(value);
  }

  function select(selection: AnalysisRequest) {
    dispatch({ type: 'select', selection });
  }

  function discard() {
    setRecording(null);
  }

  function pick() {
    discard();
    dispatch({ type: 'pick' });
  }

  async function submit() {
    if (!recording || !session.selection || active.current) return;
    const operation: Operation = {
      controller: new AbortController(),
      analysisId: null,
    };
    active.current = operation;
    dispatch({ type: 'upload' });

    try {
      let take = uploaded.current?.recording === recording ? uploaded.current.take : null;
      if (!take) {
        dispatch({ type: 'validating' });
        take = await api.upload(recording.blob, {
          source: recording.source,
          client_mime: recording.blob.type,
          original_name: recording.name,
          track_settings: recording.settings,
          interrupted: recording.partial,
        }, operation.controller.signal);
        if (operation.controller.signal.aborted) return;
        uploaded.current = { recording, take };
        dispatch({ type: 'validated', take });
      }

      // Keep the creation reply so an analysis created during cancellation can be stopped.
      const analysis = await api.analyze(take.take_id, session.selection);
      operation.analysisId = analysis.analysis_id;
      if (operation.controller.signal.aborted) {
        await api.cancel(analysis.analysis_id)
          .catch(error => console.error('Cancelled analysis cleanup failed:', error));
        return;
      }
      dispatch({ type: 'analyzing', take, analysisId: analysis.analysis_id });

      while (!operation.controller.signal.aborted) {
        const status = await api.status(analysis.analysis_id, operation.controller.signal);
        if (operation.controller.signal.aborted) return;
        if (status.status === 'done') {
          dispatch({ type: 'result', envelope: status.result });
          break;
        }
        if (status.status === 'failed') throw new Error(status.error);
        if (status.status === 'cancelled') {
          dispatch({ type: 'cancel' });
          break;
        }
        await delay(operation.controller.signal);
      }
    } catch (error) {
      if (!operation.controller.signal.aborted)
        dispatch({ type: 'error', message: errorMessage(error) });
    } finally {
      if (active.current === operation) active.current = null;
    }
  }

  async function cancel() {
    const operation = active.current;
    operation?.controller.abort();
    try {
      if (operation?.analysisId) await api.cancel(operation.analysisId);
      dispatch({ type: 'cancel' });
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }

  function retry(delta = 0) {
    if (!session.selection) return;
    const bpm = (session.selection.bpm ?? session.selection.custom_exercise?.bpm ?? 80) + delta;
    select({ ...session.selection, bpm });
    discard();
    setMethod('record');
  }

  async function remove(all: boolean) {
    if (!window.confirm(all
      ? 'Delete all saved takes and analyses permanently?'
      : 'Delete this take and its analyses?')) return;
    active.current?.controller.abort();
    try {
      if (all) await api.deleteAll();
      else if (session.take) await api.deleteTake(session.take.take_id);
      pick();
    } catch (error) {
      dispatch({ type: 'error', message: errorMessage(error) });
    }
  }

  return {
    session, method, recording,
    busy: session.phase === 'uploading' || session.phase === 'validating' || session.phase === 'analyzing',
    bpm: session.selection?.bpm ?? 80,
    setMethod, setRecording, select, discard, pick, submit, cancel, retry, remove,
  };
}
