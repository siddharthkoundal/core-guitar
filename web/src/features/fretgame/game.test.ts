import { afterEach, expect, it, vi } from 'vitest';
import { midiToFrequency } from '../../audio/pitch';
import {
  activeStrings, answerRound, applyRecords, candidatePrompts, DEFAULT_SETTINGS, emptyStore, evaluate, failRound, heatCell,
  heatLevel, loadStore, MAX_STORE_BYTES, nextPrompt, parseStore, positionsInRange, positionWeight, promptText, requiredMidis,
  saveStore, StableNoteGate, startRound, statKey, STORE_KEY, tuningMidi, validSettings,
} from './game';
import type { GameSettings, Prompt } from './game';

const STANDARD = tuningMidi('standard');
const settings = (change: Partial<GameSettings> = {}): GameSettings => ({ ...DEFAULT_SETTINGS, ...change });
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('builds positions and prompts for the chosen strings, frets and note set', () => {
  expect(positionsInRange(settings({ strings: [5], minFret: 0, maxFret: 3 }), STANDARD).map(p => p.midi)).toEqual([64, 65, 66, 67]);
  expect(activeStrings(settings({ strings: [9] }), 6)).toEqual([0, 1, 2, 3, 4, 5]);
  const find = candidatePrompts(settings({ strings: [3], minFret: 0, maxFret: 12 }), STANDARD);
  expect(find).toHaveLength(7);
  const g = find.find(prompt => prompt.pitchClass === 7);
  expect(g?.targets.map(target => target.fret)).toEqual([0, 12]);
  expect(candidatePrompts(settings({ strings: [3], naturalsOnly: false }), STANDARD)).toHaveLength(12);
  const names = candidatePrompts(settings({ mode: 'name', strings: [0], maxFret: 4 }), STANDARD);
  expect(names.map(prompt => prompt.targets[0]?.fret)).toEqual([0, 1, 3]);
  const octaves = candidatePrompts(settings({ mode: 'octaves', maxFret: 12 }), STANDARD);
  const e = octaves.find(prompt => prompt.pitchClass === 4)!;
  expect(requiredMidis(e)).toEqual([40, 52, 64, 76]);
  expect(promptText(g!, settings(), 6)).toBe('Play G on string 3');
  expect(promptText(names[0]!, settings({ answer: 'live' }), 6)).toBe('Play the highlighted position');
  expect(promptText(names[0]!, settings(), 6)).toBe('Name the highlighted note');
  expect(promptText(e, settings(), 6)).toBe('Play every E (4 pitches)');
  expect(tuningMidi('unknown')).toEqual(STANDARD);
});

it('weights unseen, missed and slow positions above mastered ones and avoids repeats', () => {
  expect(positionWeight(undefined)).toBe(3);
  const mastered = positionWeight({ attempts: 10, correct: 10, totalMs: 10000 });
  const missed = positionWeight({ attempts: 10, correct: 2, totalMs: 4000 });
  const slow = positionWeight({ attempts: 10, correct: 10, totalMs: 80000 });
  expect(mastered).toBe(1);
  expect(missed).toBeGreaterThan(slow);
  expect(slow).toBeGreaterThan(mastered);
  expect(positionWeight({ attempts: 2, correct: 0, totalMs: 0 })).toBeGreaterThan(missed);
  const options = settings({ mode: 'name', strings: [0], minFret: 0, maxFret: 1, naturalsOnly: false });
  const stats = { [statKey('standard', 0, 0)]: { attempts: 10, correct: 10, totalMs: 5000 },
    [statKey('standard', 0, 1)]: { attempts: 10, correct: 0, totalMs: 0 } };
  let picks = 0;
  for (let index = 0; index < 50; index++) picks += Number(nextPrompt(options, stats, () => index / 50)?.targets[0]?.fret === 1);
  expect(picks).toBeGreaterThan(40);
  const first = nextPrompt(options, {}, () => 0)!;
  expect(nextPrompt(options, {}, () => 0, first)?.targets[0]?.fret).not.toBe(first.targets[0]?.fret);
  expect(nextPrompt(settings({ strings: [0], minFret: 1, maxFret: 1, naturalsOnly: true }), {}, () => 0)?.pitchClass).toBe(5);
  expect(nextPrompt(settings({ strings: [0], minFret: 2, maxFret: 2, naturalsOnly: true }), {}, () => 0)).toBeNull();
});

it('scores pitch, position and note-name answers for each mode', () => {
  const [g] = candidatePrompts(settings({ strings: [3], minFret: 0, maxFret: 0 }), STANDARD) as [Prompt];
  expect(evaluate(g, { kind: 'midi', midi: 55 }, [], STANDARD).outcome).toBe('correct');
  expect(evaluate(g, { kind: 'midi', midi: 67 }, [], STANDARD).outcome).toBe('wrong');
  expect(evaluate(g, { kind: 'position', string: 3, fret: 0 }, [], STANDARD).outcome).toBe('correct');
  expect(evaluate(g, { kind: 'position', string: 2, fret: 5 }, [], STANDARD)).toEqual({ outcome: 'wrong', midi: 55 });
  expect(evaluate(g, { kind: 'pitchClass', pitchClass: 7 }, [], STANDARD).outcome).toBe('wrong');
  const name: Prompt = { mode: 'name', pitchClass: 9, string: 0, targets: [{ string: 0, fret: 5, midi: 45 }] };
  expect(evaluate(name, { kind: 'pitchClass', pitchClass: 9 }, [], STANDARD).outcome).toBe('correct');
  expect(evaluate(name, { kind: 'midi', midi: 45 }, [], STANDARD).outcome).toBe('correct');
  const octave: Prompt = { mode: 'octaves', pitchClass: 4, string: null,
    targets: [{ string: 0, fret: 0, midi: 40 }, { string: 1, fret: 7, midi: 52 }] };
  expect(evaluate(octave, { kind: 'midi', midi: 40 }, [], STANDARD).outcome).toBe('progress');
  expect(evaluate(octave, { kind: 'midi', midi: 40 }, [40], STANDARD).outcome).toBe('repeat');
  expect(evaluate(octave, { kind: 'position', string: 1, fret: 7 }, [40], STANDARD).outcome).toBe('correct');
  expect(evaluate(octave, { kind: 'midi', midi: 64 }, [], STANDARD).outcome).toBe('wrong');
});

it('plays a round: first-try scoring, mistakes, octaves progress, skip and timeout records', () => {
  const options = settings({ strings: [3], minFret: 0, maxFret: 4, roundLength: 10 });
  let round = startRound(options, {}, 0, () => 0);
  expect(round.prompt?.pitchClass).toBe(7);
  let step = answerRound(round, { kind: 'midi', midi: 57 }, {}, 500, () => 0);
  expect(step.outcome).toBe('wrong');
  expect(step.round.feedback).toBe('Heard A3 — not it. Try again.');
  step = answerRound(step.round, { kind: 'position', string: 3, fret: 0 }, {}, 1500, () => 0);
  expect(step.outcome).toBe('correct');
  expect(step.records).toEqual([{ key: 'standard:3:0', correct: false, ms: 1500 }]);
  expect(step.round.feedback).toBe('Correct — G3 at string 3, fret 0 in 1.5 s.');
  expect(step.round.firstTry).toBe(0);
  round = step.round;
  step = answerRound(round, { kind: 'position', string: 3, fret: round.prompt!.targets[0]!.fret }, {}, 2500, () => 0);
  expect(step.round.firstTry).toBe(1);
  expect(step.records[0]?.correct).toBe(true);
  step = failRound(step.round, 'skip', {}, 3000, () => 0);
  expect(step.round.feedback).toMatch(/^Skipped — .+ is at string 3, fret \d\.$/);
  expect(step.records.every(record => !record.correct)).toBe(true);
  step = failRound(step.round, 'timeout', {}, 4000, () => 0);
  expect(step.round.feedback).toMatch(/^Time's up/);
  expect(step.round.index).toBe(4);

  const octaves = startRound(settings({ mode: 'octaves', strings: [0, 1], maxFret: 7, roundLength: 10 }), {}, 0, () => 0);
  expect(requiredMidis(octaves.prompt!)).toEqual([40, 52]);
  let next = answerRound(octaves, { kind: 'midi', midi: 40 }, {}, 800, () => 0);
  expect(next.outcome).toBe('progress');
  expect(next.round.feedback).toBe('E2 ✓ — 1 to go.');
  expect(answerRound(next.round, { kind: 'midi', midi: 40 }, {}, 900).round.feedback).toBe('E2 is already ticked off.');
  next = failRound(next.round, 'timeout', {}, 1000, () => 0);
  expect(next.round.feedback).toBe("Time's up — E: E3 still missing.");
  expect(next.records.filter(record => record.correct)).toHaveLength(0);
  const solved = answerRound(answerRound(octaves, { kind: 'midi', midi: 40 }, {}, 500).round, { kind: 'midi', midi: 52 }, {}, 1000, () => 0);
  expect(solved.outcome).toBe('correct');
  expect(solved.records).toContainEqual({ key: 'standard:0:0', correct: true, ms: 500 });
  expect(solved.records).toContainEqual({ key: 'standard:1:7', correct: true, ms: 1000 });
});

it('finishes after the round length and ignores answers afterwards', () => {
  let round = startRound(settings({ mode: 'name', strings: [0], maxFret: 5, roundLength: 10 }), {}, 0, () => 0);
  for (let index = 0; index < 10; index++) {
    round = answerRound(round, { kind: 'pitchClass', pitchClass: round.prompt!.pitchClass }, {}, index * 1000 + 700, () => 0.5).round;
  }
  expect(round.prompt).toBeNull();
  expect(round.firstTry).toBe(10);
  expect(round.solvedMs).toHaveLength(10);
  expect(answerRound(round, { kind: 'pitchClass', pitchClass: 0 }, {}, 0).records).toEqual([]);
  expect(failRound(round, 'skip', {}, 0).records).toEqual([]);
});

it('accumulates bounded per-position statistics and heat levels', () => {
  const stats = applyRecords({}, [
    { key: 'standard:0:0', correct: true, ms: 1200.4 },
    { key: 'standard:0:0', correct: false, ms: null },
    { key: 'standard:0:1', correct: false, ms: 900 },
  ]);
  expect(stats['standard:0:0']).toEqual({ attempts: 2, correct: 1, totalMs: 1200 });
  expect(stats['standard:0:1']).toEqual({ attempts: 1, correct: 0, totalMs: 0 });
  expect(heatCell(stats['standard:0:0'])).toEqual({ accuracy: 50, averageMs: 1200, attempts: 2 });
  expect(heatCell(stats['standard:0:1'])).toEqual({ accuracy: 0, averageMs: null, attempts: 1 });
  expect(heatLevel(heatCell(undefined))).toBe(0);
  expect(heatLevel({ accuracy: 10, averageMs: null, attempts: 1 })).toBe(1);
  expect(heatLevel({ accuracy: 60, averageMs: null, attempts: 1 })).toBe(2);
  expect(heatLevel({ accuracy: 90, averageMs: null, attempts: 1 })).toBe(3);
});

it('persists versioned stats and rejects corrupt, oversized or obsolete storage', () => {
  expect(loadStore()).toEqual({ store: emptyStore(), error: null });
  const store = { ...emptyStore(), stats: { 'dropD:0:3': { attempts: 3, correct: 2, totalMs: 4000 } },
    settings: settings({ mode: 'octaves', tuningId: 'dropD', strings: [0, 2], maxFret: 24, answer: 'live', timerSeconds: 10, roundLength: 20 }) };
  expect(saveStore(store)).toBeNull();
  expect(loadStore()).toEqual({ store, error: null });
  const withExtra = JSON.parse(localStorage.getItem(STORE_KEY)!) as Record<string, unknown>;
  localStorage.setItem(STORE_KEY, JSON.stringify({ ...withExtra, extra: true, settings: { ...store.settings, mode: 'bogus' } }));
  expect(loadStore().store.settings).toEqual(DEFAULT_SETTINGS);
  for (const raw of ['{', JSON.stringify({ version: 2, stats: {} }), JSON.stringify({ version: 1, stats: [] }),
    JSON.stringify({ version: 1, stats: { 'nope:0:0': { attempts: 1, correct: 0, totalMs: 0 } } }),
    JSON.stringify({ version: 1, stats: { 'standard:0:25': { attempts: 1, correct: 0, totalMs: 0 } } }),
    JSON.stringify({ version: 1, stats: { 'standard:0:1': { attempts: 1, correct: 2, totalMs: 0 } } }),
    'x'.repeat(MAX_STORE_BYTES + 1)]) {
    localStorage.setItem(STORE_KEY, raw);
    const loaded = loadStore();
    expect(loaded.error).toMatch(/could not be restored/);
    expect(loaded.store).toEqual(emptyStore());
  }
  expect(() => parseStore(JSON.stringify({ version: 1, stats: Object.fromEntries(Array.from({ length: 3001 },
    (_, index) => [`standard:0:${index}`, { attempts: 0, correct: 0, totalMs: 0 }])) }))).toThrow();
  expect(saveStore({ ...store, settings: { ...store.settings, minFret: 9, maxFret: 3 } })).toMatch(/could not be saved/);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(saveStore(store)).toMatch(/quota/);
  expect(validSettings(null)).toBe(false);
  expect(validSettings({ ...DEFAULT_SETTINGS, strings: [0, 0] })).toBe(false);
});

it('emits a note only after three stable, in-tune frames, once per attack and not right after a correct answer', () => {
  const gate = new StableNoteGate();
  const read = (midi: number, cents = 0) => ({ frequency: midiToFrequency(midi) * 2 ** (cents / 1200), clarity: 0.95, rms: 0.1 });
  expect(gate.feed(read(55), 0)).toBeNull();
  expect(gate.feed(read(55, 45), 60)).toBeNull();
  expect(gate.feed(read(55), 120)).toBeNull();
  expect(gate.feed(read(55), 180)).toBeNull();
  expect(gate.feed(read(55, -30), 240)).toBe(55);
  expect(gate.feed(read(55), 300)).toBeNull();
  gate.pause(300);
  expect(gate.feed(read(57), 360)).toBeNull();
  expect(gate.feed(read(57), 420)).toBeNull();
  expect(gate.feed(read(57), 480)).toBeNull();
  expect(gate.feed(read(57), 610)).toBe(57);
  expect(gate.feed(null, 700)).toBeNull();
  for (const now of [760, 820]) expect(gate.feed(read(57), now)).toBeNull();
  expect(gate.feed(read(57), 880)).toBe(57);
  expect(new StableNoteGate().feed(read(69, 0), 0, 432)).toBeNull();
});
