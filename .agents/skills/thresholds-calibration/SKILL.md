---
name: thresholds-calibration
description: 'Tune or add analysis thresholds and run M0 calibration for coreguitar. Use when changing values in config.Thresholds (timing tolerance, SNR, clipping, polyphony, distortion, dynamics, confidence caps), adding a new threshold, running `coreguitar evaluate` on labelled real takes, writing label files, or deciding whether a detector is accurate enough.'
---

# Thresholds and M0 calibration

All tunable numbers live in one frozen dataclass: `Thresholds` in
[config.py](../../../src/coreguitar/config.py). `DEFAULT = Thresholds()` is used everywhere; tests and
evaluation can pass a custom instance via `analyze(..., th=Thresholds(...))`.
Constants below the dataclass (`SR`, hops, `CLICK_*`, `LEAD_SILENCE_S`) are a **contract** shared by the click
generator and detector — change them only together with `clicktrack.py` and `synth.py`.

## Rules

- Every value is a **placeholder** until M0 measures it on real recordings. Never describe a change as
  improving accuracy unless backed by `coreguitar evaluate` output on real labelled takes.
- Thresholds are **never a client option**: the API schemas (`server/schemas.py`) must not accept them.
- Add a short comment explaining *why* a non-obvious value was chosen (see `reliable_attack_rise_db`).
- Group new fields under the matching `# --- section ---` comment.
- `th.to_dict()` is embedded in every result, so any change alters `tests/golden/*.json`.

## Procedure: change or add a threshold

1. Edit `Thresholds` (add field with default + comment). Read it via `th.<name>` — never hard-code in detectors.
2. Run `npm run test:backend`. Expect golden JSON drift; if only the `thresholds` block or intended findings changed,
   regenerate with `.venv/bin/python .agents/skills/synthetic-audio-testing/scripts/regen_golden.py` and review `git diff tests/golden`.
3. If acceptance tests T1–T14 change outcome, the change altered behaviour — justify it or revert.
4. Update the "Known limits" section of [README.md](../../../README.md) if a placeholder became calibrated (or vice versa).

## Procedure: M0 evaluation on real takes

Protocol: [docs/m0-protocol.md](../../../docs/m0-protocol.md). Label template: [docs/label-template.json](../../../docs/label-template.json).

1. Put recordings and `<name>.label.json` files under `data/m0/` (git-ignored; never commit audio — `*.wav`, `*.m4a` are ignored).
2. Label format is documented in the docstring of [evaluate.py](../../../src/coreguitar/evaluate.py)
   (`audio`, `exercise`, `mode`, `expected_verdict`, `errors`). Valid error `type`s are the keys of `LABEL_TO_FINDINGS`
   (e.g. `late`, `early`, `wrong_note`, `missed_note`, `extra_note`, `rushing`, `dragging`, `tuning_offset`, `weak_attack`).
3. Run `.venv/bin/coreguitar evaluate data/m0` and compare precision/recall/onset error per detector.
4. Change thresholds one at a time, re-run evaluate, then re-run the synthetic suite to confirm no regressions.
5. The distortion test is `xfail` on purpose — synthetic distortion is not a valid proxy; only real takes can un-xfail it.

## Privacy

Real takes stay in `data/`. Do not paste audio-derived personal data into issues, PRs, or external tools.
