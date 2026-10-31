"""Reference exercise parsing.

Notes string tokens (whitespace separated, `|` bar lines ignored):
  E4        note name (sounding pitch)
  6/3       tab: string/fret, converted with the exercise tuning
  r         rest
  any token may take a duration suffix  :4  :8  :16  :2  :1  :4.  :8t
Without a suffix the exercise `default_duration` applies (note value relative
to the beat unit given by the time signature denominator).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .music import midi_to_name, note_to_midi, resolve_tuning, tab_to_midi

_DUR_RE = re.compile(r"^(1|2|4|8|16|32)(\.|t)?$")
_TAB_RE = re.compile(r"^([1-6])/(\d{1,2})$")


@dataclass
class RefNote:
    index: int
    midi: int
    name: str
    token: str
    start_beat: float
    dur_beats: float
    bar: int
    beat_in_bar: float


@dataclass
class Exercise:
    name: str
    tuning: str
    bpm: float
    beats_per_bar: int
    beat_unit: int
    default_duration: str
    notes_text: str
    notes: list[RefNote] = field(default_factory=list)
    total_beats: float = 0.0
    description: str = ""

    @property
    def beat_s(self) -> float:
        return 60.0 / self.bpm

    def to_dict(self) -> dict:
        d = asdict(self)
        d["notes"] = [asdict(n) for n in self.notes]
        return d


def duration_beats(dur: str, beat_unit: int) -> float:
    m = _DUR_RE.match(dur.strip())
    if not m:
        raise ValueError(f"Invalid duration '{dur}' (use 1,2,4,8,16,32 with optional '.' or 't')")
    value, mod = m.groups()
    beats = beat_unit / int(value)
    if mod == ".":
        beats *= 1.5
    elif mod == "t":
        beats *= 2.0 / 3.0
    return beats


def parse_notes(text: str, tuning: str, default_duration: str, beat_unit: int, beats_per_bar: int):
    notes: list[RefNote] = []
    cursor = 0.0
    for raw in text.replace("|", " ").split():
        token, _, dur = raw.partition(":")
        beats = duration_beats(dur or default_duration, beat_unit)
        if token.lower() != "r":
            tab = _TAB_RE.match(token)
            midi = tab_to_midi(int(tab.group(1)), int(tab.group(2)), tuning) if tab else note_to_midi(token)
            notes.append(
                RefNote(
                    index=len(notes),
                    midi=midi,
                    name=midi_to_name(midi),
                    token=raw,
                    start_beat=cursor,
                    dur_beats=beats,
                    bar=int(cursor // beats_per_bar) + 1,
                    beat_in_bar=round(cursor % beats_per_bar + 1, 3),
                )
            )
        cursor += beats
    if not notes:
        raise ValueError("Exercise contains no notes")
    return notes, cursor


def build_exercise(
    notes: str,
    *,
    name: str = "Custom exercise",
    tuning: str = "standard",
    bpm: float = 80,
    time_signature: tuple[int, int] = (4, 4),
    default_duration: str = "8",
    description: str = "",
) -> Exercise:
    tuning = resolve_tuning(tuning)
    if not 30 <= bpm <= 240:
        raise ValueError(f"BPM must be 30-240, got {bpm}")
    beats_per_bar, beat_unit = time_signature
    parsed, total = parse_notes(notes, tuning, default_duration, beat_unit, beats_per_bar)
    return Exercise(
        name=name,
        tuning=tuning,
        bpm=float(bpm),
        beats_per_bar=beats_per_bar,
        beat_unit=beat_unit,
        default_duration=default_duration,
        notes_text=notes,
        notes=parsed,
        total_beats=total,
        description=description,
    )


def load_exercise(path: str | Path, *, bpm: float | None = None, tuning: str | None = None) -> Exercise:
    data = json.loads(Path(path).read_text())
    return build_exercise(
        data["notes"],
        name=data.get("name", Path(path).stem),
        tuning=tuning or data.get("tuning", "standard"),
        bpm=bpm or data.get("bpm", 80),
        time_signature=tuple(data.get("time_signature", (4, 4))),
        default_duration=str(data.get("default_duration", "8")),
        description=data.get("description", ""),
    )
