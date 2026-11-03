import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { loadHistory } from "../chords/history";
import { loadSettings } from "../scales/settings";
import { SCALE_CATALOG, TUNINGS, noteName } from "../scales/theory";
import { askCoach, coachStatus } from "./client";
import type { CoachMessage, CoachRequest, CoachStatus } from "./client";
import { clearSavedPlans, isLevel, loadSavedPlans, storeSavedPlans } from "./storage";
import type { SavedPlan } from "./storage";
import "./coach.css";

export interface CoachProps {
  context?: string;
  onOpenScale?: (scaleId: string, root: number) => void;
}

interface Conversation {
  goal: string;
  level: CoachRequest["level"];
  context: string;
  messages: CoachMessage[];
  text: string;
  model: string;
}

interface Suggestion {
  scaleId: string;
  root: number;
  name: string;
}

const THEORY = "Local catalog (semitone intervals above root; roots C=0 to B=11):\n" +
  SCALE_CATALOG.map((scale) => `${scale.id}: ${scale.intervals.join(",")}`).join("\n") +
  "\nMajor triad 0,4,7; minor 0,3,7; dominant seventh 0,4,7,10. " +
  "Major key triads I ii iii IV V vi vii diminished. " +
  "Standard guitar open strings low to high E2 A2 D3 G3 B3 E4.";

function localContext(context: string): string {
  const chords = loadHistory();
  const saved = loadSettings();
  const tuning = TUNINGS.find((item) => item.id === saved.settings.tuningId);
  const recentChords = chords.entries.slice(-16).map((chord) => chord.name);
  return (`${THEORY.slice(0, 3000)}\nCurrent local selection:\n${context.slice(0, 4000)}` +
    `\nSaved tuning: ${tuning?.name ?? "standard"}; saved tempo: ${saved.settings.bpm} BPM.` +
    `\nRecent locally detected chords (experimental, not verified): ${recentChords.join(", ") || "none"}.` +
    (chords.warning ? `\nChord history status: ${chords.warning}` : "") +
    (saved.error ? `\nTuning settings status: ${saved.error.slice(0, 300)}` : "")).slice(0, 8000);
}

function suggestions(text: string): Suggestion[] {
  const found: Suggestion[] = [];
  for (const match of text.matchAll(/\[scale:([a-z0-9-]{1,80}):(\d{1,2})\]/g)) {
    const scale = SCALE_CATALOG.find((item) => item.id === match[1]);
    const root = Number(match[2]);
    if (scale && Number.isInteger(root) && root >= 0 && root <= 11 &&
      !found.some((item) => item.scaleId === scale.id && item.root === root)) {
      found.push({ scaleId: scale.id, root, name: scale.name });
    }
    if (found.length === 4) break;
  }
  return found;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The local coach request failed. Please retry.";
}

export function Coach({ context = "", onOpenScale }: CoachProps): ReactElement {
  const id = useId();
  const [goal, setGoal] = useState("");
  const [level, setLevel] = useState<CoachRequest["level"]>("beginner");
  const [followup, setFollowup] = useState("");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [plans, setPlans] = useState<SavedPlan[]>([]);
  const [status, setStatus] = useState<CoachStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  function refreshStatus(): void {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setChecking(true);
    setStatusError("");
    void coachStatus(controller.signal).then((value) => {
      if (!controller.signal.aborted) setStatus(value);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setStatusError(message(failure));
    }).finally(() => {
      if (!controller.signal.aborted) setChecking(false);
    });
  }

  useEffect(() => {
    try { setPlans(loadSavedPlans()); } catch (failure: unknown) { setError(message(failure)); }
    refreshStatus();
    return () => {
      request.current?.abort();
      statusRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (conversation) resultHeading.current?.focus();
  }, [conversation]);

  async function generate(isFollowup: boolean): Promise<void> {
    const prompt = (isFollowup ? followup : goal).trim();
    if (!prompt || prompt.length > 4000 || busy) return;
    const previous = isFollowup ? conversation : null;
    const selectedLevel = previous?.level ?? level;
    const selectedContext = previous?.context ?? localContext(context);
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const answer = await askCoach({
        kind: "plan", prompt, level: selectedLevel, context: selectedContext,
        ...(previous ? { messages: previous.messages.slice(-12) } : {}),
      }, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      const messages: CoachMessage[] = [
        ...(previous?.messages ?? []),
        { role: "user", content: prompt }, { role: "assistant", content: answer.text },
      ];
      setConversation({
        goal: previous?.goal ?? prompt, level: selectedLevel, context: selectedContext,
        messages: messages.slice(-12), ...answer,
      });
      setFollowup("");
    } catch (failure: unknown) {
      if (!controller.signal.aborted) setError(message(failure));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  function cancel(): void {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setNotice("Generation cancelled. Ollama may finish its already-started local computation.");
  }

  function save(): void {
    if (!conversation) return;
    const next = [{ ...conversation, id: crypto.randomUUID() }, ...plans].slice(0, 10);
    try {
      storeSavedPlans(next);
      setPlans(next);
      setNotice("Plan saved on this browser only.");
      setError("");
    } catch (failure: unknown) { setError(message(failure)); }
  }

  function remove(idToRemove: string): void {
    const next = plans.filter((plan) => plan.id !== idToRemove);
    try {
      storeSavedPlans(next);
      setPlans(next);
      setError("");
    } catch (failure: unknown) { setError(message(failure)); }
  }

  function clear(): void {
    try {
      clearSavedPlans();
      setPlans([]);
      setError("");
      setNotice("Saved plans cleared.");
    } catch (failure: unknown) { setError(message(failure)); }
  }

  const scaleSuggestions = conversation ? suggestions(conversation.text) : [];

  return <section className="coach" aria-labelledby={`${id}-heading`}>
    <header className="coach-header">
      <p className="eyebrow">On-device guidance · no cloud fallback</p>
      <h2 id={`${id}-heading`}>Your local practice coach</h2>
      <p>Turn a goal into a practice plan, then ask follow-up questions. Uses local theory
        context and a locally installed Ollama model — not web research or measured assessment.</p>
    </header>
    <aside className="coach-setup" aria-labelledby={`${id}-setup`}>
      <h3 id={`${id}-setup`}>Local setup</h3>
      <p role="status">{checking ? "Checking local Ollama…" : status?.available
        ? `Ollama is running. Local models: ${status.models.join(", ") || "none installed"}.`
        : status ? "Ollama is not running. Start the local service to generate a plan."
          : "Local Ollama status is unknown."}</p>
      {statusError && <p role="alert">{statusError}</p>}
      <button type="button" onClick={refreshStatus} disabled={checking}>Refresh local status</button>
      <details>
        <summary>Install and configure Ollama locally</summary>
        <p>Install Ollama on this computer, then run <code>ollama serve</code> and
          {" "}<code>ollama pull llama3.2</code> in your terminal. Model downloads require
          internet during setup; generation stays local.</p>
        <p>The backend uses <code>http://127.0.0.1:11434</code> only. To change its model,
          set <code>COREGUITAR_OLLAMA_MODEL</code> to an installed local model before starting
          CoreGuitar. Cloud models, proxies, redirects and tools are disabled.
          One generation runs at a time; responses are limited to 12,000 characters.</p>
      </details>
    </aside>
    <form className="coach-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void generate(false); }}>
      <label htmlFor={`${id}-goal`}>Practice goal</label>
      <textarea id={`${id}-goal`} value={goal} maxLength={4000} required rows={3}
        disabled={busy} onChange={(event) => setGoal(event.target.value)}
        placeholder="Build a 15-minute routine for G major and improvisation" />
      <label htmlFor={`${id}-level`}>Experience level</label>
      <select id={`${id}-level`} value={level} disabled={busy} onChange={(event) => {
        if (isLevel(event.target.value)) setLevel(event.target.value);
      }}>
        <option value="beginner">Beginner</option>
        <option value="intermediate">Intermediate</option>
        <option value="advanced">Advanced</option>
      </select>
      <div className="coach-actions">
        <button type="submit" disabled={busy || !goal.trim()}>Generate practice plan</button>
        {busy && <button type="button" onClick={cancel}>Cancel generation</button>}
      </div>
    </form>
    {busy && <p role="status">Thinking locally… This can take a minute. You can cancel at any time.</p>}
    {error && <p role="alert" className="coach-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {conversation && <section aria-labelledby={`${id}-answer`} className="coach-answer" aria-busy={busy}>
      <h3 id={`${id}-answer`} ref={resultHeading} tabIndex={-1}>Practice plan (suggestion)</h3>
      <p className="muted">Local model: {conversation.model}. AI suggestions can be wrong;
        verify fingerings and use comfortable tempos.</p>
      <div className="coach-text">{conversation.text}</div>
      {onOpenScale && scaleSuggestions.length > 0 && <div className="coach-actions">
        {scaleSuggestions.map((item) => <button type="button" key={`${item.scaleId}-${item.root}`}
          onClick={() => onOpenScale(item.scaleId, item.root)}>
          Open {noteName(item.root)} {item.name} on fretboard
        </button>)}
      </div>}
      <button type="button" onClick={save} disabled={busy}>Save plan</button>
      <details>
        <summary>Earlier conversation (latest answer shown above)</summary>
        <ol>{conversation.messages.slice(0, -1).map((item, index) =>
          <li key={index}><strong>{item.role === "user" ? "You" : "Local coach"}</strong>
            <div className="coach-text">{item.content}</div></li>)}</ol>
      </details>
      <form className="coach-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void generate(true); }}>
        <label htmlFor={`${id}-followup`}>Follow-up question</label>
        <textarea id={`${id}-followup`} value={followup} maxLength={4000} required rows={2}
          disabled={busy} onChange={(event) => setFollowup(event.target.value)} />
        <button type="submit" disabled={busy || !followup.trim()}>Ask follow-up</button>
      </form>
    </section>}
    <section className="coach-saved" aria-labelledby={`${id}-saved`}>
      <h3 id={`${id}-saved`}>Saved plans</h3>
      <p>Up to 10 plans, stored only in this browser. Saving replaces the oldest when full.
        No automatic progress tracking or web research.</p>
      {plans.length === 0 && <p>No saved plans yet.</p>}
      <ul>{plans.map((plan) => <li key={plan.id}>
        <button type="button" disabled={busy} onClick={() => {
          setConversation(plan); setGoal(plan.goal); setLevel(plan.level); setFollowup("");
          setError(""); setNotice("Loaded saved plan.");
        }}>Load {plan.goal.slice(0, 100)}</button>
        <button type="button" onClick={() => remove(plan.id)} aria-label={`Delete ${plan.goal.slice(0, 100)}`}>Delete</button>
      </li>)}</ul>
      <button type="button" onClick={clear}>Clear saved plans</button>
    </section>
  </section>;
}
