import workletUrl from './pcm-recorder.worklet.ts?worker&url';
import { CLICK_LEAD_IN_S, ClickPlayer } from './clickPlayer';
import { MetronomePlayer } from './metronome';
import type { MetronomeBeat, MetronomeSettings } from './metronome';
import { encodeWav } from './wav';
import type { TrackSettings } from '../api/types';
import type { RecorderEvent, RecorderState, Recording } from './types';
export type { RecorderEvent, RecorderPhase, RecorderState, Recording } from './types';

export const initialRecorder: RecorderState = { phase: 'idle', partial: false };
export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case 'permission': return { phase: 'requesting_permission', partial: false };
    case 'denied': return { phase: 'permission_denied', partial: false };
    case 'no_device': return { phase: 'no_device', partial: false };
    case 'armed': return { phase: 'armed', partial: false };
    case 'start': return { phase: 'starting', partial: false };
    case 'buffer': return { ...state, phase: 'recording' };
    case 'interrupt': return { ...state, phase: 'interrupted', partial: true };
    case 'recorded': return { phase: 'recorded', partial: event.partial };
    case 'cancel': return initialRecorder;
  }
}
interface Callbacks {
  event: (event: RecorderEvent) => void;
  devices: (devices: MediaDeviceInfo[]) => void;
  settings: (settings: TrackSettings) => void;
  level: (level: number, peak: number, elapsed: number) => void;
  recorded: (recording: Recording) => void;
  error: (error: unknown) => void;
  beat: (beat: MetronomeBeat) => void;
}
export class PcmCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private click: ClickPlayer | null = null;
  private metronome: MetronomePlayer | null = null;
  private chunks: Float32Array[] = [];
  private capturing = false;
  private confirmed = false;
  private samples = 0;
  private settings: TrackSettings = {};
  private generation = 0;
  private timers: number[] = [];
  private lastMeter = 0;
  private maxPeak = 0;
  private clickVolume = 0.7;
  private firstFrame: number | null = null;
  private clickStart: number | null = null;
  constructor(private readonly callbacks: Callbacks) {}

  async arm(deviceId: string) {
    await this.dispose();
    const generation = this.generation;
    this.callbacks.event({ type: 'permission' });
    try {
      if (!navigator.mediaDevices) throw new Error('Microphone capture needs a supported localhost browser.');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: { ideal: 1 },
        },
      });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new DOMException('No audio input was found.', 'NotFoundError');
      this.settings = track.getSettings();
      this.callbacks.settings(this.settings);
      track.onended = () => this.interrupt();
      navigator.mediaDevices.addEventListener('devicechange', this.deviceChanged);
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (generation !== this.generation) return;
      this.callbacks.devices(devices.filter(device => device.kind === 'audioinput'));
      this.callbacks.event({ type: 'armed' });
    } catch (error) {
      if (generation !== this.generation) return;
      await this.dispose();
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.callbacks.event({ type: 'denied' });
      } else if (error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
        this.callbacks.event({ type: 'no_device' });
      } else {
        this.callbacks.event({ type: 'cancel' });
        this.callbacks.error(error);
      }
    }
  }

  async start(clickBlob: Promise<Blob> | null, settings: MetronomeSettings) {
    if (!this.stream) { this.callbacks.error(new Error('Enable a microphone before recording.')); return; }
    this.clickVolume = settings.volume;
    const generation = this.generation;
    this.callbacks.event({ type: 'start' });
    this.context = new AudioContext();
    try {
      await this.context.resume();
      const context = this.context;
      const clickBuffer = clickBlob ? await context.decodeAudioData(await (await clickBlob).arrayBuffer()) : null;
      await context.audioWorklet.addModule(workletUrl);
      if (generation !== this.generation) return;
      this.node = new AudioWorkletNode(context, 'pcm-recorder');
      const silence = context.createGain();
      silence.gain.value = 0;
      const source = context.createMediaStreamSource(this.stream);
      source.connect(this.node).connect(silence).connect(context.destination);
      this.chunks = []; this.samples = 0; this.maxPeak = 0; this.confirmed = false; this.capturing = true;
      this.firstFrame = null; this.clickStart = null;
      context.onstatechange = () => { if (this.capturing && context.state !== 'running') this.interrupt(); };
      this.node.onprocessorerror = () => this.interrupt();
      this.node.port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.capturing && this.firstFrame === null && isFirstFrame(event.data)) {
          this.firstFrame = event.data.firstFrame;
          return;
        }
        if (!this.capturing || !(event.data instanceof Float32Array)) return;
        const samples = event.data;
        this.chunks.push(samples); this.samples += samples.length;
        this.maxPeak = Math.max(this.maxPeak,
          samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0));
        if (!this.confirmed) {
          this.confirmed = true;
          this.callbacks.event({ type: 'buffer' });
          if (clickBuffer) {
            this.click = new ClickPlayer(context, clickBuffer);
            this.clickStart = this.click.start(settings.bpm, settings.beatsPerBar, this.clickVolume,
              (beat, section) => this.callbacks.beat({ beat, section }), () => {
                this.timers.push(window.setTimeout(() => this.stop(), 1000));
              });
          } else {
            this.metronome = new MetronomePlayer(context);
            this.metronome.start({ ...settings, volume: this.clickVolume }, {
              leadInSeconds: 2,
              countInBeats: settings.beatsPerBar,
              onBeat: this.callbacks.beat,
            });
          }
          this.timers.push(window.setTimeout(() => this.stop(), 180000));
        }
        if (performance.now() - this.lastMeter > 100) {
          this.lastMeter = performance.now();
          const rms = Math.sqrt(samples.reduce((energy, value) => energy + value * value, 0) / samples.length);
          this.callbacks.level(rms, this.maxPeak, this.samples / context.sampleRate);
        }
      };
      this.timers.push(window.setTimeout(() => {
        if (!this.confirmed && this.capturing) {
          this.callbacks.error(new Error('No microphone PCM arrived. Check the device and record again.'));
          this.interrupt();
        }
      }, 5000));
    } catch (error) {
      if (generation !== this.generation) return;
      await this.dispose();
      this.callbacks.event({ type: 'cancel' });
      this.callbacks.error(error);
    }
  }

  setClickVolume(volume: number) {
    this.clickVolume = volume;
    this.click?.setVolume(volume);
    this.metronome?.setVolume(volume);
  }

  stop(partial = false) {
    if (!this.capturing || !this.context) return;
    this.capturing = false;
    const recording: Recording = {
      blob: new Blob([encodeWav(this.chunks, this.context.sampleRate)], { type: 'audio/wav' }),
      settings: this.settings, partial, source: 'recording', name: 'recording.wav',
    };
    const offset = this.clickOffset(this.context);
    if (offset !== null) recording.clickOffsetS = offset;
    this.callbacks.event({ type: 'recorded', partial });
    this.callbacks.recorded(recording);
    void this.dispose().catch(error => this.callbacks.error(error));
  }
  /** Where the first click lands on the recording's timeline: scheduled start minus the first captured frame,
   * plus the click file's lead-in and browser-reported output and input latency. Used when the click isn't recorded. */
  private clickOffset(context: AudioContext): number | null {
    if (this.firstFrame === null || this.clickStart === null) return null;
    const output = Number.isFinite(context.outputLatency) ? context.outputLatency : context.baseLatency;
    const input = trackLatency(this.stream);
    const offset = this.clickStart - this.firstFrame / context.sampleRate + CLICK_LEAD_IN_S + (output || 0) + input;
    return Number.isFinite(offset) && offset >= 0 ? offset : null;
  }
  private interrupt() {
    this.callbacks.event({ type: 'interrupt' });
    if (this.capturing) this.stop(true);
    else {
      void this.dispose().catch(error => this.callbacks.error(error));
      this.callbacks.event({ type: 'no_device' });
    }
  }
  private deviceChanged = () => this.interrupt();
  async dispose() {
    this.generation++;
    this.capturing = false;
    this.click?.stop(); this.click = null;
    this.metronome?.stop(); this.metronome = null;
    this.timers.forEach(timer => window.clearTimeout(timer)); this.timers = [];
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = null;
    navigator.mediaDevices?.removeEventListener('devicechange', this.deviceChanged);
    const context = this.context;
    this.context = null;
    if (context) { context.onstatechange = null; await context.close(); }
  }
}

function isFirstFrame(data: unknown): data is { firstFrame: number } {
  return typeof data === 'object' && data !== null && 'firstFrame' in data
    && typeof data.firstFrame === 'number' && Number.isFinite(data.firstFrame);
}

function trackLatency(stream: MediaStream | null): number {
  const settings: object = stream?.getAudioTracks()[0]?.getSettings() ?? {};
  const latency = 'latency' in settings ? settings.latency : undefined;
  return typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 && latency < 1 ? latency : 0;
}
