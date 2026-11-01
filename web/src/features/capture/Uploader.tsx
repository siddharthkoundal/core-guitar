import { useState } from 'react';
import type { UploaderProps } from './types';

export function Uploader({ onRecorded }: UploaderProps) {
  const [error, setError] = useState('');
  return <section aria-labelledby="upload-heading">
    <h3 id="upload-heading">Bring your own recording</h3>
    <p>WAV, WebM/Opus, Ogg/Opus, M4A, or other supported audio. 2-180 seconds, up to 100 MB.
      File content, not its name or MIME type, determines whether it is supported.</p>
    <label>Audio file<input type="file" onChange={event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 100 * 1024 * 1024) {
        setError('File exceeds 100 MB. Choose a smaller recording.'); return;
      }
      setError('');
      onRecorded({ blob: file, name: file.name, source: 'upload', partial: false, settings: {} });
    }} /></label>
    <p role="alert">{error}</p>
  </section>;
}
