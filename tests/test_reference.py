import pytest

from coreguitar.music import note_to_midi, tab_to_midi
from coreguitar.reference import build_exercise, duration_beats, load_exercise

from conftest import EXERCISES


def test_tab_and_names_agree_in_standard():
    assert tab_to_midi(6, 0, "standard") == note_to_midi("E2")
    assert tab_to_midi(1, 5, "standard") == note_to_midi("A4")


def test_alternate_tunings():
    assert tab_to_midi(6, 0, "drop_d") == note_to_midi("D2")
    assert tab_to_midi(5, 0, "drop_d") == note_to_midi("A2")
    assert tab_to_midi(6, 0, "half_step_down") == note_to_midi("D#2")
    assert tab_to_midi(1, 0, "half_step_down") == note_to_midi("D#4")


def test_durations():
    assert duration_beats("4", 4) == 1.0
    assert duration_beats("8", 4) == 0.5
    assert duration_beats("4.", 4) == 1.5
    assert duration_beats("8t", 4) == pytest.approx(1 / 3)
    with pytest.raises(ValueError):
        duration_beats("3", 4)


def test_rests_and_bars():
    ex = build_exercise("E2:4 r:4 A2:2 | 6/3:8 r:8 6/5:4", bpm=90)
    assert [n.start_beat for n in ex.notes] == [0, 2, 4, 5]
    assert [n.bar for n in ex.notes] == [1, 1, 2, 2]
    assert ex.total_beats == 6


def test_invalid_inputs():
    with pytest.raises(ValueError):
        build_exercise("r r r")
    with pytest.raises(ValueError):
        build_exercise("E2", bpm=500)


@pytest.mark.parametrize("path", sorted(EXERCISES.glob("*.json")), ids=lambda p: p.stem)
def test_shipped_exercises_parse(path):
    ex = load_exercise(path)
    assert len(ex.notes) >= 4
    assert all(40 <= n.midi <= 88 for n in ex.notes)
