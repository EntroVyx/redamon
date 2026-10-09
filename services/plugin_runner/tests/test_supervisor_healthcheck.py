"""`python -m supervisor.healthcheck`, the container's health probe: there is no
unauthenticated route, so the probe reads the key from its own environment (R-51)."""

import os
import subprocess
import sys
import threading

import pytest

from tests.support import RUNNER_KEY, RUNNER_ROOT, SDK_ROOT, free_port, install_plugin, run_list, wait_until


class LiveSupervisor:
    def __init__(self, settings):
        import uvicorn
        from supervisor.app import create_app
        self.port = free_port()
        config = uvicorn.Config(create_app(settings), host="127.0.0.1", port=self.port,
                                log_level="warning", lifespan="on")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        wait_until(lambda: self.server.started)

    def stop(self):
        self.server.should_exit = True
        self.thread.join(10)


@pytest.fixture
def live(stub_server, plugins_dir):
    from supervisor.config import Settings
    from tests.support import BOOTSTRAP, IS_ROOT, TEST_UID_RANGE
    started = []

    def start(key=RUNNER_KEY, platform="1.0.0"):
        import json
        body = json.dumps(run_list([install_plugin(plugins_dir)], platform=platform)).encode()
        stub_server.reply = lambda r: (200, {"Content-Type": "application/json"}, body)
        s = LiveSupervisor(Settings(runner_key=key, gateway_url=stub_server.base_url,
                                    plugins_dir=str(plugins_dir), sdk_dir=str(SDK_ROOT),
                                    bootstrap=str(BOOTSTRAP), spawn_as_user=IS_ROOT,
                                    uid_range=TEST_UID_RANGE))
        started.append(s)
        return s

    yield start
    for s in started:
        s.stop()


def _probe(port, key):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": str(RUNNER_ROOT),
           "PLUGIN_RUNNER_PORT": str(port)}
    if key is not None:
        env["PLUGIN_RUNNER_KEY"] = key
    return subprocess.run([sys.executable, "-m", "supervisor.healthcheck"], env=env, cwd="/",
                          capture_output=True, text=True, timeout=30)


def test_the_probe_passes_against_a_running_supervisor(live):
    s = live()
    p = _probe(s.port, RUNNER_KEY)
    assert p.returncode == 0, p.stderr
    assert RUNNER_KEY not in p.stdout + p.stderr


def test_the_probe_passes_when_the_runner_is_out_of_date(live):
    """Restarting would not help; /api/plugins/status reports the state instead."""
    s = live(platform="9.0.0")
    assert _probe(s.port, RUNNER_KEY).returncode == 0


@pytest.mark.parametrize("key", ["wrong-key", "", None])
def test_the_probe_fails_with_a_wrong_or_missing_key_and_never_prints_it(live, key):
    s = live()
    p = _probe(s.port, key)
    assert p.returncode == 1
    if key:
        assert key not in p.stdout + p.stderr
    assert RUNNER_KEY not in p.stdout + p.stderr


def test_the_probe_fails_when_nothing_listens():
    p = _probe(free_port(), RUNNER_KEY)
    assert p.returncode == 1


def test_the_probe_fails_when_the_supervisor_has_no_key(live):
    s = live(key="")
    assert _probe(s.port, "").returncode == 1
    assert _probe(s.port, RUNNER_KEY).returncode == 1
