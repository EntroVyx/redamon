"""Helpers for the plugin runner tests: a scripted HTTP server on 127.0.0.1 and the
shared Gateway contract cases. No test here touches a real network."""

from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional

RUNNER_ROOT = Path(__file__).resolve().parents[1]
SDK_ROOT = RUNNER_ROOT / "sdk"
CONTRACT_CASES = SDK_ROOT / "contract_cases.json"


def load_contract_cases() -> list[dict]:
    return json.loads(CONTRACT_CASES.read_text(encoding="utf-8"))["cases"]


class Recorded:
    def __init__(self, method: str, path: str, headers: dict, body: bytes):
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else None


# reply(request) -> (status, headers, body bytes)
Reply = Callable[[Recorded], tuple]


class StubServer:
    """Records every request and answers from `reply`; `delay` stalls each answer."""

    def __init__(self):
        self.requests: list[Recorded] = []
        self.reply: Reply = lambda r: (200, {"Content-Type": "application/json"}, b"{}")
        self.delay = 0.0
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # keep test output clean
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                rec = Recorded(self.command, self.path,
                               {k.lower(): v for k, v in self.headers.items()}, body)
                stub.requests.append(rec)
                if stub.delay:
                    time.sleep(stub.delay)
                status, headers, payload = stub.reply(rec)
                try:
                    self.send_response(status)
                    for k, v in headers.items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST = do_PUT = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        # A short poll keeps shutdown() (one per test) from waiting the default 0.5 s.
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def answer_json(self, status: int, body) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.reply = lambda r: (status, {"Content-Type": "application/json"}, payload)

    def answer_raw(self, status: int, text: str, content_type: str = "text/html") -> None:
        payload = text.encode("utf-8")
        self.reply = lambda r: (status, {"Content-Type": content_type}, payload)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def free_port() -> int:
    """A port nothing listens on (bound then released)."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def resolve_call(sdk, call: dict):
    """The SDK coroutine a contract case names, e.g. "data.get" -> sdk.data.get(...)."""
    namespace, name = call["method"].split(".")
    fn = getattr(getattr(sdk, namespace), name)
    return fn(*call.get("args", []), **call.get("kwargs", {}))


def context_kwargs(case: dict) -> dict:
    ctx = case.get("context") or {}
    return {
        "project_id": ctx.get("projectId"),
        "session_id": ctx.get("sessionId"),
        "job_id": ctx.get("jobId"),
    }


def case_id(case: dict) -> Optional[str]:
    return case["name"]
