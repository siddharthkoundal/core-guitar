"""Click track generation and click-grid detection.

Contract: the click WAV is LEAD_SILENCE_S of silence, one bar of count-in
clicks, then clicks continuing through the exercise plus one bar, then a
tail. Start recording BEFORE pressing play on the click track; the analyser
finds the clicks inside the recording, so playback latency doesn't matter.
With direct (USB processor) input the click isn't recorded, so the browser
supplies the click offset and `known_grid` builds the grid instead.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import signal

from .audio import click_band
from .config import CLICK_BAND, CLICK_DUR_S, CLICK_FREQ_HZ, LEAD_SILENCE_S, SR, TAIL_S


def click_waveform(sr: int = SR, accent: bool = False) -> np.ndarray:
    n = int(CLICK_DUR_S * sr)
    t = np.arange(n) / sr
    env = np.exp(-t / (CLICK_DUR_S / 4))
    # 3 ms raised-cosine attack keeps the click's energy near 4 kHz, out of the guitar band.
    ramp = max(1, int(0.003 * sr))
    env[:ramp] *= 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, ramp))
    amp = 0.9 if accent else 0.6
    return (amp * env * np.sin(2 * math.pi * CLICK_FREQ_HZ * t)).astype(np.float32)


def click_track(bpm: float, total_beats: float, beats_per_bar: int = 4, sr: int = 44100) -> np.ndarray:
    beat = 60.0 / bpm
    n_clicks = beats_per_bar + int(math.ceil(total_beats)) + beats_per_bar
    length = LEAD_SILENCE_S + n_clicks * beat + TAIL_S
    out = np.zeros(int(length * sr), dtype=np.float32)
    for k in range(n_clicks):
        start = int(round((LEAD_SILENCE_S + k * beat) * sr))
        w = click_waveform(sr, accent=(k % beats_per_bar == 0))
        out[start : start + len(w)] += w[: len(out) - start]
    return out


@dataclass
class ClickGrid:
    found: bool
    bpm_target: float
    bpm_measured: float | None = None
    period_s: float | None = None
    first_click_s: float | None = None
    clicks_s: list[float] = field(default_factory=list)
    residual_ms: float | None = None
    reason: str = ""

    def beat_time(self, k: float) -> float:
        return self.first_click_s + k * self.period_s

    def to_dict(self) -> dict:
        return {
            "found": self.found,
            "bpm_target": self.bpm_target,
            "bpm_measured": None if self.bpm_measured is None else round(self.bpm_measured, 2),
            "first_click_s": None if self.first_click_s is None else round(self.first_click_s, 4),
            "clicks_detected": len(self.clicks_s),
            "click_residual_ms": None if self.residual_ms is None else round(self.residual_ms, 2),
            "reason": self.reason,
        }


def detect_clicks(y: np.ndarray, bpm: float, sr: int = SR, min_clicks: int = 4) -> ClickGrid:
    """Matched-filter the click band, then fit a regular grid at ~bpm."""
    period = 60.0 / bpm
    band = click_band(y, sr)
    tmpl = click_band(click_waveform(sr), sr)
    corr = signal.correlate(band, tmpl, mode="valid", method="fft")
    env = np.abs(signal.hilbert(corr))
    if env.max() <= 0:
        return ClickGrid(False, bpm, reason="no click-band energy")

    noise = np.median(env) + 1e-12
    peaks, props = signal.find_peaks(env, distance=int(0.6 * period * sr), height=noise * 8)
    if len(peaks) < min_clicks:
        return ClickGrid(False, bpm, reason=f"only {len(peaks)} click-like peaks found")
    heights = props["peak_heights"]
    tonal = _is_tonal_click(y, peaks, sr, env / noise)
    peaks, heights = peaks[tonal], heights[tonal]
    if len(peaks) < min_clicks:
        return ClickGrid(False, bpm, reason="click-band energy is broadband (guitar), not the 4 kHz click")
    strong = peaks[heights >= 0.3 * np.percentile(heights, 90)]
    times = strong / sr
    if len(times) < min_clicks:
        return ClickGrid(False, bpm, reason="click peaks too weak")

    best = _fit_grid(times, period)
    if best is None:
        return ClickGrid(False, bpm, reason="clicks are not on a regular grid at the expected tempo")
    first, per, inliers, resid = best
    if len(inliers) < min_clicks:
        return ClickGrid(False, bpm, reason=f"only {len(inliers)} clicks on a regular grid")
    return ClickGrid(
        True,
        bpm,
        bpm_measured=60.0 / per,
        period_s=per,
        first_click_s=first,
        clicks_s=[float(t) for t in inliers],
        residual_ms=resid * 1000,
    )


def known_grid(bpm: float, first_click_s: float, duration_s: float) -> ClickGrid:
    """Grid for direct (USB processor) input, where the speaker click never reaches the recording.
    The browser measures when the first click played relative to the first recorded sample."""
    period = 60.0 / bpm
    n = max(0, int((duration_s - first_click_s) / period) + 1)
    return ClickGrid(
        True,
        bpm,
        bpm_measured=bpm,
        period_s=period,
        first_click_s=first_click_s,
        clicks_s=[first_click_s + k * period for k in range(n)],
        reason="direct input: click time measured on the browser audio clock",
    )


def _band_mf_score(y: np.ndarray, sr: int, f: float) -> np.ndarray:
    """Matched-filter envelope for a click-shaped tone at f, normalised by its median."""
    n = int(CLICK_DUR_S * sr)
    t = np.arange(n) / sr
    tmpl = np.exp(-t / (CLICK_DUR_S / 4)) * np.sin(2 * math.pi * f * t)
    sos = signal.butter(4, [f - 600, f + 600], btype="bandpass", fs=sr, output="sos")
    corr = signal.correlate(signal.sosfiltfilt(sos, y), signal.sosfiltfilt(sos, tmpl), mode="valid", method="fft")
    env = np.abs(signal.hilbert(corr))
    return env / (np.median(env) + 1e-12)


def _is_tonal_click(y: np.ndarray, peaks: np.ndarray, sr: int, click_score: np.ndarray, min_ratio: float = 2.0) -> np.ndarray:
    """The click is a 4 kHz tone; pick attacks are broadband. Keep peaks that stand
    out (relative to each band's own noise) much more in the click band than in the
    neighbouring bands. Robust to stationary broadband noise."""
    flanks = [_band_mf_score(y, sr, f) for f in (CLICK_BAND[0] - 800, CLICK_BAND[1] + 1000)]
    w = int(0.01 * sr)
    keep = np.zeros(len(peaks), dtype=bool)
    for i, p in enumerate(peaks):
        other = max(float(fl[max(0, p - w) : p + w + 1].max(initial=0.0)) for fl in flanks)
        keep[i] = click_score[p] >= min_ratio * max(other, 1.0)
    return keep


def _fit_grid(times: np.ndarray, period: float, tol: float = 0.015):
    best = None
    for anchor in times[: min(len(times), 8)]:
        k = np.round((times - anchor) / period)
        ok = (np.abs(times - (anchor + k * period)) < tol) & (k >= 0)
        if ok.sum() < 2:
            continue
        kk, tt = k[ok], times[ok]
        kk, idx = np.unique(kk, return_index=True)
        tt = tt[idx]
        if len(kk) < 2:
            continue
        per, first = np.polyfit(kk, tt, 1)
        if abs(per / period - 1) > 0.02:
            continue
        resid = float(np.std(tt - (first + per * kk)))
        score = (len(kk), -resid)
        if best is None or score > best[0]:
            best = (score, (first, per, tt, resid))
    return None if best is None else best[1]
