import type { CapturePanelProps } from './types';
import { Recorder } from './Recorder';
import { TakeReview } from './TakeReview';
import { Uploader } from './Uploader';

export function CapturePanel({
  selection, bpm, method, recording, onMethodChange, onRecorded, onSubmit, onDiscard, onPick,
}: CapturePanelProps) {
  return <section className="panel" aria-labelledby="capture-heading">
    <p className="eyebrow">02 / CAPTURE THE TAKE</p>
    <h2 id="capture-heading">{bpm} BPM / {selection.mode} mode</h2>
    {recording ? (
      <TakeReview recording={recording} onSubmit={onSubmit} onDiscard={onDiscard} />
    ) : <>
      <div className="actions">
        <button aria-pressed={method === 'record'} onClick={() => onMethodChange('record')}>
          Record
        </button>
        <button aria-pressed={method === 'upload'} onClick={() => onMethodChange('upload')}>
          Upload
        </button>
      </div>
      {method === 'record' ? (
        <Recorder selection={selection} onRecorded={onRecorded} onUpload={() => onMethodChange('upload')} />
      ) : <Uploader onRecorded={onRecorded} />}
    </>}
    <button onClick={onPick}>Pick another exercise</button>
  </section>;
}
