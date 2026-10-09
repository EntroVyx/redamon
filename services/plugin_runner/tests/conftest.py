"""Fixtures shared by the plugin runner tests (helpers live in tests/support.py)."""

import pytest

from tests.support import StubServer


@pytest.fixture
def stub_server():
    srv = StubServer()
    try:
        yield srv
    finally:
        srv.close()


@pytest.fixture
def worker():
    from tests.support import WorkerProcess
    started = []

    def start(*args, **kwargs):
        w = WorkerProcess(*args, **kwargs)
        started.append(w)
        return w

    yield start
    for w in started:
        w.close()


@pytest.fixture
def plugins_dir():
    import shutil
    from tests.support import make_plugins_dir
    d = make_plugins_dir()
    yield d
    shutil.rmtree(d, ignore_errors=True)


class RunnerHarness:
    """The supervisor app in this process, its webapp side played by a StubServer:
    `GET /api/plugin-runner/v1/run-list` answers `self.run_list` (or `self.run_list_status`),
    `POST /api/plugin-gateway/v1/jobs/complete` is recorded and answered from
    `self.complete_statuses` (then 200)."""

    def __init__(self, stub, plugins_dir, entries, overrides):
        import json as _json
        from fastapi.testclient import TestClient
        from supervisor.app import create_app
        from supervisor.config import Settings
        from tests.support import BOOTSTRAP, IS_ROOT, RUNNER_KEY, SDK_ROOT, TEST_UID_RANGE, run_list

        self.stub = stub
        self.run_list = run_list(entries or [])
        self.run_list_status = 200
        self.completions: list = []
        self.complete_statuses: list = []

        def reply(req):
            if req.path == "/api/plugin-runner/v1/run-list":
                if self.run_list_status != 200:
                    return (self.run_list_status, {"Content-Type": "application/json"},
                            b'{"error":"down","code":"down"}')
                return (200, {"Content-Type": "application/json"}, _json.dumps(self.run_list).encode())
            if req.path == "/api/plugin-gateway/v1/jobs/complete":
                self.completions.append(req)
                status = self.complete_statuses.pop(0) if self.complete_statuses else 200
                return (status, {"Content-Type": "application/json"}, b'{"ok":true}')
            return (404, {"Content-Type": "application/json"}, b'{"error":"no","code":"not_found"}')

        stub.reply = reply
        params = dict(runner_key=RUNNER_KEY, gateway_url=stub.base_url,
                      plugins_dir=str(plugins_dir), sdk_dir=str(SDK_ROOT), bootstrap=str(BOOTSTRAP),
                      spawn_as_user=IS_ROOT, reload_interval=3600, job_report_delays=(0.01, 0.02, 0.04),
                      kill_grace=0.5, uid_range=TEST_UID_RANGE)
        params.update(overrides)
        self.settings = Settings(**params)
        self.app = create_app(self.settings)
        self.client = TestClient(self.app)
        self.headers = {"X-Plugin-Runner-Key": self.settings.runner_key}

    def __enter__(self):
        self.client.__enter__()
        return self

    def __exit__(self, *exc):
        if not getattr(self, "_closed", False):
            self._closed = True
            self.client.__exit__(*exc)

    def get(self, path, **kw):
        kw.setdefault("headers", self.headers)
        return self.client.get(path, **kw)

    def post(self, path, **kw):
        kw.setdefault("headers", self.headers)
        return self.client.post(path, **kw)

    def health(self) -> dict:
        r = self.get("/runner/v1/health")
        assert r.status_code == 200, r.text
        return r.json()

    def reload(self) -> dict:
        r = self.post("/runner/v1/reload")
        assert r.status_code == 200, r.text
        return r.json()

    def restarted_from(self, old_pid) -> bool:
        """True once the first worker runs again under a new pid (one /health snapshot)."""
        workers = self.health()["workers"]
        return bool(workers) and workers[0]["state"] == "ready" and workers[0]["pid"] not in (None, old_pid)

    def workers(self) -> dict:
        return {f"{w['id']}@{w['version']}": w for w in self.health()["workers"]}

    def act(self, plugin, action, params=None, *, token="call-token", timeout=30, async_=False,
            job_id=None, ctx=None):
        body = {"token": token, "params": params or {}, "timeoutSeconds": timeout, "async": async_,
                "ctx": ctx or {"pluginId": plugin, "version": "1.0.0", "userId": "user-1"}}
        if job_id is not None:
            body["jobId"] = job_id
        return self.post(f"/runner/v1/plugins/{plugin}/actions/{action}", json=body)


@pytest.fixture
def runner(stub_server, plugins_dir):
    started = []

    def start(entries=None, **overrides):
        h = RunnerHarness(stub_server, plugins_dir, entries, overrides)
        h.__enter__()
        started.append(h)
        return h

    yield start
    for h in started:
        h.__exit__(None, None, None)
