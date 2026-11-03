import { useCallback, useEffect, useState } from 'react';
import type { Recording } from './types';

/** `mic`: a microphone hears the amp and the click. `direct`: a USB processor/interface feeds the guitar signal only. */
export type InputKind = 'mic' | 'direct';

export interface InputProfile {
  kind: InputKind;
  deviceId: string;
  /** User correction added to the browser-reported round-trip latency (direct input only). */
  latencyOffsetMs: number;
}

export const LATENCY_OFFSET_LIMIT_MS = 250;
const KIND_KEY = 'coreguitar.inputKind';
const DEVICE_KEY = 'coreguitar.deviceId';
const OFFSET_KEY = 'coreguitar.latencyOffsetMs';
const CHANGE_EVENT = 'coreguitar:input-profile';

function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(-LATENCY_OFFSET_LIMIT_MS, Math.min(LATENCY_OFFSET_LIMIT_MS, value)));
}

export function loadInputProfile(): InputProfile {
  try {
    const kind = localStorage.getItem(KIND_KEY) === 'direct' ? 'direct' : 'mic';
    const offset = Number(localStorage.getItem(OFFSET_KEY) ?? '0');
    return { kind, deviceId: localStorage.getItem(DEVICE_KEY) ?? '', latencyOffsetMs: clampOffset(offset) };
  } catch {
    return { kind: 'mic', deviceId: '', latencyOffsetMs: 0 };
  }
}

export function saveInputProfile(update: Partial<InputProfile>): InputProfile {
  const next = { ...loadInputProfile(), ...update };
  next.latencyOffsetMs = clampOffset(next.latencyOffsetMs);
  try {
    localStorage.setItem(KIND_KEY, next.kind);
    if (next.deviceId) localStorage.setItem(DEVICE_KEY, next.deviceId);
    else localStorage.removeItem(DEVICE_KEY);
    localStorage.setItem(OFFSET_KEY, String(next.latencyOffsetMs));
  } catch {
    // Storage can be unavailable (private mode); the in-memory value still applies to this page.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  return next;
}

/** Shared by the recorder, tuner and fretboard trainer so one device choice applies everywhere. */
export function useInputProfile(): [InputProfile, (update: Partial<InputProfile>) => void] {
  const [profile, setProfile] = useState(loadInputProfile);
  useEffect(() => {
    const sync = () => setProfile(loadInputProfile());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const update = useCallback((change: Partial<InputProfile>) => setProfile(saveInputProfile(change)), []);
  return [profile, update];
}

/** Audio constraints for live input; processing is always off so the guitar signal is unaltered. */
export function inputConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    channelCount: { ideal: 1 },
  };
}

/** Tags a take with its input profile; direct takes get the user's latency correction on the click time. */
export function tagRecording(recording: Recording, profile: InputProfile): Recording {
  const tagged: Recording = { ...recording, inputProfile: profile.kind };
  if (profile.kind === 'direct' && recording.clickOffsetS !== undefined)
    tagged.clickOffsetS = Math.max(0, recording.clickOffsetS + profile.latencyOffsetMs / 1000);
  return tagged;
}
