import { useEffect, useRef, useState } from 'react';
import { usePracticeSession } from '../session/usePracticeSession';
import { ExercisePicker } from '../features/exercise/ExercisePicker';
import { CapturePanel } from '../features/capture/CapturePanel';
import { NextSteps } from '../features/results/NextSteps';
import { Results } from '../features/results/Results';
import { ScaleStudio } from '../features/scales/ScaleStudio';
import { ChordStudio } from '../features/chords/ChordStudio';
import { Coach } from '../features/coach/Coach';
import { EarTraining } from '../features/learning/EarTraining';
import { LearningLibrary, ProgressDashboard } from '../features/learning/LearningViews';
import { useProgress } from '../features/learning/useProgress';
import { Tuner } from '../features/tuner/Tuner';
import { NoteFinder } from '../features/fretgame/NoteFinder';

const rooms = [
  { id: 'takes', name: 'Takes & feedback', title: 'Play a riff. ', accent: 'Get feedback.' },
  { id: 'scales', name: 'Fretboard', title: 'Learn the neck. ', accent: 'Find your sound.' },
  { id: 'ear', name: 'Ear training', title: 'Trust your ears. ', accent: 'Train them first.' },
  { id: 'tuner', name: 'Tuner', title: 'Tune up. ', accent: 'Then play.' },
  { id: 'notefinder', name: 'Note finder', title: 'Know the neck. ', accent: 'Note by note.' },
  { id: 'chords', name: 'ChordAI', title: 'Play a chord. ', accent: 'Build from it.' },
  { id: 'coach', name: 'Coach', title: 'Set a goal. ', accent: 'Make a plan.' },
  { id: 'library', name: 'Library', title: 'Dig deeper. ', accent: 'Play wider.' },
  { id: 'progress', name: 'Progress', title: 'Keep showing up. ', accent: 'Watch it stick.' },
] as const;
type Room = typeof rooms[number]['id'];

export function App() {
  const practice = usePracticeSession();
  const { session, bpm } = practice;
  const heading = useRef<HTMLHeadingElement>(null);
  const [room, setRoom] = useState<Room>('takes');
  const [openScale, setOpenScale] = useState<{ id: string; root: number; revision: number } | null>(null);
  const learning = useProgress();
  const currentRoom = rooms.find(item => item.id === room) ?? rooms[0];
  const captureActive = session.phase !== 'select_exercise' && session.phase !== 'results';
  const showingResults = room === 'takes' && session.phase === 'results';
  const learningContext = JSON.stringify({
    learnedCount: learning.progress.mastery.filter(item => item.learned).length,
    learned: learning.progress.mastery.filter(item => item.learned).slice(-30).map(item => ({ scale: item.scaleId, root: item.root })),
    recentPractice: learning.progress.sessions.slice(0, 5),
  });
  function showScale(id: string, root: number): void {
    setOpenScale(previous => ({ id, root, revision: (previous?.revision ?? 0) + 1 }));
    setRoom('scales');
  }

  useEffect(() => {
    heading.current?.focus();
  }, [session.phase, room]);

  return <div className="studio">
    <a href="#main" className="skip">Skip to practice</a>
    <header className="studio-header">
      <a className="wordmark" href="/"><span className="brand-pick" aria-hidden="true">/</span>CORE<span>GUITAR</span></a>
      <span className="local-label">LOCAL ONLY / NO TELEMETRY</span>
    </header>
    <nav className="studio-nav" aria-label="Practice rooms">
      {rooms.map(item => <button key={item.id} aria-current={room === item.id ? 'page' : undefined}
        disabled={captureActive && item.id !== 'takes'} onClick={() => {
          if (room === 'scales' && item.id !== 'scales') setOpenScale(null);
          setRoom(item.id);
        }}>{item.name}</button>)}
    </nav>
    <main id="main">
      <div className={`intro${showingResults ? ' intro-results' : ''}`}>
        <p className="eyebrow">{showingResults ? 'YOUR TAKE' : 'THE PRACTICE ROOM'}</p>
        <h1 ref={heading} tabIndex={-1}>{showingResults
          ? <>Your take. <em>Pick one improvement.</em></>
          : <>{currentRoom.title}<em>{currentRoom.accent}</em></>}</h1>
        <p className="intro-description">
          {showingResults
            ? 'Review the summary below, then choose how you want to continue.'
            : room === 'takes' ? <>Pick a riff, record or upload a take, then see where your timing and notes drifted.
              No guitar handy? Use <strong>Try a demo take</strong>.</>
              : <>Explore scales, sharpen your ear, and build a practice habit. Same room. Everything stays local.</>}
        </p>
      </div>
      <p role="alert" className={learning.error ? 'notice' : ''}>{learning.error}</p>
      {room === 'takes' && <>
      {!showingResults && <>
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
      </>}
      {captureActive && <p className="muted">Finish this take or pick another exercise before switching practice rooms.</p>}
      <p role="alert" className={session.error ? 'notice' : ''}>{session.error}</p>
      <div className={`practice-layout${showingResults ? ' results-layout' : ''}`}>
        <div className="practice-workspace">
          {session.phase === 'select_exercise' && <ExercisePicker onSelect={practice.select} onDemo={selection => void practice.demo(selection)} />}
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
            <Results envelope={session.envelope} nextSteps={
              <NextSteps bpm={bpm} rejections={session.rejections}
                onRetry={practice.retry} onPick={practice.pick}
                onDelete={() => void practice.remove(false)} />
            } />
          </>}
        </div>
        {!showingResults && <aside className="signal-guide" aria-labelledby="setup-heading">
          <p className="eyebrow">THE SIGNAL CHAIN</p>
          <h2 id="setup-heading">Before you <br />hit record</h2>
          <ol className="setup-list">
            <li><strong>Guitar into amp</strong><span>Clean channel. No distortion.</span></li>
            <li><strong>One note at a time</strong><span>Save chords and backing tracks for the jam.</span></li>
            <li><strong>Let the click through</strong><span>Use speakers, not headphones. The mic needs to hear guitar and click.</span></li>
          </ol>
          <p className="room-note">Rock is the attitude.<br /><strong>Clean is the signal.</strong></p>
          <p className="muted">Everything stays on this computer. No cloud uploads. No telemetry.</p>
        </aside>}
      </div>
      </>}
      {room === 'scales' && <ScaleStudio key={openScale?.revision ?? 0}
        {...(openScale ? { initialScaleId: openScale.id, initialRoot: openScale.root } : {})}
        onAttempt={learning.attempt} />}
      {room === 'ear' && <EarTraining onComplete={learning.quiz} />}
      {room === 'tuner' && <Tuner />}
      {room === 'notefinder' && <NoteFinder />}
      {room === 'chords' && <ChordStudio context={learningContext} />}
      {room === 'coach' && <Coach context={learningContext} onOpenScale={showScale} />}
      {room === 'library' && <LearningLibrary progress={learning.progress} onOpen={showScale} />}
      {room === 'progress' && <ProgressDashboard progress={learning.progress} onOpen={showScale} onReset={learning.reset} />}
    </main>
    <footer className="studio-footer">
      <p>
        All processing stays on this computer. No cloud AI. Takes are kept until you delete them.<br />
        Learning progress lives in this browser. Audio detection is experimental, not validated on real guitar recordings.
      </p>
      <button onClick={() => void practice.remove(true)}>Delete all saved takes</button>
    </footer>
  </div>;
}
