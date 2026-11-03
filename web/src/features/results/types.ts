import type { ReactNode } from "react";
import type {
  AnalysisResult,
  Envelope,
  Evidence,
  Finding,
  ToneCheck,
} from "../../api/types";

export type Seek = (evidence: Evidence) => void;

export interface QualityPanelProps {
  envelope: Envelope;
}

export interface ToneCheckPanelProps {
  tone: ToneCheck;
}

export interface NoteTableProps {
  result: AnalysisResult;
  seek: Seek;
}

export interface EvidenceTimelineProps {
  findings: Finding[];
  seek: Seek;
}

export interface FindingsListProps {
  findings: Finding[];
  seek: Seek;
}

export interface PrioritiesProps {
  result: AnalysisResult;
  seek: Seek;
}

export interface ResultsProps {
  envelope: Envelope;
  nextSteps?: ReactNode;
}

export interface NextStepsProps {
  bpm: number;
  rejections: number;
  onRetry: (delta?: number) => void;
  onPick: () => void;
  onDelete: () => void;
}
