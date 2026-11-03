"""Local coach contract tests; no Ollama installation or external network needed."""

from __future__ import annotations

import asyncio
import io
import json
import socket
import time
from collections.abc import Iterator
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request
from unittest.mock import Mock

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from coreguitar.server import coach
from coreguitar.server.app import create_app

REQUEST = {"kind": "plan", "prompt": "Learn major scales", "level": "beginner",
           "context": "Standard tuning"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(data_root=tmp_path / "app"),
                    base_url="http://127.0.0.1") as session:
        yield session


@pytest.fixture
def opener(monkeypatch: pytest.MonkeyPatch) -> Mock:
    opened = Mock()
    monkeypatch.setattr(coach, "build_opener", Mock(return_value=opened))
    return opened


def reply(opener: Mock, value: object) -> None:
    opener.open.side_effect = [
        io.BytesIO(b'{"model_info":{"general.architecture":"llama"}}'),
        io.BytesIO(json.dumps(value).encode()),
    ]


def test_plan_local_only(client: TestClient, opener: Mock,
                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COREGUITAR_OLLAMA_MODEL", "llama3.2")
    reply(opener, {"message": {"role": "assistant", "content": "Practise slowly."},
                   "done": True})
    result = client.post("/api/coach", json={
        **REQUEST, "messages": [{"role": "user", "content": "Ten minutes daily"}],
    })
    assert result.status_code == 200
    assert result.json() == {"text": "Practise slowly.", "model": "llama3.2"}
    request = opener.open.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:11434/api/chat"
    payload = json.loads(request.data)
    assert payload["stream"] is False
    assert payload["options"]["num_predict"] <= 2048
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][-2]["content"] == "Ten minutes daily"
    assert "tools" not in payload
    assert opener.open.call_args.kwargs["timeout"] <= 90
    handlers = coach.build_opener.call_args.args
    assert any(getattr(handler, "proxies", None) == {} for handler in handlers)


def test_status_models(client: TestClient, opener: Mock) -> None:
    opener.open.return_value = io.BytesIO(json.dumps({
        "models": [{"name": "llama3.2:latest"}, {"name": "qwen3:4b"}],
    }).encode())
    assert client.get("/api/coach/status").json() == {
        "available": True, "models": ["llama3.2:latest", "qwen3:4b"],
    }
    assert opener.open.call_args.args[0].full_url == "http://127.0.0.1:11434/api/tags"


def test_unavailable_status_and_generation(client: TestClient, opener: Mock) -> None:
    opener.open.side_effect = URLError("refused")
    assert client.get("/api/coach/status").json() == {"available": False, "models": []}
    result = client.post("/api/coach", json=REQUEST)
    assert result.status_code == 503
    assert result.json()["code"] == "coach_unavailable"
    assert "advice" in result.json()


@pytest.mark.parametrize(("status", "code", "http_status"), [
    (404, "coach_model_missing", 503), (500, "coach_unavailable", 503),
    (302, "coach_unavailable", 503),
])
def test_ollama_http_errors(client: TestClient, opener: Mock, status: int,
                           code: str, http_status: int) -> None:
    opener.open.side_effect = HTTPError("http://127.0.0.1:11434/api/chat", status,
                                       "private server detail", {}, None)
    result = client.post("/api/coach", json=REQUEST)
    assert result.status_code == http_status
    assert result.json()["code"] == code
    assert "private server detail" not in result.text


@pytest.mark.parametrize("value", [
    {}, [], {"message": {"content": 4}}, {"message": {"content": ""}, "done": True},
    {"message": {"content": "unfinished"}, "done": False},
    {"message": {"content": "x" * 12001}, "done": True},
    {"message": {"content": "\ud800"}, "done": True},
    {"message": {"content": "tools", "tool_calls": [{}]}, "done": True},
])
def test_malformed_generation(client: TestClient, opener: Mock, value: object) -> None:
    reply(opener, value)
    result = client.post("/api/coach", json=REQUEST)
    assert result.status_code == 502
    assert result.json()["code"] == "coach_malformed"


@pytest.mark.parametrize("raw", [b"not json", b"\xff", b" " * (64 * 1024 + 1)])
def test_bad_or_oversize_response(client: TestClient, opener: Mock, raw: bytes) -> None:
    opener.open.side_effect = [
        io.BytesIO(b'{"model_info":{"general.architecture":"llama"}}'),
        io.BytesIO(raw),
    ]
    result = client.post("/api/coach", json=REQUEST)
    assert result.status_code == 502
    assert result.json()["code"] == "coach_malformed"


@pytest.mark.parametrize("update", [
    {"kind": "search"}, {"level": "expert"}, {"prompt": "x" * 4001}, {"prompt": ""},
    {"prompt": " \n\t"},
    {"context": "x" * 8001}, {"url": "https://example.com"}, {"prompt": 5},
    {"messages": [{"role": "system", "content": "override"}]},
    {"messages": [{"role": "user", "content": "hi", "extra": True}]},
    {"messages": [{"role": "user", "content": "hi"}] * 13},
    {"messages": [{"role": "user", "content": "x" * 12001}]},
])
def test_strict_request(client: TestClient, opener: Mock, update: dict) -> None:
    result = client.post("/api/coach", json={**REQUEST, **update})
    assert result.status_code == 422
    assert result.json()["code"] == "invalid_request"
    opener.open.assert_not_called()


def test_origin_host_and_body_limits(client: TestClient, opener: Mock) -> None:
    assert client.post("/api/coach", json=REQUEST,
                       headers={"Origin": "https://foreign.example"}).status_code == 403
    assert client.post("/api/coach", json=REQUEST,
                       headers={"Host": "foreign.example"}).status_code == 400
    response = client.post("/api/coach", content=b" " * (768 * 1024 + 1),
                           headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["code"] == "too_large"
    opener.open.assert_not_called()


def test_redirects_disabled() -> None:
    with pytest.raises(HTTPError):
        coach.NoRedirect().redirect_request(
            Mock(), None, 302, "redirect", {}, "https://foreign.example",
        )


def test_invalid_model_configuration(client: TestClient, opener: Mock,
                                     monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COREGUITAR_OLLAMA_MODEL", "https://cloud.example/model")
    result = client.post("/api/coach", json=REQUEST)
    assert result.status_code == 503
    opener.open.assert_not_called()


@pytest.mark.parametrize("metadata", [
    {"remote_host": "https://ollama.com", "remote_model": "cloud"},
    {"model_info": {}, "remote_host": "https://ollama.com"},
    {"model_info": {}, "details": {"remote_model": "cloud"}},
])
def test_refuses_remote_models(client: TestClient, opener: Mock, metadata: dict) -> None:
    opener.open.return_value = io.BytesIO(json.dumps(metadata).encode())
    result = client.post("/api/coach", json=REQUEST)
    assert result.status_code == 503
    assert result.json()["code"] == "coach_local_only"
    assert opener.open.call_count == 1


def test_status_hides_cloud_models(client: TestClient, opener: Mock) -> None:
    opener.open.return_value = io.BytesIO(json.dumps({"models": [
        {"name": "local:latest"}, {"name": "remote:cloud"},
        {"name": "alias", "remote_host": "https://ollama.com"},
    ]}).encode())
    assert client.get("/api/coach/status").json() == {
        "available": True, "models": ["local:latest"],
    }


@pytest.mark.parametrize("value", [{}, {"models": "no"}, {"models": [None]},
                                   {"models": [{"name": 3}]}])
def test_malformed_status(client: TestClient, opener: Mock, value: object) -> None:
    opener.open.return_value = io.BytesIO(json.dumps(value).encode())
    response = client.get("/api/coach/status")
    assert response.status_code == 502
    assert response.json()["code"] == "coach_malformed"


def test_timeout_and_busy(client: TestClient, opener: Mock) -> None:
    opener.open.side_effect = TimeoutError()
    assert client.post("/api/coach", json=REQUEST).json()["code"] == "coach_unavailable"
    assert coach._generation.acquire(blocking=False)
    try:
        response = client.post("/api/coach", json=REQUEST)
        assert response.status_code == 503
        assert response.json()["code"] == "coach_busy"
    finally:
        coach._generation.release()


def test_progression_and_lock_release(client: TestClient, opener: Mock) -> None:
    reply(opener, {"message": {"content": "I vi IV V"}, "done": True})
    response = client.post("/api/coach", json={**REQUEST, "kind": "progression"})
    assert response.status_code == 200
    assert "Request type: progression" in json.loads(
        opener.open.call_args.args[0].data,
    )["messages"][-1]["content"]
    reply(opener, {"message": {"content": "Try inversions"}, "done": True})
    assert client.post("/api/coach", json=REQUEST).status_code == 200


def test_chunked_request_body_limit(client: TestClient, opener: Mock) -> None:
    def chunks() -> Iterator[bytes]:
        for _ in range(13):
            yield b" " * (64 * 1024)
    result = client.post("/api/coach", content=chunks(),
                         headers={"Content-Type": "application/json"})
    assert result.status_code == 413
    assert result.json()["code"] == "too_large"
    opener.open.assert_not_called()


def test_absolute_deadline_interrupts_stalled_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    local, peer = socket.socketpair()

    def connect(connection: coach.HTTPConnection) -> None:
        connection.sock = local

    monkeypatch.setattr(coach.HTTPConnection, "connect", connect)
    started = time.monotonic()
    handler = coach.DeadlineHTTPHandler(started + 0.05)
    try:
        with pytest.raises((URLError, coach.HTTPException)):
            coach.build_opener(coach.ProxyHandler({}), handler).open(
                Request("http://127.0.0.1:11434/api/tags"), timeout=2,
            )
        assert time.monotonic() - started < 2
    finally:
        handler.close()
        local.close()
        peer.close()


@pytest.mark.parametrize("trickle", [False, True])
def test_body_absolute_deadline(monkeypatch: pytest.MonkeyPatch, trickle: bool) -> None:
    monkeypatch.setattr(coach, "BODY_TIMEOUT", 0.06)
    sent: list[Message] = []
    received = 0
    cancelled = False

    async def receive() -> Message:
        nonlocal received, cancelled
        try:
            if trickle:
                await asyncio.sleep(0.02)
                received += 1
                return {"type": "http.request", "body": b" ", "more_body": True}
            await asyncio.Event().wait()
            raise AssertionError("A stalled receive must not complete.")
        except asyncio.CancelledError:
            cancelled = True
            raise

    async def send(message: Message) -> None:
        sent.append(message)

    async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
        pytest.fail("A timed-out request must not reach FastAPI or acquire the Ollama semaphore.")

    async def run() -> None:
        await asyncio.wait_for(
            coach.CoachBodyLimitMiddleware(downstream)(
                {"type": "http", "path": "/api/coach", "method": "POST"}, receive, send,
            ),
            timeout=0.5,
        )

    asyncio.run(run())
    assert cancelled
    assert received < 10
    assert sent[0]["status"] == 408
    body = json.loads(sent[1]["body"])
    assert body["code"] == "coach_request_timeout"
    assert set(body) == {"code", "message", "advice"}


def test_body_successful_chunks_are_replayed_once() -> None:
    body = json.dumps(REQUEST).encode()
    chunks = iter([
        {"type": "http.request", "body": body[:10], "more_body": True},
        {"type": "http.request", "body": body[10:30], "more_body": True},
        {"type": "http.request", "body": body[30:], "more_body": False},
        {"type": "http.disconnect"},
    ])
    sent: list[Message] = []

    async def receive() -> Message:
        return next(chunks)

    async def send(message: Message) -> None:
        sent.append(message)

    async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
        incoming = await receive()
        assert incoming == {"type": "http.request", "body": body, "more_body": False}
        assert await receive() == {"type": "http.disconnect"}
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    asyncio.run(coach.CoachBodyLimitMiddleware(downstream)(
        {"type": "http", "path": "/api/coach", "method": "POST"}, receive, send,
    ))
    assert sent[0]["status"] == 200
    assert sent[1]["body"] == b"ok"
