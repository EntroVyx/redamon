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
