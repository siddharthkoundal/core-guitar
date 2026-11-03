import type { TrackSettings } from "../api/types";

export type RecorderPhase =
  | "idle"
  | "requesting_permission"
  | "permission_denied"
  | "no_device"
  | "armed"
  | "starting"
  | "recording"
  | "interrupted"
  | "recorded";

export interface RecorderState {
  phase: RecorderPhase;
  partial: boolean;
}

export type RecorderEvent =
  | {
      type:
        | "permission"
        | "denied"
        | "no_device"
        | "armed"
        | "start"
        | "buffer"
        | "interrupt"
        | "cancel";
    }
  | { type: "recorded"; partial: boolean };

export interface Recording {
  blob: Blob;
  settings: TrackSettings;
  partial: boolean;
  source: "recording" | "upload";
  name: string;
  /** Seconds from the first recorded sample to the first click, on the browser audio clock (direct input). */
  clickOffsetS?: number;
  inputProfile?: "mic" | "direct";
}
