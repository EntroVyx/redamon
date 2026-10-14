"""Live contract of POST /plugins/llm/invoke with a real provider (MC-02).

Skipped unless a running agent and a user with a configured provider are named:
  REDAMON_LIVE_LLM_USER   the user id whose providers the agent loads
  REDAMON_LIVE_LLM_MODEL  a model id that user can run (e.g. openai/gpt-4.1-mini)
  INTERNAL_API_KEY        the master key
  REDAMON_LIVE_AGENT_URL  optional, default http://agent:8080
The scripted double (redamon_plugin_sdk.testing.ScriptedLlm) stands in everywhere else.
"""
from __future__ import annotations

import os

import pytest

USER = os.environ.get("REDAMON_LIVE_LLM_USER", "")
MODEL = os.environ.get("REDAMON_LIVE_LLM_MODEL", "")
KEY = os.environ.get("INTERNAL_API_KEY", "")
URL = os.environ.get("REDAMON_LIVE_AGENT_URL", "http://agent:8080").rstrip("/")


@pytest.fixture(scope="module")
def answer():
    if not (USER and MODEL and KEY and KEY != "changeme"):
        pytest.skip("live LLM contract: set REDAMON_LIVE_LLM_USER, REDAMON_LIVE_LLM_MODEL and INTERNAL_API_KEY (MC-02)")
    import httpx
    try:
        return httpx.post(f"{URL}/plugins/llm/invoke", timeout=120, headers={"x-internal-key": KEY}, json={
            "user_id": USER, "plugin_id": "live-check", "model": MODEL, "max_tokens": 20,
            "messages": [{"role": "system", "content": "Answer with one word."},
                         {"role": "user", "content": "Say: ready"}],
        })
    except httpx.TransportError as exc:
        pytest.skip(f"live LLM contract: the agent at {URL} is not reachable ({exc})")


def test_a_real_model_answers_in_the_contract_shape(answer):
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert isinstance(body["content"], str) and body["content"].strip()
    assert body["model_used"] == MODEL
    usage = body["usage"]
    assert isinstance(usage["input_tokens"], int) and usage["input_tokens"] > 0
    assert isinstance(usage["output_tokens"], int) and usage["output_tokens"] > 0
    assert isinstance(usage["estimated"], bool)
