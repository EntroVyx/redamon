"""Every supervisor route demands the runner key and fails closed (TD-08, D-18)."""

import pytest

ROUTES = [
    ("GET", "/runner/v1/health", None),
    ("POST", "/runner/v1/reload", None),
    ("POST", "/runner/v1/plugins/echo/actions/echo",
     {"token": "t", "params": {}, "timeoutSeconds": 5, "async": False,
      "ctx": {"pluginId": "echo", "version": "1.0.0", "userId": "u"}}),
    ("POST", "/runner/v1/plugins/echo/jobs/job-1/cancel", None),
    ("GET", "/runner/v1/plugins/echo/logs?lines=5", None),
]


def _call(h, method, path, body, headers):
    if method == "GET":
        return h.client.get(path, headers=headers)
    return h.client.post(path, json=body, headers=headers)


@pytest.mark.parametrize("configured", ["", "changeme"])
@pytest.mark.parametrize("method,path,body", ROUTES)
def test_without_a_configured_key_every_route_is_503(runner, configured, method, path, body):
    h = runner(runner_key=configured)
    for headers in ({}, {"X-Plugin-Runner-Key": configured}, {"X-Plugin-Runner-Key": "anything"}):
        r = _call(h, method, path, body, headers)
        assert r.status_code == 503, (headers, r.text)
        assert r.json()["code"] == "runner_not_configured"


@pytest.mark.parametrize("method,path,body", ROUTES)
def test_a_wrong_or_missing_key_is_401(runner, method, path, body):
    h = runner()
    for headers in ({}, {"X-Plugin-Runner-Key": "wrong"}, {"X-Plugin-Runner-Key": h.headers["X-Plugin-Runner-Key"] + "x"},
                    {"Authorization": f"Bearer {h.headers['X-Plugin-Runner-Key']}"}):
        r = _call(h, method, path, body, headers)
        assert r.status_code == 401, (headers, r.text)
        assert r.json() == {"error": "Invalid or missing runner key.", "code": "unauthorized"}


def test_the_right_key_is_accepted(runner):
    h = runner()
    assert h.get("/runner/v1/health").status_code == 200


def test_the_key_is_compared_in_constant_time(runner, monkeypatch):
    import supervisor.auth as auth
    seen = []
    real = auth.hmac.compare_digest

    def spy(a, b):
        seen.append(True)
        return real(a, b)

    monkeypatch.setattr(auth.hmac, "compare_digest", spy)
    h = runner()
    h.get("/runner/v1/health")
    h.client.get("/runner/v1/health", headers={"X-Plugin-Runner-Key": "wrong"})
    assert len(seen) >= 2


def test_an_unknown_route_does_not_reveal_more_without_the_key(runner):
    h = runner()
    for path in ("/runner/v1/nothing", "/docs", "/openapi.json", "/redoc"):
        assert h.client.get(path).status_code == 401, path
        assert h.get(path).status_code == 404, path
