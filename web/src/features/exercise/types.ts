import type { AnalysisRequest, CustomExercise } from "../../api/types";

export interface ExercisePickerProps {
  onSelect: (selection: AnalysisRequest) => void;
  /** Generates a synthetic take of the selection and analyzes it straight away. */
  onDemo: (selection: AnalysisRequest) => void;
}

export interface GuitarProImporterProps {
  /** Receives the converted riff; the caller fills the custom-riff fields with it. */
  onImport: (exercise: CustomExercise) => void;
}
