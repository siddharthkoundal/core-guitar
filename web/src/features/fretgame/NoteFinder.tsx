import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useInputProfile } from "../../audio/inputProfile";
import { frequencyToMidi, LivePitchInput } from "../../audio/pitch";
import type { PitchSource } from "../../audio/pitch";
import { InputDevicePicker } from "../../components/InputDevicePicker";
import { noteName, TUNINGS } from "../scales/theory";
import {
  activeStrings, answerRound, applyRecords, failRound, GAME_MODES, heatCell, heatLevel, loadStore, MAX_FRET, MODE_NAMES,
  NATURALS, noteLabel, promptText, requiredMidis, ROUND_LENGTHS, saveStore, StableNoteGate, startRound, statKey,
  stringNumber, TIMER_CHOICES, tuningMidi,
} from "./game";
import type { Answer, GameSettings, Round, RoundStep, Stats } from "./game";

export interface NoteFinderProps {
  /** Injected in tests; defaults to live device input. */
  createInput?: () => PitchSource;
  /** Called with first-try correct answers when a full round finishes. */
  onComplete?: (correct: number, total: number) => void;
}
type ListenState = "off" | "starting" | "listening";

export function NoteFinder({ createInput = () => new LivePitchInput(), onComplete }: NoteFinderProps) {
  const id = useId();
  const [initial] = useState(loadStore);
  const [settings, setSettings] = useState<GameSettings>(initial.store.settings);
  const [stats, setStats] = useState<Stats>(initial.store.stats);
  const [storageError, setStorageError] = useState(initial.error ?? "");
  const [round, setRound] = useState<Round | null>(null);
  const [summary, setSummary] = useState<{ correct: number; total: number; averageMs: number | null } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [listen, setListen] = useState<ListenState>("off");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [focused, setFocused] = useState("");
  const [profile, updateProfile] = useInputProfile();
  const roundRef = useRef<Round | null>(null);
  const statsRef = useRef<Stats>(initial.store.stats);
  const input = useRef<PitchSource | null>(null);
  const gate = useRef(new StableNoteGate());
  const generation = useRef(0);
  const board = useRef<HTMLTableElement>(null);

  const tuning = tuningMidi(settings.tuningId);
  const tuningName = TUNINGS.find(item => item.id === settings.tuningId)?.name ?? "";
  const strings = activeStrings(settings, tuning.length);
  const frets = Array.from({ length: settings.maxFret - settings.minFret + 1 }, (_, index) => settings.minFret + index);

  useEffect(() => () => { generation.current++; input.current?.stop(); input.current = null; }, []);

  function persist(nextSettings: GameSettings, nextStats: Stats): void {
    setStorageError(saveStore({ version: 1, settings: nextSettings, stats: nextStats }) ?? "");
  }
  function updateSettings(change: Partial<GameSettings>): void {
    const next = { ...settings, ...change };
    if (change.tuningId !== undefined) next.strings = activeStrings(next, tuningMidi(next.tuningId).length);
    setSettings(next);
    setSummary(null);
    persist(next, statsRef.current);
  }
  function stopListening(): void {
    generation.current++;
    input.current?.stop();
    input.current = null;
    setListen("off");
    setHeard("");
  }
  function finish(next: Round): void {
    stopListening();
    const total = next.settings.roundLength;
    const averageMs = next.solvedMs.length ? Math.round(next.solvedMs.reduce((a, b) => a + b, 0) / next.solvedMs.length) : null;
    setSummary({ correct: next.firstTry, total, averageMs });
    onComplete?.(next.firstTry, total);
  }
  function apply(step: RoundStep): void {
    if (step.records.length) {
      const nextStats = applyRecords(statsRef.current, step.records);
      statsRef.current = nextStats;
      setStats(nextStats);
      persist(step.round.settings, nextStats);
    }
    roundRef.current = step.round;
    if (step.round.prompt === null) {
      roundRef.current = null;
      setRound(null);
      finish(step.round);
    } else setRound(step.round);
  }
  function answer(value: Answer): void {
    const current = roundRef.current;
    if (!current) return;
    const now = performance.now();
    const step = answerRound(current, value, statsRef.current, now);
    if (step.outcome === "correct" || step.outcome === "progress") gate.current.pause(now);
    apply(step);
  }
  const answerRef = useRef(answer);
  answerRef.current = answer;
  function fail(reason: "timeout" | "skip"): void {
    const current = roundRef.current;
    if (current) apply(failRound(current, reason, statsRef.current, performance.now()));
  }
  const failRef = useRef(fail);
  failRef.current = fail;

  const promptKey = round ? `${round.index}` : "";
  useEffect(() => {
    if (!promptKey || !settings.timerSeconds) return;
    const timer = setTimeout(() => failRef.current("timeout"), settings.timerSeconds * 1000);
    return () => clearTimeout(timer);
  }, [promptKey, settings.timerSeconds]);

  async function listenLive(): Promise<void> {
    stopListening();
    const run = generation.current;
    const source = createInput();
    input.current = source;
    gate.current = new StableNoteGate();
    setError("");
    setListen("starting");
    try {
      await source.start(profile.deviceId, {
        onPitch: reading => {
          if (run !== generation.current) return;
          setHeard(reading ? noteLabel(Math.round(frequencyToMidi(reading.frequency))) : "");
          const midi = gate.current.feed(reading, performance.now());
          if (midi !== null) answerRef.current({ kind: "midi", midi });
        },
        onError: problem => {
          if (run !== generation.current) return;
          input.current = null;
          setListen("off");
          setError(`${problem.message} Switch “Answer with” to fretboard clicks to keep playing.`);
        },
      });
      if (run !== generation.current) return;
      setListen("listening");
      setRefreshKey(key => key + 1);
    } catch (problem) {
      if (run !== generation.current) return;
      input.current = null;
      setListen("off");
      setError(`${problem instanceof Error ? problem.message : "Audio input could not start."} Use fretboard clicks instead.`);
    }
  }
  function start(): void {
    setSummary(null);
    setConfirmReset(false);
    const next = startRound(settings, statsRef.current, performance.now());
    if (!next.prompt) {
      setError("No notes match these settings. Widen the fret range, add strings or include sharps and flats.");
      return;
    }
    setError("");
    roundRef.current = next;
    setRound(next);
    if (settings.answer === "live") void listenLive();
  }
  function end(): void {
    stopListening();
    roundRef.current = null;
    setRound(null);
  }
  function resetStats(): void {
    statsRef.current = {};
    setStats({});
    setConfirmReset(false);
    persist(settings, {});
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, string: number, fret: number): void {
    const rows = [...strings].reverse();
    let row = rows.indexOf(string);
    let column = fret;
    if (event.key === "ArrowRight") column = Math.min(settings.maxFret, fret + 1);
    else if (event.key === "ArrowLeft") column = Math.max(settings.minFret, fret - 1);
    else if (event.key === "ArrowUp") row = Math.max(0, row - 1);
    else if (event.key === "ArrowDown") row = Math.min(rows.length - 1, row + 1);
    else return;
    event.preventDefault();
    const key = `${rows[row] ?? string}:${column}`;
    setFocused(key);
    board.current?.querySelector<HTMLButtonElement>(`[data-cell="${key}"]`)?.focus();
  }

  const prompt = round?.prompt ?? null;
  const clickBoard = round !== null && settings.answer === "click" && prompt?.mode !== "name";
  const highlighted = prompt?.mode === "name" ? prompt.targets[0] : undefined;
  const found = new Set(round?.found.map(item => item.midi));
  const required = prompt ? requiredMidis(prompt) : [];
  const firstCell = `${strings[strings.length - 1] ?? 0}:${settings.minFret}`;
  const tabCell = focused || firstCell;
  const choices = settings.naturalsOnly ? NATURALS : Array.from({ length: 12 }, (_, index) => index);

  return <section className="panel note-finder" aria-labelledby={`${id}-heading`}>
    <p className="eyebrow">SEE IT / FIND IT / PLAY IT</p>
    <h2 id={`${id}-heading`}>Note finder</h2>
    <p className="muted">Fretboard memory game. Answer by playing (microphone or USB input) or by clicking the fretboard.
      Positions you miss or answer slowly come up more often. Statistics stay in this browser.</p>
    <div role="alert">{storageError && <p className="notice">{storageError}</p>}{error && <p className="notice">{error}</p>}</div>
    {!round && <>
      <div className="form-row">
        <label>Game mode<select value={settings.mode} onChange={event => {
          const mode = GAME_MODES.find(item => item === event.target.value);
          if (mode) updateSettings({ mode });
        }}>{GAME_MODES.map(mode => <option key={mode} value={mode}>{MODE_NAMES[mode]}</option>)}</select></label>
        <label>Tuning<select value={settings.tuningId} onChange={event => updateSettings({ tuningId: event.target.value })}>
          {TUNINGS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Answer with<select value={settings.answer} onChange={event =>
          updateSettings({ answer: event.target.value === "live" ? "live" : "click" })}>
          <option value="click">Fretboard clicks (no microphone)</option>
          <option value="live">Play it (microphone or USB input)</option>
        </select></label>
      </div>
      <div className="form-row">
        <label>From fret<input type="number" min={0} max={MAX_FRET} value={settings.minFret} onChange={event => {
          const value = Math.round(Number(event.target.value));
          if (Number.isFinite(value) && value >= 0 && value <= MAX_FRET) {
            updateSettings({ minFret: value, maxFret: Math.max(value, settings.maxFret) });
          }
        }} /></label>
        <label>To fret<input type="number" min={0} max={MAX_FRET} value={settings.maxFret} onChange={event => {
          const value = Math.round(Number(event.target.value));
          if (Number.isFinite(value) && value >= 0 && value <= MAX_FRET) {
            updateSettings({ maxFret: value, minFret: Math.min(value, settings.minFret) });
          }
        }} /></label>
        <label>Notes<select value={settings.naturalsOnly ? "naturals" : "all"}
          onChange={event => updateSettings({ naturalsOnly: event.target.value === "naturals" })}>
          <option value="naturals">Naturals only</option><option value="all">All notes (sharps/flats)</option></select></label>
        <label>Round length<select value={settings.roundLength} onChange={event => {
          const length = ROUND_LENGTHS.find(item => item === Number(event.target.value));
          if (length) updateSettings({ roundLength: length });
        }}>{ROUND_LENGTHS.map(length => <option key={length} value={length}>{length} prompts</option>)}</select></label>
        <label>Time per prompt<select value={settings.timerSeconds} onChange={event => {
          const seconds = TIMER_CHOICES.find(item => item === Number(event.target.value));
          if (seconds !== undefined) updateSettings({ timerSeconds: seconds });
        }}>{TIMER_CHOICES.map(seconds => <option key={seconds} value={seconds}>{seconds ? `${seconds} s` : "No timer"}</option>)}</select></label>
      </div>
      <fieldset className="note-finder-strings">
        <legend>Strings</legend>
        {tuning.map((open, string) => ({ open, string })).reverse().map(({ open, string }) =>
          <label key={string}><input type="checkbox" checked={strings.includes(string)} onChange={event => {
            const next = event.target.checked ? [...strings, string] : strings.filter(item => item !== string);
            if (next.length) updateSettings({ strings: next.sort((a, b) => a - b) });
          }} />String {stringNumber(string, tuning.length)} ({noteName(open)})</label>)}
      </fieldset>
      {settings.answer === "live" && <InputDevicePicker profile={profile} onChange={updateProfile} refreshKey={refreshKey} />}
      {summary && <p className="verdict" role="status">{summary.correct} / {summary.total} first-try correct
        {summary.averageMs !== null ? ` · average ${(summary.averageMs / 1000).toFixed(1)} s` : ""}</p>}
      <div className="actions"><button className="primary" onClick={start}>Start round</button></div>
    </>}
    {round && prompt && <>
      <p className="eyebrow">PROMPT {round.index + 1} / {round.settings.roundLength} · {MODE_NAMES[prompt.mode]}
        {settings.timerSeconds ? ` · ${settings.timerSeconds} S LIMIT` : ""}</p>
      <h3 className="note-finder-prompt">{promptText(prompt, settings, tuning.length)}</h3>
      <p className="muted">Frets {settings.minFret}–{settings.maxFret}{prompt.mode === "octaves"
        ? ` · ${found.size} of ${required.length} found` : ""}{settings.answer === "live"
        ? " · Let each note ring until it is scored; mute between notes." : ""}</p>
      {settings.answer === "live" && <p className="muted" aria-hidden="true">
        {listen === "starting" ? "Waiting for audio input permission…" : listen === "listening" ? `Hearing: ${heard || "—"}` : "Input is off."}</p>}
      {settings.answer === "click" && prompt.mode === "name" && <div className="note-finder-choices" role="group" aria-label="Note choices">
        {choices.map(pitchClass => <button key={pitchClass} onClick={() => answer({ kind: "pitchClass", pitchClass })}>{noteName(pitchClass)}</button>)}
      </div>}
    </>}
    <div className="scale-fretboard-scroll" role="region" aria-label="Note finder fretboard" tabIndex={0}>
      <table className="scale-fretboard note-finder-board" ref={board}>
        <caption>{tuningName} · frets {settings.minFret}–{settings.maxFret}{clickBoard ? " · arrow keys move, Enter answers" : ""}</caption>
        <thead><tr><th scope="col">String</th>{frets.map(fret => <th scope="col" key={fret}>{fret}</th>)}</tr></thead>
        <tbody>{[...strings].reverse().map(string => <tr key={string}>
          <th scope="row">{stringNumber(string, tuning.length)} · {noteName(tuning[string] ?? 0)}</th>
          {frets.map(fret => {
            const key = `${string}:${fret}`;
            const midi = (tuning[string] ?? 0) + fret;
            const target = highlighted?.string === string && highlighted.fret === fret;
            const ticked = prompt?.mode === "octaves" && found.has(midi);
            const className = `scale-note${target ? " note-finder-target" : ""}${ticked ? " note-finder-found" : ""}`;
            const label = `String ${stringNumber(string, tuning.length)}, fret ${fret}${target ? ", highlighted" : ""}${ticked ? `, found ${noteLabel(midi)}` : ""}`;
            return <td key={fret}>{clickBoard
              ? <button type="button" className={className} data-cell={key} tabIndex={tabCell === key ? 0 : -1} aria-label={label}
                onFocus={() => setFocused(key)} onKeyDown={event => navigate(event, string, fret)}
                onClick={() => answer({ kind: "position", string, fret })}>{ticked ? "✓" : "·"}</button>
              : <span className={className} role="img" aria-label={label}>{target ? "●" : ticked ? "✓" : "·"}</span>}</td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    {round && <>
      <p role="status" className="note-finder-feedback">{round.feedback || (settings.answer === "live" ? "Play when ready." : "Click your answer.")}</p>
      <div className="actions">
        <button onClick={() => fail("skip")}>Skip prompt</button>
        {settings.answer === "live" && listen === "off" && <button onClick={() => void listenLive()}>Restart input</button>}
        <button onClick={end}>End round</button>
      </div>
    </>}
    <section className="note-finder-stats" aria-labelledby={`${id}-stats`}>
      <h3 id={`${id}-stats`}>Your fretboard map</h3>
      <p className="muted">First-try accuracy and average answer time per position. Darker cells need more practice.</p>
      <div className="table-scroll" role="region" aria-label="Fretboard statistics" tabIndex={0}>
        <table className="note-finder-heatmap">
          <caption>{tuningName} · frets {settings.minFret}–{settings.maxFret}</caption>
          <thead><tr><th scope="col">String</th>{frets.map(fret => <th scope="col" key={fret}>{fret}</th>)}</tr></thead>
          <tbody>{tuning.map((open, string) => ({ open, string })).reverse().map(({ open, string }) => <tr key={string}>
            <th scope="row">{stringNumber(string, tuning.length)} · {noteName(open)}</th>
            {frets.map(fret => {
              const cell = heatCell(stats[statKey(settings.tuningId, string, fret)]);
              return <td key={fret} className={`heat-${heatLevel(cell)}`}>
                {cell.accuracy === null ? <><span aria-hidden="true">–</span><span className="visually-hidden">no data</span></> : <>
                  <span>{cell.accuracy}%</span>
                  <small>{cell.averageMs === null ? `${cell.attempts}×` : `${(cell.averageMs / 1000).toFixed(1)} s`}</small>
                </>}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="actions">
        {!confirmReset
          ? <button onClick={() => setConfirmReset(true)} disabled={!Object.keys(stats).length}>Reset stats</button>
          : <>
            <button className="primary" onClick={resetStats}>Confirm reset stats</button>
            <button onClick={() => setConfirmReset(false)}>Keep stats</button>
          </>}
      </div>
    </section>
  </section>;
}
