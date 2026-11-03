import { SCALE_CATALOG } from '../scales/theory';

export interface ScaleAttempt {
  scaleId: string;
  root: number;
  bpm: number;
  clean: boolean;
  durationSeconds: number;
}

export type QuizMode = 'intervals' | 'notes' | 'scales' | 'sequence';
export interface Mastery {
  scaleId: string;
  root: number;
  attempts: number;
  consecutive: number;
  learned: boolean;
}
export type LearningSession =
  | (ScaleAttempt & { kind: 'scale'; date: string })
  | { kind: 'quiz'; mode: QuizMode; correct: number; date: string };
export interface Progress {
  version: 1;
  xp: number;
  bestStreak: number;
  perfectQuiz: boolean;
  currentStreak: number;
  lastPracticeDate: string | null;
  mastery: Mastery[];
  sessions: LearningSession[];
  days: string[];
}

export const PROGRESS_KEY = 'coreguitar.learning.v1';
export const quizModes: readonly QuizMode[] = ['intervals', 'notes', 'scales', 'sequence'];
export const quizNames: Record<QuizMode, string> = {
  intervals: 'Intervals', notes: 'Single notes', scales: 'Scale identification', sequence: 'Fretboard sequence',
};

export function localDay(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function emptyProgress(): Progress {
  return { version: 1, xp: 0, bestStreak: 0, perfectQuiz: false, currentStreak: 0,
    lastPracticeDate: null, mastery: [], sessions: [], days: [] };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
function dateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function scaleId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
function validAttempt(value: unknown): value is ScaleAttempt {
  return object(value) && scaleId(value['scaleId']) && integer(value['root'], 0, 11)
    && integer(value['bpm'], 30, 240) && typeof value['clean'] === 'boolean'
    && typeof value['durationSeconds'] === 'number' && Number.isFinite(value['durationSeconds'])
    && value['durationSeconds'] >= 0 && value['durationSeconds'] <= 86400;
}
function validSession(value: unknown): value is LearningSession {
  if (!object(value) || !dateKey(value['date'])) return false;
  return value['kind'] === 'scale' ? validAttempt(value)
    : value['kind'] === 'quiz' && quizModes.some(mode => mode === value['mode'])
      && integer(value['correct'], 0, 10);
}
function validMastery(value: unknown): value is Mastery {
  return object(value) && scaleId(value['scaleId']) && integer(value['root'], 0, 11)
    && integer(value['attempts'], 1, Number.MAX_SAFE_INTEGER)
    && integer(value['consecutive'], 0, 3) && typeof value['learned'] === 'boolean';
}

export function parseProgress(raw: string): Progress {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Saved progress is not valid JSON. Reset learning progress to start again.'); }
  if (!object(value) || value['version'] !== 1 || !integer(value['xp'], 0, Number.MAX_SAFE_INTEGER)
    || !integer(value['bestStreak'], 0, Number.MAX_SAFE_INTEGER)
    || typeof value['perfectQuiz'] !== 'boolean'
    || !Array.isArray(value['mastery']) || value['mastery'].length > SCALE_CATALOG.length * 12 || !value['mastery'].every(validMastery)
    || !Array.isArray(value['sessions']) || value['sessions'].length > 100 || !value['sessions'].every(validSession)
    || !Array.isArray(value['days']) || value['days'].length > 366 || !value['days'].every(dateKey)) {
    throw new Error('Saved progress has an unsupported or invalid format. Reset learning progress to start again.');
  }
  const base: Omit<Progress, 'currentStreak' | 'lastPracticeDate'> = {
    version: 1, xp: value['xp'], bestStreak: value['bestStreak'], perfectQuiz: value['perfectQuiz'],
    mastery: value['mastery'], sessions: value['sessions'], days: value['days'],
  };
  if (!('currentStreak' in value) && !('lastPracticeDate' in value)) {
    let currentStreak = 0;
    let bestStreak = base.bestStreak;
    let lastPracticeDate: string | null = null;
    for (const date of [...new Set(base.days)].sort()) {
      currentStreak = lastPracticeDate && Date.parse(date) - Date.parse(lastPracticeDate) === 86400000
        ? currentStreak + 1 : 1;
      bestStreak = Math.max(bestStreak, currentStreak);
      lastPracticeDate = date;
    }
    return { ...base, bestStreak, currentStreak, lastPracticeDate };
  }
  const currentStreak = value['currentStreak'];
  const lastPracticeDate = value['lastPracticeDate'];
  if (!integer(currentStreak, 0, Number.MAX_SAFE_INTEGER) || !(lastPracticeDate === null || dateKey(lastPracticeDate))) {
    throw new Error('Saved progress has invalid streak metadata. Reset learning progress to start again.');
  }
  return { ...base, currentStreak, lastPracticeDate };
}

function withSession(progress: Progress, session: LearningSession, xp: number): Progress {
  if (!dateKey(session.date)) throw new Error('Invalid progress date.');
  const isLater = progress.lastPracticeDate === null || session.date > progress.lastPracticeDate;
  const previousDay = new Date(Date.parse(`${session.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const currentStreak = !isLater ? progress.currentStreak
    : progress.lastPracticeDate === previousDay ? progress.currentStreak + 1 : 1;
  return {
    ...progress, xp: progress.xp + xp,
    currentStreak, lastPracticeDate: isLater ? session.date : progress.lastPracticeDate,
    bestStreak: Math.max(progress.bestStreak, currentStreak),
    sessions: [session, ...progress.sessions].slice(0, 100),
    days: [...new Set([...progress.days, session.date])].sort().slice(-366),
  };
}

export function recordAttempt(progress: Progress, attempt: ScaleAttempt, date: string = localDay()): Progress {
  if (!validAttempt(attempt)) throw new Error('Invalid scale progress attempt.');
  const previous = progress.mastery.find(item => item.scaleId === attempt.scaleId && item.root === attempt.root);
  const consecutive = attempt.clean && attempt.bpm >= 120 ? Math.min(3, (previous?.consecutive ?? 0) + 1) : 0;
  const mastery: Mastery = {
    scaleId: attempt.scaleId, root: attempt.root, attempts: (previous?.attempts ?? 0) + 1, consecutive,
    learned: previous?.learned === true || consecutive >= 3,
  };
  const updated = withSession(progress, { ...attempt, kind: 'scale', date }, attempt.clean ? 10 : 2);
  return { ...updated, mastery: previous
    ? progress.mastery.map(item => item === previous ? mastery : item)
    : [...progress.mastery, mastery] };
}

export function recordQuiz(progress: Progress, mode: QuizMode, correct: number, date: string = localDay()): Progress {
  if (!quizModes.includes(mode) || !integer(correct, 0, 10)) throw new Error('Invalid quiz progress result.');
  return { ...withSession(progress, { kind: 'quiz', mode, correct, date }, correct * 5),
    perfectQuiz: progress.perfectQuiz || correct === 10 };
}

export function practiceStreak(progress: Progress, today: string = localDay()): number {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return progress.lastPracticeDate === today || progress.lastPracticeDate === yesterday ? progress.currentStreak : 0;
}
