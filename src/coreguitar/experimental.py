"""Experimental detectors: unintended ringing and fret buzz.

These are heuristics with NO validation yet. Their confidence is always
capped and they are never used as top-3 corrections. M0 labelled takes decide
whether they are kept, tuned, or removed.
"""

from __future__ import annotations

import numpy as np

from .music import TUNINGS, midi_to_hz, midi_to_name
from .transcribe import Note


def _spectrum(yg: np.ndarray, sr: int, a: float, b: float):
    seg = yg[int(a * sr) : int(b * sr)]
    if len(seg) < 1024:
        return None, None
    n_fft = 1 << int(np.ceil(np.log2(max(len(seg), 4096))))
    p = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n_fft)) ** 2
    return np.fft.rfftfreq(n_fft, 1 / sr), p


def _comb(freqs: np.ndarray, f0: float, kmax: int, fmax: float = 3000.0, min_w: float = 4.0) -> np.ndarray:
    mask = np.zeros(len(freqs), dtype=bool)
    k = 1
    while k <= kmax and k * f0 <= fmax:
        mask |= np.abs(freqs - k * f0) <= max(min_w, 0.025 * k * f0)
        k += 1
    return mask


def ringing(yg: np.ndarray, sr: int, notes: list[Note], tuning: str, rel_db: float) -> list[dict]:
    out = []
    open_strings = TUNINGS[tuning]
    pitched = [n for n in notes if n.midi is not None]
    for i, n in enumerate(pitched):
        nxt = pitched[i + 1].onset_s if i + 1 < len(pitched) else n.onset_s + 0.4
        a, b = n.onset_s + 0.08, min(nxt, n.onset_s + 0.3)
        if b - a < 0.08:
            continue
        freqs, p = _spectrum(yg, sr, a, b)
        if freqs is None:
            continue
        # Hann main-lobe half width is 2/T; partials closer than that can't be separated.
        lobe = 2.0 / (b - a)
        cur = _comb(freqs, midi_to_hz(n.midi_float), 12, min_w=lobe)
        cur_wide = _comb(freqs, midi_to_hz(n.midi_float), 40, min_w=1.5 * lobe)
        cur_e = p[cur].sum() + 1e-20
        candidates = []
        if i > 0 and (pitched[i - 1].midi - n.midi) % 12 not in (0, 5, 7):
            candidates.append(("previous note", pitched[i - 1].midi))
        for s in open_strings:
            if (s - n.midi) % 12 not in (0, 5, 7) and (i == 0 or s != pitched[i - 1].midi):
                candidates.append(("open string", s))
        for label, m in candidates:
            mask = _comb(freqs, midi_to_hz(m), 3, min_w=lobe) & ~cur_wide
            if not mask.any():
                continue
            rel = 10 * np.log10(p[mask].sum() / cur_e + 1e-20)
            if rel > rel_db:
                out.append({"note": n, "source": label, "ringing_midi": m, "ringing_name": midi_to_name(m), "rel_db": round(float(rel), 1)})
                break
    return out


def buzz(yg: np.ndarray, sr: int, notes: list[Note], excess_db: float) -> list[dict]:
    ratios = []
    for n in notes:
        if n.midi is None:
            continue
        nxt_cap = min(n.offset_s, n.onset_s + 0.15)
        freqs, p = _spectrum(yg, sr, n.onset_s + 0.02, nxt_cap)
        if freqs is None:
            continue
        band = (freqs >= 1500) & (freqs <= 2900)
        harm = _comb(freqs, midi_to_hz(n.midi_float), 40)
        h = p[band & harm].sum() + 1e-20
        x = p[band & ~harm].sum() + 1e-20
        ratios.append((n, 10 * np.log10(x / h)))
    if len(ratios) < 4:
        return []
    med = float(np.median([r for _, r in ratios]))
    return [
        {"note": n, "inharmonic_db": round(float(r), 1), "excess_db": round(float(r - med), 1)}
        for n, r in ratios
        if r - med >= excess_db and r > -10
    ]
