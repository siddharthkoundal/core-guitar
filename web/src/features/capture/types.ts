import type { AnalysisRequest } from "../../api/types";
import type { Recording } from "../../audio/types";
import type { CaptureMethod } from "../../session/types";
import type { Ref } from "react";

export interface CapturePanelProps {
  selection: AnalysisRequest;
  bpm: number;
  method: CaptureMethod;
  recording: Recording | null;
  onMethodChange: (method: CaptureMethod) => void;
  onRecorded: (recording: Recording) => void;
  onSubmit: () => void;
  onDiscard: () => void;
  onPick: () => void;
}

export interface RecorderProps {
  selection: AnalysisRequest;
  onRecorded: (recording: Recording) => void;
  onUpload: () => void;
}

export interface TakeReviewProps {
  recording: Recording;
  onSubmit: () => void;
  onDiscard: () => void;
}

export interface UploaderProps {
  onRecorded: (recording: Recording) => void;
}

export interface RecordingMeterHandle {
  update: (level: number, peak: number, elapsed: number) => void;
  reset: () => void;
}

export interface RecordingMeterProps {
  ref: Ref<RecordingMeterHandle>;
  visible: boolean;
}
