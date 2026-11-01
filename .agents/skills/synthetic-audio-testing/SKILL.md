---
name: synthetic-audio-testing
description: 'Write or fix Python pytest tests for coreguitar using synthetic guitar takes with injected errors (TakeSpec, render_take, run_take fixture), acceptance tests T1-T14, codec/ingest tests, server TestClient tests, and CLI golden snapshots. Use when adding backend tests, a golden snapshot test fails, regenerating tests/golden, or verifying a DSP change without real recordings.'
---

# Synthetic audio testing (pytest)

Passing on synthetic audio proves **logic consistency, not real-world accuracy**. Say so in test docstrings and PRs.

## Building blocks

- [synth.py](../../../src/coreguitar/synth.py) `TakeSpec` injects known errors by **reference note index**:
  `deviations_ms={5: 80}` (late), `wrong={9: midi}`, `missing={3}`, `extra=[(after_idx, midi)]`, `tuning_cents`,
  `drift_ms_total`, `amp_overrides`, `buzz`, `ring_prev`, `chord`, `distortion_gain`, `click_level`, `snr_db`, `gain`, `seed`.
  `render_take(ex, spec, sr=44100)` returns `(audio, truth)` with click track included.
- [conftest.py](../../../tests/conftest.py): `run_take(ex, spec, *, free=False, audio=None)` writes a WAV in `tmp_path` and
  returns the analysis dict; `chromatic` fixture; `types(res, min_conf, include_experimental)` helper; `EXERCISES` path.
- Build ad-hoc exercises with `build_exercise("5/0:4 5/3:8 r:8", bpm=80, tuning="drop_d")`.

## Patterns

```python
# T<n> one-line intent comment, as in test_acceptance.py
def test_tX_single_missed_note(run_take, chromatic):
    res = run_take(chromatic, TakeSpec(missing={7}))
    missed = [f for f in res["findings"] if f["type"] == "missed_note"]
    assert len(missed) == 1 and 7 in missed[0]["ref_indices"] and missed[0]["confidence"] >= 0.5
    assert {"wrong_note", "extra_note"}.isdisjoint(types(res, min_conf=0.5))
```

- Always assert **both** the positive finding and the absence of confident false positives.
- Confident = `confidence >= 0.5` and not `experimental`.
- Use a fixed `seed`; vary it only to prove robustness (e.g. `TakeSpec(seed=3)`).
- Known-unvalidated behaviour → `pytest.mark.xfail(reason=...)`, never delete the test.
- Server tests: `pytest.importorskip("fastapi")`, `TestClient(create_app(data_root=tmp_path / "app"), base_url="http://127.0.0.1")`
  (the host must be loopback or TrustedHostMiddleware rejects it). Poll analyses with the `wait_for` helper in `test_server.py`.
- Never write into `data/`; use `tmp_path`.

## Golden snapshots

[test_cli_golden.py](../../../tests/test_cli_golden.py) pins CLI text + JSON (minus `analyzed_at`) for `clean`, `late`, `wrong`.
`web/src/Results.test.tsx` also reads `tests/golden/late.json`, so golden changes can break frontend tests.

```bash
.venv/bin/python .agents/skills/synthetic-audio-testing/scripts/regen_golden.py --check  # report drift only
.venv/bin/python .agents/skills/synthetic-audio-testing/scripts/regen_golden.py          # rewrite goldens
git --no-pager diff --stat tests/golden
```

Regenerate **only** for intentional output changes, and explain the diff in the PR.
Script: [regen_golden.py](./scripts/regen_golden.py).

## Running

```bash
npm run test:backend                                   # all Python tests
.venv/bin/python -m pytest tests/test_acceptance.py -k t3 -q
.venv/bin/python -m pytest tests/test_codec_equivalence.py -q   # needs ffmpeg + ffprobe
```
