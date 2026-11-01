from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from coreguitar.ingest import IngestError, ingest_audio


@pytest.fixture
def wav_bytes() -> bytes:
    signal = np.zeros(3 * 44100, dtype=np.float32)
    signal[4410:8820] = 0.25
    with io.BytesIO() as output:
        sf.write(output, signal, 44100, format="WAV", subtype="PCM_16")
        return output.getvalue()


def _ingest(tmp_path: Path, content: bytes, original_name: str = "take.wav"):
    return ingest_audio(
        io.BytesIO(content),
        original_name=original_name,
        temp_root=tmp_path / "tmp",
        take_dir=tmp_path / "takes" / "f0b4d7cc-3d8d-43e0-9c14-1f93a1419170",
    )


def test_ingest_normalizes_content_to_float_wav_and_keeps_safe_layout(tmp_path, wav_bytes):
    ingested = _ingest(tmp_path, wav_bytes, original_name="../../unsafe.wav")

    assert ingested.codec == "pcm_s16le"
    assert ingested.lossy is False
    assert ingested.sample_rate == 44100
    assert ingested.channels == 1
    assert 2.9 <= ingested.duration_s <= 3.1
    assert ingested.original_path == (
        tmp_path / "takes" / "f0b4d7cc-3d8d-43e0-9c14-1f93a1419170" / "original.wav"
    )
    assert ingested.normalized_path.name == "take.wav"
    assert sf.info(ingested.normalized_path).subtype == "FLOAT"
    assert not list((tmp_path / "tmp").iterdir())


def test_ingest_accepts_audio_regardless_of_filename_extension(tmp_path, wav_bytes):
    result = _ingest(tmp_path, wav_bytes, original_name="not-audio.txt")

    assert result.codec == "pcm_s16le"
    assert result.original_path.suffix == ".bin"


def test_ingest_rejects_bad_content_and_cleans_temporary_upload(tmp_path):
    with pytest.raises(IngestError) as error:
        _ingest(tmp_path, b"not an audio file")

    assert error.value.code in {"unsupported_format", "decode_failed"}
    assert not list((tmp_path / "tmp").iterdir())
    assert not (tmp_path / "takes").exists()


def test_ingest_enforces_streamed_upload_size_and_cleans_rejected_file(
    tmp_path, wav_bytes, monkeypatch
):
    import coreguitar.ingest as ingest_module

    monkeypatch.setattr(ingest_module, "MAX_UPLOAD_BYTES", 100)

    with pytest.raises(IngestError) as error:
        _ingest(tmp_path, wav_bytes)

    assert error.value.code == "too_large"
    assert not list((tmp_path / "tmp").iterdir())
    assert not (tmp_path / "takes").exists()


@pytest.mark.parametrize(
    ("duration_s", "expected_code"),
    [(1.0, "too_short"), (181.0, "too_long")],
)
def test_ingest_enforces_duration_bounds(tmp_path, duration_s, expected_code):
    signal = np.zeros(int(duration_s * 44100), dtype=np.float32)
    with io.BytesIO() as output:
        sf.write(output, signal, 44100, format="WAV", subtype="PCM_16")
        content = output.getvalue()

    with pytest.raises(IngestError) as error:
        _ingest(tmp_path, content)

    assert error.value.code == expected_code
    assert not list((tmp_path / "tmp").iterdir())
    assert not (tmp_path / "takes").exists()


def test_duration_uses_audio_stream_not_longer_video_container():
    from coreguitar.ingest import _duration

    assert _duration({"format": {"duration": "240"}}, {"duration": "30"}) == 30
    assert _duration({"format": {"duration": "30"}}, {"duration": "N/A"}) == 30
