import { useEffect, useId, useState } from "react";
import type { InputProfile } from "../audio/inputProfile";

interface InputDevicePickerProps {
  profile: InputProfile;
  onChange: (update: Partial<InputProfile>) => void;
  /** Changing this re-reads the device list (labels appear only after permission is granted). */
  refreshKey?: number;
  disabled?: boolean;
}
interface Device { id: string; label: string }

export async function listInputDevices(): Promise<Device[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default")
    .map((device, index) => ({ id: device.deviceId, label: device.label || `Audio input ${index + 1}` }));
}

/** Shared input choice for live pitch rooms: the selection persists through the input profile. */
export function InputDevicePicker({ profile, onChange, refreshKey = 0, disabled = false }: InputDevicePickerProps) {
  const id = useId();
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    listInputDevices().then(list => { if (current) { setDevices(list); setError(""); } },
      () => { if (current) setError("Audio inputs could not be listed; the default input will be used."); });
    return () => { current = false; };
  }, [refreshKey]);
  const missing = profile.deviceId !== "" && !devices.some(device => device.id === profile.deviceId);
  return <div className="input-device">
    <label htmlFor={`${id}-device`}>Audio input</label>
    <select id={`${id}-device`} value={profile.deviceId} disabled={disabled}
      aria-describedby={`${id}-device-help`} onChange={event => onChange({ deviceId: event.target.value })}>
      <option value="">Default input</option>
      {missing && <option value={profile.deviceId}>Saved input (start listening to refresh names)</option>}
      {devices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
    </select>
    <p id={`${id}-device-help`} className="muted">Pick a microphone or a USB guitar processor. Audio stays on this computer and is never recorded.</p>
    {profile.kind === "direct" && <p className="notice">Direct USB input: heavy drive, delay or reverb make pitch tracking less reliable.
      Use the pedal&apos;s bypass or a clean preset to tune and to play notes here.</p>}
    {error && <p className="muted">{error}</p>}
  </div>;
}
