import { useEffect, useRef } from 'react';
import { usePracticeSession } from '../session/usePracticeSession';
import { ExercisePicker } from '../features/exercise/ExercisePicker';
import { CapturePanel } from '../features/capture/CapturePanel';
import { NextSteps } from '../features/results/NextSteps';
import { Results } from '../features/results/Results';

export function App() {
  const practice = usePracticeSession();
  const { session, bpm } = practice;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [session.phase]);

  return <div className="studio">
    <a href="#main" className="skip">Skip to practice</a>
    <header className="studio-header">
      <a className="wordmark" href="/"><span className="brand-pick" aria-hidden="true">/</span>CORE<span>GUITAR</span></a>
      <span className="local-label">LOCAL ONLY / NO TELEMETRY</span>
    </header>
    <main id="main">
      <div className="intro">
        <div className="intro-copy">
          <p className="eyebrow">PLUG IN. LOCK IN. / THE PRACTICE ROOM</p>
          <h1 ref={heading} tabIndex={-1}>
            Less talk.<br /><em>More rock.</em>
          </h1>
          <p className="intro-description">
            Work the riff. Hear the take. Come back tighter.<br />
            Clean tone. Single notes. No scores. Just your playing.
          </p>
        </div>
        <div className="amp-art" aria-hidden="true">
          <div className="amp-controls"><span>CORE / 01</span><i /><i /><i /><b /></div>
          <div className="amp-grille">
            <svg className="pick-art" viewBox="0 0 240 260" focusable="false">
              <path d="M120 12C67 12 22 30 22 68c0 63 70 163 98 180 28-17 98-117 98-180 0-38-45-56-98-56Z" />
              <path className="pick-slash" d="m139 55-58 92h37l-18 60 65-101h-40Z" />
            </svg>
            <span className="amp-caption">BUILT FOR THE WOODSHED</span>
          </div>
        </div>
      </div>
      <ol className="session-steps" aria-label="Practice progress">
        <li aria-current={session.phase === 'select_exercise' ? 'step' : undefined}>
          <span aria-hidden="true">01</span>Choose your riff
        </li>
        <li aria-current={session.phase !== 'select_exercise' && session.phase !== 'results' ? 'step' : undefined}>
          <span aria-hidden="true">02</span>Capture a take
        </li>
        <li aria-current={session.phase === 'results' ? 'step' : undefined}>
          <span aria-hidden="true">03</span>Listen &amp; refine
        </li>
      </ol>
      <p className="session-status" aria-live="polite">
        Session: {session.phase.replaceAll('_', ' ')}
      </p>
      <p role="alert" className={session.error ? 'notice' : ''}>{session.error}</p>
      <div className="practice-layout">
        <div className="practice-workspace">
          {session.phase === 'select_exercise' && <ExercisePicker onSelect={practice.select} />}
          {session.phase === 'capture' && session.selection && <CapturePanel
            selection={session.selection}
            bpm={bpm}
            method={practice.method}
            recording={practice.recording}
            onMethodChange={practice.setMethod}
            onRecorded={practice.setRecording}
            onSubmit={() => void practice.submit()}
            onDiscard={practice.discard}
            onPick={practice.pick}
          />}
          {practice.busy && <section className="panel" aria-live="polite">
            <h2>{session.phase === 'analyzing'
              ? 'Analyzing locally' : 'Uploading and validating locally'}</h2>
            <p>The analysis uses the normalized WAV. Settings and thresholds stay unchanged.</p>
            {session.phase === 'analyzing' &&
              <button onClick={() => void practice.cancel()}>Cancel analysis</button>}
          </section>}
          {session.phase === 'results' && session.envelope && <>
            <Results envelope={session.envelope} />
            <NextSteps bpm={bpm} rejections={session.rejections}
              onRetry={practice.retry} onPick={practice.pick}
              onDelete={() => void practice.remove(false)} />
          </>}
        </div>
        <aside className="signal-guide" aria-labelledby="setup-heading">
          <p className="eyebrow">THE SIGNAL CHAIN</p>
          <h2 id="setup-heading">Before you <br />hit record</h2>
          <ol className="setup-list">
            <li><strong>Guitar into amp</strong><span>Clean channel. No distortion.</span></li>
            <li><strong>One note at a time</strong><span>Save chords and backing tracks for the jam.</span></li>
            <li><strong>Let the click through</strong><span>Use speakers, not headphones. The mic needs to hear guitar and click.</span></li>
          </ol>
          <p className="room-note">Rock is the attitude.<br /><strong>Clean is the signal.</strong></p>
          <p className="muted">Everything stays on this computer. No cloud uploads. No telemetry.</p>
        </aside>
      </div>
    </main>
    <footer className="studio-footer">
      <p>
        All processing stays on this computer. Takes are kept until you delete them.<br />
        Accuracy is checked on synthetic audio, not yet real guitar recordings.
      </p>
      <button onClick={() => void practice.remove(true)}>Delete all saved takes</button>
    </footer>
  </div>;
}
