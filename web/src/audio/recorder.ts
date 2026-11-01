import workletUrl from './pcm-recorder.worklet.ts?worker&url';
import { ClickPlayer } from './clickPlayer';
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
}
export class PcmCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private click: ClickPlayer | null = null;
  private chunks: Float32Array[] = [];
  private capturing = false;
  private confirmed = false;
  private samples = 0;
  private settings: TrackSettings = {};
  private generation = 0;
  private timers: number[] = [];
  private lastMeter = 0;
  private maxPeak = 0;
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

  async start(clickBlob: Promise<Blob> | null) {
    if (!this.stream) { this.callbacks.error(new Error('Enable a microphone before recording.')); return; }
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
      context.onstatechange = () => { if (this.capturing && context.state !== 'running') this.interrupt(); };
      this.node.onprocessorerror = () => this.interrupt();
      this.node.port.onmessage = (event: MessageEvent<unknown>) => {
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
            this.click.start(() => {
              this.timers.push(window.setTimeout(() => this.stop(), 1000));
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

  stop(partial = false) {
    if (!this.capturing || !this.context) return;
    this.capturing = false;
    const recording: Recording = {
      blob: new Blob([encodeWav(this.chunks, this.context.sampleRate)], { type: 'audio/wav' }),
      settings: this.settings, partial, source: 'recording', name: 'recording.wav',
    };
    this.callbacks.event({ type: 'recorded', partial });
    this.callbacks.recorded(recording);
    void this.dispose().catch(error => this.callbacks.error(error));
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
