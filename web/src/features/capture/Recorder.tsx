import { useEffect, useReducer, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { TrackSettings } from '../../api/types';
import { initialRecorder, PcmCapture, recorderReducer } from '../../audio/recorder';
import { ProcessingWarnings } from '../../components/ProcessingWarnings';
import { RecordingMeter } from './RecordingMeter';
import type { RecordingMeterHandle, RecorderProps } from './types';

export function Recorder({ selection, onRecorded, onUpload }: RecorderProps) {
  const [state, dispatch] = useReducer(recorderReducer, initialRecorder);
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('coreguitar.deviceId') ?? '');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [settings, setSettings] = useState<TrackSettings>({});
  const [error, setError] = useState('');
  const meter = useRef<RecordingMeterHandle>(null);
  const callback = useRef(onRecorded);
  callback.current = onRecorded;
  const capture = useRef<PcmCapture | null>(null);
  useEffect(() => {
    const recorder = new PcmCapture({
      event: dispatch, devices: setDevices, settings: setSettings,
      level: (level, peak, elapsed) => meter.current?.update(level, peak, elapsed),
      recorded: recording => callback.current(recording),
      error: error => setError(errorMessage(error)),
    });
    capture.current = recorder;
    return () => {
      capture.current = null;
      void recorder.dispose().catch(error => console.error('Microphone cleanup failed:', error));
    };
  }, []);
  async function downloadClick() {
    try {
      const blob = await api.click(selection);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'click.wav'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(errorMessage(error)); }
  }
  const recording = ['starting', 'recording', 'interrupted'].includes(state.phase);
  return <section aria-labelledby="recorder-heading">
    <h3 id="recorder-heading">Record clean, single-note playing</h3>
    <p>Use speakers, not headphones: the same microphone must capture the click and guitar.
      Clean amp channel, quiet room, Mic Mode Standard.</p>
    {devices.length > 0 && <label>Microphone<select disabled={recording} value={deviceId}
      onChange={event => {
        setDeviceId(event.target.value); localStorage.setItem('coreguitar.deviceId', event.target.value);
        void capture.current?.arm(event.target.value);
      }}><option value="">System default</option>
      {devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Audio input'}</option>)}
    </select></label>}
    <p aria-live="polite">Recorder: {state.phase.replaceAll('_', ' ')}</p>
    {state.phase === 'permission_denied' && <p className="notice">Microphone permission was denied.
      Allow access in browser settings, or upload a recording made elsewhere.</p>}
    {state.phase === 'no_device' && <p className="notice">No microphone is available. Reconnect a device,
      choose system default, or upload a recording.</p>}
    {['idle', 'permission_denied', 'no_device'].includes(state.phase) &&
      <button onClick={() => {
        setError(''); meter.current?.reset();
        void capture.current?.arm(deviceId);
      }}>Enable microphone</button>}
    {state.phase === 'no_device' && <button onClick={() => {
      localStorage.removeItem('coreguitar.deviceId'); setDeviceId(''); void capture.current?.arm('');
    }}>Use system default microphone</button>}
    {state.phase === 'armed' && <button className="primary" onClick={() => {
      setError(''); void capture.current?.start(selection.mode === 'reference' ? api.click(selection) : null);
    }}>Start recording</button>}
    <RecordingMeter ref={meter} visible={recording} />
    {state.phase === 'recording' && <button onClick={() => capture.current?.stop()}>Stop recording</button>}
    {['armed', 'requesting_permission', 'starting', 'recording'].includes(state.phase) &&
      <button onClick={() => {
        void capture.current?.dispose().catch(error => setError(errorMessage(error)));
        dispatch({ type: 'cancel' });
      }}>Cancel recording</button>}
    {!recording && <div className="actions">
      <button onClick={onUpload}>Upload instead</button>
      {selection.mode === 'reference' && <button onClick={() => void downloadClick()}>Download click WAV</button>}
    </div>}
    <ProcessingWarnings settings={settings} />
    <p role="alert">{error}</p>
  </section>;
}
