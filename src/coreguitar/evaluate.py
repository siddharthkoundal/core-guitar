"""M0 evaluation: run the analyser on labelled real takes and score it.

Label file (one per take, `<name>.label.json`, paths relative to the label file):
{
  "audio": "takes/2026-11-01_mac_chromatic_80_a.wav",
  "exercise": "../exercises/chromatic_1234.json",   // omit for free mode
  "mode": "reference",                               // or "free"
  "bpm": 80, "tuning": "standard",                   // optional overrides
  "device": "macbook",                               // or "iphone"
  "expected_verdict": "ok",                          // ok|degraded|rejected|unsupported
  "errors": [                                        // [] for a correct take
    {"type": "late", "index": 5},
    {"type": "wrong_note", "index": 9},
    {"type": "missed_note", "index": 14},
    {"type": "extra_note", "after": 3},
    {"type": "rushing"}
  ],
  "onsets_file": "takes/...onsets.txt"               // optional Audacity label export
}
"""

from __future__ import annotations

import json
from pathlib import Path

import mir_eval
import numpy as np

from .analyze import analyze
from .reference import load_exercise

LABEL_TO_FINDINGS = {
    "late": ("timing_late",),
    "early": ("timing_early",),
    "wrong_note": ("wrong_note",),
    "missed_note": ("missed_note", "muted_note"),
    "muted_note": ("muted_note", "missed_note"),
    "extra_note": ("extra_note",),
    "rushing": ("timing_drift_rushing",),
    "dragging": ("timing_drift_dragging",),
    "timing_offset": ("timing_offset",),
    "tuning_offset": ("tuning_offset", "transposition"),
    "weak_attack": ("weak_attack", "uneven_attacks"),
    "cut_short": ("cut_short",),
    "buzz": ("possible_buzz",),
    "ringing": ("possible_ringing",),
}
GLOBAL_LABELS = {"rushing", "dragging", "timing_offset", "tuning_offset"}
SCORED_FINDINGS = {f for v in LABEL_TO_FINDINGS.values() for f in v}


def _matches(label: dict, f: dict, note_table: list[dict]) -> bool:
    if f["type"] not in LABEL_TO_FINDINGS.get(label["type"], ()):
        return False
    if label["type"] in GLOBAL_LABELS:
        return True
    if label["type"] == "extra_note":
        exp = {r["ref_index"]: r["expected_s"] for r in note_table if r["ref_index"] is not None}
        a = exp.get(label["after"])
        b = exp.get(label["after"] + 1, (a or 0) + 1.0)
        return a is not None and a < f["evidence"]["start_s"] < b + 0.1
    idx = label.get("index")
    return idx is not None and any(abs(i - idx) <= 1 for i in f["ref_indices"])


def _read_onsets(path: Path) -> np.ndarray:
    times = []
    for line in path.read_text().splitlines():
        parts = line.strip().split()
        if parts:
            times.append(float(parts[0]))
    return np.array(sorted(times))


def evaluate_take(label_path: Path) -> dict:
    lab = json.loads(label_path.read_text())
    base = label_path.parent
    ex = None
    if lab.get("mode", "reference") == "reference":
        ex = load_exercise(base / lab["exercise"], bpm=lab.get("bpm"), tuning=lab.get("tuning"))
    res = analyze(base / lab["audio"], ex, free_bpm=lab.get("bpm"), free_tuning=lab.get("tuning", "standard"))
    findings = [f for f in res["findings"] if f["type"] in SCORED_FINDINGS]
    labels = lab.get("errors", [])

    out = {"label_file": label_path.name, "device": lab.get("device", "unknown"), "mode": res["mode"],
           "expected_verdict": lab.get("expected_verdict", "ok"), "verdict": res["quality"]["verdict"],
           "quality": res["quality"]["metrics"], "click": res.get("click_grid"),
           "per_label": [], "false_positives": [], "timing": (res.get("summary") or {}).get("timing"),
           "note_accuracy": (res.get("summary") or {}).get("note_accuracy")}
    used = set()
    for lb in labels:
        hit = next((f for f in findings if f["id"] not in used and _matches(lb, f, res["note_table"])), None)
        if hit:
            used.add(hit["id"])
        out["per_label"].append({"label": lb, "found": hit is not None,
                                 "finding": hit and {k: hit[k] for k in ("id", "type", "confidence")}})
    out["false_positives"] = [{k: f[k] for k in ("id", "type", "confidence", "message")}
                              for f in findings if f["id"] not in used]

    if lab.get("onsets_file") and res["notes"]:
        ref_on = _read_onsets(base / lab["onsets_file"])
        est_on = np.array([n["onset_s"] for n in res["notes"]])
        f, p, r = mir_eval.onset.f_measure(ref_on, est_on, window=0.05)
        m = mir_eval.util.match_events(ref_on, est_on, 0.05)
        err = np.array([est_on[j] - ref_on[i] for i, j in m]) * 1000
        out["onsets"] = {"f_measure": round(f, 3), "precision": round(p, 3), "recall": round(r, 3),
                         "matched": len(m), "median_abs_err_ms": round(float(np.median(np.abs(err))), 1) if len(err) else None,
                         "p90_abs_err_ms": round(float(np.percentile(np.abs(err), 90)), 1) if len(err) else None,
                         "mean_err_ms": round(float(err.mean()), 1) if len(err) else None}
    return out


def evaluate_dir(labels_dir: Path) -> dict:
    files = sorted(labels_dir.glob("*.label.json"))
    takes = []
    for lp in files:
        try:
            takes.append(evaluate_take(lp))
        except Exception as e:  # keep going; report the broken label
            takes.append({"label_file": lp.name, "error": str(e)})
    ok = [t for t in takes if "error" not in t]

    per_type: dict[str, dict] = {}
    for t in ok:
        for pl in t["per_label"]:
            d = per_type.setdefault(pl["label"]["type"], {"labelled": 0, "found": 0, "fp_all": 0, "fp_confident": 0})
            d["labelled"] += 1
            d["found"] += int(pl["found"])
        for fp in t["false_positives"]:
            lt = next((k for k, v in LABEL_TO_FINDINGS.items() if fp["type"] in v), fp["type"])
            d = per_type.setdefault(lt, {"labelled": 0, "found": 0, "fp_all": 0, "fp_confident": 0})
            d["fp_all"] += 1
            d["fp_confident"] += int(fp["confidence"] >= 0.5)
    for d in per_type.values():
        d["recall"] = round(d["found"] / d["labelled"], 2) if d["labelled"] else None

    verdicts = {}
    for t in ok:
        key = f"{t['expected_verdict']}->{t['verdict']}"
        verdicts[key] = verdicts.get(key, 0) + 1

    devices: dict[str, dict] = {}
    for t in ok:
        d = devices.setdefault(t["device"], {"takes": 0, "snr_db": [], "click_found": 0, "click_residual_ms": [],
                                             "correct_take_note_accuracy": [], "correct_take_abs_timing_ms": []})
        d["takes"] += 1
        if t["quality"].get("snr_db") is not None:
            d["snr_db"].append(t["quality"]["snr_db"])
        if t["click"] and t["click"]["found"]:
            d["click_found"] += 1
            d["click_residual_ms"].append(t["click"]["click_residual_ms"])
        if not t["per_label"] and t["expected_verdict"] == "ok" and t["note_accuracy"] is not None:
            d["correct_take_note_accuracy"].append(t["note_accuracy"])
            if t["timing"]:
                d["correct_take_abs_timing_ms"].append(t["timing"]["mean_abs_ms"])
    for d in devices.values():
        for k in ("snr_db", "click_residual_ms", "correct_take_note_accuracy", "correct_take_abs_timing_ms"):
            v = d[k]
            d[k] = {"n": len(v), "median": round(float(np.median(v)), 2), "min": round(float(np.min(v)), 2)} if v else None

    onset = [t["onsets"] for t in ok if t.get("onsets") and t["onsets"]["p90_abs_err_ms"] is not None]
    calib = None
    if onset:
        calib = {"takes_with_onset_labels": len(onset),
                 "median_f_measure": round(float(np.median([o["f_measure"] for o in onset])), 3),
                 "suggested_timing_uncertainty_ms": round(float(np.median([o["p90_abs_err_ms"] for o in onset])), 1),
                 "systematic_bias_ms": round(float(np.median([o["mean_err_ms"] for o in onset])), 1)}
    return {"takes": takes, "per_type": per_type, "verdicts": verdicts, "devices": devices, "calibration": calib}


def render_report(rep: dict) -> str:
    L = [f"M0 evaluation over {len(rep['takes'])} labelled takes", ""]
    errs = [t for t in rep["takes"] if "error" in t]
    for t in errs:
        L.append(f"  ! {t['label_file']}: {t['error']}")
    L.append(f"{'label type':<16}{'labelled':>9}{'found':>7}{'recall':>8}{'FP(all)':>9}{'FP(conf)':>10}")
    for k, d in sorted(rep["per_type"].items()):
        rc = "-" if d["recall"] is None else f"{d['recall']:.2f}"
        L.append(f"{k:<16}{d['labelled']:>9}{d['found']:>7}{rc:>8}{d['fp_all']:>9}{d['fp_confident']:>10}")
    L.append("\nVerdicts (expected->actual): " + ", ".join(f"{k}: {v}" for k, v in sorted(rep["verdicts"].items())))
    L.append("\nDevices:")
    for dev, d in rep["devices"].items():
        L.append(f"  {dev}: {d['takes']} takes, click found {d['click_found']}, SNR {d['snr_db']}, "
                 f"click residual {d['click_residual_ms']}, correct-take note accuracy {d['correct_take_note_accuracy']}, "
                 f"correct-take mean |timing| {d['correct_take_abs_timing_ms']}")
    if rep["calibration"]:
        L.append(f"\nOnset calibration: {rep['calibration']}")
    else:
        L.append("\nNo onset labels yet: timing uncertainty stays a placeholder (see docs/m0-protocol.md).")
    small = [k for k, d in rep["per_type"].items() if d["labelled"] < 10]
    if small:
        L.append(f"\nCaution: fewer than 10 labelled examples for {', '.join(sorted(small))}; "
                 "these numbers are anecdotal, not accuracy estimates.")
    return "\n".join(L)
