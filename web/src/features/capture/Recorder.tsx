import { useEffect, useReducer, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { TrackSettings } from '../../api/types';
import { LATENCY_OFFSET_LIMIT_MS, tagRecording, useInputProfile } from '../../audio/inputProfile';
import { initialRecorder, PcmCapture, recorderReducer } from '../../audio/recorder';
import { MetronomePlayer } from '../../audio/metronome';
import type { MetronomeBeat, MetronomeSettings } from '../../audio/metronome';
import { ProcessingWarnings } from '../../components/ProcessingWarnings';
import { RecordingMeter } from './RecordingMeter';
import type { RecordingMeterHandle, RecorderProps } from './types';

export function Recorder({ selection, onRecorded, onUpload }: RecorderProps) {
  const [state, dispatch] = useReducer(recorderReducer, initialRecorder);
  const [profile, setProfile] = useInputProfile();
  const { deviceId } = profile;
  const direct = profile.kind === 'direct';
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [clickVolume, setClickVolume] = useState(() => {
    const saved = Number(localStorage.getItem('coreguitar.clickVolume'));
    return Number.isFinite(saved) && saved >= 0.2 && saved <= 1 ? saved : 0.7;
  });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [settings, setSettings] = useState<TrackSettings>({});
  const [error, setError] = useState('');
  const [metronomeMode, setMetronomeMode] = useState<'stopped' | 'warmup' | 'recording'>('stopped');
  const [muted, setMuted] = useState(false);
  const [beat, setBeat] = useState<MetronomeBeat | null>(null);
  const meter = useRef<RecordingMeterHandle>(null);
  const callback = useRef(onRecorded);
  callback.current = onRecorded;
  const capture = useRef<PcmCapture | null>(null);
  const warmup = useRef<{ context: AudioContext; player: MetronomePlayer } | null>(null);
  const clickVolumeRef = useRef(clickVolume);
  const mutedRef = useRef(muted);
  const warmupGeneration = useRef(0);
  const bpm = selection.bpm ?? selection.custom_exercise?.bpm ?? 80;
  const requestedBeatsPerBar = selection.custom_exercise?.time_signature[0] ?? 4;
  const beatsPerBar = Number.isInteger(requestedBeatsPerBar) && requestedBeatsPerBar > 0
    ? requestedBeatsPerBar : 4;
  const metronomeSettings: MetronomeSettings = { bpm, beatsPerBar, volume: clickVolume };

  function stopWarmup() {
    const active = warmup.current;
    if (!active) return;
    const generation = ++warmupGeneration.current;
    warmup.current = null;
    active.player.stop();
    setMetronomeMode('stopped');
    mutedRef.current = false;
    setMuted(false);
    setBeat(null);
    void active.context.close().catch(error => {
      if (warmupGeneration.current === generation) setError(errorMessage(error));
      else console.error('Metronome cleanup failed:', error);
    });
  }

  async function toggleWarmup() {
    if (warmup.current) {
      stopWarmup();
      return;
    }
    setError('');
    const generation = ++warmupGeneration.current;
    let context: AudioContext | null = null;
    let player: MetronomePlayer | null = null;
    try {
      context = new AudioContext();
      player = new MetronomePlayer(context);
      warmup.current = { context, player };
      setMetronomeMode('warmup');
      setBeat(null);
      mutedRef.current = false;
      setMuted(false);
      await context.resume();
      if (generation !== warmupGeneration.current || warmup.current?.player !== player) return;
      player.start({ ...metronomeSettings, volume: mutedRef.current ? 0 : clickVolumeRef.current }, {
        leadInSeconds: 2,
        countInBeats: beatsPerBar,
        onBeat: setBeat,
      });
    } catch (error) {
      if (generation !== warmupGeneration.current) return;
      player?.stop();
      if (warmup.current?.player === player) warmup.current = null;
      if (context) {
        try {
          await context.close();
        } catch (closeError) {
          if (generation === warmupGeneration.current) {
            setMetronomeMode('stopped');
            setError(`${errorMessage(error)} Audio cleanup failed: ${errorMessage(closeError)}`);
          }
          return;
        }
      }
      if (generation !== warmupGeneration.current) return;
      setMetronomeMode('stopped');
      setError(errorMessage(error));
    }
  }

  useEffect(() => {
    const recorder = new PcmCapture({
      event: event => {
        dispatch(event);
        if (event.type === 'cancel' || event.type === 'recorded' || event.type === 'no_device') {
          setMetronomeMode('stopped');
          setBeat(null);
        }
      },
      devices: setDevices, settings: setSettings, beat: setBeat,
      level: (level, peak, elapsed) => meter.current?.update(level, peak, elapsed),
      recorded: recording => {
        setMetronomeMode('stopped');
        setBeat(null);
        callback.current(tagRecording(recording, profileRef.current));
      },
      error: error => setError(errorMessage(error)),
    });
    capture.current = recorder;
    return () => {
      capture.current = null;
      void recorder.dispose().catch(error => console.error('Microphone cleanup failed:', error));
      const active = warmup.current;
      warmup.current = null;
      if (active) {
        active.player.stop();
        void active.context.close().catch(error => console.error('Metronome cleanup failed:', error));
      }
    };
  }, []);

  function changeClickVolume(value: number) {
    const next = Math.max(0.2, Math.min(1, value));
    clickVolumeRef.current = next;
    setClickVolume(next);
    localStorage.setItem('coreguitar.clickVolume', String(next));
    capture.current?.setClickVolume(next);
    warmup.current?.player.setVolume(muted ? 0 : next);
  }

  function toggleMute() {
    const next = !muted;
    mutedRef.current = next;
    setMuted(next);
    warmup.current?.player.setVolume(next ? 0 : clickVolume);
  }

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
    <h3 id="recorder-heading">{direct ? 'Record single-note playing through your processor' : 'Record clean, single-note playing'}</h3>
    <fieldset className="input-profile" disabled={recording}>
      <legend>Input</legend>
      <label><input type="radio" name="input-kind" checked={!direct}
        onChange={() => setProfile({ kind: 'mic' })} /> Mic + amp</label>
      <label><input type="radio" name="input-kind" checked={direct}
        onChange={() => setProfile({ kind: 'direct' })} /> Processor (USB)</label>
    </fieldset>
    {direct
      ? <p>Choose your processor (a multi-effects pedal or interface connected over USB) as the input below.
        Headphones are fine: the app times the click itself, so it doesn't need to be on the recording.
        Any patch works, and the tone check describes it; a dry patch (no delay or reverb) gives the most
        reliable note and timing feedback.</p>
      : <p>Use speakers, not headphones: the same microphone must capture the click and guitar.
        Clean amp channel, quiet room, Mic Mode Standard.</p>}
    {direct && <label>Latency correction ({profile.latencyOffsetMs} ms)
      <input type="number" min={-LATENCY_OFFSET_LIMIT_MS} max={LATENCY_OFFSET_LIMIT_MS} step="5"
        value={profile.latencyOffsetMs} disabled={recording} aria-describedby="latency-hint"
        onChange={event => setProfile({ latencyOffsetMs: Number(event.target.value) })} />
    </label>}
    {direct && <p id="latency-hint" className="muted">
      The browser estimates audio latency. If notes you played on the beat are reported as consistently late,
      raise this by about that many milliseconds; if early, lower it.
    </p>}
    <fieldset className="metronome-controls">
      <legend>Metronome · {bpm} BPM</legend>
      <div className="metronome-beat" aria-hidden="true">
        <strong>{beat?.beat ?? '—'}</strong>
        <span>{beat?.section === 'count-in' ? 'COUNT-IN' : beat ? 'ON THE BEAT' : 'READY'}</span>
      </div>
      <p aria-live="polite">
        {metronomeMode === 'recording' ? 'Recording click is running.' :
          metronomeMode === 'warmup' ? 'Warm-up metronome is running.' :
            'Warm up before recording, or start a take to hear the count-in.'}
      </p>
      <div className="actions">
        <button disabled={recording || metronomeMode === 'recording'} onClick={() => void toggleWarmup()}>
          {metronomeMode === 'warmup' ? 'Stop warm-up metronome' : 'Start warm-up metronome'}
        </button>
        {metronomeMode === 'warmup' && <button aria-pressed={muted} onClick={toggleMute}>
          {muted ? 'Unmute warm-up click' : 'Mute warm-up click'}
        </button>}
      </div>
      <label>Click volume ({Math.round(clickVolume * 100)}%)
        <input type="range" min="20" max="100" step="5" value={Math.round(clickVolume * 100)}
          aria-describedby="click-volume-hint"
          onChange={event => changeClickVolume(Number(event.target.value) / 100)} />
      </label>
      <p id="click-volume-hint" className="muted">
        A two-second lead-in and count-in play before each take. Warm-up can be muted; analysis clicks stay on
        at no less than 20%. {direct ? 'In processor mode the click is only for you to hear.'
          : 'Actual loudness depends on your device output, so use speakers and check the recording.'}
      </p>
    </fieldset>
    {devices.length > 0 && <label>{direct ? 'Input device' : 'Microphone'}<select disabled={recording} value={deviceId}
      onChange={event => {
        setProfile({ deviceId: event.target.value });
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
      setProfile({ deviceId: '' }); void capture.current?.arm('');
    }}>Use system default microphone</button>}
    {state.phase === 'armed' && <button className="primary" onClick={() => {
      setError('');
      stopWarmup();
      setMetronomeMode('recording');
      setBeat(null);
      void capture.current?.start(selection.mode === 'reference' ? api.click(selection) : null, metronomeSettings);
    }}>Start recording</button>}
    <RecordingMeter ref={meter} visible={recording} />
    {state.phase === 'recording' && <button onClick={() => capture.current?.stop()}>Stop recording</button>}
    {['armed', 'requesting_permission', 'starting', 'recording'].includes(state.phase) &&
      <button onClick={() => {
        void capture.current?.dispose().catch(error => setError(errorMessage(error)));
        dispatch({ type: 'cancel' });
        setMetronomeMode('stopped');
        setBeat(null);
      }}>Cancel recording</button>}
    {!recording && <div className="actions">
      <button onClick={onUpload}>Upload instead</button>
      {selection.mode === 'reference' && <button onClick={() => void downloadClick()}>Download click WAV</button>}
    </div>}
    <ProcessingWarnings settings={settings} />
    <p role="alert">{error}</p>
  </section>;
}
