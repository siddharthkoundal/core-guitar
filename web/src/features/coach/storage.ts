import { boundedText, isCoachResponse, object } from "./client";
import type { CoachMessage, CoachRequest, CoachResponse } from "./client";

export const PLANS_KEY = "coreguitar.coach.plans.v1";
const MAX_PLANS = 10;
const MAX_STORAGE = 2_000_000;

export interface SavedPlan extends CoachResponse {
  id: string;
  goal: string;
  level: CoachRequest["level"];
  context: string;
  messages: CoachMessage[];
}

export function isLevel(value: unknown): value is CoachRequest["level"] {
  return value === "beginner" || value === "intermediate" || value === "advanced";
}

function isMessage(value: unknown): value is CoachMessage {
  return object(value) && (value["role"] === "user" || value["role"] === "assistant") &&
    boundedText(value["content"], 12000);
}

function isSavedPlan(value: unknown): value is SavedPlan {
  return object(value) && isCoachResponse(value) &&
    boundedText(value["id"], 100) && boundedText(value["goal"], 4000) &&
    isLevel(value["level"]) && typeof value["context"] === "string" &&
    value["context"].length <= 8000 && Array.isArray(value["messages"]) &&
    value["messages"].length <= 12 && value["messages"].every(isMessage);
}

export function loadSavedPlans(): SavedPlan[] {
  try {
    const raw = localStorage.getItem(PLANS_KEY);
    if (raw === null) return [];
    if (raw.length > MAX_STORAGE) throw new Error("Too large");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_PLANS || !parsed.every(isSavedPlan)) {
      throw new Error("Invalid history");
    }
    if (new Set(parsed.map((plan) => plan.id)).size !== parsed.length) {
      throw new Error("Duplicate history");
    }
    return parsed;
  } catch {
    throw new Error("Saved plans could not be loaded. Clear saved plans to reset local history.");
  }
}

export function storeSavedPlans(plans: SavedPlan[]): void {
  const selected = plans.slice(0, MAX_PLANS);
  const raw = JSON.stringify(selected);
  if (raw.length > MAX_STORAGE || !selected.every(isSavedPlan)) {
    throw new Error("Saved plans exceed the local history limit.");
  }
  try {
    localStorage.setItem(PLANS_KEY, raw);
  } catch {
    throw new Error("The plan could not be saved. Browser storage may be full or disabled.");
  }
}

export function clearSavedPlans(): void {
  try {
    localStorage.removeItem(PLANS_KEY);
  } catch {
    throw new Error("Saved plans could not be cleared. Check browser storage permissions.");
  }
}
