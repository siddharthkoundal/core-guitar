import { useState } from 'react';
import { SCALE_CATALOG, noteName } from '../scales/theory';
import { practiceStreak, quizNames } from './progress';
import type { Progress } from './progress';

interface LibraryProps {
  progress: Progress;
  onOpen: (scaleId: string, root: number) => void;
}
interface ProgressProps extends LibraryProps {
  onReset: () => void;
}
function scaleName(id: string): string { return SCALE_CATALOG.find(scale => scale.id === id)?.name ?? id; }

export function LearningLibrary({ progress, onOpen }: LibraryProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [root, setRoot] = useState(0);
  const categories = [...new Set(SCALE_CATALOG.map(scale => scale.category))];
  const filtered = SCALE_CATALOG.filter(scale => (category === 'all' || scale.category === category)
    && `${scale.name} ${scale.category}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <section className="panel" aria-labelledby="library-heading">
    <p className="eyebrow">KNOW THE NECK</p>
    <h2 id="library-heading">Scale library</h2>
    <p className="muted">{SCALE_CATALOG.length} scales. Every key. Your tuning. Open any scale to explore, hear it, and practice.</p>
    <div className="form-row">
      <label>Find a scale<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Scale category<select value={category} onChange={event => setCategory(event.target.value)}>
        <option value="all">All categories</option>
        {categories.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Library root<select value={root} onChange={event => setRoot(Number(event.target.value))}>
        {Array.from({ length: 12 }, (_, value) => <option key={value} value={value}>{noteName(60 + value)}</option>)}
      </select></label>
    </div>
    <p role="status">{filtered.length} scales shown</p>
    <ul className="scale-library">{filtered.map(scale => {
      const learned = progress.mastery.some(item => item.scaleId === scale.id && item.root === root && item.learned);
      return <li key={scale.id}>
        <div><p className="eyebrow">{scale.category}</p><h3>{scale.name}</h3>
          <p className="muted">{scale.intervals.length} notes · {scale.intervals.join(' – ')} semitones</p>
          {learned && <strong className="learned-badge">Learned in this key</strong>}
        </div>
        <button onClick={() => onOpen(scale.id, root)}>Open {scale.name} on fretboard</button>
      </li>;
    })}</ul>
    {filtered.length === 0 && <p>No scales match. Clear your search or choose another category.</p>}
  </section>;
}

export function ProgressDashboard({ progress, onReset, onOpen }: ProgressProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const learned = progress.mastery.filter(item => item.learned);
  const streak = practiceStreak(progress);
  const achievements = [
    { name: 'First steps', earned: progress.sessions.length > 0, rule: 'Finish a practice run or ear quiz.' },
    { name: 'Scale keeper', earned: learned.length > 0, rule: 'Learn your first scale in one key.' },
    { name: 'Open ears', earned: progress.perfectQuiz, rule: 'Complete a perfect ear-training quiz.' },
    { name: 'Three-day rhythm', earned: progress.bestStreak >= 3, rule: 'Practice on three consecutive days.' },
    { name: 'Explorer', earned: learned.length >= 5, rule: 'Learn five scale/key combinations.' },
  ];
  return <section className="panel" aria-labelledby="progress-heading">
    <p className="eyebrow">SMALL RUNS / LASTING HABITS</p>
    <h2 id="progress-heading">Your progress</h2>
    <div className="learning-stats">
      <p><strong>{progress.xp} XP</strong><span>Level {1 + Math.floor(progress.xp / 100)}</span></p>
      <p><strong>{streak} days</strong><span>Current practice streak</span></p>
      <p><strong>{learned.length} learned</strong><span>Scale/key combinations</span></p>
    </div>
    <p className="muted">Practice XP is a habit tracker, not a recording-quality score. Three consecutive clean Sequence runs
      at 120 BPM or faster earn a learned badge. A later miss resets the run count, not the badge.</p>
    <h3>Achievements</h3>
    <ul className="achievements">{achievements.map(item => <li key={item.name}>
      <strong>{item.name}</strong><span>{item.earned ? 'Unlocked' : 'Not yet'} · {item.rule}</span>
    </li>)}</ul>
    <h3>Scale mastery</h3>
    {progress.mastery.length === 0 && <p>Finish a Sequence practice run to begin tracking mastery.</p>}
    <ul className="mastery-list">{progress.mastery.map(item => <li key={`${item.scaleId}:${item.root}`}>
      <span>{noteName(60 + item.root)} {scaleName(item.scaleId)} · {item.learned ? 'Learned' : `${item.consecutive} / 3 clean runs`} · {item.attempts} attempts</span>
      <button onClick={() => onOpen(item.scaleId, item.root)}>Practice {noteName(60 + item.root)} {scaleName(item.scaleId)} again</button>
    </li>)}</ul>
    <h3>Recent sessions</h3>
    <p className="muted">The most recent 100 completed sessions are kept in this browser.</p>
    <ol className="session-log">{progress.sessions.slice(0, 20).map((session, index) => <li key={`${session.date}:${index}`}>
      <time dateTime={session.date}>{session.date}</time>{' / '}
      {session.kind === 'quiz' ? `${quizNames[session.mode]}: ${session.correct}/10`
        : `${noteName(60 + session.root)} ${scaleName(session.scaleId)}: ${session.bpm} BPM, ${session.clean ? 'clean run' : 'keep practicing'}`}
    </li>)}</ol>
    {!confirmReset ? <button onClick={() => setConfirmReset(true)}>Reset learning progress</button>
      : <div className="notice"><p>Clear XP, scale mastery, achievements and session history? Saved audio takes are not affected.</p>
        <div className="actions"><button onClick={() => { onReset(); setConfirmReset(false); }}>Confirm reset progress</button>
          <button onClick={() => setConfirmReset(false)}>Keep progress</button></div></div>}
  </section>;
}
