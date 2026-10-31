"""Command-line interface: coreguitar <command> ..."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from .audio import AudioLoadError


def _exercise_from_args(args):
    from .reference import build_exercise, load_exercise

    if args.exercise:
        return load_exercise(args.exercise, bpm=args.bpm, tuning=args.tuning)
    if args.notes:
        num, den = (int(x) for x in args.time_sig.split("/"))
        return build_exercise(args.notes, bpm=args.bpm or 80, tuning=args.tuning or "standard",
                              time_signature=(num, den), default_duration=args.default_duration)
    return None


def _add_ref_args(p):
    p.add_argument("--exercise", help="exercise JSON file")
    p.add_argument("--notes", help='inline notes, e.g. "6/1 6/2 E2:4 r:8"')
    p.add_argument("--bpm", type=float, help="override/target tempo")
    p.add_argument("--tuning", help="standard | drop_d | half_step_down")
    p.add_argument("--time-sig", default="4/4")
    p.add_argument("--default-duration", default="8")


def cmd_analyze(args) -> int:
    from .analyze import analyze
    from .report import render_text

    ex = None if args.free else _exercise_from_args(args)
    if ex is None and not args.free:
        print("Provide --exercise/--notes for reference mode, or --free for free playing.", file=sys.stderr)
        return 2
    try:
        result = analyze(args.audio, ex, free_bpm=args.bpm if args.free else None, free_tuning=args.tuning or "standard")
    except AudioLoadError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    out = Path(args.json) if args.json else None
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2, default=_json_default))
    if not args.quiet:
        print(render_text(result))
        if out:
            print(f"\nFindings JSON: {out}")
    return 0


def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def cmd_click(args) -> int:
    from .clicktrack import click_track

    ex = _exercise_from_args(args)
    if ex is None and not (args.bpm and args.beats):
        print("Provide --exercise/--notes, or --bpm with --beats.", file=sys.stderr)
        return 2
    bpm = ex.bpm if ex else args.bpm
    beats = ex.total_beats if ex else args.beats
    bpb = ex.beats_per_bar if ex else 4
    sf.write(args.out, click_track(bpm, beats, bpb, 44100), 44100, subtype="PCM_16")
    print(f"Wrote {args.out}: {bpm:g} BPM, 2 s silence, {bpb}-beat count-in, {beats:g} beats + 1 bar.")
    print("Start recording FIRST, then play this file through the speaker.")
    return 0


def cmd_exercise(args) -> int:
    ex = _exercise_from_args(args)
    if ex is None:
        print("Provide --exercise or --notes.", file=sys.stderr)
        return 2
    print(f"{ex.name} | tuning {ex.tuning} | {ex.bpm:g} BPM | {ex.beats_per_bar}/{ex.beat_unit} | {ex.total_beats:g} beats")
    for n in ex.notes:
        print(f"  {n.index:>3}  bar {n.bar} beat {n.beat_in_bar:<5g} {n.name:<4} ({n.token}, {n.dur_beats:g} beats)")
    return 0


def _parse_pairs(items, cast):
    out = {}
    for it in items or []:
        k, v = it.split(":", 1)
        out[int(k)] = cast(v)
    return out


def cmd_synth(args) -> int:
    from .music import note_to_midi
    from .synth import TakeSpec, render_take

    ex = _exercise_from_args(args)
    if ex is None:
        print("Provide --exercise or --notes.", file=sys.stderr)
        return 2
    spec = TakeSpec(
        deviations_ms=_parse_pairs(args.shift, float),
        wrong=_parse_pairs(args.wrong, note_to_midi),
        missing={int(i) for i in args.missing or []},
        extra=[(k, note_to_midi(v)) for k, v in _parse_pairs(args.extra, str).items()],
        tuning_cents=args.cents,
        drift_ms_total=args.drift,
        snr_db=args.snr,
        chord=args.chord,
        distortion_gain=args.distortion,
    )
    y, _ = render_take(ex, spec)
    sf.write(args.out, y, 44100, subtype="FLOAT")
    print(f"Wrote synthetic take {args.out} ({len(y) / 44100:.1f} s)")
    return 0


def cmd_evaluate(args) -> int:
    from .evaluate import evaluate_dir, render_report

    report = evaluate_dir(Path(args.labels))
    print(render_report(report))
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, default=_json_default))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="coreguitar", description="Guitar practice feedback (post-recording analysis).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("analyze", help="analyse a recorded take")
    p.add_argument("audio")
    _add_ref_args(p)
    p.add_argument("--free", action="store_true", help="free-playing mode (descriptive only)")
    p.add_argument("--json", help="write findings JSON here")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(fn=cmd_analyze)

    p = sub.add_parser("click", help="generate a click track WAV for an exercise")
    _add_ref_args(p)
    p.add_argument("--beats", type=float)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_click)

    p = sub.add_parser("exercise", help="show how an exercise is parsed")
    _add_ref_args(p)
    p.set_defaults(fn=cmd_exercise)

    p = sub.add_parser("synth", help="render a synthetic take with injected errors (for testing)")
    _add_ref_args(p)
    p.add_argument("--out", required=True)
    p.add_argument("--shift", nargs="*", help="INDEX:MS timing shifts")
    p.add_argument("--wrong", nargs="*", help="INDEX:NOTE wrong notes")
    p.add_argument("--missing", nargs="*", help="INDEX of omitted notes")
    p.add_argument("--extra", nargs="*", help="AFTER_INDEX:NOTE extra notes")
    p.add_argument("--cents", type=float, default=0.0)
    p.add_argument("--drift", type=float, default=0.0, help="total drift in ms across the take")
    p.add_argument("--snr", type=float, default=50.0)
    p.add_argument("--chord", action="store_true")
    p.add_argument("--distortion", type=float, default=0.0)
    p.set_defaults(fn=cmd_synth)

    p = sub.add_parser("evaluate", help="M0: score the analyser against your labelled takes")
    p.add_argument("labels", help="directory of *.label.json files")
    p.add_argument("--json", help="write the report JSON here")
    p.set_defaults(fn=cmd_evaluate)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
