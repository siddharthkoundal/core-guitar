"""Regenerate tests/golden/*.{txt,json} exactly the way tests/test_cli_golden.py compares them.

Usage (from the repository root):
    .venv/bin/python .agents/skills/synthetic-audio-testing/scripts/regen_golden.py [--check]

--check  compare only; exit 1 if any golden file would change (no writes).
Only regenerate after an intentional output change, and review `git diff tests/golden` before committing.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests"))

from coreguitar.cli import main  # noqa: E402
from coreguitar.reference import load_exercise  # noqa: E402
from coreguitar.synth import render_take  # noqa: E402
from test_cli_golden import GOLDEN_DIR, _cases  # noqa: E402


def render(case_name, spec, exercise_path: Path, tmp: Path) -> tuple[str, str]:
    audio, _ = render_take(load_exercise(exercise_path), spec)
    audio_path = tmp / f"{case_name}.wav"
    sf.write(audio_path, audio, 44100, subtype="PCM_16")
    json_path = tmp / f"{case_name}.json"
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(["analyze", str(audio_path), "--exercise", str(exercise_path), "--json", str(json_path)])
    if code != 0:
        raise SystemExit(f"CLI failed for {case_name} with exit code {code}")
    text, _ = out.getvalue().rsplit("\nFindings JSON: ", 1)
    result = json.loads(json_path.read_text())
    result.pop("analyzed_at")
    return text, json.dumps(result, indent=2) + "\n"


def run(check: bool) -> int:
    exercise_path = ROOT / "exercises" / "chromatic_1234.json"
    changed = []
    with tempfile.TemporaryDirectory() as directory:
        for case_name, spec in _cases():
            text, json_text = render(case_name, spec, exercise_path, Path(directory))
            for path, value in ((GOLDEN_DIR / f"{case_name}.txt", text),
                                (GOLDEN_DIR / f"{case_name}.json", json_text)):
                if not path.exists() or path.read_text() != value:
                    changed.append(path.relative_to(ROOT))
                    if not check:
                        path.write_text(value)
    verb = "would change" if check else "updated"
    print("\n".join(f"{verb}: {p}" for p in changed) or "golden files are up to date")
    return 1 if check and changed else 0


if __name__ == "__main__":
    raise SystemExit(run("--check" in sys.argv[1:]))
