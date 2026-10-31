# core-guitar

A personal practice-feedback tool for guitar. You play, record, analyse, get
specific feedback, and retry.

**Current scope (M0 + M1).** A local Python analysis engine with a command-line
interface, for short, **clean-tone, single-note** exercises analysed **after**
recording.

Chords, distortion, backing tracks, video and live feedback are out of scope.
The analyser detects them and declines them rather than guessing.

> **Accuracy status.** Every result below comes from *synthetic* audio. That
> checks that the logic is consistent. It is **not** evidence of accuracy on
> real recordings. Real-world reliability is unknown until you run the M0
> protocol ([docs/m0-protocol.md](docs/m0-protocol.md)) on your own takes.

## Privacy

- All processing is local. No audio, findings or telemetry leave the machine.
- Recordings go in `data/`, which git ignores.
- To delete a take, delete its files. See [data/README.md](data/README.md).
- The later language-model features (M3) are planned to run on local
  **Ollama** only.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"          # add ,notebook for the M0 explorer
brew install ffmpeg                        # needed for iPhone .m4a files
```

## Recording (no audio interface)

1. Set the GA15II to the clean channel.
2. Place the MacBook or iPhone 20–40 cm from the speaker.
3. Play the click WAV through the MacBook speakers, so the click is captured
   in the same recording as the guitar.
4. Start recording. Stay silent for about 2 s, then play the click. Don't play
   during the count-in bar. Then play the exercise.

[docs/m0-protocol.md](docs/m0-protocol.md) has the full details.

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

### What you get from an analysis

- **Up to 3 prioritised corrections.** Each one has the observation, possible
  causes (labelled as hypotheses), a short drill, and the time range of the
  evidence.
- **The full findings list**, with confidence levels.
- **An uncertainty section.**
- **A re-record request** when the input is unusable.

## Tests

```bash
.venv/bin/pytest -q
```

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
- **Language-model features are not built yet.** The engine never uses a
  language model for measurement. Follow-up questions (M3) will be answered
  from the findings JSON.

## Roadmap

| Milestone | Content |
|---|---|
| **M0** (kit ready) | Record 30–50 labelled takes, run `coreguitar evaluate`, set the thresholds |
| **M1** (this) | Analysis engine + CLI + synthetic acceptance tests |
| M2 | React/TS UI + local FastAPI backend: record or upload, replay, timestamped evidence playback, SQLite history, delete |
| M3 | Local Ollama Q&A grounded in the findings JSON (cites finding IDs, refuses to guess beyond the measurements) |
| M4 | Retry comparison of the same passage across attempts |
