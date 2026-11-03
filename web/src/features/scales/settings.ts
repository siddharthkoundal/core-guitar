import { SCALE_CATALOG, TUNINGS } from "./theory";
import type { PracticeMode } from "./practice";

export type DisplayMode = "dots" | "notes" | "intervals";
export type Direction = "ascending" | "descending" | "both";
export type TimeSignature = "4/4" | "3/4" | "6/8" | "5/4" | "7/8";
export interface ScaleSettings {
  version: 1;
  scaleId: string;
  root: number;
  tuningId: string;
  bpm: number;
  display: DisplayMode;
  pattern: "all" | "caged" | "3nps";
  position: string;
  direction: Direction;
  practiceMode: PracticeMode;
  duration: number;
  signature: TimeSignature;
  waveform: "triangle" | "sine" | "square";
  volume: number;
}
export const SETTINGS_KEY = "coreguitar.scales.settings.v1";
export const DEFAULT_SETTINGS: ScaleSettings = {
  version: 1, scaleId: "major", root: 0, tuningId: "standard", bpm: 90,
  display: "notes", pattern: "all", position: "", direction: "ascending", practiceMode: "sequence", duration: 30,
  signature: "4/4", waveform: "triangle", volume: 0.6,
};
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
function valid(value: unknown): value is ScaleSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v["version"] === 1
    && typeof v["scaleId"] === "string" && SCALE_CATALOG.some(s => s.id === v["scaleId"])
    && typeof v["root"] === "number" && Number.isInteger(v["root"]) && v["root"] >= 0 && v["root"] <= 11
    && typeof v["tuningId"] === "string" && TUNINGS.some(t => t.id === v["tuningId"])
    && typeof v["bpm"] === "number" && Number.isInteger(v["bpm"]) && v["bpm"] >= 30 && v["bpm"] <= 240
    && oneOf(v["display"], ["dots", "notes", "intervals"])
    && oneOf(v["pattern"], ["all", "caged", "3nps"])
    && typeof v["position"] === "string" && /^(|[CAGED]|3nps-[1-7])$/.test(v["position"])
    && oneOf(v["direction"], ["ascending", "descending", "both"])
    && oneOf(v["practiceMode"], ["sequence", "random", "free"])
    && [15, 30, 60].includes(Number(v["duration"])) && typeof v["duration"] === "number"
    && oneOf(v["signature"], ["4/4", "3/4", "6/8", "5/4", "7/8"])
    && oneOf(v["waveform"], ["triangle", "sine", "square"])
    && typeof v["volume"] === "number" && Number.isFinite(v["volume"]) && v["volume"] >= 0 && v["volume"] <= 1;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function loadSettings(): { settings: ScaleSettings; error: string | null } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { settings: { ...DEFAULT_SETTINGS }, error: null };
    if (raw.length > 4096) throw new Error("Stored settings exceed the size limit.");
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed)) throw new Error("Stored settings are invalid or obsolete.");
    // Whitelist the fields: arbitrary storage keys never become component state.
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ScaleSettings)[]) {
      Object.assign(settings, { [key]: parsed[key] });
    }
    return { settings, error: null };
  } catch (error) {
    return { settings: { ...DEFAULT_SETTINGS }, error: `Scale settings could not be restored: ${message(error)}` };
  }
}
export function saveSettings(settings: ScaleSettings): string | null {
  try {
    if (!valid(settings)) throw new Error("Invalid scale settings.");
    const raw = JSON.stringify(settings);
    if (raw.length > 4096) throw new Error("Scale settings exceed the size limit.");
    localStorage.setItem(SETTINGS_KEY, raw);
    return null;
  } catch (error) {
    return `Scale settings could not be saved: ${message(error)}`;
  }
}
