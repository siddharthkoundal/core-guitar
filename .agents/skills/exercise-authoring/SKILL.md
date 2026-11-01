---
name: exercise-authoring
description: 'Create or edit coreguitar practice exercises (exercises/*.json): tab or note-name notation, durations, rests, bar lines, tunings, BPM and time signature. Use when adding a scale, riff, lick, or technique drill, when an exercise fails to parse, or when changing reference notation parsing in reference.py.'
---

# Exercise authoring

Shipped exercises are JSON files in [exercises/](../../../exercises); the file stem becomes the API `exercise_id`
(must match `^[a-z0-9_]+$`). Parsing lives in [reference.py](../../../src/coreguitar/reference.py).

## Format

```json
{
  "name": "Chromatic 1-2-3-4 (strings 6 to 1, frets 1-4)",
  "description": "One finger per fret, alternate picking. Ascending only.",
  "tuning": "standard",
  "bpm": 80,
  "time_signature": [4, 4],
  "default_duration": "8",
  "notes": "6/1 6/2 6/3 6/4 5/1 5/2 5/3 5/4 | 4/1 ..."
}
```

Tokens in `notes` (whitespace separated; `|` bar lines are ignored, use them for readability):

| Token | Meaning |
|---|---|
| `6/3` | tab: string 6 (low) … 1 (high), fret 0–24, converted with the exercise tuning |
| `E4`, `F#3`, `Bb2` | sounding pitch by note name |
| `r` | rest |
| `:4` `:8` `:16` `:2` `:1` `:32` + optional `.` (dotted) or `t` (triplet) | duration suffix; otherwise `default_duration` |

Tunings: `standard`, `drop_d`, `half_step_down` (aliases resolved by `music.resolve_tuning`). BPM 30–240.

## Scope limits

Single-note, clean-tone lines only. No chords, double-stops, bends, slides or palm-mute notation — the analyser declines polyphony.
The click + recording (`2 s + (beats + 2 bars) * beat + 2.5 s`) must fit within **180 s**, or the API rejects it.

## Procedure

1. Create `exercises/<snake_case_id>.json`.
2. Check parsing: `.venv/bin/coreguitar exercise --exercise exercises/<id>.json` (shows indices, bars, beats, pitches).
3. Add it to the clean-take loop in `test_t1_correct_take_other_exercises` (`tests/test_acceptance.py`) so a clean
   synthetic take must produce **no confident findings**.
4. Update the shipped-exercise count assertion in `tests/test_server.py` (`assert len(exercises) == 5`).
5. List it in the README "Shipped exercises" sentence.
6. Run `npm run test:backend`.

Ad-hoc exercises in tests/CLI: `build_exercise("5/0:4 5/3:8 r:8", bpm=80, tuning="drop_d")` or `coreguitar analyze --notes "..."`.
Custom exercises from the UI go through `CustomExercise` in `server/schemas.py` (same notation, max 10 000 chars).
