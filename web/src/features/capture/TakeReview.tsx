import { useEffect, useState } from 'react';
import { ProcessingWarnings } from '../../components/ProcessingWarnings';
import type { TakeReviewProps } from './types';

export function TakeReview({ recording, onSubmit, onDiscard }: TakeReviewProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(recording.blob); setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording.blob]);
  return <section aria-labelledby="review-heading">
    <h3 id="review-heading">Listen before you submit</h3>
    <p>{recording.name}</p>
    <audio aria-label="Take review playback" src={url} controls onError={() =>
      setError('This browser cannot preview the original file. You can still submit it for local decoding.')} />
    <p role="alert">{error}</p>
    {recording.partial && <p className="notice">Recording was interrupted. This partial take is playable
      and can be submitted, but re-recording is recommended.</p>}
    {recording.source === 'upload' && <p className="muted">This is the original upload preview.
      After validation, both analysis and evidence playback use the same normalized take.wav.</p>}
    {recording.source === 'recording' && <ProcessingWarnings settings={recording.settings} />}
    <div className="actions"><button className="primary" onClick={onSubmit}>Submit for analysis</button>
      <button onClick={onDiscard}>Discard / Re-record</button></div>
  </section>;
}
