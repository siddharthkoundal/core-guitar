# M0 — Recording feasibility and calibration protocol

**Goal:** find out, with your own guitar, amp, room and devices, whether the
analyser's measurements can be trusted. Then replace the placeholder
thresholds in `src/coreguitar/config.py` with numbers you have measured.

Everything below runs locally. No audio leaves your machine.

Until you finish this protocol, every number the analyser prints has only been
checked on **synthetic** audio. That shows the logic is consistent. It is not
an accuracy claim for real recordings.

---

## 1. Equipment setup (no audio interface needed)

| Item | Setting |
|---|---|
| Guitar | Pacifica 012, bridge or middle pickup. Tune with a tuner before every session. |
| GA15II | **Clean channel only** (overdrive off). Gain low, volume moderate, EQ flat-ish (treble/bass at 12 o'clock). |
| Mic position | Device 20–40 cm in front of the amp speaker, roughly on-axis, on a stable surface (not in your hand or lap). |
| Room | Quiet. No TV, fan or AC if possible. Same spot every session. |

### Click (metronome)

The analyser finds the beat grid by detecting the click **inside the
recording**. So the click must come out of a speaker, and the same mic must
pick it up.

```bash
coreguitar click --exercise exercises/chromatic_1234.json --out data/clicks/chromatic_80.wav
```

The WAV has 2 s of silence, one bar of count-in clicks, then clicks for the
whole exercise.

- Play it through the **MacBook speakers**, at moderate volume.
- It should be clearly audible but quieter than the guitar.

### Recording device

| Device | How |
|---|---|
| **MacBook** (recording and click on the same laptop) | QuickTime → New Audio Recording, or Audacity (44.1/48 kHz, mono or stereo WAV). Turn off any voice isolation or noise reduction (Control Centre → Mic Mode → **Standard**). |
| **iPhone 15 Pro** (click from the MacBook) | Voice Memos → Settings → Audio Quality **Lossless**. Turn **Enhance Recording off**, before *and* after recording. Export the `.m4a` with AirDrop. ffmpeg (`brew install ffmpeg`) decodes it. |

### Take procedure (both devices)

1. Start recording.
2. Stay silent for about 2 s. The analyser measures the noise floor here.
3. Start the click WAV.
4. During the count-in bar, don't play. Mute the strings with your fretting hand.
5. Play the exercise on the first beat after the count-in.
6. Let the last note ring, then wait about 1 s and stop.

Keep takes short: 10–40 s, one exercise per file.

---

## 2. What to record (target 30–50 takes)

Split takes roughly evenly between MacBook and iPhone. Before each one, write
down what you *intended*, because that becomes the label.

| # | Take type | Count | How to perform it | Label `errors` |
|---|---|---|---|---|
| A | **Correct** takes | 10–12 | Play as cleanly as you can (chromatic, G major, pentatonic, spider; 60–100 BPM). | `[]` |
| B | **Late/early notes** | 4 | Deliberately delay or anticipate 1–2 chosen notes by an obvious amount (roughly a 16th note). | `{"type":"late","index":N}` |
| C | **Wrong note** | 3 | Play one chosen note one fret off. | `{"type":"wrong_note","index":N}` |
| D | **Missed note** | 3 | Skip one chosen note, or fret it without picking. | `{"type":"missed_note","index":N}` |
| E | **Extra note** | 2 | Add one note between two chosen notes. | `{"type":"extra_note","after":N}` |
| F | **Rushing/dragging** | 2 | Gradually speed up (or slow down) across the take. | `{"type":"rushing"}` |
| G | **Detuned guitar** | 2 | Tune the guitar about 20–30 cents flat (one take) or a semitone down. | `{"type":"tuning_offset"}` |
| H | **Buzz** | 2 | Fret one chosen note too lightly or far from the fret, so it buzzes. | `{"type":"buzz","index":N}` |
| I | **Ringing** | 2 | Let one previous note or an open string keep sounding. | `{"type":"ringing","index":N}` |
| J | **Noisy** | 2 | Fan/TV on, or phone 2 m away. | `[]`, `expected_verdict` `"degraded"` or `"rejected"` |
| K | **Unsupported: chords** | 2 | Strum chords over the click. | `[]`, `expected_verdict: "unsupported"` |
| L | **Unsupported: overdrive** | 2 | Same exercise on the GA15II overdrive channel. | `[]`, `expected_verdict: "unsupported"` |

`index` is the **0-based** position in the exercise's note list. To see the
indices, run:

```bash
coreguitar exercise --exercise exercises/chromatic_1234.json
```

Overdrive takes (L) matter most for calibration. The distortion detector is
known to be uncalibrated (its test is marked `xfail`), and only real GA15II
overdrive recordings can calibrate it.

---

## 3. Labelling

Put takes and labels under `data/m0/`. Git ignores `data/`.

```
data/m0/
  2026-05-01_mac_chromatic_80_correct1.wav
  2026-05-01_mac_chromatic_80_correct1.label.json
  2026-05-01_mac_chromatic_80_correct1.onsets.txt   (optional, but valuable)
```

Copy `docs/label-template.json` and edit it. Paths are relative to the label
file.

### Optional: onset labels in Audacity (for the timing-uncertainty number)

Hand-marking onsets is the only way to measure how accurate the timing
measurement is on your setup. Do it for **5–6 correct takes**.

1. Open the take and zoom in on the waveform.
2. For each note, click on the start of the pick attack (the first visible
   rise), then press **Cmd+B** to add a label. The label text doesn't matter.
3. File → Export → Export Labels… → save as `<take>.onsets.txt`.
4. Add `"onsets_file": "<take>.onsets.txt"` to the label JSON.

---

## 4. Evaluate

```bash
coreguitar evaluate data/m0
```

The report shows:

- **Recall per error type:** how many deliberate errors were found.
- **False positives:** all of them, and those with confidence ≥ 0.5. Confident false positives are the ones that matter.
- **Verdict confusion:** whether noisy, chord and overdrive takes are gated correctly.
- **Per device:** SNR, click detection, and click-grid residual. This tells you whether to use the MacBook or the iPhone.
- **Onset calibration:** the p90 onset error against your hand labels. This becomes the measured `timing_uncertainty_ms`.

With fewer than 10 examples per type, the report says the numbers are
anecdotal. They are not accuracy estimates.

## 5. Decide (exit criteria for M0)

| Question | Proceed if… | Otherwise |
|---|---|---|
| Is the click detected on both devices? | It is found in ≥ 90% of takes, with residual < 3 ms. | Make the click louder, or move the device closer to the MacBook speaker. |
| Is timing usable against the 20 ms tolerance? | The measured onset uncertainty (p90) is ≤ 10 ms. | Raise the tolerance, or show timing only as a coarse "early/late" signal. |
| Are note errors found? | Wrong, missed and extra notes are mostly found, with no confident false positives on correct takes. | Inspect the failing takes in the notebook before changing any thresholds. |
| Are bad takes gated? | Noisy, chord and overdrive takes are not reported as `ok`. | Calibrate the quality gates on these takes. |
| Are the experimental detectors useful? | Buzz and ringing are flagged on the labelled notes, with few false positives. | Keep them hidden, or remove them. |

Then update `Thresholds` in `src/coreguitar/config.py`, at minimum
`timing_uncertainty_ms`, and re-run `coreguitar evaluate` to confirm the change
helps.

`notebooks/m0_explore.ipynb` plots a take's waveform, detected clicks, onsets
and pitch, so you can see *why* a take failed.
