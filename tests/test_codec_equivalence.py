from __future__ import annotations

import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
import soundfile as sf

from coreguitar.analyze import analyze
from coreguitar.ingest import IngestedAudio, ingest_audio
from coreguitar.music import note_to_midi
from coreguitar.reference import load_exercise
from coreguitar.synth import TakeSpec, render_take

ROOT = Path(__file__).resolve().parents[1]
EXERCISE_PATH = ROOT / "exercises" / "chromatic_1234.json"
CODECS = {
    "wav": (".wav", ["-c:a", "pcm_s16le"]),
    "webm_opus": (".webm", ["-c:a", "libopus", "-b:a", "128k"]),
    "ogg_opus": (".ogg", ["-c:a", "libopus", "-b:a", "128k"]),
    "m4a_aac": (".m4a", ["-c:a", "aac", "-b:a", "192k"]),
}
pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")


def _encoded_take(tmp_path: Path, case_name: str, spec: TakeSpec, codec_name: str) -> IngestedAudio:
    exercise = load_exercise(EXERCISE_PATH)
    audio, _ = render_take(exercise, spec)
    source = tmp_path / f"{case_name}-source.wav"
    sf.write(source, audio, 44100, subtype="PCM_16")

    extension, encoder_args = CODECS[codec_name]
    encoded = tmp_path / f"{case_name}-{codec_name}{extension}"
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg", "-nostdin", "-v", "error", "-y",
            "-i", str(source), *encoder_args, str(encoded),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    take_dir = tmp_path / "takes" / str(uuid.uuid4())
    with encoded.open("rb") as upload:
        return ingest_audio(
            upload,
            original_name=encoded.name,
            temp_root=tmp_path / "tmp",
            take_dir=take_dir,
        )


def _confident_findings(result: dict) -> list[dict]:
    return [
        finding for finding in result["findings"]
        if finding["confidence"] >= 0.5 and not finding["experimental"]
    ]


def test_lossy_and_lossless_ingest_produce_equivalent_findings(tmp_path):
    exercise = load_exercise(EXERCISE_PATH)
    spec = TakeSpec(deviations_ms={5: 80}, wrong={9: note_to_midi("C3")})
    baseline_audio, _ = render_take(exercise, spec)
    baseline_path = tmp_path / "baseline.wav"
    sf.write(baseline_path, baseline_audio, 44100, subtype="PCM_16")
    baseline = analyze(baseline_path, exercise)
    baseline_findings = _confident_findings(baseline)
    assert {finding["type"] for finding in baseline_findings} >= {"timing_late", "wrong_note"}

    for codec_name in CODECS:
        ingested = _encoded_take(tmp_path, "findings", spec, codec_name)
        actual = analyze(ingested.normalized_path, exercise)
        assert actual["quality"]["verdict"] == baseline["quality"]["verdict"], codec_name
        actual_findings = _confident_findings(actual)
        assert [
            (finding["type"], finding["ref_indices"]) for finding in actual_findings
        ] == [
            (finding["type"], finding["ref_indices"]) for finding in baseline_findings
        ], codec_name
        for expected, found in zip(baseline_findings, actual_findings, strict=True):
            for key in ("start_s", "end_s", "play_from_s", "play_to_s"):
                assert abs(expected["evidence"][key] - found["evidence"][key]) <= 0.01, (
                    codec_name, expected["id"], key,
                )
        assert ingested.lossy is (codec_name != "wav"), codec_name


@pytest.mark.parametrize(
    ("case_name", "spec", "expected_verdict"),
    [
        ("clipped", TakeSpec(gain=6.0), "rejected"),
        ("noisy", TakeSpec(snr_db=-6), "rejected"),
        ("chord", TakeSpec(chord=True), "unsupported"),
        ("no-click", TakeSpec(click_level=0.0), "rejected"),
    ],
)
def test_quality_gates_remain_consistent_after_codec_ingest(
    tmp_path, case_name, spec, expected_verdict
):
    for codec_name in CODECS:
        ingested = _encoded_take(tmp_path, case_name, spec, codec_name)
        result = analyze(ingested.normalized_path, load_exercise(EXERCISE_PATH))
        assert result["quality"]["verdict"] == expected_verdict, (case_name, codec_name)
        assert result["re_record"]["requested"]
