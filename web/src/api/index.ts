import type {
  AnalysisStatus,
  AnalysisRequest,
  AnalysisResult,
  CustomExercise,
  Envelope,
  Exercise,
  Evidence,
  Finding,
  Json,
  JsonObject,
  Preview,
  Priority,
  Take,
  TakeMeta,
  TrackSettings,
} from "./types";

export type * from "./types";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJson(value: unknown): value is Json {
  return (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value) ||
    (Array.isArray(value) && value.every(isJson)) ||
    (object(value) && Object.values(value).every(isJson))
  );
}
function jsonObject(value: unknown): value is JsonObject {
  return object(value) && Object.values(value).every(isJson);
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function evidence(value: unknown): value is Evidence {
  return (
    object(value) &&
    ["start_s", "end_s", "play_from_s", "play_to_s"].every(
      (key) => typeof value[key] === "number",
    )
  );
}
function finding(value: unknown): value is Finding {
  return (
    object(value) &&
    ["id", "type", "message", "confidence_label"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value["confidence"] === "number" &&
    typeof value["experimental"] === "boolean" &&
    evidence(value["evidence"]) &&
    Array.isArray(value["ref_indices"]) &&
    value["ref_indices"].every((i) => typeof i === "number") &&
    jsonObject(value["measured"])
  );
}
function priority(value: unknown): value is Priority {
  return (
    object(value) &&
    typeof value["rank"] === "number" &&
    ["title", "observation", "drill"].every(
      (key) => typeof value[key] === "string",
    ) &&
    strings(value["possible_causes"]) &&
    typeof value["causes_are_hypotheses"] === "boolean" &&
    evidence(value["evidence"])
  );
}
function settings(value: unknown): value is TrackSettings {
  return (
    object(value) &&
    ["echoCancellation", "noiseSuppression", "autoGainControl"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    ["sampleRate", "channelCount"].every(
      (key) => value[key] === undefined || typeof value[key] === "number",
    ) &&
    (value["deviceId"] === undefined || typeof value["deviceId"] === "string")
  );
}
function result(value: unknown): value is AnalysisResult {
  if (
    !object(value) ||
    !object(value["quality"]) ||
    !object(value["re_record"])
  )
    return false;
  const quality = value["quality"];
  const rerecord = value["re_record"];
  return (
    (value["mode"] === "reference" || value["mode"] === "free") &&
    typeof quality["verdict"] === "string" &&
    jsonObject(quality["metrics"]) &&
    Array.isArray(quality["issues"]) &&
    quality["issues"].every(
      (issue) =>
        object(issue) &&
        ["level", "message", "advice"].every(
          (key) => typeof issue[key] === "string",
        ),
    ) &&
    typeof rerecord["requested"] === "boolean" &&
    strings(rerecord["reasons"]) &&
    (value["summary"] === null || jsonObject(value["summary"])) &&
    ["notes", "note_table"].every(
      (key) => Array.isArray(value[key]) && value[key].every(jsonObject),
    ) &&
    Array.isArray(value["findings"]) &&
    value["findings"].every(finding) &&
    Array.isArray(value["priorities"]) &&
    value["priorities"].every(priority) &&
    Array.isArray(value["listening_points"]) &&
    value["listening_points"].every(
      (point) =>
        object(point) &&
        typeof point["observation"] === "string" &&
        typeof point["if_unintended_try"] === "string" &&
        evidence(point["evidence"]),
    ) &&
    strings(value["uncertainty"])
  );
}
function envelope(value: unknown): value is Envelope {
  return (
    object(value) &&
    ["analysis_id", "take_id", "source"].every(
      (k) => typeof value[k] === "string",
    ) &&
    jsonObject(value["request"]) &&
    settings(value["track_settings"]) &&
    typeof value["lossy"] === "boolean" &&
    result(value["result"])
  );
}
export function parseEnvelope(value: unknown): Envelope {
  if (!envelope(value)) throw new Error("Invalid analysis envelope.");
  return value;
}
function status(value: unknown): value is AnalysisStatus {
  return (
    object(value) &&
    (value["status"] === "queued" ||
      value["status"] === "running" ||
      value["status"] === "cancelled" ||
      (value["status"] === "done" && envelope(value["result"])) ||
      (value["status"] === "failed" && typeof value["error"] === "string"))
  );
}
function isTake(value: unknown): value is Take {
  return (
    object(value) &&
    typeof value["take_id"] === "string" &&
    typeof value["codec"] === "string" &&
    ["duration_s", "sample_rate", "channels"].every(
      (k) => typeof value[k] === "number",
    ) &&
    typeof value["lossy"] === "boolean" &&
    (value["source"] === "recording" || value["source"] === "upload")
  );
}
function isExercise(value: unknown): value is Exercise {
  return (
    object(value) &&
    [
      "id",
      "name",
      "description",
      "tuning",
      "default_duration",
      "notes_text",
    ].every((k) => typeof value[k] === "string") &&
    typeof value["bpm"] === "number" &&
    (value["tuning"] === "standard" ||
      value["tuning"] === "drop_d" ||
      value["tuning"] === "half_step_down") &&
    typeof value["total_beats"] === "number" &&
    Array.isArray(value["time_signature"]) &&
    value["time_signature"].length === 2 &&
    value["time_signature"].every((n) => typeof n === "number")
  );
}
function isPreview(value: unknown): value is Preview {
  return (
    object(value) &&
    typeof value["total_beats"] === "number" &&
    Array.isArray(value["notes"]) &&
    value["notes"].every(
      (note) =>
        object(note) &&
        typeof note["name"] === "string" &&
        ["index", "bar", "beat_in_bar"].every(
          (k) => typeof note[k] === "number",
        ),
    )
  );
}
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly advice = "",
  ) {
    super(message);
  }
}
async function response(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const reply = await fetch(`/api${path}`, options);
  if (!reply.ok) {
    const data: unknown = await reply.json().catch(() => null);
    if (object(data) && typeof data["message"] === "string") {
      throw new ApiError(
        String(data["code"]),
        data["message"],
        typeof data["advice"] === "string" ? data["advice"] : "",
      );
    }
    throw new Error(`Local server returned HTTP ${reply.status}.`);
  }
  return reply;
}
async function read<T>(
  path: string,
  validate: (value: unknown) => value is T,
  options: RequestInit = {},
): Promise<T> {
  const data: unknown = await (await response(path, options)).json();
  if (!validate(data))
    throw new Error("The local server returned an invalid response.");
  return data;
}
function post(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  };
}
export const api = {
  exercises: () =>
    read(
      "/exercises",
      (value): value is Exercise[] =>
        Array.isArray(value) && value.every(isExercise),
    ),
  preview: (custom: CustomExercise, signal: AbortSignal) =>
    read("/exercises/preview", isPreview, post(custom, signal)),
  click: async (selection: AnalysisRequest) =>
    (
      await response(
        "/click",
        post({
          ...(selection.exercise_id
            ? { exercise_id: selection.exercise_id }
            : { custom: selection.custom_exercise }),
          ...(selection.bpm ? { bpm: selection.bpm } : {}),
        }),
      )
    ).blob(),
  upload: (file: Blob, meta: TakeMeta, signal: AbortSignal) => {
    const body = new FormData();
    body.append("file", file, meta.original_name);
    body.append("meta", JSON.stringify(meta));
    return read("/takes", isTake, { method: "POST", body, signal });
  },
  analyze: (takeId: string, selection: AnalysisRequest, signal?: AbortSignal) =>
    read(
      `/takes/${takeId}/analyses`,
      (value): value is { analysis_id: string } =>
        object(value) && typeof value["analysis_id"] === "string",
      post(selection, signal),
    ),
  status: (analysisId: string, signal: AbortSignal) =>
    read(`/analyses/${analysisId}`, status, { signal }),
  cancel: async (analysisId: string) => {
    await response(`/analyses/${analysisId}`, { method: "DELETE" });
  },
  deleteTake: async (takeId: string) => {
    await response(`/takes/${takeId}`, { method: "DELETE" });
  },
  deleteAll: async () => {
    await response("/takes", { method: "DELETE" });
  },
};
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message} ${error.advice}`.trim();
  return error instanceof Error ? error.message : String(error);
}
