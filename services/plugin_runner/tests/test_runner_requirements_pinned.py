"""A reproducible runner image (R-25): this image runs third-party code, so nothing in it
may float: the base by digest, every Python package by exact version, nothing resolved at
build time beyond the list."""

import re

from tests.support import RUNNER_ROOT

REQUIREMENTS = RUNNER_ROOT / "requirements.txt"
DOCKERFILE = RUNNER_ROOT / "Dockerfile"
PIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][0-9A-Za-z.+-]*$")
# The agent image's versions (redamon-agent:latest, read when the runner was built).
AGENT_PINS = {"fastapi": "0.142.2", "uvicorn": "0.54.0", "pydantic": "2.13.5", "httpx": "0.28.1"}


def _lines():
    return [line.strip() for line in REQUIREMENTS.read_text().splitlines()
            if line.strip() and not line.strip().startswith("#")]


def test_every_requirement_is_an_exact_pin():
    bad = [line for line in _lines() if not PIN_RE.match(line)]
    assert bad == []


def test_the_supervisor_stack_matches_the_agent_image():
    pins = dict(line.split("==") for line in _lines())
    assert {k: pins.get(k) for k in AGENT_PINS} == AGENT_PINS


def test_no_package_is_listed_twice():
    names = [line.split("==")[0].lower().replace("_", "-") for line in _lines()]
    assert len(names) == len(set(names))


def test_the_base_image_is_pinned_by_digest():
    froms = [line for line in DOCKERFILE.read_text().splitlines() if line.startswith("FROM ")]
    assert froms and all(re.match(r"^FROM python:3\.11-slim@sha256:[0-9a-f]{64}$", f) for f in froms), froms


def test_pip_installs_exactly_the_list():
    text = DOCKERFILE.read_text()
    assert "pip install --no-cache-dir --no-deps -r /tmp/requirements.txt" in text
    assert "pip check" in text


def test_the_image_strips_setuid_and_setgid_bits():
    assert "find / -xdev -perm /6000 -type f -exec chmod a-s {} +" in DOCKERFILE.read_text()
