---
name: analysis-findings
description: 'Add, change, or remove an analysis finding type in the coreguitar DSP engine (timing, wrong/missed/extra note, pitch, dynamics, experimental ringing/buzz, quality gates). Use when touching findings.py, quality.py, experimental.py, knowledge.py, report.py, analyze.py, transcribe.py, align.py or clicktrack.py, or when asked to detect a new mistake, change confidence, prioritisation, coaching text, or the findings JSON.'
---

# Analysis findings (Python engine)

The engine turns a recording into a findings dict: `analyze.py` → `pre_checks` (quality) →
`transcribe` → `analyze_reference` / `analyze_free` (findings) → `prioritize` / `listening_points` (report).
A finding type is wired through several files; missing one silently drops it from the UI.

## Non-negotiable invariants

- **Measure, don't guess.** Findings are observations with `measured` values, a time range
  (`start_s`/`end_s` → evidence playback) and a `confidence` in [0, 1]. Causes are hypotheses (`knowledge.py`), never measured.
- **Thresholds live only in `config.Thresholds`.** No magic numbers in detectors; add a field (see `thresholds-calibration` skill).
- **Confidence is scaled by input quality**: multiply by `qf = quality.confidence_factor(th)`; fast passages get less confidence.
- **Experimental detectors** (`experimental.py`) set `experimental=True`, cap confidence at `th.experimental_confidence_cap`,
  and are never in top-3 priorities (they belong in `LISTEN_TYPES`).
- **Free mode never calls anything a mistake** (`test_t9_free_mode_language` checks wording against `MISTAKE_WORDS`).
- **Decline rather than guess**: unsupported input (chords, distortion) is a quality issue with level `unsupported`, not a finding.
- No language models, no network, no telemetry in the engine.
- CLI commands must not import `fastapi`/`uvicorn`/`coreguitar.server` (enforced by `test_cli_golden.py`). Import heavy/optional deps inside functions.

## Procedure: add a finding type

1. **Detect** in [findings.py](../../../src/coreguitar/findings.py) inside the right `_*_findings` helper:
   `F.add("<type>", "<category>", severity, confidence * qf, start_s, end_s, message, measured={...}, ref_indices=[...])`.
   Use `_where(ex, i, t)` / `ts(t)` for human locations. Add caveats with `F.note(...)` (goes to `uncertainty`).
2. **Coach** in [knowledge.py](../../../src/coreguitar/knowledge.py): add `KNOWLEDGE["<type>"]` with `title`, short `causes`
   (hypotheses for a ~1-year player), and one concrete `drill`. Unknown types fall back to the bare type name.
3. **Prioritise** in [report.py](../../../src/coreguitar/report.py): add `"<type>": "<family>"` to `FAMILY` so it can reach the
   top-3, or to `LISTEN_TYPES` if experimental/free-mode only. Tuning-family findings get a 2× boost.
4. **Test** with a synthetic take that injects the error (see `synthetic-audio-testing` skill): assert the type appears
   with `confidence >= 0.5`, the right `ref_indices`, and that `test_t1_correct_take*` stay clean (no false positives).
5. **Frontend**: `Finding.type` is a plain `string` in `web/src/api.ts`, so new types need no TS change unless you add new
   top-level fields. New/renamed fields require updating the type guards (see `local-api-contract` skill).
6. **M0 scoring**: if real takes can be labelled with this error, map the label to the type in
   `LABEL_TO_FINDINGS` in [evaluate.py](../../../src/coreguitar/evaluate.py) and document it in `docs/label-template.json`.
7. **Goldens**: if CLI text/JSON changes, run the regen script from `synthetic-audio-testing` and review the diff.
8. **Docs**: update the "What the analysis does" / "Known limits" tables in [README.md](../../../README.md).

## Changing the result shape

Any rename/removal of keys in the result dict is a contract change: bump `SCHEMA_VERSION` in
[`__init__.py`](../../../src/coreguitar/__init__.py), update `web/src/api.ts` guards, `test_server.py`
(`schema_version` assert), and goldens. Adding optional keys does not need a bump.

## Style

`from __future__ import annotations`, module docstring stating what the module does and its honesty caveats,
dataclasses with `to_dict()`, type hints, numpy vectorised maths, rounded floats in output dicts. No Python linter is configured — match neighbours.
