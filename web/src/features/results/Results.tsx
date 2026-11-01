import { useEffect, useRef, useState } from 'react';
import type { AnalysisResult, Evidence, Finding, Json, JsonObject } from '../../api/types';
import { errorMessage } from '../../api';
import { ProcessingWarnings } from '../../components/ProcessingWarnings';
import type {
  EvidenceTimelineProps,
  FindingsListProps,
  NoteTableProps,
  PrioritiesProps,
  QualityPanelProps,
  ResultsProps,
  Seek,
} from './types';

function time(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
function scalar(value: Json | undefined): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '-';
}
function number(value: Json | undefined): number | null {
  return typeof value === 'number' ? value : null;
}
function rowEvidence(row: JsonObject, result: AnalysisResult): Evidence | null {
  const finding = result.findings.find(finding => finding.ref_indices.includes(Number(row['ref_index'])));
  if (finding) return finding.evidence;
  const start = number(row['onset_s']) ?? number(row['expected_s']);
  if (start === null) return null;
  const detected = result.notes[Number(row['det_index'])];
  const end = number(detected?.['offset_s']) ?? start + 0.3;
  return { start_s: start, end_s: end, play_from_s: Math.max(0, start - 0.75), play_to_s: end + 0.75 };
}
export function QualityPanel({ envelope }: QualityPanelProps) {
  const quality = envelope.result.quality;
  return <section aria-labelledby="quality-heading">
    <p className="eyebrow">03 / CHECK THE SIGNAL FIRST</p>
    <h2 id="quality-heading">Input quality</h2>
    <p className="verdict">{quality.verdict.toUpperCase()}</p>
    <p>SNR {scalar(quality.metrics['snr_db'])} dB / peak {scalar(quality.metrics['peak_dbfs'])} dBFS</p>
    {quality.issues.map((issue, index) => <div className="notice" key={index}>
      <strong>{issue.level}: {issue.message}</strong><p>{issue.advice}</p>
    </div>)}
    {envelope.lossy && <p className="notice">Lossy codec: clipping detection less reliable.</p>}
    {envelope.source === 'recording' && <ProcessingWarnings settings={envelope.track_settings} />}
    {envelope.result.re_record.requested && <div className="notice">
      <h3>Please re-record</h3>
      <ul>{envelope.result.re_record.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
  </section>;
}
export function NoteTable({ result, seek }: NoteTableProps) {
  const rows = result.mode === 'reference' ? result.note_table : result.notes;
  return <section aria-labelledby="notes-heading"><h2 id="notes-heading">Note table</h2>
    <div className="table-scroll"><table><caption>Click a note to listen to its evidence</caption>
      <thead><tr><th scope="col">Note / index</th><th scope="col">Heard</th>
        <th scope="col">Status</th><th scope="col">Time</th><th scope="col">Timing</th>
        <th scope="col">Confidence value</th></tr></thead>
      <tbody>{rows.map((row, index) => {
        const evidence = rowEvidence(row, result);
        return <tr key={index}><th scope="row">
          <button disabled={!evidence} onClick={() => { if (evidence) seek(evidence); }}>
            #{scalar(row['ref_index'] ?? index)} {scalar(row['expected'] ?? row['name'])}
          </button></th><td>{scalar(row['played'] ?? row['name'])}</td>
          <td>{scalar(row['status'])}</td><td>{evidence ? time(evidence.start_s) : '-'}</td>
          <td>{scalar(row['timing_ms'])} ms</td><td>{scalar(row['confidence'])}</td></tr>;
      })}</tbody></table></div>
  </section>;
}
export function EvidenceTimeline({ findings, seek }: EvidenceTimelineProps) {
  return <section aria-labelledby="timeline-heading"><h2 id="timeline-heading">Evidence timeline</h2>
    <div className="timeline">{findings.filter(finding => !finding.experimental).map(finding =>
      <button key={finding.id} onClick={() => seek(finding.evidence)}>
        {time(finding.evidence.start_s)} / {finding.type.replaceAll('_', ' ')}
      </button>)}</div>
    {!findings.length && <p>No findings at the current measurement thresholds.</p>}
  </section>;
}
export function FindingsList({ findings, seek }: FindingsListProps) {
  function list(items: Finding[]) {
    return <ul className="findings">{items.map(finding => <li key={finding.id}>
      <button className="evidence" data-finding-type={finding.type}
        data-ref-indices={finding.ref_indices.join(',')} onClick={() => seek(finding.evidence)}>
        <span>{time(finding.evidence.start_s)}-{time(finding.evidence.end_s)}</span>
        <strong>{finding.message}</strong>
        <span>{finding.confidence_label} confidence / value {finding.confidence}</span>
      </button>
      <details><summary>Measured evidence</summary><pre>{JSON.stringify(finding.measured, null, 2)}</pre></details>
    </li>)}</ul>;
  }
  const experimental = findings.filter(finding => finding.experimental);
  return <section aria-labelledby="findings-heading"><h2 id="findings-heading">Findings</h2>
    <p className="muted">Confidence labels and values describe measurement confidence, not probability.</p>
    {list(findings.filter(finding => !finding.experimental))}
    {experimental.length > 0 && <details><summary>Experimental findings ({experimental.length}) - unvalidated</summary>
      {list(experimental)}</details>}
  </section>;
}
export function Priorities({ result, seek }: PrioritiesProps) {
  return <section aria-labelledby="priorities-heading"><h2 id="priorities-heading">Practice suggestions</h2>
    <p className="notice">Suggestions, not measured</p>
    {result.priorities.map(priority => <article className="priority" key={priority.rank}>
      <h3>{priority.rank}. {priority.title}</h3>
      <div><h4>Observed</h4><p>{priority.observation}</p>
        <button onClick={() => seek(priority.evidence)}>Listen to observation</button></div>
      <div className="hypothesis"><h4>Possible causes (not measured)</h4>
        <ul>{priority.possible_causes.map(cause => <li key={cause}>{cause}</li>)}</ul>
        <h4>Drill (suggestion)</h4><p>{priority.drill}</p></div>
    </article>)}
    {result.listening_points.map((point, index) => <article key={index}>
      <h3>Observed</h3><p>{point.observation}</p>
      <button onClick={() => seek(point.evidence)}>Listen to observation</button>
      <h4>Drill (suggestion, if unintended)</h4><p>{point.if_unintended_try}</p>
    </article>)}
  </section>;
}
export function Results({ envelope }: ResultsProps) {
  const player = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let frame = 0;
    function monitor() {
      const audio = player.current;
      if (audio && stopAt.current !== null && audio.currentTime >= stopAt.current) {
        audio.pause(); stopAt.current = null;
      }
      frame = requestAnimationFrame(monitor);
    }
    frame = requestAnimationFrame(monitor);
    return () => cancelAnimationFrame(frame);
  }, []);
  const seek: Seek = evidence => {
    const audio = player.current;
    if (!audio) return;
    setError('');
    audio.currentTime = evidence.play_from_s;
    stopAt.current = Math.min(evidence.play_to_s, Number.isFinite(audio.duration) ? audio.duration : evidence.play_to_s);
    void audio.play().catch(error => setError(errorMessage(error)));
  };
  const result = envelope.result;
  const alignment = result.summary?.['alignment'];
  const matches = alignment && typeof alignment === 'object' && !Array.isArray(alignment) ? alignment['match'] : null;
  return <div className="panel results">
    <QualityPanel envelope={envelope} />
    <audio ref={player} aria-label="Evidence playback" controls preload="auto"
      src={`/api/takes/${envelope.take_id}/audio`} onError={() =>
        setError('Could not load normalized evidence audio. Check that this take still exists.')} />
    <p role="alert">{error}</p>
    {result.mode === 'free' && <p className="notice">No reference: describes playing, does not judge correctness.</p>}
    {!result.re_record.requested && <>
      {result.mode === 'reference' && <p className="counts">{scalar(matches)}/{scalar(result.summary?.['notes_expected'])} notes matched</p>}
      {result.mode === 'free' && result.summary && <details><summary>Descriptive summary</summary>
        <pre>{JSON.stringify(result.summary, null, 2)}</pre></details>}
      <NoteTable result={result} seek={seek} />
      <EvidenceTimeline findings={result.findings} seek={seek} />
      <FindingsList findings={result.findings} seek={seek} />
      <Priorities result={result} seek={seek} />
    </>}
    <section aria-labelledby="uncertainty-heading"><h2 id="uncertainty-heading">Uncertainty</h2>
      <ul>{result.uncertainty.map(note => <li key={note}>{note}</li>)}</ul>
      <p>Accuracy is validated only on synthetic audio. Real guitar and room reliability remains unverified.</p>
    </section>
  </div>;
}
