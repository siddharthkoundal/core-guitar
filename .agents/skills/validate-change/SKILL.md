---
name: validate-change
description: 'Pick and run the right validation commands for a coreguitar change (Python pytest, TypeScript typecheck, ESLint, Vitest, Playwright e2e with 80% coverage gate, golden snapshot check) and interpret failures. Use before committing, opening a PR, when asked to "run the tests", "validate", "check everything", or when a CI-style check fails.'
---

# Validate a change

All commands run from the repository root and use the existing `.venv` and `web/node_modules`
(setup: `python3 -m venv .venv && .venv/bin/pip install -e ".[app,dev]" && npm --prefix web ci`; `brew install ffmpeg`).

## Choose the smallest sufficient set

| Changed | Run |
|---|---|
| `src/coreguitar/*.py` (engine) | `npm run test:backend` + golden check |
| `src/coreguitar/server/**` | `npm run test:backend` + `npm run e2e` |
| `exercises/*.json` | `npm run test:backend` |
| `web/src/**` | `npm run typecheck && npm run lint && npm run test:frontend` |
| UI flow, recording, API contract | everything above + `npm run e2e` |
| Docs only | nothing |

Order: **typecheck → lint → unit tests → build → e2e**. Stop at the first failure and fix it before moving on.

```bash
.venv/bin/python .agents/skills/synthetic-audio-testing/scripts/regen_golden.py --check   # golden drift
npm run typecheck
npm run lint
npm test                      # backend + frontend unit tests
npm run build
npm run e2e                   # instrumented build, Playwright, ≥80% coverage gate, then clean rebuild
```

## Reading failures

- **Golden mismatch** (`test_cli_golden.py`): intended output change → regenerate (see `synthetic-audio-testing`);
  otherwise a regression. `Results.test.tsx` also reads `tests/golden/late.json`.
- **`test_existing_commands_do_not_import_optional_server_dependencies`**: a top-level import pulled in FastAPI/uvicorn; move it inside the function.
- **Server tests skipped**: install the `app` extra (`.[app,dev]`).
- **Codec tests fail**: `ffmpeg`/`ffprobe` missing from PATH.
- **E2E coverage < 80%**: add Playwright or Vitest coverage for new branches; then `npm --prefix web run build` to restore the normal build.
- **Port 8767 in use**: a previous e2e server is still running — stop it by PID.
- **Acceptance test outcome flips** (T1–T14): behaviour changed; justify in the PR or revert. Never loosen asserts to make them pass.

## Before committing

- No audio or `data/` contents staged (`git status` — `*.wav`, `*.m4a`, `data/*` are ignored; keep it that way).
- No generated output staged: `web/dist`, `web/coverage`, `web/test-results`, `web/e2e/.generated`.
- README updated when commands, limits, or user-visible behaviour changed.
