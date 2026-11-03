import { useEffect, useId, useRef, useState } from "react";
import { useInputProfile } from "../../audio/inputProfile";
import { LivePitchInput } from "../../audio/pitch";
import type { PitchReading, PitchSource } from "../../audio/pitch";
import { InputDevicePicker } from "../../components/InputDevicePicker";
import { noteName, TUNINGS } from "../scales/theory";
import {
  A4_MAX, A4_MIN, AnnouncementThrottle, describeCents, direction, InTuneHold, loadA4, needlePercent, readout, saveA4, validA4,
} from "./tunerMath";
import type { TunerTarget } from "./tunerMath";

export interface TunerProps {
  /** Injected in tests; defaults to live device input. */
  createInput?: () => PitchSource;
}
type ListenState = "idle" | "starting" | "listening";

function noteLabel(midi: number): string {
  return `${noteName(Math.max(0, Math.min(127, midi)))}${Math.floor(midi / 12) - 1}`;
}

export function Tuner({ createInput = () => new LivePitchInput() }: TunerProps) {
  const id = useId();
  const [profile, updateProfile] = useInputProfile();
  const [tuningId, setTuningId] = useState("standard");
  const [target, setTarget] = useState<TunerTarget>("auto");
  const [a4, setA4] = useState(loadA4);
  const [a4Text, setA4Text] = useState(() => String(a4));
  const [a4Message, setA4Message] = useState("");
  const [state, setState] = useState<ListenState>("idle");
  const [reading, setReading] = useState<PitchReading | null>(null);
  const [inTune, setInTune] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const input = useRef<PitchSource | null>(null);
  const generation = useRef(0);
  const hold = useRef(new InTuneHold());
  const throttle = useRef(new AnnouncementThrottle());
  const tuning = TUNINGS.find(item => item.id === tuningId) ?? TUNINGS[0];
  const strings = tuning?.midi ?? [];
  const current = reading ? readout(reading.frequency, target, strings, a4) : null;

  useEffect(() => () => { generation.current++; input.current?.stop(); input.current = null; }, []);

  useEffect(() => {
    if (state !== "listening") return;
    const now = performance.now();
    setInTune(hold.current.update(current?.cents ?? null, now));
    const text = current
      ? `${noteLabel(current.midi)}${current.string === null ? "" : `, string ${strings.length - current.string} target ${noteLabel(current.targetMidi)}`}: ${describeCents(current.cents)}`
      : "No signal — pluck one string and let it ring.";
    const next = throttle.current.next(text, now);
    if (next !== null) setAnnouncement(next);
    // `current` and `strings` derive from these inputs; recomputing on each reading is intended.
  }, [reading, target, tuningId, a4, state]);

  function stop(): void {
    generation.current++;
    input.current?.stop();
    input.current = null;
    setState("idle");
    setReading(null);
    setInTune(false);
    throttle.current.reset();
    setAnnouncement("Tuner stopped.");
  }
  async function start(): Promise<void> {
    stop();
    const run = generation.current;
    const source = createInput();
    input.current = source;
    setError("");
    setAnnouncement("");
    setState("starting");
    try {
      await source.start(profile.deviceId, {
        onPitch: value => { if (run === generation.current) setReading(value); },
        onError: problem => {
          if (run !== generation.current) return;
          input.current = null;
          setState("idle");
          setReading(null);
          setInTune(false);
          setError(problem.message);
        },
      });
      if (run !== generation.current) return;
      setState("listening");
      setRefreshKey(key => key + 1);
    } catch (problem) {
      if (run !== generation.current) return;
      input.current = null;
      setState("idle");
      setError(problem instanceof Error ? problem.message : "Audio input could not start.");
    }
  }
  function changeA4(text: string): void {
    setA4Text(text);
    const value = text.trim() === "" ? NaN : Number(text);
    if (!validA4(value)) {
      setA4Message(`Enter a whole number from ${A4_MIN} to ${A4_MAX}. Using ${a4} Hz.`);
      return;
    }
    setA4(value);
    setA4Message(saveA4(value) ?? "");
  }

  const tone = current ? direction(current.cents) : null;
  return <section className="panel tuner" aria-labelledby={`${id}-heading`}>
    <p className="eyebrow">PLUCK / LISTEN / ADJUST</p>
    <h2 id={`${id}-heading`}>Tuner</h2>
    <p className="muted">Chromatic tuner using the McLeod pitch method. Pluck one string at a time and let it ring.
      Readings are estimates; a clean, quiet signal tunes best.</p>
    <div className="form-row">
      <label>Tuning<select value={tuningId} onChange={event => {
        setTuningId(event.target.value);
        if (typeof target === "number") setTarget("auto");
      }}>{TUNINGS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Reference A4 (Hz)<input type="number" inputMode="numeric" min={A4_MIN} max={A4_MAX} step={1} value={a4Text}
        aria-invalid={a4Message.startsWith("Enter")} aria-describedby={`${id}-a4-help`}
        onChange={event => changeA4(event.target.value)} /></label>
    </div>
    <p id={`${id}-a4-help`} className={a4Message ? "notice" : "muted"}>{a4Message || "Concert pitch is 440 Hz. Saved in this browser."}</p>
    <InputDevicePicker profile={profile} onChange={updateProfile} refreshKey={refreshKey} disabled={state !== "idle"} />
    <div className="actions">
      {state === "idle"
        ? <button className="primary" onClick={() => void start()}>Start tuner</button>
        : <button className="primary" onClick={stop}>{state === "starting" ? "Cancel input request" : "Stop tuner"}</button>}
    </div>
    <div className="tuner-strings" role="group" aria-label="Tuning target">
      <button aria-pressed={target === "chromatic"} onClick={() => setTarget("chromatic")}>Chromatic</button>
      <button aria-pressed={target === "auto"} onClick={() => setTarget("auto")}>Auto string</button>
      {strings.map((midi, index) => ({ midi, index })).reverse().map(({ midi, index }) =>
        <button key={index} aria-pressed={target === index} aria-label={`String ${strings.length - index}, ${noteLabel(midi)}`}
          className={current?.string === index ? "tuner-string-active" : undefined}
          onClick={() => setTarget(index)}>{strings.length - index} · {noteLabel(midi)}</button>)}
    </div>
    <div className={`tuner-display${tone ? ` tuner-${tone}` : ""}${inTune ? " tuner-locked" : ""}`}>
      <p className="tuner-note">{current ? <>{noteName(Math.max(0, Math.min(127, current.midi)))}<span>{Math.floor(current.midi / 12) - 1}</span></> : "—"}</p>
      <div className="tuner-meter" aria-hidden="true">
        <span className="tuner-scale"><span>−50</span><span>0</span><span>+50</span></span>
        <span className="tuner-zone" />
        {current && <span className="tuner-needle" style={{ left: `${needlePercent(current.cents)}%` }} />}
      </div>
      <p className="tuner-readout">
        {current && reading
          ? <>{reading.frequency.toFixed(2)} Hz · target {noteLabel(current.targetMidi)}{current.string === null ? "" : ` (string ${strings.length - current.string})`} · {describeCents(current.cents)}</>
          : state === "listening" ? "Listening — pluck one string." : state === "starting" ? "Waiting for audio input permission…" : "Tuner is off."}
      </p>
      <p className="tuner-verdict">{inTune ? "✓ In tune" : current ? (tone === "flat" ? "▲ Tune up" : tone === "sharp" ? "▼ Tune down" : "Hold steady…") : " "}</p>
    </div>
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    <p role="alert" className={error ? "notice" : ""}>{error}</p>
    <p className="muted">Stops automatically after 10 minutes. Nothing is recorded or uploaded.</p>
  </section>;
}
