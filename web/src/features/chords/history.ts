import { chordName, isQuality } from "./detector";
import type { DetectedChord } from "./detector";

export const HISTORY_KEY = "coreguitar.chords.v1";
export const HISTORY_LIMIT = 200;
export interface ChordHistory { entries: DetectedChord[]; warning: string }

function isChord(value: unknown): value is DetectedChord {
  if (typeof value !== "object" || value === null) return false;
  if (!("root" in value) || typeof value.root !== "number" || !Number.isInteger(value.root)
    || value.root < 0 || value.root > 11 || !("quality" in value) || !isQuality(value.quality)) return false;
  if (!("name" in value) || value.name !== chordName(value.root, value.quality)) return false;
  if (!("similarity" in value) || typeof value.similarity !== "number" || !Number.isFinite(value.similarity)
    || value.similarity < 0 || value.similarity > 1) return false;
  if (!("detectedAt" in value) || typeof value.detectedAt !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.detectedAt)) return false;
  const time = Date.parse(value.detectedAt);
  return Number.isFinite(time) && new Date(time).toISOString() === value.detectedAt;
}

export function loadHistory(): ChordHistory {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return { entries: [], warning: "" };
    if (raw.length > 250000) throw new Error("History too large");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid chord history");
    const valid = parsed.filter(isChord);
    return {
      entries: valid.slice(-HISTORY_LIMIT),
      warning: valid.length === parsed.length ? "" : "Invalid saved chord entries were ignored.",
    };
  } catch {
    return { entries: [], warning: "Saved chord history could not be read. New chords remain available in this session." };
  }
}

export function saveHistory(entries: readonly DetectedChord[]): string {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.filter(isChord).slice(-HISTORY_LIMIT)));
    return "";
  } catch {
    return "Chord history was not saved on this device. It remains available in this session.";
  }
}
