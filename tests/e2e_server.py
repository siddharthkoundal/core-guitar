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
    with tempfile.TemporaryDirectory(prefix="coreguitar-e2e-") as directory:
        uvicorn.run(create_app(data_root=Path(directory)), host="127.0.0.1", port=8767)


if __name__ == "__main__":
    main()
