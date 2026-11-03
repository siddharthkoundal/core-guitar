"""Guitar Pro (GP3/GP4/GP5) import: one track and a measure range -> custom exercise notation.

The analyser only handles single-note lines, so the conversion is deliberately lossy and says so:
chords keep their highest note, ties and dead notes become rests, grace notes and effects
(bends, slides, vibrato...) are dropped, and repeats are not expanded. GP6/GP7 (.gpx/.gp) files
are not supported by pyguitarpro.
"""

from __future__ import annotations

import io

from .music import TUNINGS, midi_to_name

MAX_GP_BYTES = 5 * 1024 * 1024
DEFAULT_MEASURES = 8
GP_SUFFIXES = (".gp3", ".gp4", ".gp5")
_DURATIONS = {1: "1", 2: "2", 4: "4", 8: "8", 16: "16", 32: "32"}


class GuitarProError(ValueError):
    pass


def _parse(data: bytes):
    try:
        import guitarpro
    except ImportError as exc:  # pragma: no cover - the app extra installs it
        raise GuitarProError("Guitar Pro import needs the 'pyguitarpro' package (pip install -e '.[app]').") from exc
    try:
        return guitarpro.parse(io.BytesIO(data))
    except Exception as exc:  # pyguitarpro raises many unrelated types on malformed or GP6+ files
        raise GuitarProError("Could not read this file as Guitar Pro 3, 4 or 5. "
                             "Export from Guitar Pro or TuxGuitar as .gp5 and try again.") from exc


def _tuning(track) -> tuple[int, ...]:
    """MIDI values low string first, matching `music.TUNINGS`."""
    return tuple(s.value for s in sorted(track.strings, key=lambda s: -s.number))


def _tuning_name(track) -> str | None:
    tuning = _tuning(track)
    return next((name for name, values in TUNINGS.items() if values == tuning), None)


def _has_notes(track) -> bool:
    return any(note for measure in track.measures for voice in measure.voices
               for beat in voice.beats for note in beat.notes)


def track_list(song) -> list[dict]:
    return [{
        "index": i,
        "name": (track.name or f"Track {i + 1}").strip()[:80],
        "strings": len(track.strings),
        "tuning": _tuning_name(track),
        "percussion": bool(track.isPercussionTrack),
        "has_notes": _has_notes(track),
    } for i, track in enumerate(song.tracks)]


def _default_track(song) -> int:
    for i, track in enumerate(song.tracks):
        if not track.isPercussionTrack and _has_notes(track):
            return i
    raise GuitarProError("The file has no pitched track with notes.")


def _duration(duration, warn) -> str:
    value = duration.value
    if value == 64:
        warn("64th notes were lengthened to 32nds, so later notes may drift against the bar.")
        value = 32
    text = _DURATIONS.get(value)
    if text is None:
        raise GuitarProError(f"Unsupported note length 1/{value}.")
    tuplet = (duration.tuplet.enters, duration.tuplet.times)
    if tuplet == (3, 2):
        return text + "t"
    if tuplet != (1, 1):
        warn(f"{tuplet[0]}:{tuplet[1]} tuplets were approximated as plain notes.")
    if duration.isDotted:
        return text + "."
    if getattr(duration, "isDoubleDotted", False):
        warn("Double-dotted notes were approximated as single-dotted.")
        return text + "."
    return text


def convert(data: bytes, *, track: int | None = None, start: int = 1, end: int | None = None,
            tempo_percent: int = 100) -> dict:
    """Return the song's tracks plus the chosen track/measures as `CustomExercise` fields."""
    if len(data) > MAX_GP_BYTES:
        raise GuitarProError("Guitar Pro files are limited to 5 MB.")
    song = _parse(data)
    if not song.tracks:
        raise GuitarProError("The file has no tracks.")
    index = _default_track(song) if track is None else track
    if not 0 <= index < len(song.tracks):
        raise GuitarProError(f"Track {index + 1} does not exist; the file has {len(song.tracks)}.")
    chosen = song.tracks[index]
    if chosen.isPercussionTrack:
        raise GuitarProError("Drum tracks can't be practised as guitar exercises.")
    count = len(chosen.measures)
    if count == 0:
        raise GuitarProError("The chosen track has no measures.")
    end = min(count, start + DEFAULT_MEASURES - 1) if end is None else end
    if not 1 <= start <= end <= count:
        raise GuitarProError(f"Choose measures between 1 and {count}.")

    warnings: list[str] = []

    def warn(text: str) -> None:
        if text not in warnings:
            warnings.append(text)

    tuning = _tuning_name(chosen)
    if tuning is None:
        warn("This track's tuning isn't one the analyser knows, so notes are written as pitches "
             "and the exercise uses standard tuning names. Tune your guitar to the track's tuning.")

    tokens: list[str] = []
    measures = chosen.measures[start - 1:end]
    first_sig = measures[0].timeSignature
    for number, measure in enumerate(measures, start):
        if (measure.timeSignature.numerator, measure.timeSignature.denominator.value) != (
                first_sig.numerator, first_sig.denominator.value):
            warn("The time signature changes inside the selection; the count-in uses the first one.")
        header = measure.header
        if header.isRepeatOpen or header.repeatClose > 0 or header.repeatAlternative:
            warn("Repeats and alternate endings are played as written once, not expanded.")
        voices = [v for v in measure.voices if any(b.notes for b in v.beats)]
        if len(voices) > 1:
            warn("Only the first voice of multi-voice measures was kept.")
        bar: list[str] = []
        if not any(v.beats for v in measure.voices):
            sig = measure.timeSignature
            bar = [f"r:{sig.denominator.value}"] * sig.numerator
        source = voices[0] if voices else measure.voices[0]
        for beat in ([] if bar else source.beats):
            dur = _duration(beat.duration, warn)
            played = [n for n in beat.notes if n.type.name == "normal" and not n.effect.isGrace]
            if any(n.effect.isGrace for n in beat.notes):
                warn("Grace notes were skipped.")
            if any(n.type.name == "tie" for n in beat.notes) and not played:
                warn("Tied notes became rests (the note keeps ringing; no new pick attack is expected).")
            if any(n.type.name == "dead" for n in beat.notes):
                warn("Dead (muted) notes became rests.")
            if any(_has_effect(n) for n in played):
                warn("Bends, slides, vibrato and other effects are ignored.")
            if not played:
                bar.append(f"r:{dur}")
                continue
            if len(played) > 1:
                warn("Chords were reduced to their highest note; the analyser only checks single notes.")
            strings = {s.number: s.value for s in chosen.strings}
            note = max(played, key=lambda n: strings.get(n.string, 0) + n.value)
            if tuning is not None and len(chosen.strings) == 6:
                bar.append(f"{note.string}/{note.value}:{dur}")
            else:
                bar.append(f"{midi_to_name(strings[note.string] + note.value)}:{dur}")
        tokens.append(" ".join(bar))
    notes = " | ".join(t for t in tokens if t)
    if not any(not tok.startswith("r:") for tok in notes.replace("|", " ").split()):
        raise GuitarProError("The selected measures only contain rests.")

    source_bpm = float(song.tempo or 120)
    bpm = round(source_bpm * tempo_percent / 100)
    if not 30 <= bpm <= 240:
        warn(f"Tempo {bpm} BPM is outside 30-240 and was clamped.")
        bpm = min(240, max(30, bpm))
    denominator = first_sig.denominator.value
    if denominator not in (1, 2, 4, 8, 16) or not 1 <= first_sig.numerator <= 16:
        warn("Unusual time signature replaced with 4/4.")
        time_signature = [4, 4]
    else:
        time_signature = [first_sig.numerator, denominator]
    return {
        "title": (song.title or "").strip()[:120],
        "artist": (song.artist or "").strip()[:120],
        "source_bpm": source_bpm,
        "tracks": track_list(song),
        "track": index,
        "measure_count": count,
        "start": start,
        "end": end,
        "exercise": {
            "notes": notes,
            "bpm": bpm,
            "tuning": tuning or "standard",
            "time_signature": time_signature,
            "default_duration": "8",
        },
        "warnings": warnings,
    }


def _has_effect(note) -> bool:
    e = note.effect
    return bool(e.bend or e.slides or e.vibrato or e.hammer or e.harmonic or e.trill or e.tremoloPicking)

