"""Optional, localhost-only application server."""

from __future__ import annotations

import shutil


def serve(port: int = 8765, open_browser: bool = False) -> int:
    import sys

    if not 1 <= port <= 65535:
        print("Port must be between 1 and 65535.", file=sys.stderr)
        return 2
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        print(f"Cannot serve: missing {', '.join(missing)}. Install ffmpeg (brew install ffmpeg).",
              file=sys.stderr)
        return 1
    try:
        import uvicorn
        from .app import create_app
    except ImportError as exc:
        print(f"Cannot serve: install app dependencies with pip install -e '.[app]': {exc}",
              file=sys.stderr)
        return 1
    if open_browser:
        import threading
        import webbrowser

        threading.Timer(1, webbrowser.open, args=(f"http://127.0.0.1:{port}",)).start()
    uvicorn.run(create_app(), host="127.0.0.1", port=port)
    return 0
