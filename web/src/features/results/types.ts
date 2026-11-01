import type {
  AnalysisResult,
  Envelope,
  Evidence,
  Finding,
} from "../../api/types";

export type Seek = (evidence: Evidence) => void;

export interface QualityPanelProps {
  envelope: Envelope;
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
}

export interface NextStepsProps {
  bpm: number;
  rejections: number;
  onRetry: (delta?: number) => void;
  onPick: () => void;
  onDelete: () => void;
}
