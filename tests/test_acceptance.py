"""Acceptance tests T1-T14 on synthetic audio (logic checks, not accuracy claims)."""

import numpy as np
import pytest

from coreguitar.config import Thresholds
from coreguitar.reference import build_exercise, load_exercise
from coreguitar.synth import TakeSpec
from coreguitar.music import note_to_midi
from coreguitar.synth import render_take

from conftest import EXERCISES, types

MISTAKE_WORDS = ("wrong", "mistake", "error", "missed", "incorrect", "should")


def confident(res, t=0.5):
    return types(res, min_conf=t)


# T1 correct take: no confident findings, nothing prioritised.
def test_t1_correct_take(run_take, chromatic):
    res = run_take(chromatic, TakeSpec())
    assert res["quality"]["verdict"] == "ok"
    assert confident(res) == []
    assert res["priorities"] == []
    assert res["summary"]["note_accuracy"] == 1.0


def test_t1_correct_take_other_exercises(run_take):
    for name in ("major_scale_g", "minor_pentatonic_a_box1", "spider_pairs", "my_riff"):
        res = run_take(load_exercise(EXERCISES / f"{name}.json"), TakeSpec(seed=3))
        assert confident(res) == [], (name, res["findings"])


# Damping a string before a rest makes a noise transient; it must not become a note.
def test_t1_rests_damping_is_not_a_note(run_take):
    ex = build_exercise("5/0:4 5/3:8 5/5:8 4/2:4. r:8 4/0:4 r:4 5/3:8 r:8 5/5:4", bpm=80, tuning="drop_d")
    res = run_take(ex, TakeSpec())
    assert res["summary"]["note_accuracy"] == 1.0
    assert types(res, include_experimental=True) == []
    free = run_take(ex, TakeSpec(), free=True)
    assert all(f["type"] != "possible_buzz" for f in free["findings"])


# T2 fast sixteenths at 120 BPM still transcribe completely.
def test_t2_sixteenths_120(run_take):
    ex = load_exercise(EXERCISES / "chromatic_1234.json", bpm=120)
    ex = build_exercise(ex.notes_text, bpm=120, default_duration="16")
    res = run_take(ex, TakeSpec())
    assert res["summary"]["note_accuracy"] >= 0.95
    assert "wrong_note" not in confident(res)


# T3 one note 80 ms late.
def test_t3_single_late_note(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(deviations_ms={5: 80}))
    late = [f for f in res["findings"] if f["type"] == "timing_late"]
    assert len(late) == 1 and 5 in late[0]["ref_indices"] and late[0]["confidence"] >= 0.5
    assert 60 <= late[0]["measured"]["mean_ms"] <= 100 if "mean_ms" in late[0]["measured"] else True
    assert {"wrong_note", "missed_note", "extra_note"}.isdisjoint(confident(res))


# T4 gradual rushing is reported as a trend, not as many separate early notes.
def test_t4_drift_is_trend(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(drift_ms_total=-150))
    t = confident(res)
    assert "timing_drift_rushing" in t
    assert "timing_early" not in t and "timing_late" not in t


# T5 dragging confined to bar 2 is localised.
def test_t5_drag_in_bar2(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(deviations_ms={i: 60 for i in range(8, 16)}))
    late = [f for f in res["findings"] if f["type"] == "timing_late" and f["confidence"] >= 0.5]
    assert late
    idx = {i for f in late for i in f["ref_indices"]}
    assert idx and idx <= set(range(8, 16))


# T6 wrong note.
def test_t6_wrong_note(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(wrong={9: note_to_midi("C3")}))
    wrong = [f for f in res["findings"] if f["type"] == "wrong_note"]
    assert len(wrong) == 1 and wrong[0]["ref_indices"] == [9]
    assert wrong[0]["measured"]["heard"] == "C3"


# T7 missed + extra notes do not cascade into misalignment.
def test_t7_missed_and_extra(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(missing={14}, extra=[(3, note_to_midi("G3"))]))
    t = confident(res, 0.0)
    assert "missed_note" in t and "extra_note" in t
    assert "wrong_note" not in t
    assert res["summary"]["alignment"]["match"] == 23


# T8 guitar 30 cents flat: one tuning finding, no wrong notes.
def test_t8_detuned(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(tuning_cents=-30))
    t = confident(res)
    assert "tuning_offset" in t
    assert "wrong_note" not in t and "intonation" not in t
    assert -40 <= res["summary"]["tuning_offset_cents"] <= -20


# T8b whole-take transposition by a semitone is reported once.
# (Uses the G major scale: a chromatic run shifted a semitone is just the same run shifted one note.)
def test_t8_transposed(run_take):
    ex = load_exercise(EXERCISES / "major_scale_g.json")
    res = run_take(ex, TakeSpec(wrong={n.index: n.midi + 1 for n in ex.notes}))
    t = confident(res, 0.0)
    assert "transposition" in t
    assert t.count("wrong_note") == 0


# T9 free mode is descriptive and never calls things mistakes.
def test_t9_free_mode_language(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(deviations_ms={5: 80}, wrong={9: 48}), free=True)
    assert res["mode"] == "free"
    assert res["priorities"] == []
    text = " ".join(f["message"] for f in res["findings"]).lower()
    text += " ".join(str(v) for v in (res["summary"] or {}).values()).lower()
    assert not any(w in text for w in MISTAKE_WORDS), text


# T10 noisy audio: degraded or rejected, never confident wrong notes.
# (TakeSpec.snr_db is relative to the whole mix; the analyser measures guitar level vs lead-in noise.)
def test_t10_noise(run_take, chromatic):
    for snr, allowed in ((5, {"degraded"}), (-6, {"rejected"})):
        res = run_take(chromatic, TakeSpec(snr_db=snr))
        assert res["quality"]["verdict"] in allowed, (snr, res["quality"])
        assert "wrong_note" not in confident(res)


# T11 clipping is rejected with advice to re-record.
def test_t11_clipping(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(gain=6.0))
    assert res["quality"]["verdict"] == "rejected"
    assert res["re_record"]["requested"]
    assert res["findings"] == []


# T12 chords and distortion are out of MVP scope.
def test_t12_chords_unsupported(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(chord=True))
    assert res["quality"]["verdict"] == "unsupported"
    assert res["re_record"]["requested"]


@pytest.mark.xfail(reason="Distortion heuristic is uncalibrated: synthetic tanh distortion is not a valid proxy. "
                          "Calibrate on real GA15II overdrive takes from the M0 protocol.", strict=False)
def test_t12_distortion_unsupported(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(distortion_gain=30.0))
    assert res["quality"]["verdict"] == "unsupported"


# T13 short, silent, and click-less recordings.
def test_t13_silent(run_take, chromatic):
    res = run_take(chromatic, audio=np.zeros(44100 * 5, dtype=np.float32))
    assert res["quality"]["verdict"] == "rejected"


def test_t13_too_short(run_take, chromatic):
    audio, _ = __import__("coreguitar.synth", fromlist=["render_take"]).render_take(chromatic)
    res = run_take(chromatic, audio=audio[: 44100])
    assert res["quality"]["verdict"] == "rejected"


def test_t13_no_click(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(click_level=0.0))
    assert res["quality"]["verdict"] == "rejected"
    assert any(i["code"] == "no_click" for i in res["quality"]["issues"])


# T14 very fast notes: timing findings are flagged as low confidence.
def test_t14_fast_notes_low_confidence(run_take):
    ex = build_exercise("6/1 6/2 6/3 6/4 5/1 5/2 5/3 5/4 4/1 4/2 4/3 4/4 3/1 3/2 3/3 3/4",
                        bpm=180, default_duration="16")
    res = run_take(ex, TakeSpec(deviations_ms={6: 30}))
    timing = [f for f in res["findings"] if f["type"].startswith("timing_")]
    assert all(f["confidence"] < 0.5 for f in timing)


# Experimental detectors: flagged on synthetic buzz, but never prioritised.
def test_experimental_buzz(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(buzz={i: 0.6 for i in (4, 5, 6)}))
    buzz = [f for f in res["findings"] if f["type"] == "possible_buzz"]
    assert buzz and all(f["experimental"] and f["confidence"] <= 0.4 for f in buzz)
    assert all(p.get("type") != "possible_buzz" for p in res["priorities"])


# T15 notes played on click instants remain detectable when their pitches are stable.
def test_t15_click_coincident_pitched_attacks_are_kept(run_take):
    ex = load_exercise(EXERCISES / "major_scale_g.json")
    res = run_take(ex, TakeSpec(click_level=0.7, snr_db=70.0))
    assert res["summary"]["alignment"]["match"] == len(ex.notes)
    assert "missed_note" not in confident(res)


# T16 a stable 2x inter-onset ratio is reported as a rhythm mismatch, not tempo drift.
def test_t16_eighth_notes_played_as_quarters(run_take):
    notes = "6/3 6/5 5/2 5/3 5/5 4/2 4/4 4/5"
    reference = build_exercise(notes, bpm=70, default_duration="8")
    played = build_exercise(notes, bpm=70, default_duration="4")
    audio, _ = render_take(played, TakeSpec(seed=5))
    res = run_take(reference, audio=audio)
    rhythm = [f for f in res["findings"] if f["type"] == "rhythm_mismatch"]
    assert len(rhythm) == 1
    assert "quarter" in rhythm[0]["message"] and "eighth" in rhythm[0]["message"]
    assert not any(f["type"].startswith("timing_") for f in res["findings"])


# T17 notes begun before the exercise starts are identified as count-in playing.
def test_t17_first_notes_during_count_in_are_not_reported_late(run_take):
    ex = load_exercise(EXERCISES / "major_scale_g.json")
    res = run_take(ex, TakeSpec(deviations_ms={0: -2600, 1: -2450, 5: 80}, seed=4))
    assert [note["name"] for note in res["notes"][:2]] == ["G2", "A2"]
    assert any(f["type"] == "started_during_count_in" for f in res["findings"])
    assert not any("Did you start late?" in f["message"] for f in res["findings"])
    assert any(f["type"] == "timing_late" and 5 in f["ref_indices"] for f in res["findings"])


def test_t21_note_during_opening_rest_is_not_count_in_playing(run_take):
    ex = build_exercise("r:4 6/3:4 6/5:4 5/2:4 5/3:4 5/5:4", bpm=80, default_duration="4")
    res = run_take(ex, TakeSpec(deviations_ms={0: -400}, seed=7))
    assert not any(f["type"] == "started_during_count_in" for f in res["findings"])


# T18 one repeated scale apex is allowed without reducing note accuracy.
def test_t18_repeated_top_note_is_allowed(run_take):
    ex = load_exercise(EXERCISES / "major_scale_g.json")
    apex = next(n for n in ex.notes if n.name == "G3")
    res = run_take(ex, TakeSpec(extra=[(apex.index, apex.midi)], seed=6))
    assert res["summary"]["note_accuracy"] == 1.0
    assert "extra_note" not in confident(res)
    assert res["summary"]["alignment"]["optional_repeat"] == 1


# T19 notes from one consistently flat tab string are grouped into a tuning finding.
def test_t19_out_of_tune_string_is_reported_as_a_group(run_take):
    ex = build_exercise("6/3 6/5 5/2 5/3 5/5 4/2", bpm=80, default_duration="4")
    res = run_take(ex, TakeSpec(note_tuning_cents={0: -30, 1: -30}, seed=9))
    strings = [f for f in res["findings"] if f["type"] == "string_tuning"]
    assert len(strings) == 1
    assert strings[0]["measured"]["string"] == 6
    assert strings[0]["ref_indices"] == [0, 1]


# T20 low-confidence observations are omitted at the configured reporting floor.
def test_t20_findings_obey_configured_confidence_floor(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(deviations_ms={5: 80}),
                   th=Thresholds(min_finding_confidence=0.95))
    assert res["findings"] == []
    assert res["priorities"] == []
