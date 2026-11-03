from __future__ import annotations

import io
import json

import pytest

guitarpro = pytest.importorskip("guitarpro", reason="Install .[app] for Guitar Pro import.")
from guitarpro import models as m

from coreguitar.guitarpro import GuitarProError, convert
from coreguitar.reference import build_exercise


def gp5(measures, *, tempo=100, strings=None, drums_first=False) -> bytes:
    """measures: list of beats; each beat is (duration, [(string, fret, type)], dotted, triplet)."""
    song = m.Song()
    song.tempo = tempo
    song.title = "Test riff"
    for _ in range(len(measures) - 1):
        song.newMeasure()
    track = song.tracks[0]
    if strings is not None:
        track.strings = [m.GuitarString(number=i + 1, value=v) for i, v in enumerate(strings)]
    for measure, beats in zip(track.measures, measures):
        voice = measure.voices[0]
        for value, notes, dotted, triplet in beats:
            duration = m.Duration(value=value, isDotted=dotted)
            if triplet:
                duration.tuplet = m.Tuplet(enters=3, times=2)
            beat = m.Beat(voice, duration=duration, status=m.BeatStatus.normal if notes else m.BeatStatus.rest)
            for string, fret, kind in notes:
                beat.notes.append(m.Note(beat, value=fret, string=string, type=kind))
            voice.beats.append(beat)
    if drums_first:
        drums = m.Track(song, number=2, name="Drums", isPercussionTrack=True)
        song.tracks.insert(0, drums)
    out = io.BytesIO()
    guitarpro.write(song, out, version=(5, 1, 0))
    return out.getvalue()


N = m.NoteType.normal


def q(string, fret, value=4):
    return (value, [(string, fret, N)], False, False)


def test_single_note_measures_convert_to_tab_tokens():
    data = gp5([[q(5, 0), q(5, 3), q(5, 5), q(4, 2)], [q(6, 3, 8), q(6, 5, 8), (4, [], False, False), q(5, 0, 2)]])
    res = convert(data)
    ex = res["exercise"]
    assert ex["notes"] == "5/0:4 5/3:4 5/5:4 4/2:4 | 6/3:8 6/5:8 r:4 5/0:2"
    assert ex["tuning"] == "standard" and ex["bpm"] == 100 and ex["time_signature"] == [4, 4]
    assert res["title"] == "Test riff" and res["measure_count"] == 2 and res["warnings"] == []
    built = build_exercise(**ex)
    assert built.total_beats == 8 and len(built.notes) == 7


def test_lossy_conversions_warn_and_keep_single_notes():
    chord = (4, [(5, 2, N), (4, 2, N), (3, 1, N)], False, False)
    tie = (4, [(3, 1, m.NoteType.tie)], False, False)
    dead = (4, [(6, 0, m.NoteType.dead)], False, False)
    trip = [(8, [(1, f, N)], False, True) for f in (0, 1, 3)]
    res = convert(gp5([[chord, tie, dead, (4, [(2, 1, N)], True, False)], trip + [q(1, 0, 2), q(1, 0)]]))
    assert res["exercise"]["notes"] == "3/1:4 r:4 r:4 2/1:4. | 1/0:8t 1/1:8t 1/3:8t 1/0:2 1/0:4"
    joined = " ".join(res["warnings"])
    assert "highest note" in joined and "Tied" in joined and "Dead" in joined


def test_range_tempo_track_and_unknown_tuning():
    data = gp5([[q(5, 0)] * 4, [q(5, 2)] * 4, [q(5, 3)] * 4], tempo=200,
               strings=[64, 59, 55, 50, 45, 36], drums_first=True)
    res = convert(data, start=2, end=3, tempo_percent=50)
    assert res["track"] == 1 and res["tracks"][0]["percussion"]
    assert res["exercise"]["bpm"] == 100
    assert res["exercise"]["notes"].startswith("B2:4 B2:4")
    assert res["tracks"][1]["tuning"] is None and "tuning" in res["warnings"][0]
    with pytest.raises(GuitarProError):
        convert(data, track=0)
    with pytest.raises(GuitarProError):
        convert(data, start=3, end=4)
    with pytest.raises(GuitarProError):
        convert(b"not a guitar pro file")
    with pytest.raises(GuitarProError):
        convert(gp5([[(1, [], False, False)]]))


def test_import_endpoint(tmp_path):
    pytest.importorskip("fastapi", reason="Install .[app,dev] to run optional server tests.")
    from fastapi.testclient import TestClient

    from coreguitar.server.app import create_app

    data = gp5([[q(5, 0), q(5, 3), q(5, 5), q(4, 2)]] * 3)
    with TestClient(create_app(data_root=tmp_path / "app"), base_url="http://127.0.0.1") as client:
        def post(name="riff.gp5", body=data, options=None):
            return client.post("/api/import/guitarpro", files={"file": (name, body)},
                               data={"options": json.dumps(options or {})})

        ok = post(options={"start": 2, "tempo_percent": 80})
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert body["start"] == 2 and body["end"] == 3 and body["exercise"]["bpm"] == 80
        assert body["note_count"] == 8 and body["total_beats"] == 8
        preview = client.post("/api/exercises/preview", json=body["exercise"])
        assert preview.status_code == 200
        assert post(name="riff.gpx").status_code == 422
        assert post(body=b"junk").json()["code"] == "invalid_request"
        assert post(options={"tempo_percent": 500}).status_code == 422
        assert post(options={"thresholds": {}}).status_code == 422
        too_long = gp5([[q(5, 0)] * 4] * 80, tempo=60)
        slow = post(body=too_long, options={"end": 80, "tempo_percent": 50})
        assert slow.status_code == 422 and "fewer measures" in slow.json()["message"]
        big = post(body=b"0" * (6 * 1024 * 1024))
        assert big.status_code == 413
