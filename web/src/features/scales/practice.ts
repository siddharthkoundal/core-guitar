import { validMidi } from "./theory";

export type PracticeMode = "sequence" | "random" | "free";
export interface PracticeRun {
  readonly mode: PracticeMode;
  readonly notes: readonly number[];
  readonly startedAt: number;
  readonly durationSeconds: number;
  readonly hits: number;
  readonly errors: number;
  readonly target: number;
}
function randomNote(notes: readonly number[], random: () => number): number {
  const index = Math.min(notes.length - 1, Math.max(0, Math.floor(random() * notes.length)));
  return notes[index] ?? 60;
}
export function beginPractice(
  mode: PracticeMode, notes: readonly number[], startedAt: number, durationSeconds: number,
  random: () => number = Math.random,
): PracticeRun {
  if (!notes.length || notes.some(n => !validMidi(n)) || !Number.isFinite(startedAt)
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Invalid practice run.");
  return { mode, notes: [...notes], startedAt, durationSeconds, hits: 0, errors: 0,
    target: mode === "random" ? randomNote(notes, random) : notes[0] ?? 60 };
}
export function hitNote(run: PracticeRun, midi: number, random: () => number = Math.random): PracticeRun {
  if (!validMidi(midi)) throw new Error("Invalid MIDI practice note.");
  if (run.mode === "free") return { ...run, hits: run.hits + 1 };
  if (midi % 12 !== run.target % 12) return { ...run, errors: run.errors + 1 };
  const hits = run.hits + 1;
  return { ...run, hits,
    target: run.mode === "random" ? randomNote(run.notes, random) : run.notes[hits % run.notes.length] ?? run.target };
}
export function finishPractice(run: PracticeRun, now: number): { clean: boolean; durationSeconds: number } | null {
  if (now - run.startedAt < run.durationSeconds * 1000) return null;
  return { clean: run.mode !== "free" && run.errors === 0 && run.hits >= run.notes.length,
    durationSeconds: run.durationSeconds };
}
