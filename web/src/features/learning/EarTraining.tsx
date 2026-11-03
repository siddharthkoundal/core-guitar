import { useEffect, useRef, useState } from 'react';
import { playNotes, stopNotes } from '../scales/sound';
import { SCALE_CATALOG, noteName } from '../scales/theory';
import { quizModes, quizNames } from './progress';
import type { QuizMode } from './progress';

interface Question {
  prompt: string;
  notes: number[];
  answer: string;
  options: string[];
}
interface EarTrainingProps {
  onComplete: (mode: QuizMode, correct: number) => void;
}
const intervals = ['Minor second', 'Major second', 'Minor third', 'Major third', 'Perfect fourth',
  'Tritone', 'Perfect fifth', 'Minor sixth', 'Major sixth', 'Minor seventh', 'Major seventh', 'Octave'];

function choose<T>(values: readonly T[], random: () => number): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('No ear-training choices are available.');
  return value;
}
function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    const previous = result[index];
    const replacement = result[target];
    if (previous !== undefined && replacement !== undefined) {
      result[index] = replacement; result[target] = previous;
    }
  }
  return result;
}

export function makeQuestion(mode: QuizMode, random: () => number = Math.random): Question {
  const root = 60 + Math.floor(random() * 12);
  let prompt: string;
  let notes: number[];
  let answer: string;
  let candidates: string[];
  switch (mode) {
    case 'intervals': {
      const interval = 1 + Math.floor(random() * 12);
      answer = intervals[interval - 1] ?? 'Octave';
      candidates = intervals.filter(name => name !== answer);
      notes = [root, root + interval];
      prompt = 'Name the ascending interval.';
      break;
    }
    case 'notes':
      notes = [root];
      answer = noteName(root);
      candidates = Array.from({ length: 12 }, (_, index) => noteName(60 + index)).filter(name => name !== answer);
      prompt = 'Name the note. Use Replay reference C for a pitch reference.';
      break;
    case 'scales': {
      const signatures = new Set<string>();
      const scales = SCALE_CATALOG.filter(scale => {
        const key = scale.intervals.join(',');
        if (signatures.has(key)) return false;
        signatures.add(key); return true;
      });
      const scale = choose(scales, random);
      notes = [...scale.intervals.map(interval => root + interval), root + 12];
      answer = scale.name;
      candidates = scales.filter(item => item !== scale).map(item => item.name);
      prompt = 'Identify the scale played from its root to the octave.';
      break;
    }
    case 'sequence': {
      const sequences = [[0, 2, 4], [0, 4, 2], [4, 2, 0], [2, 0, 4]];
      const selected = choose(sequences, random);
      notes = selected.map(interval => root + interval);
      answer = notes.map(noteName).join(' → ');
      candidates = sequences.filter(item => item !== selected)
        .map(sequence => sequence.map(interval => noteName(root + interval)).join(' → '));
      prompt = 'Listen, then choose the fretboard note sequence in the order played.';
      break;
    }
  }
  const distractors = shuffled(candidates, random).slice(0, 3);
  return { prompt, notes, answer, options: shuffled([answer, ...distractors], random) };
}

export function EarTraining({ onComplete }: EarTrainingProps) {
  const [mode, setMode] = useState<QuizMode>('intervals');
  const [quiz, setQuiz] = useState<{ questions: Question[]; index: number; correct: number; selected: string | null } | null>(null);
  const [finished, setFinished] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; stopNotes(); }, []);
  function stop(): void { generation.current++; stopNotes(); setPlaying(false); setError(''); }
  async function play(notes: number[]): Promise<void> {
    stop();
    const current = generation.current;
    setPlaying(true);
    try { await playNotes(notes, 100); }
    catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : 'Audio playback failed.');
    } finally { if (current === generation.current) setPlaying(false); }
  }
  const question = quiz?.questions[quiz.index];
  return <section className="panel" aria-labelledby="ear-heading">
    <p className="eyebrow">LISTEN / RECOGNIZE / REPEAT</p>
    <h2 id="ear-heading">Ear training</h2>
    <p className="muted">Ten questions, four ways to listen. These quizzes use synthesized notes, not microphone assessment.</p>
    {!quiz && <>
      <label>Ear-training mode<select value={mode} onChange={event => {
        const value = quizModes.find(item => item === event.target.value);
        if (value) { setMode(value); setFinished(null); }
      }}>{quizModes.map(value => <option key={value} value={value}>{quizNames[value]}</option>)}</select></label>
      {finished !== null && <p className="verdict" role="status">{finished} / 10 correct</p>}
      <button className="primary" onClick={() => {
        stop(); setFinished(null);
        setQuiz({ questions: Array.from({ length: 10 }, () => makeQuestion(mode)), index: 0, correct: 0, selected: null });
      }}>Start 10-question quiz</button>
    </>}
    {quiz && question && <>
      <p className="eyebrow">QUESTION {quiz.index + 1} / 10 · {quizNames[mode]}</p>
      <h3>{question.prompt}</h3>
      <div className="actions">
        <button onClick={() => void play(question.notes)}>{playing ? 'Replay question' : 'Play question'}</button>
        {mode === 'notes' && <button onClick={() => void play([60])}>Replay reference C</button>}
        <button onClick={stop}>Stop audio</button>
      </div>
      <div className="quiz-answers" role="group" aria-label="Answer choices">{question.options.map(option => <button key={option}
        disabled={quiz.selected !== null} aria-pressed={quiz.selected === option}
        onClick={() => { stop(); setQuiz({ ...quiz, selected: option, correct: quiz.correct + Number(option === question.answer) }); }}>
        {option}
      </button>)}</div>
      <p role="status">{quiz.selected !== null
        ? `${quiz.selected === question.answer ? 'Correct.' : 'Not quite.'} ${question.answer}.` : 'Play the audio when you are ready.'}</p>
      <div className="actions">
        <button className="primary" disabled={quiz.selected === null} onClick={() => {
          stop();
          if (quiz.index === 9) { onComplete(mode, quiz.correct); setFinished(quiz.correct); setQuiz(null); }
          else setQuiz({ ...quiz, index: quiz.index + 1, selected: null });
        }}>{quiz.index === 9 ? 'Finish quiz' : 'Next question'}</button>
        <button onClick={() => { stop(); setQuiz(null); }}>Cancel quiz</button>
      </div>
    </>}
    <p role="alert" className={error ? 'notice' : ''}>{error}</p>
  </section>;
}
