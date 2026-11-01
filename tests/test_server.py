from __future__ import annotations

import io
import json
import os
import time
import uuid

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("fastapi", reason="Install .[app,dev] to run optional server tests.")
pytest.importorskip("httpx", reason="Install .[app,dev] to run optional server tests.")

from fastapi.testclient import TestClient

from coreguitar.server.app import create_app
from coreguitar.synth import render_take


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(data_root=tmp_path / "app"), base_url="http://127.0.0.1") as client:
        yield client


def upload(client, audio=None):
    if audio is None:
        audio = np.zeros(3 * 44100, dtype=np.float32)
    stream = io.BytesIO()
    sf.write(stream, audio, 44100, format="WAV", subtype="PCM_16")
    return client.post("/api/takes", files={"file": ("test.wav", stream.getvalue())},
                       data={"meta": json.dumps({"source": "upload", "original_name": "test.wav"})})


def wait_for(client, analysis_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        response = client.get(f"/api/analyses/{analysis_id}").json()
        if response["status"] not in ("queued", "running"):
            return response
        time.sleep(0.05)
    pytest.fail("Analysis did not finish")


def test_health_exercises_preview_click(client):
    assert client.get("/api/health").json()["schema_version"] == "1.0"
    exercises = client.get("/api/exercises").json()
    assert len(exercises) == 5
    assert "total_beats" in exercises[0]
    custom = {"notes": "E2:4 G2:4", "bpm": 80, "tuning": "standard",
              "time_signature": [4, 4], "default_duration": "8"}
    preview = client.post("/api/exercises/preview", json=custom)
    assert preview.status_code == 200
    assert preview.json()["notes"][0]["name"] == "E2"
    click = client.post("/api/click", json={"custom": custom})
    assert click.status_code == 200 and click.content[:4] == b"RIFF"
    assert sf.info(io.BytesIO(click.content)).subtype == "PCM_16"
    custom["notes"] = "garbage"
    invalid = client.post("/api/exercises/preview", json=custom)
    assert invalid.status_code == 422
    assert set(invalid.json()) >= {"code", "message"}
    custom["notes"] = "E2:1 " * 30
    custom["bpm"] = 30
    assert client.post("/api/exercises/preview", json=custom).status_code == 422


def test_upload_analyze_envelope_and_range(client, chromatic):
    audio, _ = render_take(chromatic)
    response = upload(client, audio)
    assert response.status_code == 201
    take = response.json()
    assert take["source"] == "upload" and not take["lossy"]
    ranged = client.get(f"/api/takes/{take['take_id']}/audio", headers={"Range": "bytes=0-15"})
    assert ranged.status_code == 206 and len(ranged.content) == 16
    response = client.post(f"/api/takes/{take['take_id']}/analyses",
                           json={"mode": "reference", "exercise_id": "chromatic_1234"})
    assert response.status_code == 202
    job = wait_for(client, response.json()["analysis_id"])
    assert job["status"] == "done", job
    assert job["result"]["take_id"] == take["take_id"]
    assert job["result"]["result"]["quality"]["verdict"] == "ok"
    assert job["result"]["result"]["summary"]["alignment"]["match"] == 24
    assert client.delete(f"/api/takes/{take['take_id']}").status_code == 204
    assert client.get(f"/api/takes/{take['take_id']}/audio").status_code == 404
    assert client.get(f"/api/analyses/{response.json()['analysis_id']}").status_code == 404


def test_invalid_uuid_host_origin_and_overrides(client):
    assert client.get("/api/takes/not-a-uuid/audio").status_code == 422
    assert client.get(f"/api/takes/{uuid.uuid4()}/audio").status_code == 404
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 400
    assert client.delete("/api/takes", headers={"Origin": "http://evil.example"}).status_code == 403
    dev_proxy = {"Host": "127.0.0.1:5173", "Origin": "http://127.0.0.1:5173"}
    assert client.delete("/api/takes", headers=dev_proxy).status_code == 204
    take = upload(client).json()
    for request in [
        {"mode": "free", "thresholds": {}},
        {"mode": "free", "th": {}},
        {"mode": "reference"},
        {"mode": "free", "bpm": 0},
        {"mode": "reference", "exercise_id": "../chromatic_1234"},
    ]:
        assert client.post(f"/api/takes/{take['take_id']}/analyses", json=request).status_code == 422


def test_invalid_upload_and_metadata(client):
    invalid = client.post("/api/takes", files={"file": ("bad.wav", b"invalid")},
                          data={"meta": '{"source":"upload"}'})
    assert invalid.status_code == 415
    assert invalid.json()["code"] == "unsupported_format"
    assert invalid.json()["advice"]
    assert upload(client, np.zeros(44100)).json()["code"] == "too_short"
    invalid_meta = client.post("/api/takes", files={"file": ("bad.wav", b"invalid")},
                               data={"meta": '{"source":"fake"}'})
    assert invalid_meta.status_code == 422
    assert client.delete("/api/takes").status_code == 204


def test_cancel_and_delete_all(client):
    take = upload(client).json()
    analysis = client.post(f"/api/takes/{take['take_id']}/analyses",
                           json={"mode": "free"}).json()["analysis_id"]
    assert client.delete(f"/api/analyses/{analysis}").status_code == 204
    assert client.get(f"/api/analyses/{analysis}").json()["status"] == "cancelled"
    assert client.get(f"/api/takes/{take['take_id']}/audio").status_code == 200
    assert client.delete("/api/takes").status_code == 204
    assert client.get(f"/api/analyses/{analysis}").status_code == 404


def test_startup_sweeps_only_stale_temp_files(tmp_path):
    root = tmp_path / "app"
    temp = root / "tmp"
    temp.mkdir(parents=True)
    old = temp / "old"
    old.write_text("old")
    os.utime(old, (time.time() - 4000, time.time() - 4000))
    fresh = temp / "fresh"
    fresh.write_text("fresh")
    with TestClient(create_app(data_root=root), base_url="http://127.0.0.1"):
        assert not old.exists()
        assert fresh.exists()


def slow_analysis(audio, exercise, request, output):
    time.sleep(10)


def failed_analysis(audio, exercise, request, output):
    raise RuntimeError("Deliberate test worker failure")


@pytest.mark.parametrize("runner", [slow_analysis, failed_analysis])
def test_subprocess_timeout_and_failure(tmp_path, runner):
    with TestClient(create_app(data_root=tmp_path / "app", job_timeout=0.1,
                              job_runner=runner), base_url="http://127.0.0.1") as client:
        take = upload(client).json()
        analysis = client.post(f"/api/takes/{take['take_id']}/analyses",
                               json={"mode": "free"}).json()["analysis_id"]
        result = wait_for(client, analysis)
        assert result["status"] == "failed" and result["error"]


def test_cancel_running_worker_and_queued_job(tmp_path):
    with TestClient(create_app(data_root=tmp_path / "app", job_runner=slow_analysis),
                    base_url="http://127.0.0.1") as client:
        take = upload(client).json()
        jobs = [
            client.post(f"/api/takes/{take['take_id']}/analyses",
                        json={"mode": "free"}).json()["analysis_id"] for _ in range(2)
        ]
        deadline = time.monotonic() + 5
        while client.get(f"/api/analyses/{jobs[0]}").json()["status"] == "queued":
            assert time.monotonic() < deadline
            time.sleep(0.01)
        assert client.get(f"/api/analyses/{jobs[1]}").json()["status"] == "queued"
        client.delete(f"/api/analyses/{jobs[1]}")
        client.delete(f"/api/analyses/{jobs[0]}")
        assert all(client.get(f"/api/analyses/{job}").json()["status"] == "cancelled" for job in jobs)
        assert not list((tmp_path / "app" / "takes" / take["take_id"]).glob("work-*"))


def test_result_persists_after_restart(tmp_path):
    root = tmp_path / "app"
    with TestClient(create_app(data_root=root), base_url="http://127.0.0.1") as client:
        take = upload(client).json()
        analysis = client.post(f"/api/takes/{take['take_id']}/analyses",
                               json={"mode": "free"}).json()["analysis_id"]
        original = wait_for(client, analysis)
        assert original["status"] == "done"
    with TestClient(create_app(data_root=root), base_url="http://127.0.0.1") as client:
        assert client.get(f"/api/analyses/{analysis}").json() == original


def test_upload_cap_rejects_before_decode(client, monkeypatch):
    import coreguitar.ingest as ingest
    monkeypatch.setattr(ingest, "MAX_UPLOAD_BYTES", 100)
    response = upload(client)
    assert response.status_code == 413 and response.json()["code"] == "too_large"


def test_http_body_cap_prevents_oversized_multipart_staging(client):
    response = client.post("/api/takes", content=b"not parsed",
                           headers={"Content-Length": str(101 * 1024 * 1024)})
    assert response.status_code == 413
    assert response.json()["code"] == "too_large"


def test_reject_external_playlist(client):
    content = b"#EXTM3U\nhttp://127.0.0.1:1/private.wav\n"
    response = client.post("/api/takes", files={"file": ("take.wav", content)},
                           data={"meta": '{"source":"upload"}'})
    assert response.status_code == 415


def test_reference_tuning_override_uses_existing_parser(client):
    take = upload(client).json()
    analysis = client.post(f"/api/takes/{take['take_id']}/analyses",
                           json={"mode": "reference", "exercise_id": "chromatic_1234",
                                 "tuning": "drop_d"}).json()["analysis_id"]
    result = wait_for(client, analysis)["result"]["result"]
    assert result["exercise"]["tuning"] == "drop_d"
    assert result["exercise"]["notes"][0]["name"] == "D#2"


def test_serve_checks_decoder_dependencies(monkeypatch, capsys):
    from coreguitar.cli import main
    import coreguitar.server as server
    monkeypatch.setattr(server.shutil, "which", lambda name: None)
    assert main(["serve"]) == 1
    assert "missing ffmpeg, ffprobe" in capsys.readouterr().err
