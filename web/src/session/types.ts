import type { AnalysisRequest, Envelope, Take } from "../api/types";

export type CaptureMethod = "record" | "upload";

export interface Session {
  phase:
    | "select_exercise"
    | "capture"
    | "uploading"
    | "validating"
    | "analyzing"
    | "results";
  selection: AnalysisRequest | null;
  take: Take | null;
  analysisId: string | null;
  envelope: Envelope | null;
  error: string | null;
  rejections: number;
}

export type SessionEvent =
  | { type: "select"; selection: AnalysisRequest }
  | { type: "upload" | "validating" | "cancel" | "pick" }
  | { type: "analyzing"; take: Take; analysisId: string }
  | { type: "validated"; take: Take }
  | { type: "result"; envelope: Envelope }
  | { type: "error"; message: string };
