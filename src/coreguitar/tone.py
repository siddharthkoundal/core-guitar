"""Tone check: descriptive measurements of a take's signal chain (drive, dynamics, brightness, noise, level).

Honesty caveats: every label here is a heuristic on placeholder thresholds in `config.Thresholds`.
Nothing is calibrated against real pedal or amp settings, and no label is a judgement of
good or bad tone. Measurements describe the recording, not the player's technique.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

from .audio import frame_rms_db
from .config import CLICK_BAND, SR, Thresholds
from .transcribe import Note

FRAME_HOP = 256
CAVEAT = ("Tone check labels are uncalibrated heuristics from signal measurements. They describe this recording, "
          "not your pedal settings, and they are not a quality score.")


def _no_click(y: np.ndarray, sr: int) -> np.ndarray:
    sos = signal.butter(4, CLICK_BAND, btype="bandstop", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, y).astype(np.float32)


def _harmonic_ratio_db(y: np.ndarray, sr: int, note: Note) -> float | None:
    """Energy in harmonics 5-20 relative to harmonics 1-4 during the note's steady part."""
    if note.midi_float is None:
        return None
    a = int((note.onset_s + 0.05) * sr)
    b = int(min(note.offset_s, note.onset_s + 0.3) * sr)
    if b - a < int(0.08 * sr):
        return None
    seg = y[a:b] * np.hanning(b - a)
    nfft = max(8192, 1 << int(np.ceil(np.log2(b - a))))
    spec = np.abs(np.fft.rfft(seg, n=nfft)) ** 2
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    f0 = 440.0 * 2 ** ((note.midi_float - 69) / 12)
    width = max(f0 * 0.06, 6.0)

    def band(k: int) -> float:
        fk = k * f0
        if fk + width >= sr / 2 or (CLICK_BAND[0] - width < fk < CLICK_BAND[1] + width):
            return 0.0
        return float(spec[(freqs > fk - width) & (freqs < fk + width)].sum())

    low = sum(band(k) for k in range(1, 5))
    high = sum(band(k) for k in range(5, 21))
    if low <= 0:
        return None
    return float(10 * np.log10(high / low + 1e-12))


def _hum(y: np.ndarray, sr: int, a: int, b: int, prominence_db: float) -> int | None:
    """50 or 60 Hz mains hum in a quiet stretch: harmonic peaks well above neighbouring bins."""
    if b - a < int(0.8 * sr):
        return None
    seg = y[a:b] * np.hanning(b - a)
    n = 1 << int(np.ceil(np.log2(b - a)))
    spec = 10 * np.log10(np.abs(np.fft.rfft(seg, n=n)) ** 2 + 1e-20)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    best: tuple[float, int] | None = None
    for mains in (50, 60):
        scores = []
        for k in (1, 2, 3):
            f = mains * k
            peak = spec[(freqs > f - 2) & (freqs < f + 2)]
            ref = spec[((freqs > f - 15) & (freqs < f - 5)) | ((freqs > f + 5) & (freqs < f + 15))]
            if len(peak) and len(ref):
                scores.append(float(peak.max() - np.median(ref)))
        if scores and max(scores) >= prominence_db and (best is None or max(scores) > best[0]):
            best = (max(scores), mains)
    return None if best is None else best[1]


def tone_check(y: np.ndarray, raw: np.ndarray, notes: list[Note], th: Thresholds, *,
               input_profile: str = "mic", quiet_until_s: float | None = None, sr: int = SR) -> dict:
    """Describe drive, dynamics, brightness, noise and level. Returns a JSON-ready dict.

    Delay/reverb are not detected: on test signals an echo detector could not tell repeats
    from the played rhythm reliably, so processor-mode advice mentions them instead.
    """
    yc = _no_click(y, sr)
    rms = frame_rms_db(yc, hop=FRAME_HOP)
    hop_s = FRAME_HOP / sr
    peak = float(np.max(np.abs(raw))) if len(raw) else 0.0
    peak_dbfs = float(20 * np.log10(max(peak, 1e-10)))
    signal_db = float(np.percentile(rms, 95)) if len(rms) else -120.0
    if quiet_until_s and quiet_until_s > 0.8:
        a, b = int(0.2 / hop_s), int((quiet_until_s - 0.2) / hop_s)
        noise_db = float(np.median(rms[a:b])) if b > a else float(np.percentile(rms, 10))
        quiet = (int(0.2 * sr), int((quiet_until_s - 0.2) * sr))
    else:
        noise_db = float(np.percentile(rms, 10)) if len(rms) else -120.0
        quiet = None
    active = rms > max(noise_db + 10, signal_db - 30)
    active_rms_db = float(10 * np.log10(np.mean(10 ** (rms[active] / 10)) + 1e-20)) if active.any() else None
    crest = None if active_rms_db is None else peak_dbfs - active_rms_db

    centroid = None
    if active.any():
        spec_c = np.abs(signal.stft(yc, fs=sr, nperseg=1024, noverlap=1024 - FRAME_HOP)[2]) ** 2
        freqs = np.fft.rfftfreq(1024, 1 / sr)
        cent = (freqs[:, None] * spec_c).sum(axis=0) / (spec_c.sum(axis=0) + 1e-20)
        n = min(len(cent), len(active))
        if active[:n].any():
            centroid = float(np.median(cent[:n][active[:n]]))

    pitched = [n for n in notes if n.midi_float is not None and n.source.startswith("attack")]
    ratios = [r for r in (_harmonic_ratio_db(yc, sr, n) for n in pitched) if r is not None]
    harmonic_ratio = float(np.median(ratios)) if ratios else None
    attacks = [n.attack_db for n in pitched if np.isfinite(n.attack_db)]
    attack_spread = float(np.std(attacks)) if len(attacks) >= 4 else None
    decays = [n.decay_db for n in pitched if n.decay_db is not None]
    decay = float(np.median(decays)) if len(decays) >= 3 else None

    hum = _hum(yc, sr, *quiet, th.tone_hum_prominence_db) if quiet and noise_db > th.tone_gate_floor_dbfs else None

    metrics = {
        "peak_dbfs": round(peak_dbfs, 1),
        "active_rms_dbfs": None if active_rms_db is None else round(active_rms_db, 1),
        "crest_db": None if crest is None else round(crest, 1),
        "noise_floor_dbfs": round(noise_db, 1),
        "centroid_hz": None if centroid is None else round(centroid),
        "harmonic_ratio_db": None if harmonic_ratio is None else round(harmonic_ratio, 1),
        "attack_spread_db": None if attack_spread is None else round(attack_spread, 1),
        "decay_db_200ms": None if decay is None else round(decay, 1),
        "hum_hz": hum,
        "notes_measured": len(ratios),
    }
    traits: list[dict] = []
    advice: list[str] = []
    direct = input_profile == "direct"

    def trait(code: str, label: str, detail: str, attention: bool = False) -> None:
        traits.append({"code": code, "label": label, "detail": detail, "attention": attention})

    if peak_dbfs >= th.tone_level_hot_dbfs:
        trait("level_hot", "Level: very hot", f"Peaks reach {peak_dbfs:.1f} dBFS, at or near digital full scale.", True)
        advice.append("Lower the processor's output/USB level or the patch volume until peaks sit around -6 dBFS."
                      if direct else "Lower the amp volume or move the mic back until peaks sit around -6 dBFS.")
    elif peak_dbfs < th.tone_level_low_dbfs:
        trait("level_low", "Level: low", f"Peaks only reach {peak_dbfs:.1f} dBFS.", True)
        advice.append("Raise the processor's output/USB level or patch volume (aim for peaks around -12 to -6 dBFS)."
                      if direct else "Raise the amp volume or move the mic closer (aim for peaks around -12 to -6 dBFS).")
    else:
        trait("level_ok", "Level: healthy", f"Peaks reach {peak_dbfs:.1f} dBFS with headroom.")

    # Harmonic ratio alone under-reads saturation, so a squashed and sustained envelope also counts.
    flat = crest is not None and decay is not None
    if harmonic_ratio is not None or flat:
        ratio_txt = (f"Upper harmonics are {harmonic_ratio:+.0f} dB relative to the first four"
                     if harmonic_ratio is not None else "Harmonic content could not be measured")
        env_txt = f"; peak-to-average {crest:.0f} dB, {decay:.1f} dB decay in 200 ms." if flat else "."
        heavy = ((harmonic_ratio is not None and harmonic_ratio >= th.tone_drive_heavy_ratio_db)
                 or (flat and crest <= th.tone_drive_heavy_crest_db and decay <= th.tone_drive_heavy_decay_db))
        light = ((harmonic_ratio is not None and harmonic_ratio >= th.tone_drive_light_ratio_db)
                 or (crest is not None and crest <= th.tone_drive_light_crest_db))
        if heavy:
            trait("drive_heavy", "Drive: heavy (likely distortion/fuzz)", ratio_txt + env_txt)
        elif light:
            trait("drive_light", "Drive: light to medium (likely overdrive/crunch)", ratio_txt + env_txt)
        else:
            trait("drive_clean", "Drive: clean or edge-of-breakup", ratio_txt + env_txt)

    squashed = crest is not None and crest <= th.tone_compressed_crest_db
    even = attack_spread is not None and attack_spread <= th.tone_compressed_attack_spread_db
    if squashed and (even or attack_spread is None):
        trait("compressed", "Dynamics: heavily compressed or saturated",
              f"Peak-to-average ratio is {crest:.0f} dB" + (f" and note attacks vary by only {attack_spread:.1f} dB." if even else "."))
        advice.append("Compression and gain hide picking dynamics, so dynamics findings are less meaningful on this tone.")
    elif crest is not None:
        trait("dynamic", "Dynamics: open", f"Peak-to-average ratio is {crest:.0f} dB"
              + (f"; note attacks vary by {attack_spread:.1f} dB." if attack_spread is not None else "."))

    if centroid is not None:
        if centroid >= th.tone_bright_centroid_hz:
            trait("bright", "Brightness: bright", f"Spectral centroid is about {centroid:.0f} Hz.")
        elif centroid <= th.tone_dark_centroid_hz:
            trait("dark", "Brightness: dark", f"Spectral centroid is about {centroid:.0f} Hz.")
        else:
            trait("balanced", "Brightness: balanced", f"Spectral centroid is about {centroid:.0f} Hz.")

    if noise_db <= th.tone_gate_floor_dbfs:
        trait("gated", "Noise: very low floor (noise gate likely on)",
              f"Between notes the signal drops to {noise_db:.0f} dBFS.")
        advice.append("If quiet notes or tails get cut off, lower the noise-gate threshold on the processor.")
    elif hum is not None:
        trait("hum", f"Noise: mains hum at {hum} Hz", "Hum peaks stand out in the silence before you play.", True)
        advice.append("Hum often comes from single-coil pickups, ground loops or a shared power supply; "
                      "try a different outlet/USB port, turn away from the computer screen, or enable the gate.")
    elif signal_db - noise_db < th.snr_degraded_db:
        trait("noisy", "Noise: noticeable", f"Signal is only {signal_db - noise_db:.0f} dB above the noise floor.", True)
        advice.append("High-gain patches amplify pickup and cable noise; a noise gate or a little less gain helps.")

    if direct:
        advice.append("Delay and reverb tails can read as extra or ringing notes. For timing and note feedback, "
                      "a dry preset gives the most reliable results.")

    return {
        "experimental": True,
        "input_profile": input_profile,
        "metrics": metrics,
        "traits": traits,
        "advice": advice,
        "caveat": CAVEAT,
    }


def is_driven(tone: dict | None) -> bool:
    return bool(tone) and any(t["code"] in ("drive_heavy", "compressed") for t in tone["traits"])

