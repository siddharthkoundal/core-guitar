# core-guitar

A personal practice-feedback tool for guitar. You play, record, analyse, get
specific feedback, and retry.

**Current scope (M0 + M1).** A local Python analysis engine with a command-line
interface, for short, **clean-tone, single-note** exercises analysed **after**
recording.

**Stage 1A app.** A desktop-local browser UI now supports exercise selection,
custom riffs, free play, PCM WAV microphone recording, file upload, and
timestamped evidence playback. The analysis engine and its thresholds are
unchanged. There is no score, automatic tempo adjustment, or automatic calibration.

The studio uses a rock rehearsal-room visual style: gig-poster typography and
red/off-white controls. A three-step practice strip
and signal-chain checklist keep setup visible on desktop and mobile. All artwork
and fonts are local; the rock styling does not expand analysis beyond clean-tone,
single-note playing. Reduced-motion and keyboard-focus support remain built in.

The **recording analyser** still declines chords and backing tracks rather than
guessing. Distortion is declined in Mic + amp mode but analysed, with caveats, in
Processor (USB) mode (see below). Separate browser learning rooms now offer scales, ear
training and experimental live chord recognition; they do not change the
recording analyser or its accuracy claims.

### Learning rooms

The existing rehearsal-room design and take workflow are retained. The navigation
adds:

- **Fretboard:** 55 scale entries covering all 48 reference choices, 12 tunings (including 7/8 strings), note/interval/pattern
  displays, position guides, synthesized playback, metronome and scale practice.
- **Ear training:** ten-question interval, single-note, scale-identification and
  note-sequence quizzes with replay and answer feedback.
- **ChordAI:** browser microphone chord recognition across nine chord qualities
  and twelve roots, manual chord selection, local history and Ollama progression
  suggestions. Similarity is not a calibrated probability of correctness.
- **Coach:** goal- and level-based practice plans and follow-up conversation with
  a local Ollama model. Plans are suggestions, not measurements.
- **Library / Progress:** searchable scales, practice history, XP, levels, daily
  streaks and achievements. Three consecutive clean Sequence runs at 120 BPM or
  faster mark a scale/key combination learned; a later miss does not remove it.
  Learning XP is not a score for recorded playing.

CAGED major/minor and pentatonic forms and seven-note 3NPS shapes are available in
standard six-string tuning. Other tunings retain the full interactive fretboard
instead of presenting standard-tuning shapes as valid alternate-tuning fingerings.

Learning settings/history are stored in this browser, separately from audio takes.
Session history is capped at 100 entries and chord history at 200. Clearing browser
site data removes browser learning data; deleting saved takes does not clear
learning progress. The Progress room has a separate, confirmed reset.

#### Optional local AI (no API key)

Install [Ollama](https://ollama.com/). If it is not already running, start
`ollama serve` in a separate terminal. Then download a model once and launch:

```bash
ollama pull llama3.2
npm start
```

If Ollama is already running, do not start a second server. To select a different
installed model, start core-guitar with `COREGUITAR_OLLAMA_MODEL=<model> npm start`.
The backend talks only to `http://127.0.0.1:11434`; it does not accept a remote
model endpoint. Coach and ChordAI report an explicit error if the local service or
model is unavailable. The scale library, quizzes and existing analysis work
without Ollama.

These are original local implementations inspired by
[Scale Teacher](https://github.com/SeanSnaider/Guitar-Scale-Tool). Its cloud Claude
and web-research features are intentionally not used: local plans cannot claim to
have searched the web or verified current research. Microphone recognition remains
experimental; synthetic tests do not establish accuracy on real guitars.

> **Accuracy status.** Every result below comes from *synthetic* audio. That
> checks that the logic is consistent. It is **not** evidence of accuracy on
> real recordings. Real-world reliability is unknown until you run the M0
> protocol ([docs/m0-protocol.md](docs/m0-protocol.md)) on your own takes.

## Privacy

- All processing is local. No audio, findings or telemetry leave the machine.
- Recordings go in `data/`, which git ignores.
- App takes and analyses remain in `data/app/takes/` until you choose **Delete this
  take** or **Delete all saved takes**. CLI recordings can still be deleted directly.
  See [data/README.md](data/README.md).
- Optional language-model features run on local **Ollama** only. Installing Ollama
  and downloading models require network access during setup, not during practice.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"          # add ,notebook for the M0 explorer
brew install ffmpeg                        # needed for iPhone .m4a files
```

### Desktop-local app

Requires Python 3.10+ and Node.js 22.13+ for the frontend toolchain.

```bash
.venv/bin/pip install -e ".[app,dev]"
npm --prefix web ci
npm start
```

Open <http://127.0.0.1:8765>. Server dependencies are optional and lazy-imported:
the existing CLI commands do not import FastAPI or uvicorn. `serve` checks for
both ffmpeg and ffprobe before starting. Stop it with Ctrl+C.

**Quickest first test (no guitar or microphone):** keep the default exercise and
press **Try a demo take**. The local server generates a synthetic take of that
riff with one note played 80 ms late (`POST /api/demo-take`), then uploads and
analyzes it, so you land on results with a single timing finding. For a real take,
press **Continue to capture** and record or upload. Custom riffs and free play
are under **More options**.

All browser assets and requests use the same local origin, with no CDNs, telemetry,
or cloud calls. Optional AI requests are proxied to the fixed local Ollama service.
The server binds **127.0.0.1 only**,
accepts only localhost/127.0.0.1 host headers, and has no CORS support. This is
not a phone/LAN app: remote microphone access needs a secure HTTPS origin and
a separate authentication/network design, which are out of scope for Stage 1A.

Run these shortcuts from the repository root after setup:

| Command | Purpose |
|---|---|
| `npm start` | Build the frontend, then serve the complete app on port 8765 |
| `npm run backend` | Start only the Python backend on port 8765 |
| `npm run dev` | Start the frontend with live updates on port 5173 |
| `npm run build` | Build the production frontend |
| `npm test` | Run backend and frontend unit tests |
| `npm run test:backend` | Run only Python tests |
| `npm run test:frontend` | Run only frontend unit tests |
| `npm run typecheck` | Check frontend TypeScript |
| `npm run lint` | Lint the frontend |
| `npm run e2e` | Run isolated browser tests and coverage |

For development, use two terminals: `npm run backend` in one and `npm run dev`
in the other, then open <http://127.0.0.1:5173>. Vite's `/api` proxy forwards
to port 8765 on loopback. Stop each server with Ctrl+C.

Inside `web/`, both `npm start` and `npm run dev` launch the frontend only.
The root npm scripts are shortcuts to the existing tools, not a Node backend;
they use the `.venv` created during setup and add no dependencies.

### Browser recording and support

- Chrome 150 and Safari 27 on macOS were manually checked at 48 kHz: both
  captured PCM through an AudioWorklet and captured a 4 kHz speaker click.
- Chrome reported echo cancellation, noise suppression and automatic gain
  control all **false**. Safari reported echo cancellation **false** but did
  **not expose NS/AGC settings**; those off requests cannot be independently
  verified from `getSettings()`. The UI labels unreported settings explicitly.
  This spike is a feasibility check, not a real-guitar accuracy validation.
- The recorder requests EC/NS/AGC off, uses mono PCM16 WAV rather than
  MediaRecorder, remembers the microphone device locally, and starts the click
  only after receiving its first captured PCM buffer. Reference recording stops
  one second after click playback ends; all recordings have a 180 second cap.
- Set **macOS Mic Mode to Standard**. Use the clean amp channel in a quiet room
  with the microphone 20-40 cm from the amp. The click must be audible through
  speakers: **headphones lead to a no-click rejection**.
- Device changes, a disconnected microphone, or an interrupted AudioContext
  produce a partial take with a warning. Playback and submission remain available.
  Permission denial or no device still offer upload and click download.
- Uploads are streamed with a 100 MB cap, must contain audio lasting 2-180 seconds,
  and are checked by content rather than extension/MIME. Both analysis and
  evidence playback use the same float32 normalized `take.wav` at its native rate.
  Lossy codecs warn that **clipping detection is less reliable**.
- Quality and re-record advice come first. Coaching causes are hypotheses and
  drills are suggestions, not measurements. Free mode describes playing without
  judging correctness. Three consecutive rejections show the setup checklist.

Single-worker analysis runs in a killable subprocess with a 300 second timeout.
Cancellation keeps the take; deletion cancels any related work and removes its
audio, metadata and analyses. Completed results persist on disk across restarts.
There is no audio-take history database or take comparison UI in this stage;
the learning-session history is separate browser-local data.

### Frontend structure

```
web/src/
  main.tsx            entry point
  app/                studio shell: layout and focus on phase changes
  api/                local server client and response validation
    types.ts          exercise, take, request and analysis contracts
  audio/              PCM capture, click playback, WAV encoding
    types.ts          recording and recorder state contracts
  session/            session reducer and usePracticeSession workflow hook
    types.ts          session state/events and capture method
  components/         UI shared across features
    types.ts          shared component props
  features/
    exercise/         exercise, custom riff and free-play selection
      types.ts        exercise picker props
    capture/          record/upload, live meter, take review
      types.ts        capture component props and meter handle
    results/          quality, findings, evidence playback, next steps
      types.ts        results and next-step component props
    scales/           theory catalog, fretboard, synthesis and scale practice
    chords/           experimental browser chord recognition and progressions
    coach/            local Ollama client and saved practice plans
    learning/         ear quizzes, library, mastery and browser-local progress
```

- `session/usePracticeSession.ts` owns submission, polling, cancellation,
  validated take reuse, retries and deletion, using `sessionReducer`.
- Feature components receive state and callbacks as props. Only the session hook,
  the exercise picker and the recorder call the API directly.
- `features/capture/RecordingMeter.tsx` keeps 10 Hz audio meter updates in its
  own subtree instead of rerendering microphone controls. Clipping stays flagged
  until the next microphone attempt.
- `components/ProcessingWarnings.tsx` is shared by capture and results without
  pulling recorder code into results.
- Tests sit next to the code they cover; `src/test-utils.tsx` is shared.
- API contracts live under `api/types.ts`; audio and session state types live in
  their domain folders. Each feature's component props are declared in that
  feature's `types.ts`, with shared component props in `components/types.ts`.

New UI goes in the matching `features/<area>/` folder. Code used by more than one
feature goes in `components/`. These boundaries use React only, with no
state-management dependencies.
Unit tests cover workflow errors, cancellation, cached take reuse, tempo limits
and meter render isolation; browser tests cover the complete studio workflow.

## Recording (no audio interface)

1. Set the GA15II to the clean channel.
2. Place the MacBook or iPhone 20–40 cm from the speaker.
3. Play the click WAV through the MacBook speakers, so the click is captured
   in the same recording as the guitar.
4. Start recording. Stay silent for about 2 s, then play the click. Don't play
   during the count-in bar. Then play the exercise.

[docs/m0-protocol.md](docs/m0-protocol.md) has the full details.

## Recording through a USB processor (e.g. the Soran Dual Stomp)

A multi-effects pedal that shows up on the Mac as a USB audio interface can feed
the analyser directly, and the analyser can describe the processed tone.

1. Connect the pedal over USB-C. In the studio's **Input** box choose
   **Processor (USB)**, then pick the pedal as the input device. The choice is
   saved and also used by the tuner and note finder.
2. Monitor through the pedal's headphone/amp output or the Mac's headphones.
   The click does not need to be on the recording: in this mode the browser
   records when the click started on its own audio clock and sends that offset
   with the take, so the server builds the beat grid from it.
3. Any patch works. Overdrive and compression are analysed instead of
   rejected, but buzz findings are dropped and dynamics findings carry a note,
   because drive hides both. A dry patch (no delay, reverb, octave or
   harmoniser) gives the most reliable note and timing feedback. Delay and
   reverb tails can read as extra or ringing notes.
4. If on-beat notes are consistently reported late or early, set **Latency
   correction** (±250 ms). Browser latency reports vary by device.

Uploaded files in Processor mode have no click offset. Record them in the
studio, or use Mic + amp mode with an audible click.

Every analysis also includes an experimental **tone check**. It reports level
and headroom, drive (clean, light or heavy), compression, brightness, the
noise floor or gate, and mains hum, each with the measured values. It is not
calibrated against real pedals, and it does not detect echo or delay.

## Import a riff from Guitar Pro

In **More options → Custom riff**, choose a `.gp3`, `.gp4` or `.gp5` file
(export GP6/GP7 files as `.gp5` first). Then pick a track, a bar range and a
tempo percentage, and click **Use as custom riff**. The conversion is lossy
and lists everything it changed:

- chords keep their highest note;
- tied and dead notes become rests;
- grace notes, effects and repeats are ignored;
- 64th notes become 32nds, and tuplets other than triplets become plain notes.

Tab tokens are kept when the track uses standard, drop D or half-step-down
tuning. Other tunings fall back to note names. Files are capped at 5 MB and
are not stored. The converted riff must fit the 180-second take limit.

## Usage

```bash
# See how an exercise is parsed (indices are used for labelling)
coreguitar exercise --exercise exercises/chromatic_1234.json

# Make the click track for it (optionally at a different tempo)
coreguitar click --exercise exercises/chromatic_1234.json --bpm 70 --out data/clicks/chromatic_70.wav

# Analyse a take against the reference
coreguitar analyze data/takes/take1.m4a --exercise exercises/chromatic_1234.json --bpm 70 --json data/results/take1.json

# Inline notes instead of a file: string/fret or note names, with optional durations
coreguitar analyze take.wav --notes "5/0:4 5/3:8 5/5:8 4/2:4. r:8" --bpm 80 --tuning drop_d

# Free playing: describes what was played; doesn't call anything a mistake
coreguitar analyze take.wav --free --bpm 90

# M0: score the analyser against your labelled takes
coreguitar evaluate data/m0
```

Supported tunings are `standard`, `drop_d` and `half_step_down`.

Shipped exercises are in `exercises/`: chromatic, spider, G major, A minor
pentatonic box 1, and a riff template.

## What the analysis does

| Layer | Method | Status |
|---|---|---|
| Click / beat grid | Matched filter on the 4 kHz click inside the recording; grid fit | Reliable on synthetic audio; needs M0 check per device |
| Note onsets | Spectral flux with a noise-adaptive floor, refined on the attack envelope | Same |
| Pitch | pYIN + note segmentation | Same |
| Alignment | Dynamic programming of detected notes vs reference | Same |
| Timing, wrong, missed and extra notes, drift, tuning offset | Measured from the above, with confidence gated by measurement uncertainty | Same |
| Input-quality gates | SNR, clipping, polyphony cue, click presence | Polyphony and noise OK on synthetic audio; **distortion gate uncalibrated** |
| Dynamics (weak or uneven attacks) | Attack level, detrended by pitch, with same-pitch confirmation | Low confidence by design (the room and amp colour the loudness) |
| Ringing, buzz | Spectral heuristics | **Experimental**: capped confidence, never top-3 |
| Tone check (level, drive, compression, brightness, gate/hum) | Crest factor, harmonic balance, attack spread, decay, centroid, noise floor, hum peak | **Experimental, uncalibrated**; describes the signal, never judges it |

### What you get from an analysis

- **Up to 3 prioritised corrections.** Each one has the observation, possible
  causes (labelled as hypotheses), a short drill, and the time range of the
  evidence.
- **The full findings list**, with confidence levels.
- **An uncertainty section.**
- **A re-record request** when the input is unusable.

## Tests

```bash
npm test
npm run typecheck
npm run lint
npm --prefix web exec -- playwright install chromium  # once, if not installed
npm run e2e
```

Browser tests run against an isolated loopback server on port 8767, use a
synthetic fake microphone, and do not write into your app take collection.
`npm --prefix web run e2e` temporarily builds with local Istanbul instrumentation,
enforces 80% aggregate source coverage for statements, branches, functions and
lines, then restores an uninstrumented production build. Generated coverage,
fixtures, traces and recordings are git-ignored. If a browser test fails, run
`npm --prefix web run build` to restore the uninstrumented build before regular use.
`npm --prefix web run coverage` reports focused unit-test coverage separately;
it does not include browser integration coverage.
Codec tests cover WAV, WebM/Opus, Ogg/Opus and M4A/AAC through ingest and analysis,
including confident findings, evidence timestamps within 10 ms, and quality gates.
CLI golden snapshots pin text and JSON (excluding `analyzed_at`) for three takes.
The 60/120 second synthetic analysis spike took 2.58/3.68 seconds on this Mac;
this is a local timing sample, not a cross-hardware performance guarantee.

### Short manual guitar checks

1. Clean chromatic: record, listen back, submit, and inspect the note table.
2. Delay note index 5; click its timing finding and verify the audible evidence.
3. Play a wrong note at index 9 of G major; inspect expected versus heard pitch.
4. Use headphones for the click: expect `no_click` and re-record advice.
5. Upload a Voice Memos `.m4a` of the same take; compare verdict/findings and
   check the lossy warning (AAC is lossy; ALAC is not).
6. Unplug the mic mid-take: expect an interrupted partial recording with a warning.
7. Cancel recording: no upload. Cancel analysis: the take remains. Delete it:
   normalized audio and result files are removed.

The acceptance tests T1–T14 run on synthetic takes with known injected errors:

- correct, late/early, wrong, missed and extra notes, drift;
- tuning and transposition;
- noisy, clipped, silent, chord and distorted input;
- missing click;
- free mode;
- the evaluation tool.

The distortion test is marked `xfail`: synthetic distortion is not a valid
proxy for the GA15II overdrive, so it needs real takes.

## Known limits (honest list)

- **Thresholds are placeholders** until M0 calibration. These include the
  timing uncertainty (10 ms), the quality gates and the dynamics thresholds.
- **Distortion detection is not calibrated.** Overdrive takes may not be
  rejected yet.
- **Short inserted notes can be heard an octave off.** The finding is still
  produced, at low confidence.
- **Spurious extra notes.** A late re-attack in a long final tail can show up
  as a low-confidence extra note.
- **Ringing and buzz detectors are unvalidated.** On synthetic audio the
  ringing detector barely separates injected ringing from clean playing.
- **Processor mode is unverified on the real pedal.** The tone-check
  thresholds come from synthetic audio. The pedal's USB channel layout is not
  known, so input is mixed to mono. Browser latency reports may need the manual
  correction.
- **Language-model features are not built yet.** The engine never uses a
  language model for measurement. Follow-up questions (M3) will be answered
  from the findings JSON.

## Roadmap

| Milestone | Content |
|---|---|
| **M0** (kit ready) | Record 30–50 labelled takes, run `coreguitar evaluate`, set the thresholds |
| **M1** (this) | Analysis engine + CLI + synthetic acceptance tests |
| **Stage 1A** | Local FastAPI + React/TS: PCM record or upload, replay, timestamped evidence, quality gates, cancellation, file-backed retention and delete |
| M2 (later) | SQLite practice history and richer session browsing; explicitly deferred from Stage 1A |
| M3 | Local Ollama Q&A grounded in the findings JSON (cites finding IDs, refuses to guess beyond the measurements) |
| M4 | Retry comparison of the same passage across attempts |
