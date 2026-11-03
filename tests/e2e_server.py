"""Isolated local server and deterministic fixtures for the browser tests."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn

from coreguitar.analyze import analyze
from coreguitar.cli import _json_default
from coreguitar.reference import load_exercise
from coreguitar.server.app import create_app
from coreguitar.synth import TakeSpec, render_take


def main():
    root = Path(__file__).resolve().parents[1]
    fixtures = root / "web" / "e2e" / ".generated"
    fixtures.mkdir(parents=True, exist_ok=True)
    exercise = load_exercise(root / "exercises" / "chromatic_1234.json")
    for name, spec in (
        ("findings", TakeSpec(deviations_ms={5: 80}, wrong={9: 48})),
        ("clipped", TakeSpec(gain=6)),
    ):
        audio, _ = render_take(exercise, spec)
        path = fixtures / f"{name}.wav"
        sf.write(path, audio, 44100, subtype="PCM_16")
        if name == "findings":
            (fixtures / "expected.json").write_text(
                json.dumps(analyze(path, exercise), default=_json_default)
            )
    sf.write(fixtures / "silent.wav", np.zeros(44100 * 3), 44100, subtype="PCM_16")
    _write_guitarpro(fixtures / "riff.gp5")
    with tempfile.TemporaryDirectory(prefix="coreguitar-e2e-") as directory:
        uvicorn.run(create_app(data_root=Path(directory)), host="127.0.0.1", port=8767)


def _write_guitarpro(path: Path) -> None:
    """Two bars of quarter notes plus a chord, for the Guitar Pro import test."""
    try:
        import guitarpro
        from guitarpro import models as m
    except ImportError:
        return
    song = m.Song()
    song.title, song.tempo = "E2E riff", 90
    song.newMeasure()
    for measure, frets in zip(song.tracks[0].measures, ((0, 2, 3, 5), (5, 3, 2, 0))):
        voice = measure.voices[0]
        for i, fret in enumerate(frets):
            beat = m.Beat(voice, duration=m.Duration(value=4), status=m.BeatStatus.normal)
            beat.notes.append(m.Note(beat, value=fret, string=5, type=m.NoteType.normal))
            if i == 0 and fret == 5:
                beat.notes.append(m.Note(beat, value=5, string=4, type=m.NoteType.normal))
            voice.beats.append(beat)
    with path.open("wb") as stream:
        guitarpro.write(song, stream, version=(5, 1, 0))


if __name__ == "__main__":
    main()
