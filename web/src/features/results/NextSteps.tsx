import type { NextStepsProps } from './types';

export function NextSteps({ bpm, rejections, onRetry, onPick, onDelete }: NextStepsProps) {
  return <section className="next-steps" aria-labelledby="next-heading">
    <h2 id="next-heading">Your next step</h2>
    <p>Nothing changes automatically. Choose what to practise next.</p>
    <div className="actions">
      <button className="primary" onClick={() => onRetry()}>Record again</button>
      <button disabled={bpm + 5 > 240} onClick={() => onRetry(5)}>+5 BPM</button>
      <button disabled={bpm - 10 < 30} onClick={() => onRetry(-10)}>-10 BPM</button>
      <button onClick={onPick}>Pick another exercise</button>
      <button onClick={onDelete}>Delete this take</button>
    </div>
    {rejections >= 3 && <div className="notice">
      <h3>Setup checklist: 3 consecutive rejected takes</h3>
      <ul>
        <li>Clean amp channel only; gain low and EQ flat.</li>
        <li>Microphone stable, 20-40 cm from the speaker; quiet room.</li>
        <li>macOS Mic Mode Standard; no voice isolation or noise reduction.</li>
        <li>Play the click through speakers, not headphones, quieter than the guitar.</li>
        <li>Stay silent during the lead-in and count-in; keep the click running to the end.</li>
        <li>Lower input or amp volume if clipping is reported.</li>
      </ul>
    </div>}
  </section>;
}
