---
name: local-api-contract
description: 'Add or change a coreguitar HTTP endpoint or payload end-to-end: FastAPI route in server/app.py, strict Pydantic models in server/schemas.py, job/store logic, error codes, and the matching TypeScript types and runtime type guards in web/src/api.ts. Use when touching /api routes, request/response shapes, upload/ingest limits, analysis jobs, take storage/deletion, or loopback security (host/origin checks).'
---

# Local API contract (FastAPI ↔ React)

The server ([server/app.py](../../../src/coreguitar/server/app.py)) is a same-origin, **loopback-only** app built by
`create_app(data_root=..., dist_root=..., job_timeout=..., job_runner=...)`. The web client
([web/src/api.ts](../../../web/src/api.ts)) validates **every** response at runtime — there is no codegen.

## Security & privacy invariants (do not weaken)

- Bind `127.0.0.1` only; `TrustedHostMiddleware` allows `localhost`/`127.0.0.1`; mutating requests with a foreign `Origin` get 403. No CORS.
- No CDNs, telemetry, outbound calls, or OpenAPI docs (`docs_url=None`).
- Validate IDs with `valid_id()` from `store.py` before touching the filesystem. All take data stays under `data/app/`.
- Uploads: streamed, 100 MB cap (`UploadLimitMiddleware` + `ingest.MAX_UPLOAD_BYTES`), 2–180 s, sniffed by content not extension.
- DSP runs in the single-worker killable subprocess (`server/jobs.py`), never in the request thread.
- Analysis thresholds are **never** accepted from clients.

## Error envelope

Errors are always JSON `{"code": str, "message": str, "advice"?: str}`. Map new failure modes to an exception handler
(`ValueError` → 422 `invalid_request`, `FileNotFoundError` → 404 `not_found`, `IngestError` → code-specific status).
The client surfaces them as `ApiError(code, message, advice)`; `errorMessage()` joins message + advice for the UI.

## Procedure: new or changed endpoint

1. **Schema**: add a `StrictModel` (`extra="forbid"`) in [schemas.py](../../../src/coreguitar/server/schemas.py). Reuse
   `Bpm`, `Tuning`, `ExerciseId` annotated types; use `model_validator(mode="after")` for cross-field rules.
2. **Route**: add inside `create_app`. Keep handlers sync (`def`) for blocking work (FastAPI runs them in a threadpool).
   Lazy-import engine modules inside the handler where the CLI must stay free of server deps.
3. **TS types**: add the `interface` in `api.ts` and a type-guard function (`object()`, `strings()`, `jsonObject()`
   helpers). Use bracket access (`value["key"]`) — `noPropertyAccessFromIndexSignature` is on.
4. **Client method**: add to the `api` object via `read(path, guard, options)` / `response()` / `post(body, signal)`.
   Accept an `AbortSignal` for anything the user can cancel.
5. **Tests**:
   - Python: `tests/test_server.py` with the `client` fixture — happy path, 422 on bad input, 403 on foreign origin
     where relevant, 404 on unknown ID.
   - TS: `web/src/api.test.ts` — `vi.stubGlobal('fetch', ...)`; assert invalid shapes are **rejected** (no success-shaped defaults).
6. **Schema version**: bump `SCHEMA_VERSION` only for breaking result changes; update the `/api/health` assert in `test_server.py`.
7. Update the README if user-visible limits or behaviour change.

## Dev wiring

`npm run backend` (port 8765) + `npm run dev` (Vite on 5173 proxies `/api` with `changeOrigin: false` so the origin
check still passes). E2E uses an isolated server on 8767 via `tests/e2e_server.py`.
