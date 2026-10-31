"""Note names, MIDI numbers and guitar tunings."""

from __future__ import annotations

import math
import re

_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_NOTE_RE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d)$")

# Strings listed 6 (lowest) -> 1 (highest), as sounding MIDI notes.
TUNINGS: dict[str, tuple[int, ...]] = {
    "standard": (40, 45, 50, 55, 59, 64),
    "drop_d": (38, 45, 50, 55, 59, 64),
    "half_step_down": (39, 44, 49, 54, 58, 63),
}
TUNING_ALIASES = {
    "e_standard": "standard",
    "dropd": "drop_d",
    "drop-d": "drop_d",
    "eb": "half_step_down",
    "eb_standard": "half_step_down",
    "half-step-down": "half_step_down",
}


def resolve_tuning(name: str) -> str:
    key = name.strip().lower().replace(" ", "_")
    key = TUNING_ALIASES.get(key, key)
    if key not in TUNINGS:
        raise ValueError(f"Unsupported tuning '{name}'. Supported: {', '.join(TUNINGS)}")
    return key


def note_to_midi(name: str) -> int:
    m = _NOTE_RE.match(name.strip())
    if not m:
        raise ValueError(f"Invalid note name '{name}' (expected e.g. E2, F#3, Bb4)")
    letter, acc, octave = m.groups()
    pc = _PC[letter.upper()] + (1 if acc == "#" else -1 if acc == "b" else 0)
    return 12 * (int(octave) + 1) + pc


def midi_to_name(midi: int) -> str:
    midi = int(round(midi))
    return f"{_NAMES[midi % 12]}{midi // 12 - 1}"


def tab_to_midi(string: int, fret: int, tuning: str) -> int:
    strings = TUNINGS[resolve_tuning(tuning)]
    if not 1 <= string <= 6:
        raise ValueError(f"String must be 1-6, got {string}")
    if not 0 <= fret <= 24:
        raise ValueError(f"Fret must be 0-24, got {fret}")
    return strings[6 - string] + fret


def hz_to_midi_float(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def midi_to_hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)
