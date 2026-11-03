export type Tuning = "standard" | "drop_d" | "half_step_down";

export interface CustomExercise {
  notes: string;
  bpm: number;
  tuning: Tuning;
  time_signature: [number, number];
  default_duration: string;
}

export interface Exercise {
  id: string;
  name: string;
  description: string;
  tuning: Tuning;
  bpm: number;
  time_signature: [number, number];
  default_duration: string;
  notes_text: string;
  total_beats: number;
}

export interface RefNote {
  index: number;
  bar: number;
  beat_in_bar: number;
  name: string;
}

export interface Preview {
  notes: RefNote[];
  total_beats: number;
}

export interface AnalysisRequest {
  mode: "reference" | "free";
  exercise_id?: string;
  custom_exercise?: CustomExercise;
  bpm?: number;
  tuning?: Tuning;
  input_profile?: "mic" | "direct";
  click_offset_s?: number;
}

export interface TrackSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
  deviceId?: string;
}

export interface TakeMeta {
  source: "recording" | "upload";
  client_mime: string;
  original_name: string;
  track_settings: TrackSettings;
  interrupted: boolean;
}

export interface Take {
  take_id: string;
  duration_s: number;
  sample_rate: number;
  channels: number;
  codec: string;
  lossy: boolean;
  source: "recording" | "upload";
}

export type Json = null | string | number | boolean | Json[] | JsonObject;

export interface JsonObject {
  [key: string]: Json;
}

export interface Evidence {
  start_s: number;
  end_s: number;
  play_from_s: number;
  play_to_s: number;
}

export interface Finding {
  id: string;
  type: string;
  message: string;
  confidence: number;
  confidence_label: string;
  experimental: boolean;
  evidence: Evidence;
  ref_indices: number[];
  measured: JsonObject;
}

export interface Priority {
  rank: number;
  title: string;
  observation: string;
  possible_causes: string[];
  causes_are_hypotheses: boolean;
  drill: string;
  evidence: Evidence;
}

export interface ListeningPoint {
  observation: string;
  if_unintended_try: string;
  evidence: Evidence;
}

export interface ToneTrait {
  code: string;
  label: string;
  detail: string;
  attention: boolean;
}

/** Experimental, uncalibrated description of the signal chain (drive, dynamics, brightness, noise, level). */
export interface ToneCheck {
  experimental: true;
  input_profile: "mic" | "direct";
  metrics: JsonObject;
  traits: ToneTrait[];
  advice: string[];
  caveat: string;
}

export interface AnalysisResult {
  mode: "reference" | "free";
  quality: {
    verdict: string;
    metrics: JsonObject;
    issues: { level: string; message: string; advice: string }[];
  };
  re_record: { requested: boolean; reasons: string[] };
  summary: JsonObject | null;
  notes: JsonObject[];
  note_table: JsonObject[];
  findings: Finding[];
  priorities: Priority[];
  listening_points: ListeningPoint[];
  uncertainty: string[];
  /** Absent in analyses saved before the tone check existed; null when the take was too short or silent. */
  tone?: ToneCheck | null;
}

export interface Envelope {
  analysis_id: string;
  take_id: string;
  source: string;
  request: JsonObject;
  track_settings: TrackSettings;
  lossy: boolean;
  result: AnalysisResult;
}

export type AnalysisStatus =
  | { status: "queued" | "running" | "cancelled" }
  | { status: "failed"; error: string }
  | { status: "done"; result: Envelope };

export interface GuitarProTrack {
  index: number;
  name: string;
  strings: number;
  tuning: Tuning | null;
  percussion: boolean;
}
export interface GuitarProImportOptions {
  track?: number;
  start?: number;
  end?: number;
  tempo_percent?: number;
}
export interface GuitarProImport {
  title: string;
  artist: string;
  source_bpm: number;
  tracks: GuitarProTrack[];
  track: number;
  measure_count: number;
  start: number;
  end: number;
  exercise: CustomExercise;
  warnings: string[];
  total_beats: number;
  note_count: number;
}
