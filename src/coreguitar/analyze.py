"""Analysis entry point: audio file (+ optional reference) -> findings dict."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from . import SCHEMA_VERSION, __version__
from .audio import guitar_band, load_audio
from .clicktrack import detect_clicks
from .config import DEFAULT, SR, Thresholds
from .findings import analyze_free, analyze_reference
from .quality import post_checks, pre_checks
from .reference import Exercise
from .transcribe import transcribe
from .report import listening_points, prioritize


def analyze(path: str | Path, exercise: Exercise | None = None, *, free_bpm: float | None = None,
            free_tuning: str = "standard", th: Thresholds = DEFAULT) -> dict:
    mode = "reference" if exercise is not None else "free"
    y, raw, native_sr = load_audio(path)
    yg = guitar_band(y)

    bpm = exercise.bpm if exercise else free_bpm
    grid = detect_clicks(y, bpm) if bpm else None
    quiet_until = grid.first_click_s if grid is not None and grid.found else None
    quality = pre_checks(y, raw, yg, th, quiet_until)

    result: dict = {
        "schema_version": SCHEMA_VERSION,
        "app_version": __version__,
        "analyzed_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "input": {"file": Path(path).name, "duration_s": round(len(y) / SR, 2), "native_sample_rate": native_sr},
        "mode": mode,
        "exercise": exercise.to_dict() if exercise else None,
        "thresholds": th.to_dict(),
        "click_grid": grid.to_dict() if grid else None,
        "privacy": {"processing": "local", "audio_sent_over_network": False},
        "notes": [],
        "note_table": [],
        "summary": None,
        "findings": [],
        "priorities": [],
        "listening_points": [],
        "uncertainty": [],
    }

    if mode == "reference" and quality.verdict not in ("rejected",) and not grid.found:
        quality.add("no_click", "rejected",
                    f"Could not find the click track in the recording ({grid.reason}).",
                    "Start recording first, then play the click track through the laptop/phone speaker "
                    "loud enough to be heard on the recording, and keep it running until you finish.")

    if quality.usable:
        clicks = None
        if grid is not None and grid.found:
            n_beats = int((len(y) / SR - grid.first_click_s) / grid.period_s) + 1
            clicks = [grid.beat_time(k) for k in range(n_beats)]
        notes, _ = transcribe(yg, SR, quality.metrics.get("noise_floor_dbfs", -70.0), clicks)
        post_checks(quality, notes, th)
        result["notes"] = [n.to_dict() for n in notes]
        if quality.usable:
            if mode == "reference":
                F, rows, summary = analyze_reference(exercise, grid, notes, quality, th, yg, SR, len(y) / SR)
                result["note_table"] = rows
                result["summary"] = summary
                result["priorities"] = prioritize(F.items, th)
            else:
                F, desc = analyze_free(notes, grid, quality, th, yg, SR, free_tuning)
                result["summary"] = desc
                result["listening_points"] = listening_points(F.items, th)
            result["findings"] = [f.to_dict() for f in F.items]
            result["uncertainty"] = F.uncertainty
            if quality.verdict == "degraded":
                result["uncertainty"].insert(0, "Input quality is degraded; all confidences were reduced.")

    result["quality"] = quality.to_dict()
    blocking = [i for i in quality.issues if i["level"] in ("rejected", "unsupported")]
    result["re_record"] = {
        "requested": bool(blocking),
        "reasons": [f"{i['message']} {i['advice']}" for i in blocking],
    }
    return result
