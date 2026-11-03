import { useEffect, useId, useRef, useState } from "react";
import { askCoach } from "../coach/client";
import { chordName } from "./detector";
import type { ChordShape } from "./detector";
import { parseProgression } from "./progression";

interface ChordAIProps { context: string; onChoose: (chord: ChordShape) => void }
interface Message { role: "user" | "assistant"; content: string }

export function ChordAI({ context, onChoose }: ChordAIProps) {
  const id = useId();
  const [genre, setGenre] = useState("Pop");
  const [prompt, setPrompt] = useState("Suggest a short, playable guitar chord progression.");
  const [level, setLevel] = useState<"beginner" | "intermediate" | "advanced">("beginner");
  const [followup, setFollowup] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState<{ text: string; model: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  async function send(isFollowup: boolean): Promise<void> {
    if (request.current) return;
    const question = isFollowup ? followup.trim() : prompt.trim();
    if (!question) { setError("Enter a progression prompt or a follow-up question."); return; }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    setNotice("");
    const history = isFollowup ? messages : [];
    const fullPrompt = `Genre: ${genre}. ${question}\n`
      + 'Explain your suggestion in plain text. Optionally add one fenced json block with exactly '
      + '{"chords":[{"root":0,"quality":"major"}]}. Root is an integer 0..11 (C=0). '
      + "Allowed qualities: major, minor, dom7, maj7, min7, dim, aug, sus2, sus4. Maximum 32 chords.";
    try {
      const response = await askCoach({
        kind: "progression", prompt: fullPrompt, level, context: context.slice(0, 6000),
        ...(history.length ? { messages: history.slice(-12) } : {}),
      }, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setReply(response);
      const nextMessages: Message[] = [...history, { role: "user", content: fullPrompt.slice(0, 4000) },
        { role: "assistant", content: response.text.slice(0, 4000) }];
      setMessages(nextMessages.slice(-12));
      setFollowup("");
    } catch (error) {
      if (controller.signal.aborted || request.current !== controller) return;
      setError(error instanceof Error ? error.message : "The local coach could not answer. Check Ollama and try again.");
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }

  function cancel(): void {
    request.current?.abort();
    request.current = null;
    setPending(false);
    setNotice("ChordAI request cancelled.");
  }

  const progression = reply ? parseProgression(reply.text) : [];
  return <section className="chord-ai" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>ChordAI / progression assistant</h3>
    <p className="muted">Uses your local Ollama only. No cloud requests. Suggestions are not measured assessments.</p>
    <form onSubmit={event => { event.preventDefault(); void send(false); }}>
      <div className="form-row">
        <label>Genre<select value={genre} onChange={event => setGenre(event.target.value)} disabled={pending}>
          {["Pop", "Rock", "Blues", "Jazz", "Folk", "Classical", "Other"].map(value =>
            <option key={value}>{value}</option>)}
        </select></label>
        <label>Playing level<select value={level} disabled={pending} onChange={event => {
          const value = event.target.value;
          if (value === "beginner" || value === "intermediate" || value === "advanced") setLevel(value);
        }}>
          <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option>
          <option value="advanced">Advanced</option>
        </select></label>
      </div>
      <label>Progression prompt<textarea maxLength={1800} value={prompt} disabled={pending}
        onChange={event => setPrompt(event.target.value)} /></label>
      <div className="actions">
        <button type="submit" disabled={pending}>Ask ChordAI</button>
        {pending && <button type="button" onClick={cancel}>Cancel ChordAI</button>}
      </div>
    </form>
    <p role="status" className="muted">{pending ? "Waiting for your local Ollama…" : notice}</p>
    <div role="alert">{error && <p className="notice">{error}</p>}</div>
    {reply && <>
      <p className="muted">Local model: {reply.model}</p>
      <pre className="chord-response">{reply.text}</pre>
      {progression.length > 0 && <div className="chord-progression" aria-label="Validated chord suggestions">
        {progression.map((chord, index) => <button type="button" key={index}
          onClick={() => onChoose(chord)} aria-label={`Use ${chordName(chord.root, chord.quality)} suggestion ${index + 1}`}>
          {chordName(chord.root, chord.quality)}
        </button>)}
      </div>}
      <form onSubmit={event => { event.preventDefault(); void send(true); }}>
        <label>Follow-up question<input value={followup} maxLength={1800} disabled={pending}
          onChange={event => setFollowup(event.target.value)} /></label>
        <button type="submit" disabled={pending || !followup.trim()}>Send follow-up</button>
      </form>
    </>}
  </section>;
}
