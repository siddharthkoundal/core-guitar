import { useEffect, useRef, useState } from 'react';
import { emptyProgress, localDay, parseProgress, PROGRESS_KEY, recordAttempt, recordQuiz } from './progress';
import type { Progress, QuizMode, ScaleAttempt } from './progress';

type Update = (progress: Progress) => Progress;
const unsaved = 'Learning progress is available this visit, but browser storage could not save it.';

function readProgress(): Progress {
  const raw = localStorage.getItem(PROGRESS_KEY);
  return raw ? parseProgress(raw) : emptyProgress();
}
function load(): { progress: Progress; error: string } {
  try { return { progress: readProgress(), error: '' }; }
  catch (error) {
    return { progress: emptyProgress(), error: error instanceof Error ? error.message : 'Learning progress could not be loaded.' };
  }
}

export function useProgress() {
  const [state, setState] = useState(load);
  const persisted = useRef(state.progress);
  const pending = useRef<Update[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    function synchronize(event: StorageEvent): void {
      if (event.key !== PROGRESS_KEY && event.key !== null) return;
      try {
        const progress = event.newValue ? parseProgress(event.newValue) : emptyProgress();
        persisted.current = progress;
        setState({ progress: pending.current.reduce((value, update) => update(value), progress),
          error: pending.current.length ? unsaved : '' });
      } catch (error) {
        setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Updated progress could not be read.' }));
      }
    }
    window.addEventListener('storage', synchronize);
    return () => { mounted.current = false; window.removeEventListener('storage', synchronize); };
  }, []);

  function flush(reset: boolean): void {
    if (!pending.current.length) return;
    let base = persisted.current;
    try {
      base = reset ? emptyProgress() : readProgress();
      const progress = pending.current.reduce((value, update) => update(value), base);
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
      persisted.current = progress;
      pending.current = [];
      if (mounted.current) setState({ progress, error: '' });
    } catch (error) {
      persisted.current = base;
      if (mounted.current) setState({
        progress: pending.current.reduce((value, update) => update(value), base),
        error: error instanceof Error && error.message.startsWith('Saved progress') ? error.message : unsaved,
      });
    }
  }
  function update(operation: Update, reset = false): void {
    if (reset) pending.current = [];
    pending.current.push(operation);
    if (navigator.locks) {
      void navigator.locks.request(PROGRESS_KEY, () => flush(reset)).catch(() => {
        if (mounted.current) setState(previous => ({ ...previous, error: 'Learning progress could not acquire its browser storage lock. Try again.' }));
      });
    } else flush(reset);
  }
  return {
    ...state,
    attempt: (attempt: ScaleAttempt): void => {
      const date = localDay();
      update(progress => recordAttempt(progress, attempt, date));
    },
    quiz: (mode: QuizMode, correct: number): void => {
      const date = localDay();
      update(progress => recordQuiz(progress, mode, correct, date));
    },
    reset: (): void => update(emptyProgress, true),
  };
}
