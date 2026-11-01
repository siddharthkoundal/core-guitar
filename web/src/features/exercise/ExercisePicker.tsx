import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { CustomExercise, Exercise, Preview, Tuning } from '../../api/types';
import type { ExercisePickerProps } from './types';

export const defaultCustom: CustomExercise = {
  notes: 'E2:4 G2:4 A2:4 B2:4', bpm: 80, tuning: 'standard',
  time_signature: [4, 4], default_duration: '8',
};

export function ExercisePicker({ onSelect }: ExercisePickerProps) {
  const [mode, setMode] = useState('shipped');
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [exerciseId, setExerciseId] = useState('');
  const [custom, setCustom] = useState(defaultCustom);
  const [preview, setPreview] = useState<{ value: Preview; key: string } | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(custom);
  const selected = exercises.find(ex => ex.id === exerciseId);
  useEffect(() => {
    let active = true;
    api.exercises().then(items => {
      if (!active) return;
      setExercises(items);
      setExerciseId(items[0]?.id ?? '');
    }).catch(error => { if (active) setError(errorMessage(error)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (mode !== 'custom') return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      api.preview(custom, controller.signal).then(value => {
        if (!controller.signal.aborted) { setPreview({ value, key }); setError(''); }
      }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [custom, key, mode]);
  function tuning(value: string) {
    if (value === 'standard' || value === 'drop_d' || value === 'half_step_down') {
      setCustom({ ...custom, tuning: value });
    }
  }
  function select() {
    if (mode === 'shipped' && selected) {
      onSelect({ mode: 'reference', exercise_id: selected.id, bpm: custom.bpm });
    } else if (mode === 'custom' && preview?.key === key) {
      onSelect({ mode: 'reference', custom_exercise: custom, bpm: custom.bpm });
    } else if (mode === 'free') {
      onSelect({ mode: 'free', bpm: custom.bpm, tuning: custom.tuning });
    }
  }
  return <section className="panel" aria-labelledby="choose-heading">
    <p className="eyebrow">01 / THE SETLIST</p>
    <h2 id="choose-heading">One passage. One focused take.</h2>
    <label>Practice mode<select value={mode} onChange={event => { setMode(event.target.value); setError(''); }}>
      <option value="shipped">Practice library</option>
      <option value="custom">Custom riff</option>
      <option value="free">Free play</option>
    </select></label>
    {mode === 'shipped' && <>
      <label>Exercise<select value={exerciseId} onChange={event => {
        setExerciseId(event.target.value);
        const ex = exercises.find(ex => ex.id === event.target.value);
        if (ex) setCustom({ ...custom, bpm: ex.bpm });
      }}>{exercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}</select></label>
      <p>{selected?.description}</p>
      <p className="muted">{selected?.tuning} / {selected?.total_beats} beats</p>
    </>}
    <div className="form-row">
      <label>BPM<input type="number" min="30" max="240" value={custom.bpm}
        onChange={event => setCustom({ ...custom, bpm: Number(event.target.value) })} /></label>
      {mode !== 'shipped' && <label>Tuning<select value={custom.tuning}
        onChange={event => tuning(event.target.value)}>
        {(['standard', 'drop_d', 'half_step_down'] satisfies Tuning[]).map(value =>
          <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
      </select></label>}
    </div>
    {mode === 'custom' && <>
      <label>Notes<textarea value={custom.notes}
        aria-describedby="notes-hint" aria-invalid={Boolean(error)}
        onChange={event => setCustom({ ...custom, notes: event.target.value })} /></label>
      <p id="notes-hint" className="muted">Note names or string/fret; e.g. 5/0:4 5/3:8 E3:4 r:8. Indices start at 0.</p>
      <div className="form-row">
        <label>Beats per bar<input type="number" min="1" max="16" value={custom.time_signature[0]}
          onChange={event => setCustom({ ...custom,
            time_signature: [Number(event.target.value), custom.time_signature[1]] })} /></label>
        <label>Beat unit<select value={custom.time_signature[1]} onChange={event =>
          setCustom({ ...custom, time_signature: [custom.time_signature[0], Number(event.target.value)] })}>
          {[1, 2, 4, 8, 16].map(unit => <option key={unit}>{unit}</option>)}</select></label>
        <label>Default duration<select value={custom.default_duration} onChange={event =>
          setCustom({ ...custom, default_duration: event.target.value })}>
          {['1', '2', '4', '8', '16', '32', '4.', '8t'].map(value => <option key={value}>{value}</option>)}
        </select></label>
      </div>
      {preview?.key === key && <div className="preview">
        <strong>{preview.value.total_beats} beats</strong>
        <ol>{preview.value.notes.map(note => <li key={note.index}>
          #{note.index}: {note.name}, bar {note.bar} beat {note.beat_in_bar}
        </li>)}</ol>
      </div>}
    </>}
    {mode === 'free' && <p className="notice">No reference: describes playing, does not judge correctness.</p>}
    <p role="alert">{error}</p>
    <button className="primary" disabled={!Number.isFinite(custom.bpm) || custom.bpm < 30 || custom.bpm > 240
      || (mode === 'shipped' && !selected) || (mode === 'custom' && preview?.key !== key)}
      onClick={select}>Continue to capture</button>
  </section>;
}
