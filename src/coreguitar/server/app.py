"""Same-origin HTTP API and built SPA, served only on the desktop loopback."""

from __future__ import annotations

import asyncio
import io
import logging
import math
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import soundfile as sf
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .. import SCHEMA_VERSION, __version__
from ..ingest import MAX_UPLOAD_BYTES, IngestError, ingest_audio
from ..reference import load_exercise
from .jobs import Jobs
from .schemas import AnalysisRequest, ClickRequest, CustomExercise, TakeMeta
from .store import Store, valid_id, write_json

ROOT = Path(__file__).resolve().parents[3]
logger = logging.getLogger(__name__)


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/api/takes" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        total = 0
        started = False

        async def limited_receive():
            nonlocal total
            message = await receive()
            total += len(message.get("body", b""))
            if total > MAX_UPLOAD_BYTES + 64 * 1024:
                raise IngestError("too_large", "The uploaded file exceeds the 100 MB limit.",
                                  "Choose a smaller audio file.")
            return message

        async def tracked_send(message):
            nonlocal started
            started = started or message["type"] == "http.response.start"
            await send(message)

        headers = dict(scope.get("headers", []))
        try:
            size = int(headers.get(b"content-length", b"0"))
            if size > MAX_UPLOAD_BYTES + 64 * 1024:
                response = JSONResponse({"code": "too_large", "message": "Upload exceeds 100 MB.",
                                         "advice": "Choose a smaller audio file."}, status_code=413)
                return await response(scope, receive, send)
            await self.app(scope, limited_receive, tracked_send)
        except IngestError as exc:
            if started:
                raise
            await JSONResponse({"code": exc.code, "message": exc.message, "advice": exc.advice},
                               status_code=413)(scope, receive, send)


def create_app(*, data_root: Path | None = None, dist_root: Path | None = None,
               job_timeout: float = 300, job_runner=None) -> FastAPI:
    store = Store(data_root or ROOT / "data" / "app")
    dist = (dist_root or ROOT / "web" / "dist").resolve()
    exercises = {
        path.stem: load_exercise(path) for path in sorted((ROOT / "exercises").glob("*.json"))
    }

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.sweep()
        jobs = Jobs(store, job_timeout, **({"runner": job_runner} if job_runner else {}))
        app.state.jobs = jobs

        async def sweep_hourly():
            while True:
                await asyncio.sleep(3600)
                try:
                    await run_in_threadpool(store.sweep)
                except OSError:
                    logger.exception("Could not sweep stale temporary uploads")

        sweeper = asyncio.create_task(sweep_hourly())
        try:
            yield
        finally:
            sweeper.cancel()
            try:
                await sweeper
            except asyncio.CancelledError:
                pass
            await run_in_threadpool(jobs.close)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.add_middleware(UploadLimitMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])

    @app.middleware("http")
    async def same_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method not in ("GET", "HEAD", "OPTIONS") and origin:
            parsed = urlsplit(origin)
            if parsed.scheme != request.url.scheme or parsed.netloc != request.headers.get("host"):
                return JSONResponse({"code": "invalid_origin", "message": "Use the local app origin."},
                                    status_code=403)
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValidationError)
    async def validation_error(request: Request, exc):
        return JSONResponse({"code": "invalid_request", "message": str(exc)}, status_code=422)

    @app.exception_handler(ValueError)
    async def value_error(request: Request, exc: ValueError):
        return JSONResponse({"code": "invalid_request", "message": str(exc)}, status_code=422)

    @app.exception_handler(FileNotFoundError)
    async def missing(request: Request, exc):
        return JSONResponse({"code": "not_found", "message": "Take or analysis not found."},
                            status_code=404)

    @app.exception_handler(IngestError)
    async def ingest_error(request: Request, exc: IngestError):
        statuses = {"too_large": 413, "too_short": 422, "too_long": 422,
                    "unsupported_format": 415, "decode_failed": 422}
        return JSONResponse({"code": exc.code, "message": exc.message, "advice": exc.advice},
                            status_code=statuses[exc.code])

    def select_exercise(exercise_id, custom, bpm=None, tuning=None):
        if exercise_id is not None:
            if exercise_id not in exercises:
                raise ValueError("Unknown shipped exercise.")
            from ..reference import build_exercise
            shipped = exercises[exercise_id]
            ex = build_exercise(
                shipped.notes_text, name=shipped.name, description=shipped.description,
                bpm=bpm or shipped.bpm, tuning=tuning or shipped.tuning,
                time_signature=(shipped.beats_per_bar, shipped.beat_unit),
                default_duration=shipped.default_duration,
            )
        else:
            ex = custom.model_copy(update={"bpm": bpm or custom.bpm,
                                           "tuning": tuning or custom.tuning}).build()
        click_duration = 2 + (math.ceil(ex.total_beats) + 2 * ex.beats_per_bar) * ex.beat_s + 2.5
        if click_duration > 180:
            raise ValueError("Exercise click and recording tail must fit within 180 seconds.")
        return ex

    @app.get("/api/health")
    def health():
        return {"app_version": __version__, "schema_version": SCHEMA_VERSION,
                "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))}

    @app.get("/api/exercises")
    def list_exercises():
        return [
            {"id": exercise_id, "name": ex.name, "description": ex.description,
             "tuning": ex.tuning, "bpm": ex.bpm,
             "time_signature": [ex.beats_per_bar, ex.beat_unit],
             "default_duration": ex.default_duration, "notes_text": ex.notes_text,
             "total_beats": ex.total_beats}
            for exercise_id, ex in exercises.items()
        ]

    @app.post("/api/exercises/preview")
    def preview(custom: CustomExercise):
        return select_exercise(None, custom).to_dict()

    @app.post("/api/click")
    def click(request: ClickRequest):
        from ..clicktrack import click_track
        ex = select_exercise(request.exercise_id, request.custom, request.bpm)
        output = io.BytesIO()
        sf.write(output, click_track(ex.bpm, ex.total_beats, ex.beats_per_bar, 44100),
                 44100, format="WAV", subtype="PCM_16")
        return Response(output.getvalue(), media_type="audio/wav",
                        headers={"Content-Disposition": 'attachment; filename="click.wav"'})

    @app.post("/api/takes", status_code=201)
    def take(file: UploadFile = File(), meta: str = Form()):
        metadata = TakeMeta.model_validate_json(meta)
        take_id = str(uuid4())
        audio = ingest_audio(file.file, original_name=metadata.original_name or file.filename or "",
                             temp_root=store.tmp, take_dir=store.take_path(take_id))
        value = {"take_id": take_id, "duration_s": audio.duration_s,
                 "sample_rate": audio.sample_rate, "channels": audio.channels,
                 "codec": audio.codec, "lossy": audio.lossy, **metadata.model_dump()}
        try:
            write_json(store.take_path(take_id) / "meta.json", value)
        except OSError:
            store.delete(take_id)
            logger.exception("Could not save take metadata")
            raise
        return {key: value[key] for key in ("take_id", "duration_s", "sample_rate",
                                            "channels", "codec", "lossy", "source")}

    @app.get("/api/takes/{take_id}/audio")
    def audio(take_id: str):
        store.meta(take_id)
        return FileResponse(store.take_path(take_id) / "take.wav", media_type="audio/wav")

    @app.post("/api/takes/{take_id}/analyses", status_code=202)
    def analyze_take(take_id: str, request: AnalysisRequest):
        valid_id(take_id)
        ex = None
        if request.mode == "reference":
            reference = select_exercise(request.exercise_id, request.custom_exercise,
                                        request.bpm, request.tuning)
            ex = {"notes": reference.notes_text, "name": reference.name, "tuning": reference.tuning,
                  "bpm": reference.bpm, "time_signature": (reference.beats_per_bar, reference.beat_unit),
                  "default_duration": reference.default_duration, "description": reference.description}
        return {"analysis_id": app.state.jobs.submit(take_id, request.model_dump(), ex)}

    @app.get("/api/analyses/{analysis_id}")
    def analysis(analysis_id: str):
        return app.state.jobs.get(analysis_id)

    @app.delete("/api/analyses/{analysis_id}", status_code=204)
    def cancel(analysis_id: str):
        app.state.jobs.cancel(analysis_id)
        return Response(status_code=204)

    @app.delete("/api/takes/{take_id}", status_code=204)
    def delete(take_id: str):
        app.state.jobs.delete_take(take_id)
        return Response(status_code=204)

    @app.delete("/api/takes", status_code=204)
    def delete_all():
        for take_id in store.ids():
            app.state.jobs.delete_take(take_id)
        return Response(status_code=204)

    @app.get("/{path:path}")
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"code": "not_found", "message": "Unknown API route."}, status_code=404)
        candidate = (dist / path).resolve()
        if candidate.is_relative_to(dist) and candidate.is_file():
            return FileResponse(candidate)
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index)
        return HTMLResponse(
            "<h1>CoreGuitar</h1><p>Build the local UI: npm --prefix web ci &amp;&amp; "
            "npm --prefix web run build</p>", status_code=503,
        )

    return app
