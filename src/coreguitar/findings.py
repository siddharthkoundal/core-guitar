"""Turn measurements into findings. Each finding is an observation with
measured values, a time range (audio evidence) and a confidence."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from . import experimental
from .align import Op, align, estimate_offset
from .clicktrack import ClickGrid
from .config import Thresholds
from .music import midi_to_name
from .quality import Quality
from .reference import Exercise
from .transcribe import Note


def conf_label(c: float) -> str:
    return "high" if c >= 0.75 else "medium" if c >= 0.5 else "low"


def ts(t: float) -> str:
    m, s = divmod(max(t, 0.0), 60)
    return f"{int(m)}:{s:04.1f}"


@dataclass
class Finding:
    id: str
    type: str
    category: str
    severity: float
    confidence: float
    start_s: float
    end_s: float
    message: str
    measured: dict = field(default_factory=dict)
    ref_indices: list[int] = field(default_factory=list)
    det_indices: list[int] = field(default_factory=list)
    experimental: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "category": self.category,
            "severity": round(self.severity, 2),
            "confidence": round(self.confidence, 2),
            "confidence_label": conf_label(self.confidence),
            "experimental": self.experimental,
            "message": self.message,
            "measured": self.measured,
            "evidence": {
                "start_s": round(self.start_s, 3),
                "end_s": round(self.end_s, 3),
                "play_from_s": round(max(0.0, self.start_s - 0.75), 3),
                "play_to_s": round(self.end_s + 0.75, 3),
            },
            "ref_indices": self.ref_indices,
            "det_indices": self.det_indices,
        }


class Findings:
    def __init__(self) -> None:
        self.items: list[Finding] = []
        self.uncertainty: list[str] = []

    def add(self, type_: str, category: str, severity: float, confidence: float, start: float, end: float,
            message: str, **kw) -> Finding:
        f = Finding(f"f{len(self.items) + 1}", type_, category, float(np.clip(severity, 0, 1)),
                    float(np.clip(confidence, 0, 1)), float(start), float(end), message, **kw)
        self.items.append(f)
        return f

    def note(self, text: str) -> None:
        if text not in self.uncertainty:
            self.uncertainty.append(text)


def _where(ex: Exercise, i: int, t: float) -> str:
    n = ex.notes[i]
    beat = int(n.beat_in_bar) if float(n.beat_in_bar).is_integer() else n.beat_in_bar
    return f"bar {n.bar}, beat {beat} ({ts(t)})"


def _runs(items: list[tuple[int, float]], gap: int = 1) -> list[list[tuple[int, float]]]:
    """Group (ref_index, value) by consecutive ref index and same sign."""
    runs: list[list[tuple[int, float]]] = []
    for it in items:
        if runs and it[0] - runs[-1][-1][0] <= gap and np.sign(it[1]) == np.sign(runs[-1][-1][1]):
            runs[-1].append(it)
        else:
            runs.append([it])
    return runs


# ---------------------------------------------------------------------------
# Reference mode
# ---------------------------------------------------------------------------

def _detrend_by_pitch(vals: np.ndarray, midi: np.ndarray) -> np.ndarray:
    if len(vals) >= 6 and np.ptp(midi) >= 5:
        slope, icpt = np.polyfit(midi, vals, 1)
        return vals - (slope * midi + icpt) + float(np.median(vals))
    return vals


def analyze_reference(ex: Exercise, grid: ClickGrid, notes: list[Note], quality: Quality, th: Thresholds,
                      yg: np.ndarray, sr: int, audio_dur: float) -> tuple[Findings, list[dict], dict]:
    F = Findings()
    qf = quality.confidence_factor(th)
    beat = grid.period_s
    ref_t = [grid.beat_time(ex.beats_per_bar + n.start_beat) for n in ex.notes]
    covered = [t for t in ref_t if t < audio_dur - 0.15]
    if len(covered) < len(ref_t):
        F.note(f"The recording ends before the exercise finishes; the last {len(ref_t) - len(covered)} "
               "reference notes were not analysed.")
        if len(covered) < 2:
            F.note("The recording stops before the exercise starts.")
            return F, [], {"notes_expected": len(ex.notes), "notes_detected": len(notes)}
        ex = replace(ex, notes=ex.notes[: len(covered)])
        ref_t = covered
    ref_midi = [n.midi for n in ex.notes]
    det_mf = [n.midi_float for n in notes]
    det_t = [n.onset_s for n in notes]
    det_c = [n.confidence for n in notes]

    # Fast passages: onsets may merge, so findings there get less confidence.
    fast = []
    for i in range(len(ref_t)):
        gaps = [ref_t[i] - ref_t[i - 1]] if i > 0 else []
        gaps += [ref_t[i + 1] - ref_t[i]] if i + 1 < len(ref_t) else []
        fast.append(bool(gaps) and min(gaps) < th.min_reliable_ioi_s)
    if any(fast):
        F.note(f"Some notes are less than {th.min_reliable_ioi_s * 1000:.0f} ms apart; note detection there is less reliable.")

    ops = align(ref_midi, ref_t, det_mf, det_t, det_c, beat, 0.0)
    off, iqr, cnt = estimate_offset(ops, ref_midi, det_mf)
    offset_used = 0.0
    if cnt >= 4 and iqr < 0.3:
        semis = int(round(off))
        if abs(off) >= 0.75 and abs(off - semis) < 0.35:
            offset_used = off
            F.add("transposition", "tuning", 1.0, 0.85 * qf, ref_t[0], ref_t[-1],
                  f"Nearly all notes are about {abs(semis)} semitone{'s' if abs(semis) > 1 else ''} "
                  f"{'lower' if semis < 0 else 'higher'} than the reference (tuning selected: {ex.tuning}).",
                  measured={"median_offset_semitones": round(off, 2), "paired_notes": cnt})
        elif abs(off) <= 0.7:
            offset_used = off
            if abs(off) * 100 >= th.tuning_offset_report_cents:
                F.add("tuning_offset", "tuning", min(1.0, 0.4 + abs(off)), 0.85 * qf, ref_t[0], ref_t[-1],
                      f"The guitar sounds about {abs(off) * 100:.0f} cents {'flat' if off < 0 else 'sharp'} overall "
                      f"(measured across {cnt} notes). This is treated as tuning, not as wrong notes.",
                      measured={"median_offset_cents": round(off * 100, 1), "paired_notes": cnt})
    if offset_used:
        ops = align(ref_midi, ref_t, det_mf, det_t, det_c, beat, offset_used)

    rows = _note_rows(ex, notes, ops, ref_t, offset_used)
    _note_findings(F, ex, notes, ops, ref_t, fast, qf, offset_used)
    timing = _timing_findings(F, ex, grid, notes, ops, ref_t, fast, qf, th)
    _pitch_dynamics_findings(F, ex, notes, ops, ref_t, qf, th, offset_used)
    _experimental_findings(F, yg, sr, notes, ex.tuning, th, ops, ex)

    counts = {k: sum(1 for o in ops if o.kind == k) for k in ("match", "wrong", "octave", "unpitched", "missed", "extra")}
    summary = {
        "notes_expected": len(ex.notes),
        "notes_detected": len(notes),
        "alignment": counts,
        "note_accuracy": round(counts["match"] / len(ex.notes), 3),
        "tuning_offset_cents": round(offset_used * 100, 1),
        **timing,
    }
    return F, rows, summary


def _note_rows(ex, notes, ops, ref_t, offset):
    rows = []
    for o in ops:
        r = ex.notes[o.ref] if o.ref is not None else None
        d = notes[o.det] if o.det is not None else None
        rows.append({
            "status": o.kind,
            "ref_index": o.ref,
            "expected": r.name if r else None,
            "expected_s": round(ref_t[o.ref], 4) if r else None,
            "bar": r.bar if r else None,
            "beat": r.beat_in_bar if r else None,
            "det_index": o.det,
            "played": d.name if d else None,
            "onset_s": round(d.onset_s, 4) if d else None,
            "timing_ms": round((d.onset_s - ref_t[o.ref]) * 1000, 1) if (d and r) else None,
            "cents": round((d.midi_float - offset - r.midi) * 100, 1)
            if (d and r and d.midi_float is not None and o.kind == "match") else None,
            "confidence": d.confidence if d else None,
        })
    return rows


def _note_findings(F, ex, notes, ops, ref_t, fast, qf, offset):
    paired_det = {o.det for o in ops if o.det is not None and o.ref is not None}
    for o in ops:
        ff = 0.6 if (o.ref is not None and fast[o.ref]) else 1.0
        if o.kind == "wrong":
            d, r = notes[o.det], ex.notes[o.ref]
            q = int(round(d.midi_float - offset))
            diff = q - r.midi
            F.add("wrong_note", "notes", 0.9, d.confidence * qf * ff, d.onset_s, d.offset_s,
                  f"{_where(ex, o.ref, d.onset_s)}: expected {r.name}, heard {midi_to_name(q)} "
                  f"({'+' if diff > 0 else ''}{diff} semitone{'s' if abs(diff) != 1 else ''}).",
                  measured={"expected": r.name, "heard": midi_to_name(q), "semitones": diff},
                  ref_indices=[o.ref], det_indices=[o.det])
        elif o.kind == "octave":
            d, r = notes[o.det], ex.notes[o.ref]
            F.add("octave_ambiguous", "notes", 0.3, 0.35 * qf, d.onset_s, d.offset_s,
                  f"{_where(ex, o.ref, d.onset_s)}: heard {d.name}, an octave from the expected {r.name}. "
                  "This is often a pitch-detection octave error rather than a playing error.",
                  measured={"expected": r.name, "heard": d.name}, ref_indices=[o.ref], det_indices=[o.det])
        elif o.kind == "unpitched":
            d, r = notes[o.det], ex.notes[o.ref]
            F.add("muted_note", "notes", 0.6, 0.6 * qf * ff, d.onset_s, d.offset_s,
                  f"{_where(ex, o.ref, d.onset_s)}: an attack was heard where {r.name} was expected, "
                  "but it had no clear pitch (muted or dead note?).",
                  measured={"expected": r.name}, ref_indices=[o.ref], det_indices=[o.det])
        elif o.kind == "missed":
            r = ex.notes[o.ref]
            t = ref_t[o.ref]
            F.add("missed_note", "notes", 0.9, 0.8 * qf * ff, t - 0.05, t + 0.25,
                  f"{_where(ex, o.ref, t)}: expected {r.name}, but no note was detected there.",
                  measured={"expected": r.name}, ref_indices=[o.ref])
        elif o.kind == "extra":
            d = notes[o.det]
            near_same = any(
                j in paired_det and notes[j].midi == d.midi and abs(notes[j].onset_s - d.onset_s) < 0.1
                for j in range(max(0, o.det - 1), min(len(notes), o.det + 2)) if j != o.det
            )
            label = d.name or "an unpitched sound"
            msg = (f"Extra attack on {label} at {ts(d.onset_s)}, right next to the intended note (double pick?)."
                   if near_same else f"Extra note {label} at {ts(d.onset_s)} that isn't in the reference.")
            conf = d.confidence * 0.9 * qf * (1.0 if d.source == "attack" else 0.7) * (0.7 if near_same else 1.0)
            F.add("extra_note", "notes", 0.7, conf, d.onset_s, d.offset_s, msg,
                  measured={"heard": d.name, "double_attack": near_same}, det_indices=[o.det])


def _timing_findings(F, ex, grid, notes, ops, ref_t, fast, qf, th) -> dict:
    pairs = [o for o in ops if o.ref is not None and o.det is not None]
    if len(pairs) < 3:
        F.note("Too few matched notes to assess timing.")
        return {"timing": None}
    tol, unc = th.timing_tolerance_ms, th.timing_uncertainty_ms
    t = np.array([ref_t[o.ref] for o in pairs])
    dev = np.array([(notes[o.det].onset_s - ref_t[o.ref]) * 1000 for o in pairs])
    beat_ms = grid.period_s * 1000
    resid = dev.copy()
    stats = {
        "timing": {
            "mean_ms": round(float(dev.mean()), 1),
            "median_ms": round(float(np.median(dev)), 1),
            "mean_abs_ms": round(float(np.abs(dev).mean()), 1),
            "std_ms": round(float(dev.std()), 1),
            "within_tolerance_pct": round(float(np.mean(np.abs(dev) < tol) * 100), 1),
            "tolerance_ms": tol,
            "assumed_measurement_uncertainty_ms": unc,
        }
    }
    med = float(np.median(dev))
    if abs(med) > 0.4 * beat_ms:
        F.add("timing_offset", "timing", 1.0, 0.8 * qf, t[0], t[-1],
              f"The whole take is shifted by about {med / beat_ms:+.1f} beats against the click. "
              f"Did you start {'late' if med > 0 else 'early'}? The count-in is {ex.beats_per_bar} clicks; start on the next one.",
              measured={"median_ms": round(med, 1), "beats": round(med / beat_ms, 2)})
        resid = dev - med
        med = 0.0

    trend = None
    if len(pairs) >= th.drift_min_notes:
        b, a = np.polyfit(t, resid, 1)
        fit = a + b * t
        ss_res = float(((resid - fit) ** 2).sum())
        ss_tot = float(((resid - resid.mean()) ** 2).sum()) + 1e-9
        r2 = 1 - ss_res / ss_tot
        total = float(b * (t[-1] - t[0]))
        if r2 >= th.drift_min_r2 and abs(total) >= 2 * tol:
            rushing = total < 0
            played_bpm = ex.bpm / (1 + b / 1000.0)
            trend = F.add(
                "timing_drift_rushing" if rushing else "timing_drift_dragging", "timing", 0.8,
                min(0.9, 0.5 + 0.4 * r2) * qf, t[0], t[-1],
                f"Gradual {'speed-up' if rushing else 'slow-down'} through the take: notes moved from "
                f"{fit[0]:+.0f} ms to {fit[-1]:+.0f} ms relative to the click "
                f"(average played tempo about {played_bpm:.0f} BPM vs target {ex.bpm:.0f}).",
                measured={"start_ms": round(float(fit[0]), 1), "end_ms": round(float(fit[-1]), 1),
                          "r2": round(r2, 2), "played_bpm": round(played_bpm, 1)},
            )
            resid = resid - fit
    if trend is None and abs(med) >= tol and np.mean(np.sign(dev) == np.sign(med)) >= 0.75:
        F.add("timing_offset", "timing", min(1.0, abs(med) / (3 * tol)), (0.85 if abs(med) >= tol + unc else 0.5) * qf,
              t[0], t[-1],
              f"Notes are consistently {'behind' if med > 0 else 'ahead of'} the click by about {abs(med):.0f} ms.",
              measured={"median_ms": round(med, 1)})
        resid = resid - med

    flagged = [(o.ref, float(r)) for o, r in zip(pairs, resid) if abs(r) >= tol]
    det_of = {o.ref: o.det for o in pairs}
    for run in _runs(flagged):
        idx = [i for i, _ in run]
        vals = np.array([v for _, v in run])
        mean = float(vals.mean())
        late = mean > 0
        per = []
        for i, v in run:
            c = 0.85 if abs(v) >= tol + unc else 0.45
            c *= 1.0 if notes[det_of[i]].source == "attack" else 0.6
            rise = notes[det_of[i]].attack_rise_db
            c *= 0.5 if rise is None or rise < th.reliable_attack_rise_db else 1.0
            c *= 0.6 if fast[i] else 1.0
            per.append(c)
        start, end = ref_t[idx[0]], ref_t[idx[-1]] + 0.15
        span = _where(ex, idx[0], start) if len(idx) == 1 else (
            f"bar {ex.notes[idx[0]].bar} beat {ex.notes[idx[0]].beat_in_bar:g} to bar {ex.notes[idx[-1]].bar} "
            f"beat {ex.notes[idx[-1]].beat_in_bar:g} ({ts(start)}-{ts(end)})")
        names = ", ".join(ex.notes[i].name for i in idx)
        F.add("timing_late" if late else "timing_early", "timing",
              min(1.0, abs(mean) / (3 * tol)) * (0.7 + 0.1 * min(len(idx), 3)), float(np.mean(per)) * qf, start, end,
              f"{span}: {len(idx)} note{'s' if len(idx) > 1 else ''} ({names}) {'late' if late else 'early'} "
              f"by about {abs(mean):.0f} ms" + (" relative to your overall trend." if trend is not None else "."),
              measured={"deviation_ms": [round(v, 1) for v in vals], "mean_ms": round(mean, 1)},
              ref_indices=idx, det_indices=[det_of[i] for i in idx])
    if th.timing_uncertainty_ms == Thresholds().timing_uncertainty_ms:
        F.note(f"Timing measurement uncertainty ({unc:.0f} ms) is a placeholder until M0 calibration; "
               f"deviations between {tol:.0f} and {tol + unc:.0f} ms are reported with low confidence.")
    return stats


def _pitch_dynamics_findings(F, ex, notes, ops, ref_t, qf, th, offset):
    matched = [o for o in ops if o.kind == "match"]
    off = []
    for o in matched:
        d = notes[o.det]
        if d.duration_s < 0.15 or d.midi_float is None:
            continue
        c = (d.midi_float - offset - ex.notes[o.ref].midi) * 100
        if abs(c) >= th.note_intonation_cents:
            off.append((o, c))
    if off:
        F.add("intonation", "pitch", 0.35, 0.6 * qf, notes[off[0][0].det].onset_s, notes[off[-1][0].det].offset_s,
              "Notes noticeably out of tune relative to the rest of the take: " + "; ".join(
                  f"{ex.notes[o.ref].name} at {ts(notes[o.det].onset_s)} {c:+.0f} cents" for o, c in off[:6]) + ".",
              measured={"notes": [{"ref_index": o.ref, "cents": round(c, 1)} for o, c in off]},
              ref_indices=[o.ref for o, _ in off], det_indices=[o.det for o, _ in off])

    att = [(o, notes[o.det].attack_db) for o in matched if np.isfinite(notes[o.det].attack_db)]
    if len(att) >= 4:
        # Low and high strings differ in loudness through amp+mic; judge evenness after removing that pitch trend.
        vals = _detrend_by_pitch(np.array([a for _, a in att]), np.array([ex.notes[o.ref].midi for o, _ in att]))
        att = [(o, v) for (o, _), v in zip(att, vals)]
        med, sd = float(np.median(vals)), float(vals.std())
        weak = [(o, a) for o, a in att if a < med - th.attack_weak_db]
        if weak:
            # A single pitch can be quiet because of room/amp/speaker resonances. Only claim a weak
            # pick stroke confidently when the same pitch is louder elsewhere in the take.
            by_pitch: dict[int, list[float]] = {}
            for o, a in att:
                by_pitch.setdefault(ex.notes[o.ref].midi, []).append(a)

            def same_pitch_louder(o, a) -> bool:
                others = list(by_pitch[ex.notes[o.ref].midi])
                others.remove(a)
                return bool(others) and float(np.median(others)) - a >= th.attack_weak_db

            confirmed = any(same_pitch_louder(o, a) for o, a in weak)
            msg = "Much quieter than your typical note: " + ", ".join(
                f"{ex.notes[o.ref].name} at {ts(notes[o.det].onset_s)} ({a - med:+.0f} dB)" for o, a in weak[:6]) + "."
            if not confirmed:
                msg += (" These pitches only appear once, so the room or amp could also be the cause; "
                        "listen back before working on it.")
            F.add("weak_attack", "dynamics", 0.45, (0.6 if confirmed else 0.4) * qf,
                  notes[weak[0][0].det].onset_s, notes[weak[-1][0].det].offset_s, msg,
                  measured={"pitch_detrended": True, "same_pitch_confirmed": confirmed,
                            "notes": [{"ref_index": o.ref, "rel_db": round(a - med, 1)} for o, a in weak]},
                  ref_indices=[o.ref for o, _ in weak], det_indices=[o.det for o, _ in weak])
        if sd > th.attack_spread_db:
            F.add("uneven_attacks", "dynamics", 0.5, 0.6 * qf, notes[att[0][0].det].onset_s, notes[att[-1][0].det].offset_s,
                  f"Note volume varies a lot across the take, beyond normal string-to-string differences "
                  f"(spread {sd:.1f} dB, loudest-to-quietest {np.ptp(vals):.0f} dB).",
                  measured={"attack_std_db": round(sd, 1), "attack_range_db": round(float(np.ptp(vals)), 1),
                            "pitch_detrended": True})

    short = []
    for o in matched:
        d, r = notes[o.det], ex.notes[o.ref]
        expected = r.dur_beats * 60.0 / ex.bpm
        nxt = notes[o.det + 1].onset_s if o.det + 1 < len(notes) else None
        gap = (nxt - d.offset_s) if nxt is not None else expected - d.duration_s
        if d.duration_s < th.cut_short_fraction * expected and gap > 0.08:
            short.append((o, d.duration_s, expected))
    if short:
        F.add("cut_short", "articulation", 0.4, 0.55 * qf, notes[short[0][0].det].onset_s, notes[short[-1][0].det].offset_s,
              "Notes that stopped well before the next one: " + ", ".join(
                  f"{ex.notes[o.ref].name} at {ts(notes[o.det].onset_s)} ({ds * 1000:.0f} of {e * 1000:.0f} ms)"
                  for o, ds, e in short[:6]) + ".",
              measured={"notes": [{"ref_index": o.ref, "sounded_ms": round(ds * 1000), "expected_ms": round(e * 1000)}
                                  for o, ds, e in short]},
              ref_indices=[o.ref for o, _, _ in short], det_indices=[o.det for o, _, _ in short])


def _experimental_findings(F, yg, sr, notes, tuning, th, ops=None, ex=None, neutral=False):
    cap = th.experimental_confidence_cap
    ref_of = {o.det: o.ref for o in (ops or []) if o.det is not None}
    for r in experimental.ringing(yg, sr, notes, tuning, th.ringing_rel_db):
        n = r["note"]
        F.add("possible_ringing", "experimental", 0.4, cap, n.onset_s, min(n.offset_s, n.onset_s + 0.4),
              f"At {ts(n.onset_s)} ({n.name}), {r['ringing_name']} ({r['source']}) seems to keep sounding underneath "
              f"({r['rel_db']:+.0f} dB relative)." + ("" if not neutral else " This may be intentional."),
              measured={"rel_db": r["rel_db"], "ringing": r["ringing_name"], "source": r["source"]},
              det_indices=[n.index], ref_indices=[ref_of[n.index]] if ref_of.get(n.index) is not None else [],
              experimental=True)
    for b in experimental.buzz(yg, sr, notes, th.buzz_excess_db):
        n = b["note"]
        F.add("possible_buzz", "experimental", 0.4, cap, n.onset_s, min(n.offset_s, n.onset_s + 0.3),
              f"At {ts(n.onset_s)} ({n.name}) there is extra noisy energy in the 1.5-3 kHz range compared with your "
              f"other notes ({b['excess_db']:+.0f} dB). This can be fret buzz.",
              measured={"inharmonic_db": b["inharmonic_db"], "excess_db": b["excess_db"]},
              det_indices=[n.index], ref_indices=[ref_of[n.index]] if ref_of.get(n.index) is not None else [],
              experimental=True)
    F.note("Ringing and buzz detectors are experimental and unvalidated; treat them as 'worth a listen', not facts.")


# ---------------------------------------------------------------------------
# Free-playing mode: describe, never judge.
# ---------------------------------------------------------------------------

def analyze_free(notes: list[Note], grid: ClickGrid | None, quality: Quality, th: Thresholds,
                 yg: np.ndarray, sr: int, tuning: str) -> tuple[Findings, dict]:
    F = Findings()
    pitched = [n for n in notes if n.midi is not None]
    on = np.array([n.onset_s for n in notes])
    desc: dict = {"notes_detected": len(notes), "pitched_notes": len(pitched)}
    if pitched:
        lo, hi = min(pitched, key=lambda n: n.midi), max(pitched, key=lambda n: n.midi)
        pcs: dict[str, int] = {}
        for n in pitched:
            k = n.name.rstrip("-0123456789")
            pcs[k] = pcs.get(k, 0) + 1
        desc["range"] = {"lowest": lo.name, "highest": hi.name, "semitones": hi.midi - lo.midi}
        desc["most_used_notes"] = sorted(pcs.items(), key=lambda kv: -kv[1])[:6]
        F.add("description_range", "description", 0, 0.8, on[0], notes[-1].offset_s,
              f"You played {len(pitched)} pitched notes from {lo.name} to {hi.name}; most used: "
              + ", ".join(f"{k} ({v})" for k, v in desc["most_used_notes"]) + ".", measured=desc["range"])
    if len(on) >= 3:
        ioi = np.diff(on)
        span = on[-1] - on[0]
        desc["notes_per_second"] = round(len(on) / span, 2) if span > 0 else None
        desc["median_gap_ms"] = round(float(np.median(ioi) * 1000))
        desc["gap_variation_cv"] = round(float(ioi.std() / ioi.mean()), 2)
        pauses = [(on[i], ioi[i]) for i in range(len(ioi)) if ioi[i] > max(0.6, 3 * np.median(ioi))]
        desc["pauses"] = [{"at_s": round(float(a), 2), "length_s": round(float(b), 2)} for a, b in pauses]
        F.add("description_rhythm", "description", 0, 0.7, on[0], notes[-1].offset_s,
              f"About {desc['notes_per_second']} notes per second; typical gap between notes {desc['median_gap_ms']} ms "
              f"(variation {desc['gap_variation_cv']:.2f}, where 0 is perfectly even). "
              + (f"{len(pauses)} longer pause{'s' if len(pauses) != 1 else ''}." if pauses else "No long pauses."),
              measured={k: desc[k] for k in ("notes_per_second", "median_gap_ms", "gap_variation_cv")})
        if grid is not None and grid.found:
            sub = grid.period_s / 2
            phase = (on - grid.first_click_s) / sub
            dev = (phase - np.round(phase)) * sub * 1000
            desc["click_alignment"] = {"within_20ms_of_eighth_grid_pct": round(float(np.mean(np.abs(dev) < 20) * 100), 1),
                                       "mean_abs_ms": round(float(np.abs(dev).mean()), 1)}
            F.add("description_click", "description", 0, 0.6, on[0], notes[-1].offset_s,
                  f"{desc['click_alignment']['within_20ms_of_eighth_grid_pct']:.0f}% of attacks fall within 20 ms of an "
                  "eighth-note position of the click (descriptive only; off-grid notes may be intentional).",
                  measured=desc["click_alignment"])
    att = np.array([n.attack_db for n in pitched if np.isfinite(n.attack_db)])
    if len(att) >= 4:
        desc["dynamics"] = {"attack_range_db": round(float(np.ptp(att)), 1), "attack_std_db": round(float(att.std()), 1)}
        F.add("description_dynamics", "description", 0, 0.6, on[0], notes[-1].offset_s,
              f"Note volumes span about {np.ptp(att):.0f} dB (spread {att.std():.1f} dB).",
              measured=desc["dynamics"])
    _experimental_findings(F, yg, sr, notes, tuning, th, neutral=True)
    F.note("Free-playing mode has no reference, so it describes what was played and never labels notes or timing as mistakes.")
    return F, desc
