from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import soundfile as sf

from coreguitar.cli import main
from coreguitar.music import note_to_midi
from coreguitar.reference import load_exercise
from coreguitar.synth import TakeSpec, render_take

ROOT = Path(__file__).resolve().parents[1]
GOLDEN_DIR = Path(__file__).parent / "golden"


def _cases() -> list[tuple[str, TakeSpec]]:
    return [
        ("clean", TakeSpec()),
        ("late", TakeSpec(deviations_ms={5: 80})),
        ("wrong", TakeSpec(wrong={9: note_to_midi("C3")})),
    ]


def test_cli_text_and_json_match_golden_outputs(tmp_path: Path, capsys) -> None:
    exercise_path = ROOT / "exercises" / "chromatic_1234.json"
    exercise = load_exercise(exercise_path)

    for case_name, spec in _cases():
        audio, _ = render_take(exercise, spec)
        audio_path = tmp_path / f"{case_name}.wav"
        sf.write(audio_path, audio, 44100, subtype="PCM_16")
        json_path = tmp_path / f"{case_name}.json"

        assert main([
            "analyze", str(audio_path), "--exercise", str(exercise_path),
            "--json", str(json_path),
        ]) == 0
        cli_text = capsys.readouterr().out
        text, footer = cli_text.rsplit("\nFindings JSON: ", 1)
        result = json.loads(json_path.read_text())
        result.pop("analyzed_at")
        json_text = json.dumps(result, indent=2)

        assert footer == f"{json_path}\n"
        assert text == (GOLDEN_DIR / f"{case_name}.txt").read_text()
        assert json_text + "\n" == (GOLDEN_DIR / f"{case_name}.json").read_text()


def test_existing_commands_do_not_import_optional_server_dependencies():
    arguments = ["exercise", "--exercise", str(ROOT / "exercises" / "chromatic_1234.json")]
    script = (
        "import sys; from coreguitar.cli import main; "
        f"assert main({arguments!r}) == 0; "
        "assert not any(name in sys.modules for name in "
        "('fastapi', 'uvicorn', 'coreguitar.server'))"
    )
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, timeout=30)
