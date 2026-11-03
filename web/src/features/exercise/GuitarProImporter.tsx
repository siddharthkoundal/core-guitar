import { useState } from 'react';
import { api, errorMessage } from '../../api';
import type { GuitarProImport, GuitarProImportOptions } from '../../api/types';
import type { GuitarProImporterProps } from './types';

export function GuitarProImporter({ onImport }: GuitarProImporterProps) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<GuitarProImport | null>(null);
  const [options, setOptions] = useState<GuitarProImportOptions>({ start: 1, tempo_percent: 100 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function convert(source: File, next: GuitarProImportOptions) {
    setBusy(true);
    setError('');
    try {
      const value = await api.importGuitarPro(source, next);
      setResult(value);
      setOptions({ ...next, track: value.track, start: value.start, end: value.end });
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  function number(key: keyof GuitarProImportOptions, value: string) {
    const parsed = Number(value);
    setOptions({ ...options, [key]: Number.isFinite(parsed) ? parsed : undefined });
  }

  return <fieldset className="gp-import" aria-describedby="gp-hint">
    <legend>Import from Guitar Pro</legend>
    <p id="gp-hint" className="muted">
      .gp3, .gp4 or .gp5 (export newer files as .gp5). One track, single notes only: chords keep their
      top note, ties and dead notes become rests, effects and repeats are ignored.
    </p>
    <label>Guitar Pro file<input type="file" accept=".gp3,.gp4,.gp5" onChange={event => {
      const chosen = event.target.files?.[0] ?? null;
      setFile(chosen);
      setResult(null);
      const fresh = { start: 1, tempo_percent: options.tempo_percent ?? 100 };
      setOptions(fresh);
      if (chosen) void convert(chosen, fresh);
    }} /></label>
    {result && <>
      <p><strong>{result.title || 'Untitled'}</strong>{result.artist && ` by ${result.artist}`}
        {' '}({result.measure_count} bars, {result.source_bpm} BPM)</p>
      <div className="form-row">
        <label>Track<select value={options.track ?? result.track}
          onChange={event => number('track', event.target.value)}>
          {result.tracks.map(track => <option key={track.index} value={track.index} disabled={track.percussion}>
            {track.name}{track.percussion ? ' (drums)' : ''}
          </option>)}
        </select></label>
        <label>From bar<input type="number" min="1" max={result.measure_count} value={options.start ?? 1}
          onChange={event => number('start', event.target.value)} /></label>
        <label>To bar<input type="number" min="1" max={result.measure_count} value={options.end ?? ''}
          onChange={event => number('end', event.target.value)} /></label>
        <label>Tempo %<input type="number" min="25" max="200" step="5" value={options.tempo_percent ?? 100}
          onChange={event => number('tempo_percent', event.target.value)} /></label>
      </div>
      <button disabled={busy || !file} onClick={() => { if (file) void convert(file, options); }}>
        Convert again
      </button>
      <pre className="gp-preview" aria-label="Converted notes">{result.exercise.notes}</pre>
      <p className="muted">{result.note_count} notes, {result.total_beats} beats at {result.exercise.bpm} BPM.</p>
      {result.warnings.length > 0 && <ul className="gp-warnings" aria-label="Import warnings">
        {result.warnings.map(warning => <li key={warning}>{warning}</li>)}
      </ul>}
      <button className="primary" disabled={busy} onClick={() => onImport(result.exercise)}>
        Use as custom riff
      </button>
    </>}
    {busy && <p role="status">Converting…</p>}
    <p role="alert">{error}</p>
  </fieldset>;
}
