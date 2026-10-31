import json

import soundfile as sf

from conftest import EXERCISES

from coreguitar.evaluate import evaluate_dir
from coreguitar.synth import TakeSpec, render_take


def _write_take(d, name, ex, exercise_path, spec, errors, verdict):
    audio, gt = render_take(ex, spec)
    sf.write(d / f"{name}.wav", audio, 44100)
    (d / f"{name}.onsets.txt").write_text("".join(f"{e['onset_s']:.4f}\t{e['onset_s']:.4f}\tn\n" for e in gt))
    (d / f"{name}.label.json").write_text(json.dumps({
        "audio": f"{name}.wav", "exercise": str(exercise_path), "device": "synthetic",
        "expected_verdict": verdict, "errors": errors, "onsets_file": f"{name}.onsets.txt",
    }))


def test_evaluate_dir_scores_labelled_takes(tmp_path, chromatic):
    path = EXERCISES / "chromatic_1234.json"
    _write_take(tmp_path, "correct", chromatic, path, TakeSpec(), [], "ok")
    _write_take(tmp_path, "errors", chromatic, path, TakeSpec(deviations_ms={5: 80}, wrong={9: 48}, missing={14}),
                [{"type": "late", "index": 5}, {"type": "wrong_note", "index": 9}, {"type": "missed_note", "index": 14}],
                "ok")
    _write_take(tmp_path, "noisy", chromatic, path, TakeSpec(snr_db=-6), [], "rejected")

    rep = evaluate_dir(tmp_path)

    assert not any("error" in t for t in rep["takes"])
    for t in ("late", "wrong_note", "missed_note"):
        assert rep["per_type"][t]["recall"] == 1.0
    assert all(k.split("->")[0] == k.split("->")[1] for k in rep["verdicts"])
    assert rep["calibration"]["suggested_timing_uncertainty_ms"] < 10
