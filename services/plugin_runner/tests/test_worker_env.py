"""A worker starts with a clean environment: whatever the supervisor's own environment
holds (the runner key, database URLs, tokens), the worker sees only the variables the
supervisor lists (D-09, D-17, D-18)."""

import os

import pytest

from tests.support import IS_ROOT, RUNNER_KEY, install_plugin

EXPECTED = {"PATH", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "REDAMON_GATEWAY_URL",
            "HOME", "TMPDIR"}
FORBIDDEN_PARTS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "DATABASE")


@pytest.fixture
def secret_environment(monkeypatch):
    monkeypatch.setenv("PLUGIN_RUNNER_KEY", RUNNER_KEY)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@postgres:5432/db")
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    monkeypatch.setenv("INTERNAL_API_KEY", "k" * 32)
    monkeypatch.setenv("MCP_AUTH_TOKEN", "t" * 32)
    monkeypatch.setenv("POSTGRES_PASSWORD", "p" * 16)


def test_the_worker_environment_is_only_the_listed_variables(runner, plugins_dir, secret_environment):
    h = runner([install_plugin(plugins_dir)])
    env = h.act("echo", "describe").json()["result"]["env"]
    assert set(env) == EXPECTED
    assert not [k for k in env if any(part in k.upper() for part in FORBIDDEN_PARTS)]
    assert env["REDAMON_GATEWAY_URL"] == h.settings.gateway_url
    assert RUNNER_KEY not in repr(env)


def test_the_runner_key_never_reaches_the_worker(runner, plugins_dir, secret_environment):
    h = runner([install_plugin(plugins_dir)])
    described = h.act("echo", "describe").json()
    assert RUNNER_KEY not in repr(described)


@pytest.mark.skipif(not IS_ROOT, reason="needs workers under their own UID")
def test_the_worker_cannot_read_the_supervisors_environment(runner, plugins_dir, secret_environment):
    from tests.test_worker_spawn_limits import PROBE_ACTIONS, PROBES
    entry = install_plugin(plugins_dir, extra_files={"engine/probes.py": PROBES})
    entry["manifest"]["actions"].extend(PROBE_ACTIONS)
    h = runner([entry])
    out = h.act("echo", "read_file", {"path": f"/proc/{os.getpid()}/environ"}).json()["result"]
    assert out["read"] is False
