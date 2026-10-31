"""Rank findings into at most N actionable corrections and render text."""

from __future__ import annotations

from .config import Thresholds
from .findings import Finding, conf_label, ts
from .knowledge import advice_for

FAMILY = {
    "transposition": "tuning",
    "tuning_offset": "tuning",
    "wrong_note": "notes",
    "missed_note": "notes",
    "extra_note": "notes",
    "muted_note": "notes",
    "timing_offset": "timing",
    "timing_drift_rushing": "timing",
    "timing_drift_dragging": "timing",
    "timing_late": "timing",
    "timing_early": "timing",
    "intonation": "pitch",
    "uneven_attacks": "dynamics",
    "weak_attack": "dynamics",
    "cut_short": "articulation",
}
LISTEN_TYPES = ("possible_buzz", "possible_ringing")


def _score(f: Finding) -> float:
    boost = 2.0 if FAMILY.get(f.type) == "tuning" else 1.0
    return f.severity * f.confidence * boost


def prioritize(findings: list[Finding], th: Thresholds) -> list[dict]:
    eligible = [f for f in findings if f.type in FAMILY and not f.experimental and f.confidence >= th.min_priority_confidence]
    fams: dict[str, list[Finding]] = {}
    for f in eligible:
        fams.setdefault(FAMILY[f.type], []).append(f)
    ranked = []
    for fam, items in fams.items():
        items.sort(key=_score, reverse=True)
        score = _score(items[0]) * (1 + 0.15 * min(len(items) - 1, 4))
        ranked.append((score, fam, items))
    ranked.sort(key=lambda r: r[0], reverse=True)
    out = []
    for rank, (score, fam, items) in enumerate(ranked[: th.max_priorities], start=1):
        lead = items[0]
        adv = advice_for(lead.type)
        more = len(items) - 1
        out.append({
            "rank": rank,
            "family": fam,
            "title": adv["title"],
            "finding_ids": [f.id for f in items],
            "observation": lead.message + (f" (+{more} related finding{'s' if more > 1 else ''})" if more else ""),
            "confidence_label": conf_label(lead.confidence),
            "possible_causes": adv["causes"],
            "causes_are_hypotheses": True,
            "drill": adv["drill"],
            "evidence": lead.to_dict()["evidence"],
            "score": round(score, 3),
        })
    return out


def listening_points(findings: list[Finding], th: Thresholds) -> list[dict]:
    """Free mode: audible-issue hints phrased neutrally ('if unintended...')."""
    pts = [f for f in findings if f.type in LISTEN_TYPES]
    pts.sort(key=lambda f: f.start_s)
    out = []
    for f in pts[: th.max_priorities]:
        adv = advice_for(f.type)
        out.append({
            "title": adv["title"],
            "finding_ids": [f.id],
            "observation": f.message,
            "if_unintended_try": adv["drill"],
            "evidence": f.to_dict()["evidence"],
        })
    return out


def render_text(result: dict) -> str:
    L: list[str] = []
    q = result["quality"]
    L.append(f"== {result['input']['file']} ({result['input']['duration_s']} s) - mode: {result['mode']} ==")
    if result.get("exercise"):
        ex = result["exercise"]
        L.append(f"Exercise: {ex['name']} | tuning {ex['tuning']} | {ex['bpm']:g} BPM")
    L.append(f"Input quality: {q['verdict'].upper()}  (SNR {q['metrics'].get('snr_db', '?')} dB, "
             f"peak {q['metrics'].get('peak_dbfs', '?')} dBFS)")
    for i in q["issues"]:
        L.append(f"  - [{i['level']}] {i['message']} -> {i['advice']}")
    if result["re_record"]["requested"]:
        L.append("\nPlease re-record: " + " ".join(result["re_record"]["reasons"]))
        return "\n".join(L)

    s = result.get("summary") or {}
    if result["mode"] == "reference" and s.get("alignment"):
        t = s.get("timing") or {}
        L.append(f"\nNotes: {s['alignment']['match']}/{s['notes_expected']} as expected"
                 + (f" | timing: {t.get('within_tolerance_pct')}% within +/-{t.get('tolerance_ms'):g} ms, "
                    f"mean {t.get('mean_ms'):+} ms" if t else ""))
    pri = result.get("priorities") or []
    if result["mode"] == "reference":
        if pri:
            L.append("\nTop corrections:")
            for p in pri:
                ev = p["evidence"]
                L.append(f" {p['rank']}. {p['title']}  [{p['confidence_label']} confidence, listen {ts(ev['play_from_s'])}-{ts(ev['play_to_s'])}]")
                L.append(f"    Observed: {p['observation']}")
                if p["possible_causes"]:
                    L.append("    Possible causes (not measured): " + " / ".join(p["possible_causes"]))
                L.append(f"    Drill: {p['drill']}")
        else:
            L.append("\nNo confident corrections at the current thresholds. Nice take - try +5 BPM.")
    else:
        lp = result.get("listening_points") or []
        if lp:
            L.append("\nWorth a listen (if unintended):")
            for p in lp:
                L.append(f" - {p['observation']}  Try: {p['if_unintended_try']}")

    L.append("\nAll findings:")
    for f in result["findings"]:
        tag = " [experimental]" if f["experimental"] else ""
        L.append(f" {f['id']:>4} {ts(f['evidence']['start_s'])} {f['type']:<22} {f['confidence_label']:<6}{tag} {f['message']}")
    if result.get("uncertainty"):
        L.append("\nUncertainty:")
        for u in result["uncertainty"]:
            L.append(f" - {u}")
    return "\n".join(L)
