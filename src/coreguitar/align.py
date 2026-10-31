"""Align detected notes to the reference (edit-distance DP with timing costs)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Op:
    kind: str  # match | wrong | octave | unpitched | missed | extra
    ref: int | None
    det: int | None


def _pitch_cost(det_midi_f, ref_midi: int, offset: float) -> tuple[float, str]:
    if det_midi_f is None:
        return 0.9, "unpitched"
    q = int(round(det_midi_f - offset))
    if q == ref_midi:
        return 0.0, "match"
    if abs(q - ref_midi) == 12:
        return 0.6, "octave"
    return 1.1, "wrong"


def align(ref_midi: list[int], ref_t: list[float], det_midi_f: list, det_t: list[float], det_conf: list[float],
          beat_s: float, offset: float = 0.0) -> list[Op]:
    n, m = len(ref_midi), len(det_t)
    INF = 1e9
    cost = np.full((n + 1, m + 1), INF)
    back = np.zeros((n + 1, m + 1), dtype=np.int8)  # 1 diag, 2 up (missed), 3 left (extra)
    cost[0, 0] = 0.0
    ins = [0.6 + 0.4 * c for c in det_conf]
    for i in range(n + 1):
        for j in range(m + 1):
            if i == 0 and j == 0:
                continue
            best, how = INF, 0
            if i > 0 and j > 0:
                pc, _ = _pitch_cost(det_midi_f[j - 1], ref_midi[i - 1], offset)
                tc = 0.6 * min(abs(det_t[j - 1] - ref_t[i - 1]) / beat_s, 2.0)
                c = cost[i - 1, j - 1] + pc + tc
                if c < best:
                    best, how = c, 1
            if i > 0 and cost[i - 1, j] + 1.0 < best:
                best, how = cost[i - 1, j] + 1.0, 2
            if j > 0 and cost[i, j - 1] + ins[j - 1] < best:
                best, how = cost[i, j - 1] + ins[j - 1], 3
            cost[i, j], back[i, j] = best, how
    ops: list[Op] = []
    i, j = n, m
    while i > 0 or j > 0:
        how = back[i, j]
        if how == 1:
            _, kind = _pitch_cost(det_midi_f[j - 1], ref_midi[i - 1], offset)
            ops.append(Op(kind, i - 1, j - 1))
            i, j = i - 1, j - 1
        elif how == 2:
            ops.append(Op("missed", i - 1, None))
            i -= 1
        else:
            ops.append(Op("extra", None, j - 1))
            j -= 1
    return ops[::-1]


def estimate_offset(ops: list[Op], ref_midi: list[int], det_midi_f: list) -> tuple[float, float, int]:
    """Median and IQR of (detected - reference) semitones over paired notes."""
    diffs = [
        det_midi_f[o.det] - ref_midi[o.ref]
        for o in ops
        if o.ref is not None and o.det is not None and det_midi_f[o.det] is not None
        and abs(det_midi_f[o.det] - ref_midi[o.ref]) < 2.6
    ]
    if not diffs:
        return 0.0, 0.0, 0
    q75, q25 = np.percentile(diffs, [75, 25])
    return float(np.median(diffs)), float(q75 - q25), len(diffs)
