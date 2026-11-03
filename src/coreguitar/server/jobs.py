"""One queued analysis worker; each DSP run lives in a killable subprocess."""

from __future__ import annotations

import json
import logging
import multiprocessing
import queue
import threading
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .store import Store, valid_id, write_json

logger = logging.getLogger(__name__)


def run_analysis(audio: str, exercise: dict | None, request: dict, output: str) -> None:
    from ..analyze import analyze
    from ..reference import build_exercise

    reference = build_exercise(**exercise) if exercise is not None else None
    result = analyze(audio, reference, free_bpm=request.get("bpm"),
                     free_tuning=request.get("tuning") or "standard",
                     input_profile=request.get("input_profile") or "mic",
                     click_offset_s=request.get("click_offset_s"))
    write_json(Path(output), result)


@dataclass
class Job:
    analysis_id: str
    take_id: str
    request: dict
    exercise: dict | None
    status: str = "queued"
    error: str | None = None
    process: multiprocessing.Process | None = None


class Jobs:
    def __init__(self, store: Store, timeout: float = 300, runner=run_analysis):
        self.store = store
        self.timeout = timeout
        self.runner = runner
        self.jobs: dict[str, Job] = {}
        self.lock = threading.RLock()
        self.queue: queue.Queue[str | None] = queue.Queue()
        self.worker = threading.Thread(target=self._work, name="coreguitar-analysis", daemon=True)
        self.worker.start()

    def submit(self, take_id: str, request: dict, exercise: dict | None) -> str:
        with self.lock:
            self.store.meta(take_id)
            analysis_id = str(uuid4())
            self.jobs[analysis_id] = Job(analysis_id, take_id, request, exercise)
            self.queue.put(analysis_id)
            return analysis_id

    def get(self, analysis_id: str) -> dict:
        with self.lock:
            analysis_id = valid_id(analysis_id)
            job = self.jobs.get(analysis_id)
            if job:
                response: dict = {"status": job.status}
                if job.status == "done":
                    response["result"] = self._envelope(job)
                if job.error:
                    response["error"] = job.error
                return response
            # Completed results survive restarting the server.
            for take_id in self.store.ids():
                result_path = self.store.take_path(take_id) / f"analysis-{analysis_id}.json"
                if result_path.is_file():
                    return {"status": "done", "result": json.loads(result_path.read_text())}
            raise FileNotFoundError(analysis_id)

    def _envelope(self, job: Job) -> dict:
        path = self.store.take_path(job.take_id) / f"analysis-{job.analysis_id}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def cancel(self, analysis_id: str) -> None:
        with self.lock:
            analysis_id = valid_id(analysis_id)
            job = self.jobs.get(analysis_id)
            if job is None:
                self.get(analysis_id)
                return
            if job.status not in ("queued", "running"):
                return
            job.status = "cancelled"
            if job.process is not None:
                job.process.kill()
                job.process.join()
            self._remove_partial(job)

    def delete_take(self, take_id: str) -> None:
        with self.lock:
            for job in list(self.jobs.values()):
                if job.take_id == take_id:
                    self.cancel(job.analysis_id)
                    del self.jobs[job.analysis_id]
            self.store.delete(take_id)

    def _remove_partial(self, job: Job) -> None:
        directory = self.store.take_path(job.take_id)
        for suffix in ("json", "pending"):
            (directory / f"work-{job.analysis_id}.{suffix}").unlink(missing_ok=True)

    def _work(self) -> None:
        while (analysis_id := self.queue.get()) is not None:
            with self.lock:
                job = self.jobs.get(analysis_id)
                if job is None or job.status != "queued":
                    continue
                directory = self.store.take_path(job.take_id)
                output = directory / f"work-{analysis_id}.json"
                process = multiprocessing.get_context("spawn").Process(
                    target=self.runner,
                    args=(str(directory / "take.wav"), job.exercise, job.request, str(output)),
                )
                job.process = process
                job.status = "running"
                try:
                    process.start()
                except (OSError, RuntimeError):
                    logger.exception("Could not start analysis %s", analysis_id)
                    job.status = "failed"
                    job.error = "Could not start analysis. Check the local server log."
                    process.close()
                    job.process = None
                    continue
            process.join(self.timeout)
            with self.lock:
                if job.status == "cancelled":
                    process.close()
                    job.process = None
                    continue
                if process.is_alive():
                    process.kill()
                    process.join()
                    job.status = "failed"
                    job.error = "Analysis exceeded the 300 second timeout. Try a shorter take."
                    self._remove_partial(job)
                    process.close()
                    job.process = None
                    continue
                if process.exitcode != 0 or not output.is_file():
                    logger.error("Analysis %s exited with code %s", analysis_id, process.exitcode)
                    job.status = "failed"
                    job.error = "Analysis failed. Check the local server log and try again."
                    self._remove_partial(job)
                    process.close()
                    job.process = None
                    continue
                try:
                    meta = self.store.meta(job.take_id)
                    result = json.loads(output.read_text(encoding="utf-8"))
                    envelope = {
                        "analysis_id": analysis_id, "take_id": job.take_id,
                        "source": meta["source"], "request": job.request,
                        "track_settings": meta["track_settings"], "lossy": meta["lossy"],
                        "result": result,
                    }
                    write_json(directory / f"analysis-{analysis_id}.json", envelope)
                    job.status = "done"
                except (OSError, ValueError, KeyError):
                    logger.exception("Could not save analysis %s", analysis_id)
                    job.status = "failed"
                    job.error = "Could not save analysis. Check free disk space and the server log."
                finally:
                    self._remove_partial(job)
                    process.close()
                    job.process = None

    def close(self) -> None:
        with self.lock:
            for job in self.jobs.values():
                self.cancel(job.analysis_id)
            self.queue.put(None)
        self.worker.join()
