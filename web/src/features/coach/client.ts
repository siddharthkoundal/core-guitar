/** Same-origin adapter: Ollama URLs and model choice are never accepted from the UI. */
export interface CoachMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CoachRequest {
  kind: "plan" | "progression";
  prompt: string;
  level: "beginner" | "intermediate" | "advanced";
  context: string;
  messages?: CoachMessage[];
}

export interface CoachResponse {
  text: string;
  model: string;
}

export interface CoachStatus {
  available: boolean;
  models: string[];
}

export class CoachApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CoachApiError";
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function isCoachResponse(value: unknown): value is CoachResponse {
  return object(value) && boundedText(value["text"], 12000) && boundedText(value["model"], 200);
}

function isStatus(value: unknown): value is CoachStatus {
  return object(value) && typeof value["available"] === "boolean" &&
    Array.isArray(value["models"]) && value["models"].length <= 200 &&
    value["models"].every((model: unknown) => boundedText(model, 200));
}

async function read(path: "/api/coach" | "/api/coach/status", signal: AbortSignal,
  request?: CoachRequest): Promise<unknown> {
  const response = await fetch(path, {
    method: request ? "POST" : "GET",
    credentials: "same-origin", redirect: "error", cache: "no-store", signal,
    ...(request ? {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    } : {}),
  });
  let value: unknown;
  try {
    const raw = await response.text();
    if (raw.length > 100000) throw new Error("Response too large");
    value = JSON.parse(raw);
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    throw new CoachApiError("invalid_response", "The local coach returned invalid JSON.");
  }
  if (!response.ok) {
    if (object(value) && boundedText(value["code"], 100) &&
      boundedText(value["message"], 16000) &&
      (value["advice"] === undefined || boundedText(value["advice"], 2000))) {
      throw new CoachApiError(value["code"],
        `${value["message"]}${value["advice"] ? ` ${value["advice"]}` : ""}`);
    }
    throw new CoachApiError("invalid_response", "The local coach returned an invalid error.");
  }
  return value;
}

export async function askCoach(request: CoachRequest, signal: AbortSignal): Promise<CoachResponse> {
  const value = await read("/api/coach", signal, request);
  if (!isCoachResponse(value)) {
    throw new CoachApiError("invalid_response", "The local coach returned an invalid answer.");
  }
  return value;
}

export async function coachStatus(signal: AbortSignal): Promise<CoachStatus> {
  const value = await read("/api/coach/status", signal);
  if (!isStatus(value)) {
    throw new CoachApiError("invalid_response", "The local coach returned an invalid status.");
  }
  return value;
}
