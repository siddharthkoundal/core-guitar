"""Analysis entry point: audio file (+ optional reference) -> findings dict."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from . import SCHEMA_VERSION, __version__
from .audio import guitar_band, load_audio
from .clicktrack import detect_clicks, known_grid
from .config import DEFAULT, SR, Thresholds
from .findings import analyze_free, analyze_reference
from .quality import post_checks, pre_checks
from .reference import Exercise
from .tone import is_driven, tone_check
from .transcribe import transcribe
from .report import listening_points, prioritize


def analyze(path: str | Path, exercise: Exercise | None = None, *, free_bpm: float | None = None,
            free_tuning: str = "standard", th: Thresholds = DEFAULT, input_profile: str = "mic",
            click_offset_s: float | None = None) -> dict:
    """`input_profile` is "mic" (mic in front of an amp) or "direct" (USB processor/interface).
    `click_offset_s` is the browser-measured time of the first click in the recording; with it
    the grid is built directly instead of being detected from the audio."""
    if input_profile not in ("mic", "direct"):
        raise ValueError(f"unknown input_profile {input_profile!r}")
    mode = "reference" if exercise is not None else "free"
    y, raw, native_sr = load_audio(path)
    yg = guitar_band(y)
    direct = input_profile == "direct"

    bpm = exercise.bpm if exercise else free_bpm
    if bpm and click_offset_s is not None:
        grid = known_grid(bpm, click_offset_s, len(y) / SR)
    else:
        grid = detect_clicks(y, bpm) if bpm else None
    quiet_until = grid.first_click_s if grid is not None and grid.found else None
    quality = pre_checks(y, raw, yg, th, quiet_until, input_profile)

    result: dict = {
        "schema_version": SCHEMA_VERSION,
        "app_version": __version__,
        "analyzed_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "input": {"file": Path(path).name, "duration_s": round(len(y) / SR, 2), "native_sample_rate": native_sr,
                  "profile": input_profile},
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
                    "Record in the studio with Processor (USB) input selected, so the app can time the click itself."
                    if direct else
                    "Start recording first, then play the click track through the laptop/phone speaker "
                    "loud enough to be heard on the recording, and keep it running until you finish.")

    notes: list = []
    if quality.usable:
        clicks = None
        if grid is not None and grid.found and click_offset_s is None:
            n_beats = int((len(y) / SR - grid.first_click_s) / grid.period_s) + 1
            clicks = [grid.beat_time(k) for k in range(n_beats)]
        notes, _ = transcribe(yg, SR, quality.metrics.get("noise_floor_dbfs", -70.0), clicks)
        post_checks(quality, notes, th, input_profile)
        result["notes"] = [n.to_dict() for n in notes]
    blocked_early = any(i["code"] in ("too_short", "silent") for i in quality.issues)
    tone = None if blocked_early else tone_check(y, raw, notes, th, input_profile=input_profile,
                                                 quiet_until_s=quiet_until)
    result["tone"] = tone
    if notes and quality.usable:
        if mode == "reference":
            F, rows, summary = analyze_reference(exercise, grid, notes, quality, th, yg, SR, len(y) / SR)
            result["note_table"] = rows
            result["summary"] = summary
        else:
            F, desc = analyze_free(notes, grid, quality, th, yg, SR, free_tuning)
            result["summary"] = desc
        if direct and tone is not None:
            _adjust_for_processor(F, tone)
        if mode == "reference":
            result["priorities"] = prioritize(F.items, th)
        else:
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


def _adjust_for_processor(F, tone: dict) -> None:
    """Driven/compressed processor patches mimic fret buzz and flatten picking dynamics."""
    if is_driven(tone):
        dropped = [f for f in F.items if f.type == "possible_buzz"]
        F.items = [f for f in F.items if f.type != "possible_buzz"]
        if dropped:
            F.note(f"{len(dropped)} possible-buzz point(s) were not reported: drive or compression on the "
                   "processor adds the same high-frequency grit that buzz detection looks for.")
        if any(f.category == "dynamics" for f in F.items):
            F.note("Compression and drive narrow picking dynamics, so dynamics findings are less meaningful on this tone.")
    if any(f.type == "possible_ringing" for f in F.items):
        F.note("Delay or reverb on the processor can look like ringing strings; check with a dry preset.")
