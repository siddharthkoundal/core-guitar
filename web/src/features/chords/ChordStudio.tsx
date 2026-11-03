import { useEffect, useId, useRef, useState } from "react";
import { ChordAI } from "./ChordAI";
import { chordName, isQuality, QUALITIES, ROOT_NAMES } from "./detector";
import type { ChordQuality, ChordShape, DetectedChord, DetectionResult } from "./detector";
import { HISTORY_LIMIT, loadHistory, saveHistory } from "./history";
import { ChordMicrophone } from "./microphone";
import type { MicrophoneStatus } from "./microphone";

export interface ChordStudioProps {
  /** Overrides localStorage persistence. Manual selections use similarity 0 (not measured). */
  onDetected?: (chord: { name: string; root: number; quality: string; similarity: number; detectedAt: string }) => void;
  context?: string;
}

export function ChordStudio({ onDetected, context = "" }: ChordStudioProps) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [initial] = useState(() => onDetected ? { entries: [], warning: "" } : loadHistory());
  const [history, setHistory] = useState<DetectedChord[]>(initial.entries);
  const historyRef = useRef<DetectedChord[]>(initial.entries);
  const [warning, setWarning] = useState(initial.warning);
  const [status, setStatus] = useState<MicrophoneStatus>({ state: "idle" });
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [manual, setManual] = useState<ChordShape | null>(null);
  const [root, setRoot] = useState(0);
  const [quality, setQuality] = useState<ChordQuality>("major");
  const microphone = useRef<ChordMicrophone | null>(null);
  const lastDetected = useRef("");

  function addChord(chord: DetectedChord): void {
    const next = [...historyRef.current, chord].slice(-HISTORY_LIMIT);
    historyRef.current = next;
    setHistory(next);
    if (onDetected) {
      try { onDetected(chord); setWarning(""); }
      catch { setWarning("Parent chord persistence failed. This chord is still available in this session."); }
    } else {
      setWarning(saveHistory(next));
    }
  }
  const addRef = useRef(addChord);
  addRef.current = addChord;

  useEffect(() => {
    heading.current?.focus();
    const input = new ChordMicrophone({
      onStatus: setStatus,
      onResult: value => {
        setResult(value);
        if (value.state === "detected") {
          if (lastDetected.current !== value.chord.name) addRef.current(value.chord);
          lastDetected.current = value.chord.name;
        } else {
          lastDetected.current = "";
        }
      },
    });
    microphone.current = input;
    return () => { input.dispose(); microphone.current = null; };
  }, []);

  function choose(chord: ChordShape): void {
    microphone.current?.stop();
    lastDetected.current = "";
    setResult(null);
    setManual(chord);
    addChord({ ...chord, name: chordName(chord.root, chord.quality),
      similarity: 0, detectedAt: new Date().toISOString() });
  }

  function stop(): void {
    microphone.current?.stop();
    lastDetected.current = "";
    setResult(null);
  }

  const active = status.state === "permission" || status.state === "listening";
  return <section className="panel chord-studio" aria-labelledby={`${id}-heading`}>
    <p className="eyebrow">CHORD LAB / LISTEN &amp; EXPLORE</p>
    <h2 ref={heading} tabIndex={-1} id={`${id}-heading`}>Chords &amp; ChordAI</h2>
    <p className="muted">Original browser-only template matching: 108 templates, nine qualities, twelve roots.
      Audio stays on this device. Play one sustained chord for at least 2.5 seconds.</p>
    <p className="notice">Cosine similarity describes template fit, not calibrated accuracy.
      Noise, harmonics and ambiguous voicings can prevent detection. Augmented inversions and
      sus2/sus4 aliases need manual root selection.</p>
    <div className="actions">
      <button type="button" disabled={active} onClick={() => {
        setResult(null); setManual(null); lastDetected.current = "";
        void microphone.current?.start();
      }}>Start chord microphone</button>
      {active && <button type="button" onClick={stop}>
        {status.state === "permission" ? "Cancel microphone request" : "Stop chord microphone"}
      </button>}
    </div>
    <div className="chord-live" role="status" aria-live="polite">
      {status.state === "idle" && <p>Microphone off. Select a chord manually or start listening.</p>}
      {status.state === "permission" && <p>Waiting for microphone permission. You can cancel this request.</p>}
      {status.state === "listening" && !result && <p>Listening — averaging 2.5 seconds of audio…</p>}
      {status.state === "listening" && result?.state === "no-signal"
        && <p>No signal: check your input device and play a sustained chord.</p>}
      {status.state === "listening" && result?.state === "ambiguous"
        && <p>Ambiguous chord: try a cleaner sustained voicing or use manual selection.</p>}
      {status.state === "listening" && result?.state === "detected" && <p>
        <strong className="chord-name">{result.chord.name}</strong>
        {" / "}Cosine similarity {result.chord.similarity.toFixed(3)} (not accuracy)
      </p>}
    </div>
    <div role="alert">{status.state === "error" && <p className="notice">{status.message}</p>}</div>
    <fieldset className="chord-manual">
      <legend>Manual chord fallback</legend>
      <div className="form-row">
        <label>Root<select value={root} onChange={event => setRoot(Number(event.target.value))}>
          {ROOT_NAMES.map((name, index) => <option value={index} key={name}>{name}</option>)}
        </select></label>
        <label>Quality<select value={quality} onChange={event => {
          if (isQuality(event.target.value)) setQuality(event.target.value);
        }}>
          {QUALITIES.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      <button type="button" onClick={() => choose({ root, quality })}>Add manual chord</button>
      {manual && <p>{chordName(manual.root, manual.quality)} — manual selection; similarity not measured.</p>}
    </fieldset>
    <section className="chord-history" aria-labelledby={`${id}-history`}>
      <h3 id={`${id}-history`}>Chord history</h3>
      <p className="muted">Last {HISTORY_LIMIT} entries. {onDetected
        ? "Sent to parent persistence; this list shows the current session."
        : "Saved in this browser only. Manual selections store similarity 0 (not measured)."}</p>
      {warning && <p className="notice" role="status">{warning}</p>}
      {history.length ? <ol>{history.map((chord, index) => <li key={`${chord.detectedAt}-${index}`}>
        <strong>{chord.name}</strong>{" / "}
        {chord.similarity === 0 ? "Manual selection" : `Similarity ${chord.similarity.toFixed(3)} (not accuracy)`}
        {" / "}<time dateTime={chord.detectedAt}>{new Date(chord.detectedAt).toLocaleTimeString()}</time>
      </li>)}</ol> : <p className="muted">No chords saved yet.</p>}
      <button type="button" disabled={!history.length} onClick={() => {
        historyRef.current = [];
        setHistory([]);
        setWarning(onDetected ? "" : saveHistory([]));
      }}>Clear chord history</button>
    </section>
    <ChordAI context={`${context.slice(0, 4800)}\nRecent chords: ${history.slice(-16).map(chord => chord.name).join(", ")}`}
      onChoose={choose} />
  </section>;
}
