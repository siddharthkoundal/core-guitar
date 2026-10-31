"""Audio loading and filtering."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

from .config import CLICK_BAND, GUITAR_BAND_MAX_HZ, SR


class AudioLoadError(Exception):
    pass


def load_audio(path: str | Path, sr: int = SR) -> tuple[np.ndarray, np.ndarray, int]:
    """Return (resampled mono audio, raw mono audio at native rate, native rate).

    The raw signal is kept for clipping detection, which resampling would smear.
    """
    path = Path(path)
    if not path.exists():
        raise AudioLoadError(f"File not found: {path}")
    try:
        raw, native_sr = sf.read(str(path), always_2d=True, dtype="float32")
    except Exception:
        raw, native_sr = _read_via_ffmpeg(path)
    raw = raw.mean(axis=1) if raw.ndim == 2 else raw
    y = librosa.resample(raw, orig_sr=native_sr, target_sr=sr) if native_sr != sr else raw.copy()
    return y.astype(np.float32), raw.astype(np.float32), int(native_sr)


def _read_via_ffmpeg(path: Path) -> tuple[np.ndarray, int]:
    """Decode formats libsndfile can't (e.g. iPhone .m4a / ALAC / AAC)."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AudioLoadError(
            f"Cannot decode {path.suffix} without ffmpeg. Install ffmpeg or export the take as WAV."
        )
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "decoded.wav"
        proc = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", str(path), "-c:a", "pcm_f32le", str(out)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise AudioLoadError(f"ffmpeg could not decode {path}: {proc.stderr.strip()[:300]}")
        data, sr = sf.read(str(out), always_2d=True, dtype="float32")
    return data, sr


def guitar_band(y: np.ndarray, sr: int = SR) -> np.ndarray:
    """Remove the click band and everything above the guitar analysis band."""
    stop = signal.butter(4, CLICK_BAND, btype="bandstop", fs=sr, output="sos")
    low = signal.butter(8, GUITAR_BAND_MAX_HZ, btype="lowpass", fs=sr, output="sos")
    return signal.sosfiltfilt(low, signal.sosfiltfilt(stop, y)).astype(np.float32)


def click_band(y: np.ndarray, sr: int = SR) -> np.ndarray:
    bp = signal.butter(4, CLICK_BAND, btype="bandpass", fs=sr, output="sos")
    return signal.sosfiltfilt(bp, y).astype(np.float32)


def frame_rms_db(y: np.ndarray, frame: int = 1024, hop: int = 256) -> np.ndarray:
    rms = librosa.feature.rms(y=y, frame_length=frame, hop_length=hop)[0]
    return 20 * np.log10(np.maximum(rms, 1e-10))


def db(x: float) -> float:
    return float(20 * np.log10(max(x, 1e-10)))
