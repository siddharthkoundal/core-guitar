import { isQuality } from "./detector";
import type { ChordShape } from "./detector";

function isShape(value: unknown): value is ChordShape {
  return typeof value === "object" && value !== null
    && Object.keys(value).every(key => key === "root" || key === "quality")
    && "root" in value && typeof value.root === "number" && Number.isInteger(value.root)
    && value.root >= 0 && value.root < 12 && "quality" in value && isQuality(value.quality);
}

/** Untrusted model output is text; only this bounded fenced JSON shape is actionable. */
export function parseProgression(text: string): ChordShape[] {
  if (text.length > 100000) return [];
  for (const match of text.matchAll(/```json\s*\n([\s\S]*?)\n```/gi)) {
    try {
      const value: unknown = JSON.parse(match[1] ?? "");
      if (typeof value !== "object" || value === null || !("chords" in value)
        || Object.keys(value).some(key => key !== "chords") || !Array.isArray(value.chords)
        || value.chords.length < 1 || value.chords.length > 32 || !value.chords.every(isShape)) continue;
      return value.chords.map(chord => ({ root: chord.root, quality: chord.quality }));
    } catch {
      // Invalid JSON stays visible as plain text, never executable suggestions.
      continue;
    }
  }
  return [];
}
