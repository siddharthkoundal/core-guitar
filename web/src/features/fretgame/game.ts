import { frequencyToMidi } from "../../audio/pitch";
import type { PitchReading } from "../../audio/pitch";
import { noteName, TUNINGS } from "../scales/theory";

export type GameMode = "find" | "name" | "octaves";
export type AnswerMode = "live" | "click";
export const GAME_MODES: readonly GameMode[] = ["find", "name", "octaves"];
export const MODE_NAMES: Record<GameMode, string> = {
  find: "Find the note", name: "Name the position", octaves: "All octaves",
};
export const ROUND_LENGTHS = [10, 20] as const;
export const TIMER_CHOICES = [0, 5, 10, 15] as const;
export type RoundLength = typeof ROUND_LENGTHS[number];
export type TimerSeconds = typeof TIMER_CHOICES[number];

export interface GameSettings {
  mode: GameMode;
  tuningId: string;
  /** Zero-based, low string first. */
  strings: number[];
  minFret: number;
  maxFret: number;
  naturalsOnly: boolean;
  roundLength: RoundLength;
  timerSeconds: TimerSeconds;
  answer: AnswerMode;
}
export interface PositionStat { attempts: number; correct: number; totalMs: number }
export type Stats = Record<string, PositionStat>;
export interface FretGameStore { version: 1; settings: GameSettings; stats: Stats }

export const STORE_KEY = "coreguitar.fretgame.v1";
export const MAX_STORE_BYTES = 200000;
export const MAX_STAT_ENTRIES = 3000;
export const MAX_FRET = 24;
export const NATURALS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
export const DEFAULT_SETTINGS: GameSettings = {
  mode: "find", tuningId: "standard", strings: [0, 1, 2, 3, 4, 5], minFret: 0, maxFret: 12,
  naturalsOnly: true, roundLength: 10, timerSeconds: 0, answer: "click",
};

export interface Position { string: number; fret: number; midi: number }
export interface Prompt {
  mode: GameMode;
  pitchClass: number;
  /** Target string for "find"; the highlighted position's string for "name". */
  string: number | null;
  targets: Position[];
}
export type Answer = { kind: "midi"; midi: number } | { kind: "position"; string: number; fret: number } | { kind: "pitchClass"; pitchClass: number };
export type Outcome = "correct" | "progress" | "wrong" | "repeat";
export interface StatRecord { key: string; correct: boolean; ms: number | null }

export function tuningMidi(tuningId: string): readonly number[] {
  return (TUNINGS.find(item => item.id === tuningId) ?? TUNINGS[0])?.midi ?? [];
}
export function noteLabel(midi: number): string {
  return `${noteName(midi)}${Math.floor(midi / 12) - 1}`;
}
export function stringNumber(string: number, stringCount: number): number {
  return stringCount - string;
}
export function statKey(tuningId: string, string: number, fret: number): string {
  return `${tuningId}:${string}:${fret}`;
}

/** Strings outside the tuning are dropped; an empty selection means every string. */
export function activeStrings(settings: GameSettings, stringCount: number): number[] {
  const strings = [...new Set(settings.strings)].filter(n => n >= 0 && n < stringCount).sort((a, b) => a - b);
  return strings.length ? strings : Array.from({ length: stringCount }, (_, index) => index);
}
export function allowedPitchClass(pitchClass: number, naturalsOnly: boolean): boolean {
  return !naturalsOnly || NATURALS.includes(pitchClass);
}
export function positionsInRange(settings: GameSettings, tuning: readonly number[]): Position[] {
  const minFret = Math.max(0, Math.min(settings.minFret, settings.maxFret));
  const maxFret = Math.min(MAX_FRET, Math.max(settings.minFret, settings.maxFret));
  return activeStrings(settings, tuning.length).flatMap(string => {
    const open = tuning[string] ?? 0;
    return Array.from({ length: maxFret - minFret + 1 }, (_, offset) => {
      const fret = minFret + offset;
      return { string, fret, midi: open + fret };
    });
  });
}

/** FretBoardMemorizer-style weighting: unseen, inaccurate and slow positions come up more often. */
export function positionWeight(stat: PositionStat | undefined): number {
  if (!stat || stat.attempts === 0) return 3;
  const accuracy = stat.correct / stat.attempts;
  const averageMs = stat.correct ? stat.totalMs / stat.correct : 8000;
  const slow = Math.min(2, Math.max(0, (averageMs - 2000) / 3000));
  const unfamiliar = 1 - Math.min(1, stat.attempts / 5);
  return 1 + 4 * (1 - accuracy) + slow + unfamiliar;
}

function weightedPick<T>(items: readonly { item: T; weight: number }[], random: () => number): T | null {
  const total = items.reduce((sum, entry) => sum + entry.weight, 0);
  if (!items.length || total <= 0) return null;
  let threshold = random() * total;
  for (const entry of items) {
    threshold -= entry.weight;
    if (threshold < 0) return entry.item;
  }
  return items[items.length - 1]?.item ?? null;
}
function promptId(prompt: Prompt): string {
  return `${prompt.mode}:${prompt.pitchClass}:${prompt.string ?? ""}:${prompt.mode === "name" ? prompt.targets[0]?.fret ?? "" : ""}`;
}

export function candidatePrompts(settings: GameSettings, tuning: readonly number[]): Prompt[] {
  const positions = positionsInRange(settings, tuning).filter(p => allowedPitchClass(p.midi % 12, settings.naturalsOnly));
  switch (settings.mode) {
    case "name":
      return positions.map(position => ({ mode: "name", pitchClass: position.midi % 12, string: position.string, targets: [position] }));
    case "find": {
      const groups = new Map<string, Position[]>();
      for (const position of positions) {
        const key = `${position.string}:${position.midi % 12}`;
        groups.set(key, [...groups.get(key) ?? [], position]);
      }
      return [...groups.values()].flatMap(targets => {
        const first = targets[0];
        return first ? [{ mode: "find" as const, pitchClass: first.midi % 12, string: first.string, targets }] : [];
      });
    }
    case "octaves": {
      const groups = new Map<number, Position[]>();
      for (const position of positions) groups.set(position.midi % 12, [...groups.get(position.midi % 12) ?? [], position]);
      return [...groups.entries()].map(([pitchClass, targets]) => ({ mode: "octaves", pitchClass, string: null, targets }));
    }
  }
}

export function nextPrompt(settings: GameSettings, stats: Stats, random: () => number = Math.random,
  previous: Prompt | null = null): Prompt | null {
  const tuning = tuningMidi(settings.tuningId);
  const candidates = candidatePrompts(settings, tuning);
  const avoid = previous && candidates.length > 1 ? promptId(previous) : null;
  return weightedPick(candidates.map(prompt => ({
    item: prompt,
    weight: promptId(prompt) === avoid ? 0 : prompt.targets.reduce((sum, target) =>
      sum + positionWeight(stats[statKey(settings.tuningId, target.string, target.fret)]), 0) / prompt.targets.length,
  })), random);
}

export function requiredMidis(prompt: Prompt): number[] {
  return [...new Set(prompt.targets.map(target => target.midi))].sort((a, b) => a - b);
}
export function promptText(prompt: Prompt, settings: GameSettings, stringCount: number): string {
  const name = noteName(prompt.pitchClass);
  switch (prompt.mode) {
    case "find":
      return `Play ${name} on string ${stringNumber(prompt.string ?? 0, stringCount)}`;
    case "name":
      return settings.answer === "click" ? "Name the highlighted note" : "Play the highlighted position";
    case "octaves":
      return `Play every ${name} (${requiredMidis(prompt).length} pitches)`;
  }
}

/** Pure scoring of one answer; `found` lists MIDI notes already ticked off in "All octaves". */
export function evaluate(prompt: Prompt, answer: Answer, found: readonly number[], tuning: readonly number[]): { outcome: Outcome; midi: number | null } {
  if (answer.kind === "pitchClass") {
    return { outcome: prompt.mode === "name" && answer.pitchClass === prompt.pitchClass ? "correct" : "wrong", midi: null };
  }
  const midi = answer.kind === "midi" ? answer.midi : (tuning[answer.string] ?? 0) + answer.fret;
  switch (prompt.mode) {
    case "name":
    case "find": {
      const hit = answer.kind === "midi"
        ? prompt.targets.some(target => target.midi === midi)
        : prompt.targets.some(target => target.string === answer.string && target.fret === answer.fret);
      return { outcome: hit ? "correct" : "wrong", midi };
    }
    case "octaves": {
      const required = requiredMidis(prompt);
      if (!required.includes(midi)) return { outcome: "wrong", midi };
      if (found.includes(midi)) return { outcome: "repeat", midi };
      return { outcome: found.length + 1 >= required.length ? "correct" : "progress", midi };
    }
  }
}

export function applyRecords(stats: Stats, records: readonly StatRecord[]): Stats {
  const next = { ...stats };
  for (const record of records) {
    const previous = next[record.key] ?? { attempts: 0, correct: 0, totalMs: 0 };
    next[record.key] = {
      attempts: Math.min(1e6, previous.attempts + 1),
      correct: Math.min(1e6, previous.correct + Number(record.correct)),
      totalMs: Math.min(1e9, previous.totalMs + (record.correct && record.ms !== null ? Math.max(0, Math.round(record.ms)) : 0)),
    };
  }
  return next;
}

export interface Round {
  settings: GameSettings;
  index: number;
  prompt: Prompt | null;
  promptStartedAt: number;
  mistakes: number;
  found: { midi: number; at: number }[];
  firstTry: number;
  solvedMs: number[];
  feedback: string;
}
export interface RoundStep { round: Round; records: StatRecord[]; outcome: Outcome | "timeout" | "skip" }

export function startRound(settings: GameSettings, stats: Stats, now: number, random: () => number = Math.random): Round {
  return { settings, index: 0, prompt: nextPrompt(settings, stats, random), promptStartedAt: now, mistakes: 0, found: [],
    firstTry: 0, solvedMs: [], feedback: "" };
}

function recordsFor(round: Round, prompt: Prompt, solved: boolean, now: number, matched: Position | null): StatRecord[] {
  const key = (target: Position) => statKey(round.settings.tuningId, target.string, target.fret);
  const clean = solved && round.mistakes === 0;
  if (prompt.mode === "octaves") {
    return prompt.targets.map(target => {
      const found = round.found.find(item => item.midi === target.midi);
      return { key: key(target), correct: clean && found !== undefined, ms: found ? found.at - round.promptStartedAt : null };
    });
  }
  const ms = now - round.promptStartedAt;
  if (matched) return [{ key: key(matched), correct: clean, ms }];
  return prompt.targets.map(target => ({ key: key(target), correct: false, ms: null }));
}
function advance(round: Round, stats: Stats, records: StatRecord[], now: number, random: () => number,
  feedback: string, solved: boolean): Round {
  const prompt = round.prompt;
  const firstTry = round.firstTry + Number(solved && round.mistakes === 0);
  const solvedMs = solved ? [...round.solvedMs, now - round.promptStartedAt] : round.solvedMs;
  const index = round.index + 1;
  const finished = index >= round.settings.roundLength;
  return { ...round, index, firstTry, solvedMs, mistakes: 0, found: [], promptStartedAt: now, feedback,
    prompt: finished ? null : nextPrompt(round.settings, applyRecords(stats, records), random, prompt) };
}
function locate(prompt: Prompt, tuning: readonly number[], midi: number): string {
  const target = prompt.targets.find(item => item.midi === midi) ?? prompt.targets[0];
  return target ? `string ${stringNumber(target.string, tuning.length)}, fret ${target.fret}` : "";
}

export function answerRound(round: Round, answer: Answer, stats: Stats, now: number, random: () => number = Math.random): RoundStep {
  const prompt = round.prompt;
  if (!prompt) return { round, records: [], outcome: "repeat" };
  const tuning = tuningMidi(round.settings.tuningId);
  const result = evaluate(prompt, answer, round.found.map(item => item.midi), tuning);
  const heard = result.midi === null ? (answer.kind === "pitchClass" ? noteName(answer.pitchClass) : "") : noteLabel(result.midi);
  switch (result.outcome) {
    case "wrong":
      return { round: { ...round, mistakes: round.mistakes + 1,
        feedback: `${answer.kind === "midi" ? "Heard" : "Chose"} ${heard} — not it. Try again.` }, records: [], outcome: "wrong" };
    case "repeat":
      return { round: { ...round, feedback: `${heard} is already ticked off.` }, records: [], outcome: "repeat" };
    case "progress": {
      const found = [...round.found, { midi: result.midi ?? 0, at: now }];
      return { round: { ...round, found, feedback: `${heard} ✓ — ${requiredMidis(prompt).length - found.length} to go.` },
        records: [], outcome: "progress" };
    }
    case "correct": {
      const solvedRound = prompt.mode === "octaves" && result.midi !== null
        ? { ...round, found: [...round.found, { midi: result.midi, at: now }] } : round;
      const matched = prompt.mode === "octaves" ? null : answer.kind === "position"
        ? prompt.targets.find(target => target.string === answer.string && target.fret === answer.fret) ?? null
        : answer.kind === "midi" ? prompt.targets.find(target => target.midi === answer.midi) ?? null : prompt.targets[0] ?? null;
      const records = recordsFor(solvedRound, prompt, true, now, matched);
      const where = prompt.mode === "octaves" ? `all ${noteName(prompt.pitchClass)}s found`
        : `${noteLabel(matched?.midi ?? prompt.targets[0]?.midi ?? 0)} at ${locate(prompt, tuning, matched?.midi ?? -1)}`;
      const seconds = ((now - round.promptStartedAt) / 1000).toFixed(1);
      return { round: advance(solvedRound, stats, records, now, random, `Correct — ${where} in ${seconds} s.`, true), records, outcome: "correct" };
    }
  }
}

export function failRound(round: Round, reason: "timeout" | "skip", stats: Stats, now: number, random: () => number = Math.random): RoundStep {
  const prompt = round.prompt;
  if (!prompt) return { round, records: [], outcome: reason };
  const tuning = tuningMidi(round.settings.tuningId);
  const records = recordsFor(round, prompt, false, now, null);
  const answer = prompt.mode === "octaves"
    ? `${noteName(prompt.pitchClass)}: ${requiredMidis(prompt).filter(midi => !round.found.some(item => item.midi === midi)).map(noteLabel).join(", ")} still missing`
    : `${noteLabel(prompt.targets[0]?.midi ?? 0)} is at ${locate(prompt, tuning, prompt.targets[0]?.midi ?? -1)}`;
  const feedback = `${reason === "timeout" ? "Time's up" : "Skipped"} — ${answer}.`;
  return { round: advance(round, stats, records, now, random, feedback, false), records, outcome: reason };
}

export interface StableNoteOptions { frames?: number; maxCents?: number; ignoreMs?: number }
/** Emits a MIDI note once per attack after it is stable for a few frames and close to a semitone. */
export class StableNoteGate {
  private candidate: number | null = null;
  private count = 0;
  private lastSent: number | null = null;
  private ignoreUntil = -Infinity;
  private readonly frames: number;
  private readonly maxCents: number;
  private readonly ignoreMs: number;
  public constructor(options: StableNoteOptions = {}) {
    this.frames = options.frames ?? 3;
    this.maxCents = options.maxCents ?? 40;
    this.ignoreMs = options.ignoreMs ?? 300;
  }
  public feed(reading: PitchReading | null, now: number, a4 = 440): number | null {
    if (!reading) { this.candidate = null; this.count = 0; this.lastSent = null; return null; }
    const exact = frequencyToMidi(reading.frequency, a4);
    const midi = Math.round(exact);
    if (Math.abs(exact - midi) * 100 >= this.maxCents) { this.candidate = null; this.count = 0; return null; }
    this.count = this.candidate === midi ? this.count + 1 : 1;
    this.candidate = midi;
    if (now < this.ignoreUntil || this.count < this.frames || this.lastSent === midi) return null;
    this.lastSent = midi;
    return midi;
  }
  /** Ignore input briefly after a correct answer so the ringing note is not re-scored. */
  public pause(now: number): void { this.ignoreUntil = now + this.ignoreMs; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
export function validSettings(value: unknown): value is GameSettings {
  if (!object(value)) return false;
  const strings = value["strings"];
  return GAME_MODES.some(mode => mode === value["mode"])
    && typeof value["tuningId"] === "string" && TUNINGS.some(tuning => tuning.id === value["tuningId"])
    && Array.isArray(strings) && strings.length >= 1 && strings.length <= 8
    && strings.every(n => integer(n, 0, 7)) && new Set(strings).size === strings.length
    && integer(value["minFret"], 0, MAX_FRET) && integer(value["maxFret"], 0, MAX_FRET) && value["minFret"] <= value["maxFret"]
    && typeof value["naturalsOnly"] === "boolean"
    && ROUND_LENGTHS.some(n => n === value["roundLength"])
    && TIMER_CHOICES.some(n => n === value["timerSeconds"])
    && (value["answer"] === "live" || value["answer"] === "click");
}
const KEY_PATTERN = /^([A-Za-z0-9]+):([0-7]):(\d{1,2})$/;
function validStats(value: unknown): value is Stats {
  if (!object(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_STAT_ENTRIES) return false;
  return entries.every(([key, stat]) => {
    const match = KEY_PATTERN.exec(key);
    return match !== null && TUNINGS.some(tuning => tuning.id === match[1]) && Number(match[3]) <= MAX_FRET
      && object(stat) && integer(stat["attempts"], 0, 1e6) && integer(stat["correct"], 0, 1e6)
      && stat["correct"] <= stat["attempts"] && integer(stat["totalMs"], 0, 1e9);
  });
}
export function emptyStore(): FretGameStore {
  return { version: 1, settings: { ...DEFAULT_SETTINGS, strings: [...DEFAULT_SETTINGS.strings] }, stats: {} };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function parseStore(raw: string): FretGameStore {
  if (raw.length > MAX_STORE_BYTES) throw new Error("Stored statistics exceed the size limit.");
  const parsed: unknown = JSON.parse(raw);
  if (!object(parsed) || parsed["version"] !== 1) throw new Error("Stored statistics are invalid or obsolete.");
  if (!validStats(parsed["stats"])) throw new Error("Stored statistics are invalid.");
  // Whitelist fields so arbitrary storage keys never become component state.
  const stats: Stats = {};
  for (const [key, stat] of Object.entries(parsed["stats"])) {
    stats[key] = { attempts: stat.attempts, correct: stat.correct, totalMs: stat.totalMs };
  }
  const saved = parsed["settings"];
  const settings = validSettings(saved) ? {
    mode: saved.mode, tuningId: saved.tuningId, strings: [...saved.strings], minFret: saved.minFret, maxFret: saved.maxFret,
    naturalsOnly: saved.naturalsOnly, roundLength: saved.roundLength, timerSeconds: saved.timerSeconds, answer: saved.answer,
  } : emptyStore().settings;
  return { version: 1, settings, stats };
}
export function loadStore(): { store: FretGameStore; error: string | null } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return { store: raw === null ? emptyStore() : parseStore(raw), error: null };
  } catch (error) {
    return { store: emptyStore(), error: `Note finder statistics could not be restored: ${message(error)}` };
  }
}
export function saveStore(store: FretGameStore): string | null {
  try {
    if (!validSettings(store.settings) || !validStats(store.stats)) throw new Error("Invalid note finder data.");
    const raw = JSON.stringify(store);
    if (raw.length > MAX_STORE_BYTES) throw new Error("Statistics exceed the size limit.");
    localStorage.setItem(STORE_KEY, raw);
    return null;
  } catch (error) {
    return `Note finder statistics could not be saved: ${message(error)}`;
  }
}

export interface HeatCell { accuracy: number | null; averageMs: number | null; attempts: number }
export function heatCell(stat: PositionStat | undefined): HeatCell {
  if (!stat || stat.attempts === 0) return { accuracy: null, averageMs: null, attempts: 0 };
  return { accuracy: Math.round(stat.correct / stat.attempts * 100),
    averageMs: stat.correct ? Math.round(stat.totalMs / stat.correct) : null, attempts: stat.attempts };
}
export function heatLevel(cell: HeatCell): 0 | 1 | 2 | 3 {
  if (cell.accuracy === null) return 0;
  if (cell.accuracy >= 85) return 3;
  return cell.accuracy >= 50 ? 2 : 1;
}
