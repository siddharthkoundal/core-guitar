"""Shared helpers: render synthetic takes with known ground truth and analyse them.

Passing these tests shows the analysis logic is consistent on synthetic audio.
It says nothing about accuracy on real recordings (that is what M0 evaluation is for).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import soundfile as sf

from coreguitar.analyze import analyze
from coreguitar.reference import load_exercise
from coreguitar.synth import TakeSpec, render_take

ROOT = Path(__file__).resolve().parents[1]
EXERCISES = ROOT / "exercises"


@pytest.fixture
def run_take(tmp_path):
    counter = {"n": 0}

    def _run(ex, spec: TakeSpec | None = None, *, free: bool = False, audio=None, sr: int = 44100):
        if audio is None:
            audio, _ = render_take(ex, spec, sr)
        counter["n"] += 1
        path = tmp_path / f"take{counter['n']}.wav"
        sf.write(path, audio, sr)
        if free:
            return analyze(path, None, free_bpm=ex.bpm if ex else None)
        return analyze(path, ex)

    return _run


@pytest.fixture
def chromatic():
    return load_exercise(EXERCISES / "chromatic_1234.json")


def types(res: dict, min_conf: float = 0.0, include_experimental: bool = False) -> list[str]:
    return [f["type"] for f in res["findings"]
            if f["confidence"] >= min_conf and (include_experimental or not f["experimental"])]
