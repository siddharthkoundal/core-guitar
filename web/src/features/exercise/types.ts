import type { AnalysisRequest } from "../../api/types";

export interface ExercisePickerProps {
  onSelect: (selection: AnalysisRequest) => void;
}
