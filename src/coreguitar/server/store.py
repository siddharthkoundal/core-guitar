"""UUID-addressed local take storage, with atomic metadata writes."""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from uuid import UUID


def valid_id(value: str) -> str:
    parsed = UUID(value)
    if parsed.version != 4 or str(parsed) != value:
        raise ValueError("Expected a canonical UUID4.")
    return str(parsed)


def write_json(path: Path, value: dict) -> None:
    from ..cli import _json_default

    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value, indent=2, default=_json_default), encoding="utf-8")
    os.replace(temporary, path)


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.takes = self.root / "takes"
        self.tmp = self.root / "tmp"
        self.takes.mkdir(parents=True, exist_ok=True)
        self.tmp.mkdir(parents=True, exist_ok=True)

    def take_path(self, take_id: str) -> Path:
        path = self.takes / valid_id(take_id)
        if path.is_symlink():
            raise ValueError("Symlink take directories are not supported.")
        return path

    def meta(self, take_id: str) -> dict:
        return json.loads((self.take_path(take_id) / "meta.json").read_text(encoding="utf-8"))

    def ids(self) -> list[str]:
        result = []
        for path in self.takes.iterdir():
            if path.is_dir() and not path.is_symlink():
                try:
                    result.append(valid_id(path.name))
                except ValueError:
                    continue
        return result

    def delete(self, take_id: str) -> None:
        path = self.take_path(take_id)
        if not path.is_dir():
            raise FileNotFoundError(take_id)
        shutil.rmtree(path)

    def sweep(self, now: float | None = None) -> None:
        cutoff = (time.time() if now is None else now) - 3600
        for path in self.tmp.iterdir():
            if path.lstat().st_mtime < cutoff:
                if path.is_dir() and not path.is_symlink():
                    if any(entry.stat().st_mtime >= cutoff for entry in path.rglob("*")):
                        continue
                    shutil.rmtree(path)
                else:
                    path.unlink()
