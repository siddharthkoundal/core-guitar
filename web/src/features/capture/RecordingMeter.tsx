import { useImperativeHandle, useState } from 'react';
import type { RecordingMeterProps } from './types';

export function RecordingMeter({ ref, visible }: RecordingMeterProps) {
  const [meter, setMeter] = useState({ level: 0, elapsed: 0, clipped: false });
  // Audio callbacks update only this subtree, not the microphone controls.
  useImperativeHandle(ref, () => ({
    update: (level, peak, elapsed) => setMeter(previous => ({
      level, elapsed, clipped: previous.clipped || peak >= 0.9995,
    })),
    reset: () => setMeter({ level: 0, elapsed: 0, clipped: false }),
  }), []);

  if (!visible) return null;
  return <>
    <p className="time">{meter.elapsed.toFixed(1)} s / 180 s</p>
    <label>Input level<meter min={0} max={1} value={Math.min(1, meter.level * 3)} /></label>
    <p>{meter.clipped ? 'Clipping detected: lower the input or amp level.' : 'No clipping observed yet.'}</p>
  </>;
}
