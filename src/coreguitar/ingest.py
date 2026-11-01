"""Validate uploaded audio and store an analysis-ready local WAV."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import soundfile as sf

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MIN_DURATION_S = 2.0
MAX_DURATION_S = 180.0
UPLOAD_CHUNK_BYTES = 64 * 1024
FFPROBE_TIMEOUT_S = 30
FFMPEG_TIMEOUT_S = 120

_ALLOWED_SUFFIXES = {
    ".aac", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm",
}
_LOSSLESS_CODECS = {"alac", "ape", "flac", "mlp", "truehd", "tta", "wavpack"}
_INPUT_FORMATS = "wav,aiff,flac,ogg,matroska,webm,mov,mp3,aac"


class IngestError(Exception):
    """An expected validation or decoding error for an uploaded take."""

    def __init__(self, code: str, message: str, advice: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.advice = advice


@dataclass(frozen=True)
class IngestedAudio:
    original_path: Path
    normalized_path: Path
    duration_s: float
    sample_rate: int
    channels: int
    codec: str
    lossy: bool


def ingest_audio(
    upload: BinaryIO,
    *,
    original_name: str,
    temp_root: Path,
    take_dir: Path,
) -> IngestedAudio:
    """Stream, validate, and normalize an upload without trusting its filename."""
    temp_root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="upload-", dir=temp_root) as work_dir:
        work = Path(work_dir)
        source_path = work / "upload"
        _stream_upload(upload, source_path)
        probe = _probe(source_path)
        audio_stream = next(
            (stream for stream in probe["streams"] if stream.get("codec_type") == "audio"),
            None,
        )
        if audio_stream is None:
            raise IngestError(
                "unsupported_format",
                "The uploaded file does not contain an audio stream.",
                "Choose a file containing audio, such as WAV, WebM, Ogg, or M4A.",
            )

        duration_s = _duration(probe, audio_stream)
        if duration_s < MIN_DURATION_S:
            raise IngestError(
                "too_short",
                f"The recording is {duration_s:.2f} seconds; at least 2 seconds are required.",
                "Record or select a take that is at least 2 seconds long.",
            )
        if duration_s > MAX_DURATION_S:
            raise IngestError(
                "too_long",
                f"The recording is {duration_s:.2f} seconds; the maximum is 180 seconds.",
                "Trim the recording to 180 seconds or less.",
            )

        codec = audio_stream.get("codec_name")
        sample_rate = _positive_int(audio_stream.get("sample_rate"))
        channels = _positive_int(audio_stream.get("channels"))
        if not isinstance(codec, str) or not codec or sample_rate is None or channels is None:
            raise IngestError(
                "decode_failed",
                "Audio metadata is incomplete or invalid.",
                "Try exporting the recording as WAV or another supported audio format.",
            )

        wav_path = work / "take.wav"
        _normalize(source_path, wav_path, sample_rate)
        info = sf.info(wav_path)
        if info.duration < MIN_DURATION_S:
            raise IngestError("too_short", "Decoded audio is shorter than 2 seconds.",
                              "Record a take at least 2 seconds long.")
        if info.duration > MAX_DURATION_S:
            raise IngestError("too_long", "Decoded audio is longer than 180 seconds.",
                              "Trim the take to 180 seconds or less.")
        duration_s = info.duration
        suffix = _safe_suffix(original_name)
        take_dir.parent.mkdir(parents=True, exist_ok=True)
        take_dir.mkdir(exist_ok=False)
        original_path = take_dir / f"original{suffix}"
        normalized_path = take_dir / "take.wav"
        try:
            os.replace(source_path, original_path)
            os.replace(wav_path, normalized_path)
        except OSError:
            shutil.rmtree(take_dir)
            raise

    return IngestedAudio(
        original_path=original_path,
        normalized_path=normalized_path,
        duration_s=duration_s,
        sample_rate=sample_rate,
        channels=channels,
        codec=codec,
        lossy=not codec.startswith("pcm_") and codec not in _LOSSLESS_CODECS,
    )


def _stream_upload(upload: BinaryIO, destination: Path) -> None:
    written = 0
    try:
        with destination.open("wb") as target:
            while chunk := upload.read(UPLOAD_CHUNK_BYTES):
                if not isinstance(chunk, bytes):
                    raise IngestError(
                        "decode_failed",
                        "The upload stream did not provide binary data.",
                        "Try selecting the file again.",
                    )
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise IngestError(
                        "too_large",
                        "The uploaded file exceeds the 100 MB limit.",
                        "Choose a smaller audio file.",
                    )
                target.write(chunk)
    except OSError as exc:
        raise IngestError(
            "decode_failed",
            "The uploaded file could not be read.",
            "Try selecting the file again.",
        ) from exc


def _probe(path: Path) -> dict:
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        raise IngestError(
            "decode_failed",
            "ffprobe is not installed.",
            "Install ffmpeg, which includes ffprobe, and try again.",
        )
    command = [
        ffprobe,
        "-v", "error",
        "-protocol_whitelist", "file,pipe",
        "-format_whitelist", _INPUT_FORMATS,
        "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration:format=format_name,duration",
        "-of", "json",
        str(path),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=FFPROBE_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise IngestError(
            "decode_failed",
            "Audio inspection timed out.",
            "Try a different audio export.",
        ) from exc
    except OSError as exc:
        raise IngestError(
            "decode_failed",
            "Audio inspection could not be started.",
            "Check that ffmpeg is installed and try again.",
        ) from exc
    if completed.returncode != 0:
        raise IngestError(
            "unsupported_format",
            "The uploaded file is not a supported audio format.",
            "Choose WAV, WebM, Ogg, M4A, or another ffmpeg-readable audio file.",
        )
    try:
        probe = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise IngestError(
            "decode_failed",
            "Audio inspection returned invalid metadata.",
            "Try exporting the recording as WAV or another supported audio format.",
        ) from exc
    streams = probe.get("streams")
    if not isinstance(streams, list):
        raise IngestError(
            "decode_failed",
            "Audio inspection returned invalid stream metadata.",
            "Try exporting the recording as WAV or another supported audio format.",
        )
    return probe


def _duration(probe: dict, audio_stream: dict) -> float:
    format_info = probe.get("format")
    raw_duration = audio_stream.get("duration")
    if raw_duration in (None, "", "N/A"):
        raw_duration = format_info.get("duration") if isinstance(format_info, dict) else None
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError) as exc:
        raise IngestError(
            "decode_failed",
            "Audio duration could not be determined.",
            "Try exporting the recording as WAV or another supported audio format.",
        ) from exc
    if not (duration >= 0 and duration < float("inf")):
        raise IngestError(
            "decode_failed",
            "Audio duration is invalid.",
            "Try exporting the recording as WAV or another supported audio format.",
        )
    return duration


def _positive_int(value: object) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _normalize(source_path: Path, wav_path: Path, sample_rate: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise IngestError(
            "decode_failed",
            "ffmpeg is not installed.",
            "Install ffmpeg and try again.",
        )
    command = [
        ffmpeg,
        "-nostdin",
        "-v", "error",
        "-y",
        "-protocol_whitelist", "file,pipe",
        "-format_whitelist", _INPUT_FORMATS,
        "-i", str(source_path),
        "-map", "0:a:0",
        "-vn",
        "-c:a", "pcm_f32le",
        "-ar", str(sample_rate),
        str(wav_path),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise IngestError(
            "decode_failed",
            "Audio conversion timed out.",
            "Try a shorter recording or export it as WAV.",
        ) from exc
    except OSError as exc:
        raise IngestError(
            "decode_failed",
            "Audio conversion could not be started.",
            "Check that ffmpeg is installed and try again.",
        ) from exc
    if completed.returncode != 0 or not wav_path.is_file():
        raise IngestError(
            "decode_failed",
            "The uploaded audio could not be decoded.",
            "Try exporting the recording as WAV or another supported audio format.",
        )


def _safe_suffix(original_name: str) -> str:
    suffix = Path(original_name).suffix.lower()
    return suffix if suffix in _ALLOWED_SUFFIXES else ".bin"
