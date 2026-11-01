import type { Session, SessionEvent } from "./types";

export type { Session, SessionEvent } from "./types";

export const initialSession: Session = {
  phase: 'select_exercise', selection: null, take: null, analysisId: null,
  envelope: null, error: null, rejections: 0,
};
export function sessionReducer(state: Session, event: SessionEvent): Session {
  switch (event.type) {
    case 'select': return { ...state, phase: 'capture', selection: event.selection,
      analysisId: null, envelope: null, error: null };
    case 'upload': return { ...state, phase: 'uploading', error: null };
    case 'validating': return { ...state, phase: 'validating' };
    case 'validated': return { ...state, take: event.take };
    case 'analyzing': return { ...state, phase: 'analyzing', take: event.take,
      analysisId: event.analysisId };
    case 'result': return { ...state, phase: 'results', envelope: event.envelope,
      rejections: event.envelope.result.re_record.requested ? state.rejections + 1 : 0 };
    case 'cancel': return { ...state, phase: 'capture', error: null, analysisId: null, envelope: null };
    case 'error': return { ...state, phase: 'capture', error: event.message };
    case 'pick': return { ...initialSession, rejections: state.rejections };
  }
}
