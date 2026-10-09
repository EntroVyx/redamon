"""The plugin-gateway proxy: the only door between the plugins network and the rest of
the stack (master plan TD-05). Standard library only, trusted code in the runner's image.

    :7071  plugins-net → webapp   /api/plugin-gateway/v1/* and /api/plugin-runner/v1/*
    :7072  webapp → supervisor    /runner/v1/*

The proxy joins only plugins-net and plugins-edge, so even a compromised proxy reaches
the webapp and nothing else. The webapp still authenticates every call; this layer keeps
workers away from every other webapp route and strips every header but four.

Refused before anything is sent upstream: a method other than GET or POST, a path outside
the listener's prefix, any %-encoded byte, `..`, `//` or a backslash, a query string on a
POST or one over 512 characters, a body on a GET, a chunked body, a body over 8 MB. An
answer over 16 MB becomes a 502. One log line per request: listener, method, path (no
query), status, milliseconds; never a header or a body.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_QUERY_CHARS = 512
# An LLM call may take 600 s and an action 900 s (PLUGIN_ACTION_MAX_TIMEOUT); the runner
# door must outlast both.
UPSTREAM_TIMEOUT = 960.0
FORWARDED_HEADERS = ("Authorization", "Content-Type", "X-Plugin-Runner-Key")
PATH_RULES = {
    "gateway": re.compile(r"^/api/plugin-(?:gateway|runner)/v1/[a-z0-9/_-]+$"),
    "runner": re.compile(r"^/runner/v1/[A-Za-z0-9/_-]+$"),
}


def _refusal(target: str, kind: str, method: str):
    """(status, code) when the request line is refused, else None."""
    path, sep, query = target.partition("?")
    if "%" in target or "\\" in target or ".." in path or "//" in path or "#" in target:
        return 404, "not_found"
    if not PATH_RULES[kind].match(path):
        return 404, "not_found"
    if sep and (method != "GET" or len(query) > MAX_QUERY_CHARS):
        return 400, "query_refused"
    return None


def build_server(kind: str, bind: str, port: int, upstream: str, *, timeout: float = UPSTREAM_TIMEOUT,
                 max_body: int = MAX_BODY_BYTES, max_response: int = MAX_RESPONSE_BYTES,
                 log=None) -> ThreadingHTTPServer:
    if kind not in PATH_RULES:
        raise ValueError(f"unknown listener {kind!r}")
    up = urlsplit(upstream)
    if up.scheme != "http" or not up.hostname:
        raise ValueError(f"the upstream must be http://host:port, not {upstream!r}")
    up_host, up_port = up.hostname, up.port or 80
    write = log or (lambda line: print(line, flush=True))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "plugin-gateway"
        sys_version = ""

        def log_message(self, *args):  # the one line per request is ours
            pass

        def _answer(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            self.close_connection = True

        def _error(self, status: int, code: str, message: str) -> int:
            self._answer(status, json.dumps({"error": message, "code": code}).encode())
            return status

        def _handle(self) -> int:
            if self.command not in ("GET", "POST"):
                return self._error(405, "method_refused", "Only GET and POST pass this proxy.")
            refused = _refusal(self.path, kind, self.command)
            if refused:
                return self._error(refused[0], refused[1], "Refused by the plugin gateway proxy.")
            if self.headers.get("Transfer-Encoding"):
                return self._error(411, "length_required", "A body needs a Content-Length.")
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._error(400, "bad_length", "Content-Length is not a number.")
            if length < 0:
                return self._error(400, "bad_length", "Content-Length is not a number.")
            if length > max_body:
                return self._error(413, "body_too_large", f"A body is limited to {max_body} bytes.")
            if self.command == "GET" and length:
                return self._error(400, "body_refused", "A GET has no body.")
            body = self.rfile.read(length) if length else b""
            headers = {"Host": f"{up_host}:{up_port}", "Connection": "close"}
            for name in FORWARDED_HEADERS:
                value = self.headers.get(name)
                if value is not None:
                    headers[name] = value
            if self.command == "POST":
                headers["Content-Length"] = str(len(body))
            conn = http.client.HTTPConnection(up_host, up_port, timeout=timeout)
            try:
                # putrequest, not request(): request() adds Accept-Encoding of its own.
                conn.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
                for name, value in headers.items():
                    conn.putheader(name, value)
                conn.endheaders(body if self.command == "POST" else None)
                resp = conn.getresponse()
                data = resp.read(max_response + 1)
                status, content_type = resp.status, resp.getheader("Content-Type") or "application/json"
            except (socket.timeout, TimeoutError):
                return self._error(504, "upstream_timeout", "The upstream did not answer in time.")
            except (OSError, http.client.HTTPException):
                return self._error(502, "upstream_unreachable", "The upstream could not be reached.")
            finally:
                conn.close()
            if len(data) > max_response:
                return self._error(502, "upstream_response_too_large", "The upstream's answer is too large.")
            self._answer(status, data, content_type)
            return status

        def _run(self) -> None:
            started = time.monotonic()
            status = 500
            try:
                status = self._handle()
            finally:
                path = self.path.split("?", 1)[0]
                if len(path) > 200 or not path.isprintable():
                    path = "<unprintable path>"
                write(f"[plugin-gateway] {kind} {self.command} {path} {status} "
                      f"{int((time.monotonic() - started) * 1000)}ms")

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = do_TRACE = do_CONNECT = _run

    server = ThreadingHTTPServer((bind, port), Handler)
    server.daemon_threads = True
    return server


def main() -> None:
    bind = os.environ.get("PLUGIN_PROXY_BIND") or "0.0.0.0"
    servers = [
        build_server("gateway", bind, int(os.environ.get("PLUGIN_PROXY_GATEWAY_PORT") or 7071),
                     os.environ.get("PLUGIN_GATEWAY_UPSTREAM") or "http://webapp:3000"),
        build_server("runner", bind, int(os.environ.get("PLUGIN_PROXY_RUNNER_PORT") or 7072),
                     os.environ.get("PLUGIN_RUNNER_UPSTREAM") or "http://plugin-runner:7080"),
    ]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"[plugin-gateway] listening on {bind}: gateway {servers[0].server_address[1]}, "
          f"runner {servers[1].server_address[1]}", flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
