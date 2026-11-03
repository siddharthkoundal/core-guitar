"""Processor (direct USB) input and the tone check, on synthetic takes.

Synthetic drive is a tanh curve, not a real pedal; these tests pin the heuristics' wiring,
not their accuracy on the user's processor.
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from coreguitar.analyze import analyze
from coreguitar.config import DEFAULT, LEAD_SILENCE_S
from coreguitar.synth import TakeSpec, render_take
from coreguitar.tone import is_driven, tone_check

from conftest import types

DRY = dict(click_level=0.0, snr_db=70.0, reverb=False)


def run_direct(tmp_path, ex, spec, **kw):
    audio, _ = render_take(ex, spec)
    path = tmp_path / "direct.wav"
    sf.write(path, audio, 44100)
    return analyze(path, ex, input_profile="direct", **kw)


def codes(res: dict) -> set[str]:
    return {t["code"] for t in res["tone"]["traits"]}


def test_clean_mic_take_reports_clean_dynamic_tone(run_take, chromatic):
    res = run_take(chromatic)
    assert res["input"]["profile"] == "mic"
    assert res["tone"]["experimental"] and res["tone"]["caveat"]
    assert {"level_ok", "drive_clean", "dynamic"} <= codes(res)
    assert not {"drive_heavy", "compressed", "level_hot"} & codes(res)


def test_direct_profile_uses_browser_click_offset(tmp_path, chromatic):
    res = run_direct(tmp_path, chromatic, TakeSpec(deviations_ms={3: 90}, **DRY), click_offset_s=LEAD_SILENCE_S)
    assert res["quality"]["verdict"] == "ok"
    assert res["click_grid"]["found"] and "browser audio clock" in res["click_grid"]["reason"]
    assert types(res, min_conf=0.6) == ["timing_late"]
    assert "gated" in codes(res)


def test_direct_profile_without_offset_or_click_is_rejected_with_processor_advice(tmp_path, chromatic):
    res = run_direct(tmp_path, chromatic, TakeSpec(**DRY))
    no_click = [i for i in res["quality"]["issues"] if i["code"] == "no_click"]
    assert no_click and "Processor (USB)" in no_click[0]["advice"]
    assert res["tone"] is not None


def test_driven_direct_take_is_analysed_and_drops_buzz(tmp_path, chromatic):
    spec = TakeSpec(distortion_gain=30, buzz={5: 0.3}, **DRY)
    res = run_direct(tmp_path, chromatic, spec, click_offset_s=LEAD_SILENCE_S)
    assert res["quality"]["verdict"] in ("ok", "degraded")
    assert {"drive_heavy", "compressed"} <= codes(res)
    assert "possible_buzz" not in types(res, include_experimental=True)
    assert any("Delay and reverb" in a for a in res["tone"]["advice"])


def test_tone_levels_hum_and_driven_helper():
    sr = 22050
    t = np.arange(int(6 * sr)) / sr
    quiet = 1e-4 * np.sin(2 * np.pi * 60 * t[: 2 * sr])
    note = 0.5 * np.sin(2 * np.pi * 220 * t[: 4 * sr]) * np.exp(-t[: 4 * sr])
    y = np.concatenate([quiet, note]).astype(np.float32)
    res = tone_check(y, y, [], DEFAULT, quiet_until_s=2.0, sr=sr)
    found = {t["code"] for t in res["traits"]}
    assert "level_ok" in found and "hum" in found
    assert res["metrics"]["hum_hz"] == 60
    hot = tone_check(y * 2.2, np.clip(y * 2.2, -1, 1), [], DEFAULT, sr=sr)
    assert hot["traits"][0]["code"] == "level_hot" and hot["traits"][0]["attention"]
    low = tone_check(y * 0.01, y * 0.01, [], DEFAULT, sr=sr)
    assert low["traits"][0]["code"] == "level_low"
    assert not is_driven(None) and not is_driven(res)
    assert is_driven({"traits": [{"code": "drive_heavy"}]})


def test_unknown_input_profile_is_an_error(tmp_path, chromatic):
    with pytest.raises(ValueError):
        analyze(tmp_path / "missing.wav", chromatic, input_profile="usb")
