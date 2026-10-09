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
