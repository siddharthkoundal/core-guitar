"""Synthetic guitar-like takes with known ground truth.

Used for automated acceptance tests and demos. This is additive synthesis,
not a realistic guitar model, so passing tests on synthetic audio only proves
the algorithm logic; real-recording accuracy comes from M0 evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import signal

from .clicktrack import click_track
from .config import LEAD_SILENCE_S
from .music import midi_to_hz
from .reference import Exercise


def pluck(midi: float, dur: float, sr: int, amp: float = 0.4, seed: int = 0, buzz: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(max(dur, 0.02) * sr)
    t = np.arange(n) / sr
    f0 = midi_to_hz(midi)
    y = np.zeros(n)
    k = 1
    while k <= 20 and k * f0 < 0.45 * sr:
        partial = k * f0 * np.sqrt(1 + 1e-4 * k * k)
        y += (1.0 / k**1.1) * np.exp(-(1.2 + 0.5 * k) * t) * np.sin(2 * np.pi * partial * t + rng.uniform(0, 6.28))
        k += 1
    # Normalise energy over the first 60 ms (peak depends on random partial phases).
    y /= 3.0 * np.sqrt(np.mean(y[: max(1, int(0.06 * sr))] ** 2)) + 1e-9
    ramp = max(1, int(0.002 * sr))
    y[:ramp] *= np.linspace(0, 1, ramp)
    nb = min(n, int(0.008 * sr))
    burst = rng.standard_normal(nb) * np.exp(-np.arange(nb) / (0.002 * sr)) * 0.25
    y[:nb] += burst
    if buzz > 0:
        sos = signal.butter(4, [1600, 2900], btype="bandpass", fs=sr, output="sos")
        rattle = signal.sosfilt(sos, rng.standard_normal(n)) * np.exp(-6 * t)
        rattle *= 0.5 * (1 + np.sign(np.sin(2 * np.pi * f0 * t)))
        y += buzz * rattle / (np.max(np.abs(rattle)) + 1e-9)
    fade = min(n, int(0.012 * sr))
    y[-fade:] *= np.linspace(1, 0, fade)
    return (amp * y).astype(np.float32)


@dataclass
class TakeSpec:
    deviations_ms: dict[int, float] = field(default_factory=dict)
    wrong: dict[int, int] = field(default_factory=dict)
    missing: set[int] = field(default_factory=set)
    extra: list[tuple[int, int]] = field(default_factory=list)  # (after_ref_index, midi)
    tuning_cents: float = 0.0
    drift_ms_total: float = 0.0
    amp_overrides: dict[int, float] = field(default_factory=dict)
    buzz: dict[int, float] = field(default_factory=dict)
    ring_prev: bool = False
    chord: bool = False
    distortion_gain: float = 0.0
    click_level: float = 0.25
    snr_db: float | None = 50.0
    gain: float = 1.0
    reverb: bool = True
    seed: int = 1


def render_take(ex: Exercise, spec: TakeSpec | None = None, sr: int = 44100) -> tuple[np.ndarray, list[dict]]:
    """Return (audio, ground_truth_events)."""
    spec = spec or TakeSpec()
    beat = ex.beat_s
    start = LEAD_SILENCE_S + ex.beats_per_bar * beat
    clicks = click_track(ex.bpm, ex.total_beats, ex.beats_per_bar, sr) * spec.click_level
    out = np.zeros(len(clicks), dtype=np.float32)
    span = ex.total_beats * beat
    played = []
    for n in ex.notes:
        if n.index in spec.missing:
            continue
        nominal = start + n.start_beat * beat
        drift = spec.drift_ms_total / 1000.0 * (n.start_beat * beat / span if span else 0)
        t = nominal + drift + spec.deviations_ms.get(n.index, 0.0) / 1000.0
        played.append((t, n))
    events: list[dict] = []
    for k, (t, n) in enumerate(played):
        midi = spec.wrong.get(n.index, n.midi)
        # A note rings until the next played note, unless a rest follows it.
        written = n.dur_beats * beat
        rest_after = n.index + 1 < len(ex.notes) and ex.notes[n.index + 1].start_beat > n.start_beat + n.dur_beats + 1e-6
        if k + 1 < len(played) and not rest_after:
            dur = played[k + 1][0] - t + 0.01
        else:
            dur = written + (0.5 if k + 1 == len(played) else 0.0)
        dur += 0.4 if spec.ring_prev else 0.0
        amp = spec.amp_overrides.get(n.index, 0.4)
        y = pluck(midi + spec.tuning_cents / 100, dur, sr, amp, seed=spec.seed + n.index, buzz=spec.buzz.get(n.index, 0))
        if spec.chord:
            for iv in (4, 7):
                y = y + pluck(midi + iv + spec.tuning_cents / 100, dur, sr, amp, seed=spec.seed + 100 + iv + n.index)
        _mix(out, y, t, sr)
        events.append({"ref_index": n.index, "onset_s": t, "midi": midi})
    for after, midi in spec.extra:
        ref = ex.notes[after]
        t = start + (ref.start_beat + ref.dur_beats / 2) * beat
        _mix(out, pluck(midi, ref.dur_beats * beat / 2, sr, 0.4, seed=999 + after), t, sr)
        events.append({"ref_index": None, "onset_s": t, "midi": midi, "extra": True})

    if spec.distortion_gain > 0:
        out = np.tanh(spec.distortion_gain * out) * 0.5
    if spec.reverb:
        rng = np.random.default_rng(spec.seed)
        ir_len = int(0.25 * sr)
        ir = rng.standard_normal(ir_len) * np.exp(-np.arange(ir_len) / (0.05 * sr)) * 0.03
        ir[0] = 1.0
        out = signal.fftconvolve(out, ir)[: len(out)].astype(np.float32)
    out = out + clicks
    if spec.snr_db is not None:
        rng = np.random.default_rng(spec.seed + 7)
        sig = np.sqrt(np.mean(out[out != 0] ** 2)) if np.any(out) else 0.01
        noise = rng.standard_normal(len(out)) * sig / (10 ** (spec.snr_db / 20))
        out = out + noise.astype(np.float32)
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 0.9:
        out = out * (0.9 / peak)
    out = out * spec.gain
    if spec.gain > 1.0:
        out = np.clip(out, -1.0, 1.0)
    return out.astype(np.float32), events


def _mix(out: np.ndarray, y: np.ndarray, t: float, sr: int) -> None:
    i = int(round(t * sr))
    if i >= len(out):
        return
    j = min(len(out), i + len(y))
    out[i:j] += y[: j - i]
