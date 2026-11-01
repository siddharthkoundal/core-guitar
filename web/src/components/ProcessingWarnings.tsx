import type { ProcessingWarningsProps } from './types';

export function ProcessingWarnings({ settings }: ProcessingWarningsProps) {
  const active = [settings.echoCancellation, settings.noiseSuppression, settings.autoGainControl].some(value => value === true);
  const unknown = [settings.echoCancellation, settings.noiseSuppression, settings.autoGainControl].some(value => value === undefined);
  return <>
    {active && <p className="notice">Microphone EC/NS/AGC processing is still on. It can alter guitar attacks.
      On macOS, set Mic Mode to Standard and record again.</p>}
    {unknown && <p className="muted">Some microphone processing settings are not reported by this browser.
      Off requests cannot be verified. Set macOS Mic Mode to Standard.</p>}
  </>;
}
