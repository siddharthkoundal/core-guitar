import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { SCALE_CATALOG, TUNINGS, fretboard, intervalName, noteName, resolveScaleId, scaleNotes } from "./theory";
import type { FretNote } from "./theory";
import { getPatterns } from "./patterns";
import { AudioPlayer, isAudioCancellation } from "./sound";
import { beginPractice, finishPractice, hitNote } from "./practice";
import type { PracticeRun } from "./practice";
import { loadSettings, saveSettings } from "./settings";
import type { Direction, DisplayMode, ScaleSettings, TimeSignature } from "./settings";
import { MicrophoneInput } from "./microphone";

export interface ScaleAttempt {
  scaleId: string;
  root: number;
  bpm: number;
  clean: boolean;
  durationSeconds: number;
}
export interface ScaleStudioProps {
  initialScaleId?: string;
  initialRoot?: number;
  onAttempt?: (attempt: ScaleAttempt) => void;
}
interface ActiveRun {
  run: PracticeRun;
  scaleId: string;
  root: number;
  bpm: number;
}
function errorText(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.message : String(error);
}
function directed(notes: readonly number[], direction: Direction): number[] {
  if (direction === "descending") return [...notes].reverse();
  if (direction === "both") return [...notes, ...notes.slice(0, -1).reverse()];
  return [...notes];
}

export function ScaleStudio({ initialScaleId, initialRoot, onAttempt }: ScaleStudioProps): ReactElement {
  const id = useId();
  const [restored] = useState(loadSettings);
  const [settings, setSettings] = useState<ScaleSettings>(() => ({
    ...restored.settings,
    ...(initialScaleId && resolveScaleId(initialScaleId) ? { scaleId: resolveScaleId(initialScaleId) ?? "major" } : {}),
    ...(initialRoot !== undefined && Number.isInteger(initialRoot) && initialRoot >= 0 && initialRoot <= 11
      ? { root: initialRoot } : {}),
  }));
  const [storageError, setStorageError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [status, setStatus] = useState("Choose a scale or play any fret.");
  const [playing, setPlaying] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [practice, setPractice] = useState<PracticeRun | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [lastNote, setLastNote] = useState<string | null>(null);
  const [inputSource, setInputSource] = useState<"clicks" | "microphone">("clicks");
  const [microphoneState, setMicrophoneState] = useState<"off" | "requesting" | "listening">("off");
  const [microphoneStatus, setMicrophoneStatus] = useState("Microphone off.");
  const [livePitch, setLivePitch] = useState<number | null>(null);
  const [melody] = useState(() => new AudioPlayer());
  const [click] = useState(() => new AudioPlayer());
  const [clock] = useState(() => new AudioPlayer());
  const [microphone] = useState(() => new MicrophoneInput());
  const run = useRef<ActiveRun | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const audioGeneration = useRef(0);
  const clockGeneration = useRef(0);
  const microphoneGeneration = useRef(0);
  const callback = useRef(onAttempt);
  const practiceHeading = useRef<HTMLHeadingElement>(null);
  const board = useRef<HTMLTableElement>(null);
  const [focusedCell, setFocusedCell] = useState("0:0");

  const scale = SCALE_CATALOG.find(s => s.id === settings.scaleId) ?? SCALE_CATALOG[0]!;
  const tuning = TUNINGS.find(t => t.id === settings.tuningId) ?? TUNINGS[0]!;
  const cells = fretboard(tuning);
  const patternResult = settings.pattern === "all" ? { patterns: [], reason: null }
    : getPatterns(scale, settings.root, tuning, settings.pattern);
  const pattern = patternResult.patterns.find(p => p.id === settings.position) ?? patternResult.patterns[0];
  const selectedCells = new Set(pattern?.notes.map(n => `${n.string}:${n.fret}`));
  const sequence = directed(scaleNotes(scale, settings.root), settings.direction);
  const categories = [...new Set(SCALE_CATALOG.map(s => s.category))];
  const sound = { waveform: settings.waveform, volume: settings.volume };
  const related = SCALE_CATALOG.filter(s => s.id !== scale.id).map(s => ({
    scale: s, common: s.intervals.filter(n => scale.intervals.includes(n)).length,
    difference: s.intervals.filter(n => !scale.intervals.includes(n)).length
      + scale.intervals.filter(n => !s.intervals.includes(n)).length,
  })).sort((a, b) => a.difference - b.difference || b.common - a.common).slice(0, 3);
  const firstRoot = (pattern?.notes ?? cells).find(n => n.midi % 12 === settings.root);

  useEffect(() => { callback.current = onAttempt; }, [onAttempt]);
  useEffect(() => { setStorageError(saveSettings(settings)); }, [settings]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      audioGeneration.current++;
      clockGeneration.current++;
      microphoneGeneration.current++;
      run.current = null;
      if (timer.current !== null) clearInterval(timer.current);
      melody.stop();
      click.stop();
      clock.stop();
      microphone.stop();
    };
  }, [melody, click, clock, microphone]);

  function clearRun(): void {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    run.current = null;
    setPractice(null);
  }
  function stopAudio(): void {
    audioGeneration.current++;
    clockGeneration.current++;
    melody.stop();
    click.stop();
    clock.stop();
    setPlaying(false);
    setMetronome(false);
  }
  function stopMicrophone(): void {
    microphoneGeneration.current++;
    microphone.stop();
    setMicrophoneState("off");
    setMicrophoneStatus("Microphone off.");
    setLivePitch(null);
  }
  function update(patch: Partial<ScaleSettings>): void {
    if (run.current) setStatus("Practice cancelled because settings changed. No attempt saved.");
    clearRun();
    stopAudio();
    stopMicrophone();
    setSettings(previous => ({ ...previous, ...patch }));
    setFocusedCell("0:0");
  }
  function reportAudio(error: unknown): void {
    if (alive.current && !isAudioCancellation(error)) setAudioError(`Audio: ${errorText(error)}`);
  }
  function playScale(): void {
    if (inputSource === "microphone") return;
    setAudioError(null);
    melody.stop();
    click.stop();
    const generation = ++audioGeneration.current;
    setPlaying(true);
    void melody.play(sequence, settings.bpm, sound).then(() => {
      if (alive.current && generation === audioGeneration.current) setPlaying(false);
    }, error => {
      if (alive.current && generation === audioGeneration.current) {
        setPlaying(false);
        reportAudio(error);
      }
    });
  }
  function toggleMetronome(): void {
    if (inputSource === "microphone") return;
    setAudioError(null);
    const generation = ++clockGeneration.current;
    if (metronome) {
      clock.stop();
      setMetronome(false);
    } else {
      setMetronome(true);
      const [beats, unit] = settings.signature.split("/").map(Number);
      void clock.metronome(settings.bpm, { ...sound, beatsPerBar: beats ?? 4, beatUnit: unit === 8 ? 8 : 4 }).catch(error => {
        if (alive.current && generation === clockGeneration.current && !isAudioCancellation(error)) {
          setMetronome(false);
          reportAudio(error);
        }
      });
    }
  }
  function startPractice(): void {
    if (inputSource === "microphone" && microphoneState !== "listening") return;
    clearRun();
    melody.stop();
    audioGeneration.current++;
    setPlaying(false);
    const next = beginPractice(settings.practiceMode, sequence, performance.now(), settings.duration);
    run.current = { run: next, scaleId: scale.id, root: settings.root, bpm: settings.bpm };
    setPractice(next);
    setRemaining(settings.duration);
    setStatus(settings.practiceMode === "free" ? "Free exploration started; correctness is not graded." : "Follow the target notes. Any octave is accepted.");
    practiceHeading.current?.focus();
    timer.current = setInterval(() => {
      const current = run.current;
      if (!current) return;
      const now = performance.now();
      const result = finishPractice(current.run, now);
      setRemaining(Math.max(0, Math.ceil(current.run.durationSeconds - (now - current.run.startedAt) / 1000)));
      if (!result) return;
      clearRun();
      stopAudio();
      stopMicrophone();
      setStatus(current.run.mode === "free" ? "Free practice complete — ungraded."
        : result.clean ? "Clean run complete — full target cycle, no wrong notes."
          : "Run complete — repeat a full target cycle without wrong notes for a clean run.");
      try {
        if (current.run.mode === "sequence") {
          callback.current?.({ scaleId: current.scaleId, root: current.root, bpm: current.bpm, ...result });
        }
      } catch (error) {
        setAudioError(`Attempt could not be saved: ${errorText(error)}`);
      }
    }, 100);
  }
  function scoreNote(midi: number): void {
    const current = run.current;
    if (current && !finishPractice(current.run, performance.now())) {
      const next = hitNote(current.run, midi);
      run.current = { ...current, run: next };
      setPractice(next);
    }
  }
  function startMicrophone(): void {
    stopAudio();
    setAudioError(null);
    const generation = ++microphoneGeneration.current;
    setMicrophoneState("requesting");
    setMicrophoneStatus("Waiting for microphone permission. You can cancel this request.");
    const current = () => alive.current && generation === microphoneGeneration.current;
    void microphone.start({
      onNote: midi => {
        if (!current()) return;
        setLivePitch(midi);
        scoreNote(midi);
      },
      onStatus: message => {
        if (!current()) return;
        setMicrophoneStatus(message);
        if (message.startsWith("No signal") || message.startsWith("Uncertain")) setLivePitch(null);
      },
      onError: error => {
        if (!current()) return;
        stopMicrophone();
        clearRun();
        setAudioError(`Microphone: ${errorText(error)}`);
        setStatus("Live practice stopped. No attempt saved.");
      },
    }).then(() => {
      if (current()) setMicrophoneState("listening");
    }, error => {
      if (!current() || isAudioCancellation(error)) return;
      stopMicrophone();
      setAudioError(`Microphone: ${errorText(error)}`);
    });
  }
  function playFret(note: FretNote): void {
    setLastNote(`${note.string}:${note.fret}`);
    setFocusedCell(`${note.string}:${note.fret}`);
    // Click input is recorded synchronously; audio availability never fabricates a hit.
    if (inputSource === "microphone") return;
    scoreNote(note.midi);
    melody.stop();
    audioGeneration.current++;
    setPlaying(false);
    const generation = audioGeneration.current;
    void click.play([note.midi], settings.bpm, sound).catch(error => {
      if (generation === audioGeneration.current) reportAudio(error);
    });
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, note: FretNote): void {
    let string = note.string;
    let fret = note.fret;
    if (event.key === "ArrowRight") fret = Math.min(24, fret + 1);
    else if (event.key === "ArrowLeft") fret = Math.max(0, fret - 1);
    else if (event.key === "ArrowUp") string = Math.min(tuning.midi.length - 1, string + 1);
    else if (event.key === "ArrowDown") string = Math.max(0, string - 1);
    else if (event.key === "Home") fret = 0;
    else if (event.key === "End") fret = 24;
    else return;
    event.preventDefault();
    const key = `${string}:${fret}`;
    setFocusedCell(key);
    board.current?.querySelector<HTMLButtonElement>(`[data-cell="${key}"]`)?.focus();
  }

  return <section className="panel scale-studio" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Scale &amp; fretboard studio</h2>
    <p className="muted">{SCALE_CATALOG.length} scales · {categories.length} categories · {TUNINGS.length} tunings. Notes use sharp pitch-class names; interval labels show semitones, not key-specific spelling. Ionian = major; Aeolian = natural minor.</p>
    <div role="alert">{restored.error && <p className="notice">{restored.error}</p>}
      {storageError && <p className="notice">{storageError}</p>}
      {audioError && <p className="notice">{audioError}</p>}</div>
    <div className="form-row">
      <label>Root<select value={settings.root} onChange={event => update({ root: Number(event.target.value) })}>
        {Array.from({ length: 12 }, (_, root) => <option key={root} value={root}>{noteName(root)}</option>)}
      </select></label>
      <label>Scale<select value={scale.id} onChange={event => update({ scaleId: event.target.value, position: "" })}>
        {categories.map(category => <optgroup key={category} label={category}>
          {SCALE_CATALOG.filter(s => s.category === category).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </optgroup>)}
      </select></label>
      <label>Tuning<select value={tuning.id} onChange={event => update({ tuningId: event.target.value })}>
        {TUNINGS.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></label>
    </div>
    <div className="scale-details">
      <p><strong>Scale tones:</strong> {scaleNotes(scale, settings.root).slice(0, -1).map(noteName).join(" · ")}</p>
      <p><strong>Interval formula:</strong> {scale.intervals.map(intervalName).join(" · ")}</p>
      <p><strong>Steps in semitones:</strong> {scale.intervals.map((n, i) => (scale.intervals[i + 1] ?? 12) - n).join(" – ")} (back to the octave).</p>
      {firstRoot && <p className="muted">Start on {noteName(settings.root)}: string {tuning.midi.length - firstRoot.string},
        fret {firstRoot.fret} ({pattern ? "lowest tonic in this pattern" : "lowest available tonic"}). Follow the highlighted notes toward the next octave.</p>}
      <div className="actions scale-related" aria-label="Related scales">
        <span>Compare nearby interval sets:</span>
        {related.map(({ scale: neighbor, common }) => <button key={neighbor.id} type="button"
          onClick={() => update({ scaleId: neighbor.id, position: "" })}>{neighbor.name} · {common} shared tones</button>)}
      </div>
    </div>
    <div className="form-row">
      <label>Labels<select value={settings.display} onChange={event => update({ display: event.target.value as DisplayMode })}>
        <option value="dots">Dots</option><option value="notes">Notes</option><option value="intervals">Intervals</option>
      </select></label>
      <label>Pattern system<select value={settings.pattern} onChange={event => update({ pattern: event.target.value as ScaleSettings["pattern"], position: "" })}>
        <option value="all">Full fretboard</option><option value="caged">CAGED · 5 forms</option><option value="3nps">3NPS · 7 patterns</option>
      </select></label>
      {pattern && <label>Position<select value={pattern.id} onChange={event => update({ position: event.target.value })}>
        {patternResult.patterns.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>}
    </div>
    {patternResult.reason && <p className="notice">{patternResult.reason}</p>}
    {pattern && <p className="scale-pattern-label">{pattern.name} — frets {Math.min(...pattern.notes.map(n => n.fret))}–{Math.max(...pattern.notes.map(n => n.fret))}.
      {settings.pattern === "3nps" && " Three consecutive scale tones per string; wide stretches may require shifting."}
      {settings.pattern === "caged" && (scale.id === "natural-minor" || scale.id === "minor-pentatonic")
        && " These are the relative-major chord forms, not minor chord grips. Root markers still show the selected minor tonic."}</p>}
    <p id={`${id}-board-help`} className="muted">{inputSource === "clicks"
      ? "Input source: fretboard clicks (or keyboard). No microphone is used."
      : "Input source: experimental live monophonic microphone. Fretboard clicks do not count as played notes and synthesized audio is muted."}
      {" "}Root = R / ◎. Arrow keys move between frets and strings; Enter or Space plays. Off-scale frets remain playable.</p>
    <div className="scale-fretboard-scroll" role="region" aria-label="Scrollable guitar fretboard" tabIndex={0}>
      <table className="scale-fretboard" ref={board} aria-describedby={`${id}-board-help`}>
        <caption>{noteName(settings.root)} {scale.name} · {tuning.name} · {pattern?.name ?? "all scale notes"}</caption>
        <thead><tr><th scope="col">String</th>{Array.from({ length: 25 }, (_, fret) => <th scope="col" key={fret}>{fret}</th>)}</tr></thead>
        <tbody>{[...tuning.midi].reverse().map((open, row) => {
          const string = tuning.midi.length - row - 1;
          return <tr key={string}><th scope="row">{tuning.midi.length - string} · {noteName(open)}</th>
            {cells.filter(n => n.string === string).map(note => {
              const interval = (note.midi - settings.root + 120) % 12;
              const inScale = scale.intervals.includes(interval);
              const key = `${string}:${note.fret}`;
              const highlighted = inScale && (!pattern || selectedCells.has(key));
              const label = settings.display === "dots" ? (interval === 0 ? "◎" : "●")
                : settings.display === "notes" ? noteName(note.midi) : intervalName(interval);
              return <td key={note.fret}><button type="button" className={`scale-note${highlighted ? " scale-note-in" : " scale-note-out"}${highlighted && interval === 0 ? " scale-note-root" : ""}${lastNote === key ? " scale-note-active" : ""}${livePitch === note.midi ? " scale-note-live" : ""}`}
                data-cell={key} tabIndex={focusedCell === key ? 0 : -1}
                aria-label={`String ${tuning.midi.length - string}, fret ${note.fret}, ${noteName(note.midi)}${Math.floor(note.midi / 12) - 1}, ${inScale ? intervalName(interval) : "outside scale"}${highlighted && pattern ? `, ${pattern.name}` : ""}`}
                onFocus={() => setFocusedCell(key)} onKeyDown={event => navigate(event, note)} onClick={() => playFret(note)}>
                {highlighted ? label : "·"}
              </button></td>;
            })}
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="form-row">
      <label>Tempo (BPM)<input type="number" min={30} max={240} step={1} value={settings.bpm}
        onChange={event => {
          const bpm = Number(event.target.value);
          if (Number.isInteger(bpm) && bpm >= 30 && bpm <= 240) update({ bpm });
        }} /></label>
      <label>Direction<select value={settings.direction} onChange={event => update({ direction: event.target.value as Direction })}>
        <option value="ascending">Ascending</option><option value="descending">Descending</option><option value="both">Ascending &amp; descending</option>
      </select></label>
      <label>Time signature<select value={settings.signature} onChange={event => update({ signature: event.target.value as TimeSignature })}>
        {(["4/4", "3/4", "6/8", "5/4", "7/8"] as const).map(signature => <option key={signature} value={signature}>{signature}</option>)}
      </select></label>
    </div>
    <details className="scale-sound-settings"><summary>Sound settings</summary>
      <div className="form-row">
        <label>Tone<select value={settings.waveform} onChange={event => update({ waveform: event.target.value as ScaleSettings["waveform"] })}>
          <option value="triangle">Soft pluck</option><option value="sine">Pure tone</option><option value="square">Bright tone</option>
        </select></label>
        <label>Volume<input type="range" min={0} max={1} step={0.05} value={settings.volume}
          onChange={event => update({ volume: Number(event.target.value) })} /></label>
      </div>
      <p className="muted">Synthesized tones, not recorded guitar. BPM counts quarter notes; /8 meters click eighth notes. The first beat of each bar is accented.</p>
    </details>
    <p className="scale-sequence">{sequence.map(noteName).join(" → ")}</p>
    <div className="actions">
      <button type="button" onClick={playScale} disabled={playing || practice !== null || inputSource === "microphone"}>{playing ? "Playing scale…" : "Play scale"}</button>
      <button type="button" onClick={stopAudio}>Stop audio</button>
      <button type="button" aria-pressed={metronome} onClick={toggleMetronome} disabled={inputSource === "microphone"}>{metronome ? "Stop metronome" : "Start metronome"}</button>
    </div>
    <section className="scale-practice" aria-labelledby={`${id}-practice`}>
      <h3 id={`${id}-practice`} tabIndex={-1} ref={practiceHeading}>Timed practice</h3>
      <p className="muted">Note matching, not technique analysis. Clean means a full target cycle without wrong notes; timing and sound quality are not graded. Any octave counts. Only sequence runs are saved to progress. Free practice is ungraded and never marked clean.</p>
      <div className="form-row">
        <label>Note input<select value={inputSource} onChange={event => {
          clearRun(); stopAudio(); stopMicrophone();
          setInputSource(event.target.value === "microphone" ? "microphone" : "clicks");
          setStatus("Input changed. Start a new practice run.");
        }}>
          <option value="clicks">Fretboard clicks / keyboard</option>
          <option value="microphone">Live microphone (experimental, one note)</option>
        </select></label>
        <label>Practice mode<select value={settings.practiceMode} onChange={event => update({ practiceMode: event.target.value as ScaleSettings["practiceMode"] })}>
          <option value="sequence">Sequence</option><option value="random">Random targets</option><option value="free">Free exploration</option>
        </select></label>
        <label>Run duration<select value={settings.duration} onChange={event => update({ duration: Number(event.target.value) })}>
          <option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option>
        </select></label>
      </div>
      {inputSource === "microphone" && <div className="scale-microphone">
        <p className="notice">Experimental single-note pitch input. Use headphones and a clean, quiet guitar signal; chords, distortion and background sound can be misidentified. Synthesized playback is muted to prevent feedback. Hold a note briefly to stabilize; mute between repeated notes. Periodicity is not an accuracy score. No recording is saved or uploaded. Capture stops after 3 minutes.</p>
        <p role="status">{microphoneStatus}</p>
        <button type="button" onClick={microphoneState === "off" ? startMicrophone : () => {
          stopMicrophone(); clearRun(); setStatus("Microphone stopped. No attempt saved.");
        }}>{microphoneState === "requesting" ? "Cancel microphone request" : microphoneState === "listening" ? "Stop microphone" : "Enable microphone"}</button>
      </div>}
      <p role="status">{status}</p>
      {practice && <div className="scale-target">
        <p aria-live="polite">{practice.mode === "free" ? `${practice.hits} notes explored`
          : `Target: ${noteName(practice.target)} · ${practice.hits} correct · ${practice.errors} wrong notes`}</p>
        <p><time>{remaining}s remaining</time></p>
      </div>}
      <div className="actions">
        <button type="button" onClick={startPractice} disabled={practice !== null || (inputSource === "microphone" && microphoneState !== "listening")}>Start practice</button>
        {practice && <button type="button" onClick={() => {
          clearRun(); stopAudio(); stopMicrophone(); setStatus("Practice cancelled. No attempt saved.");
        }}>Cancel practice</button>}
      </div>
    </section>
  </section>;
}
