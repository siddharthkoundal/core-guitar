import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { AnalysisRequest, CustomExercise, Exercise, Preview, Tuning } from '../../api/types';
import { GuitarProImporter } from './GuitarProImporter';
import type { ExercisePickerProps } from './types';

export const defaultCustom: CustomExercise = {
  notes: 'E2:4 G2:4 A2:4 B2:4', bpm: 80, tuning: 'standard',
  time_signature: [4, 4], default_duration: '8',
};

function rhythmDescription(exercise: Exercise): string {
  const values = new Map<string, number>();
  const noteNames: Record<number, string> = {
    1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: 'sixteenth', 32: 'thirty-second',
  };
  for (const token of exercise.notes_text.replaceAll('|', ' ').split(/\s+/)) {
    if (!token || token.split(':', 1)[0]?.toLowerCase() === 'r') continue;
    const duration = token.split(':')[1] ?? exercise.default_duration;
    const match = /^(1|2|4|8|16|32)(\.|t)?$/.exec(duration);
    if (!match) continue;
    const denominator = Number(match[1]);
    const modifier = match[2];
    const beats = exercise.time_signature[1] / denominator
      * (modifier === '.' ? 1.5 : modifier === 't' ? 2 / 3 : 1);
    const noteValue = exercise.time_signature[1] / beats;
    const rounded = Math.round(noteValue);
    const name = Math.abs(noteValue - rounded) < 0.1
      ? `${noteNames[rounded] ?? 'subdivision'} notes`
      : 'triplet subdivisions';
    const perClick = 1 / beats;
    const count = Number.isInteger(perClick) ? perClick : Number(perClick.toFixed(1));
    values.set(name, count);
  }
  return [...values].map(([name, count]) => `${name} · ${count} per click`).join('; ');
}

function quarterNotes(notes: string): string {
  return notes.replace(/:(?:1|2|4|8|16|32)(?:\.|t)?/g, ':4');
}

export function ExercisePicker({ onSelect, onDemo }: ExercisePickerProps) {
  const [mode, setMode] = useState('shipped');
  const [quarterNotePractice, setQuarterNotePractice] = useState(false);
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
      const first = items[0];
      if (first) setCustom(value => ({ ...value, bpm: first.bpm }));
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
  function selection(): AnalysisRequest | null {
    if (!Number.isFinite(custom.bpm) || custom.bpm < 30 || custom.bpm > 240) return null;
    if (mode === 'shipped' && selected) {
      if (quarterNotePractice) {
        return {
          mode: 'reference',
          custom_exercise: {
            notes: quarterNotes(selected.notes_text),
            bpm: custom.bpm,
            tuning: selected.tuning,
            time_signature: selected.time_signature,
            default_duration: '4',
          },
          bpm: custom.bpm,
        };
      }
      return { mode: 'reference', exercise_id: selected.id, bpm: custom.bpm };
    } else if (mode === 'custom' && preview?.key === key) {
      return { mode: 'reference', custom_exercise: custom, bpm: custom.bpm };
    } else if (mode === 'free') {
      return { mode: 'free', bpm: custom.bpm, tuning: custom.tuning };
    }
    return null;
  }
  const ready = selection();
  return <section className="panel" aria-labelledby="choose-heading">
    <p className="eyebrow">01 / PICK A RIFF</p>
    <h2 id="choose-heading">Pick a riff and a tempo</h2>
    {mode === 'shipped' && <>
      <label>Exercise<select value={exerciseId} onChange={event => {
        setExerciseId(event.target.value);
        const ex = exercises.find(ex => ex.id === event.target.value);
        if (ex) setCustom({ ...custom, bpm: ex.bpm });
      }}>{exercises.map(ex => <option key={ex.id} value={ex.id}>{ex.name}</option>)}</select></label>
      <p>{selected?.description}</p>
      <p className="muted">{selected?.tuning.replaceAll('_', ' ')} tuning / {selected?.total_beats} beats</p>
      {selected && rhythmDescription(selected) && <>
        <p className="muted">{quarterNotePractice ? 'Quarter notes · 1 per click (practice version)' : rhythmDescription(selected)}</p>
        <label><input type="checkbox" checked={quarterNotePractice}
          onChange={event => setQuarterNotePractice(event.target.checked)} />
          Quarter-note practice (one note per click)</label>
      </>}
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
    <details className="more-options" open={mode !== 'shipped'}>
      <summary>More options: custom riff or free play</summary>
      <label>Practice mode<select value={mode} onChange={event => { setMode(event.target.value); setError(''); }}>
        <option value="shipped">Practice library</option>
        <option value="custom">Custom riff</option>
        <option value="free">Free play</option>
      </select></label>
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
        <GuitarProImporter onImport={exercise => { setCustom(exercise); setError(''); }} />
        {preview?.key === key && <div className="preview">
          <strong>{preview.value.total_beats} beats</strong>
          <ol>{preview.value.notes.map(note => <li key={note.index}>
            #{note.index}: {note.name}, bar {note.bar} beat {note.beat_in_bar}
          </li>)}</ol>
        </div>}
      </>}
      {mode === 'free' && <p className="notice">No reference: describes playing, does not judge correctness.</p>}
    </details>
    <p role="alert">{error}</p>
    <div className="actions">
      <button className="primary" disabled={!ready} onClick={() => { if (ready) onSelect(ready); }}>
        Continue to capture
      </button>
      {ready?.mode === 'reference' && <button aria-describedby="demo-hint" onClick={() => onDemo(ready)}>
        Try a demo take
      </button>}
    </div>
    {ready?.mode === 'reference' && <p id="demo-hint" className="muted">
      No guitar? Analyze a generated take of this riff with one note played late.
    </p>}
  </section>;
}
