import { centsOff, nearestNote } from "../../audio/pitch";

export const A4_KEY = "coreguitar.tunerA4";
export const A4_MIN = 430;
export const A4_MAX = 450;
export const A4_DEFAULT = 440;
export const IN_TUNE_CENTS = 5;
export const IN_TUNE_HOLD_MS = 350;

export function validA4(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= A4_MIN && value <= A4_MAX;
}
export function loadA4(): number {
  try {
    const raw = localStorage.getItem(A4_KEY);
    const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return validA4(value) ? value : A4_DEFAULT;
  } catch {
    return A4_DEFAULT;
  }
}
export function saveA4(value: number): string | null {
  if (!validA4(value)) return `Reference pitch must be a whole number from ${A4_MIN} to ${A4_MAX} Hz.`;
  try {
    localStorage.setItem(A4_KEY, String(value));
    return null;
  } catch {
    return "Reference pitch applies to this visit but could not be saved in browser storage.";
  }
}

/** `chromatic`: nearest semitone. `auto`: nearest open string. A number: that string (zero-based, low first). */
export type TunerTarget = "chromatic" | "auto" | number;

export interface TunerReadout {
  /** The detected (nearest) note. */
  midi: number;
  /** Target the cents refer to. */
  targetMidi: number;
  /** Zero-based string index when tuning to a string. */
  string: number | null;
  cents: number;
}

export function nearestString(frequency: number, strings: readonly number[], a4 = A4_DEFAULT): number {
  let best = 0;
  let distance = Infinity;
  strings.forEach((midi, index) => {
    const value = Math.abs(centsOff(frequency, midi, a4));
    if (value < distance) { best = index; distance = value; }
  });
  return best;
}

export function readout(frequency: number, target: TunerTarget, strings: readonly number[], a4 = A4_DEFAULT): TunerReadout {
  const note = nearestNote(frequency, a4);
  if (target === "chromatic" || !strings.length) {
    return { midi: note.midi, targetMidi: note.midi, string: null, cents: note.cents };
  }
  const string = target === "auto" ? nearestString(frequency, strings, a4) : Math.min(Math.max(0, target), strings.length - 1);
  const targetMidi = strings[string] ?? note.midi;
  return { midi: note.midi, targetMidi, string, cents: centsOff(frequency, targetMidi, a4) };
}

export type TuneDirection = "in-tune" | "flat" | "sharp";
export function direction(cents: number): TuneDirection {
  if (Math.abs(cents) <= IN_TUNE_CENTS) return "in-tune";
  return cents < 0 ? "flat" : "sharp";
}
/** Needle position as a 0–100 percentage across a −50..+50 cent scale. */
export function needlePercent(cents: number): number {
  return 50 + Math.max(-50, Math.min(50, cents));
}
export function describeCents(cents: number): string {
  const rounded = Math.round(cents);
  if (Math.abs(cents) <= IN_TUNE_CENTS) return `in tune (${rounded > 0 ? "+" : ""}${rounded} cents)`;
  const amount = Math.abs(rounded) > 50 ? "more than 50 cents" : `${Math.abs(rounded)} cents`;
  return `${amount} ${cents < 0 ? "flat — tune up" : "sharp — tune down"}`;
}

/** Reports in-tune only after the pitch has stayed within ±5 cents for a short hold. */
export class InTuneHold {
  private since: number | null = null;
  private readonly holdMs: number;
  public constructor(holdMs = IN_TUNE_HOLD_MS) { this.holdMs = holdMs; }
  public update(cents: number | null, now: number): boolean {
    if (cents === null || Math.abs(cents) > IN_TUNE_CENTS) { this.since = null; return false; }
    this.since ??= now;
    return now - this.since >= this.holdMs;
  }
}

/** Throttles screen-reader announcements: only changed text, at most once per interval. */
export class AnnouncementThrottle {
  private last = "";
  private at = -Infinity;
  private readonly intervalMs: number;
  public constructor(intervalMs = 1500) { this.intervalMs = intervalMs; }
  public next(text: string, now: number): string | null {
    if (text === this.last || now - this.at < this.intervalMs) return null;
    this.last = text;
    this.at = now;
    return text;
  }
  public reset(): void { this.last = ""; this.at = -Infinity; }
}
