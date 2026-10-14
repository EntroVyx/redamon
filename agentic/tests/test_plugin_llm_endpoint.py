"""POST /plugins/llm/invoke: the plugin platform's model call (TD-09, D-13, R-69).

The webapp's Gateway calls it for a plugin action with the model the user chose for that
plugin in Models by feature. The provider key never leaves the agent; the runner and the
plugin's code never see it. Master key only, refused outright when that key is weak, and
NOT charged to the shared per-user agent cap (plugins have their own daily cap, counted by
the webapp). It never reads a project's settings: outside a session task that would read
another tenant's last-loaded settings.
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from unittest.mock import patch

import pytest
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MASTER = "m" * 40
SCANNER = "s" * 40


@pytest.fixture(scope="module")
def api():
    @asynccontextmanager
    async def fake_lifespan(_app):
        yield

    with patch("api.lifespan", fake_lifespan):
        import api as api_module
    return api_module


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    import llm_guard
    monkeypatch.setenv("INTERNAL_API_KEY", MASTER)
    monkeypatch.setenv("SCANNER_API_KEY", SCANNER)
    llm_guard.reset_state()
    yield
    llm_guard.reset_state()


@pytest.fixture(autouse=True)
def no_project_settings():
    def tripwire(*_a, **_k):
        raise AssertionError("project settings read by the plugin LLM endpoint")

    with patch("project_settings.get_setting", side_effect=tripwire), \
         patch("project_settings.get_settings", side_effect=tripwire), \
         patch("prompts.get_setting", side_effect=tripwire):
        yield


class FakeLlm(BaseModel):
    """Stands in for a LangChain chat model: the fields the endpoint may adjust, and ainvoke."""
    max_tokens: Optional[int] = 4096
    temperature: Optional[float] = 0.0
    reply: object = "ok"
    usage: Optional[dict] = None
    error: Optional[str] = None
    seen: list = []
    built: list = []

    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage
        self.seen.append({"messages": messages, "max_tokens": self.max_tokens, "temperature": self.temperature})
        if self.error:
            raise RuntimeError(self.error)
        msg = AIMessage(content=self.reply)
        if self.usage is not None:
            msg.usage_metadata = self.usage
        return msg


def _client(api):
    from fastapi.testclient import TestClient
    return TestClient(api.app)


def _body(**over):
    body = {
        "user_id": "user-1",
        "plugin_id": "skiller",
        "model": "openai/gpt-test",
        "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Hello"}],
    }
    body.update(over)
    return {k: v for k, v in body.items() if v is not None}


def _call(api, body, key=MASTER):
    return _client(api).post("/plugins/llm/invoke", json=body, headers={"x-internal-key": key})


@pytest.fixture
def llm(api):
    fake = FakeLlm(reply=[{"type": "text", "text": "Hi"}, {"type": "text", "text": " there."}],
                   usage={"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}, seen=[])

    async def build(feature, model, user_id):
        fake.built.append((feature, model, user_id))
        return fake, None

    with patch.object(api, "_build_feature_llm", side_effect=build):
        yield fake


# ── auth ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("key", [SCANNER, "", "wrong"])
def test_only_the_master_key(api, llm, key):
    assert _call(api, _body(), key=key).status_code == 401
    assert llm.seen == []


@pytest.mark.parametrize("weak", ["", "changeme"])
def test_a_weak_master_key_is_refused(api, llm, monkeypatch, weak):
    monkeypatch.setenv("INTERNAL_API_KEY", weak)
    res = _call(api, _body(), key=weak)
    assert res.status_code == 503
    assert "INTERNAL_API_KEY" in res.json()["error"]
    # Coded, with the model echoed: without them the webapp reads "the agent is outdated".
    assert res.json()["code"] == "agent_not_configured"
    assert res.json()["model_used"] == _body()["model"]
    assert llm.seen == []


def test_the_shared_agent_cap_is_not_charged(api, llm):
    """require_internal_auth would record the user in both limiters on every call."""
    import llm_guard
    for _ in range(3):
        assert _call(api, _body()).status_code == 200
    assert llm_guard._daily_cap._state == {}
    assert llm_guard._rate_limiter._state == {}
    # Control: a route guarded by require_internal_auth records the caller even when its
    # body is refused (422), so its handler (which would reach the network) never runs.
    res = _client(api).post("/models", json=[1], headers={"x-internal-key": MASTER})
    assert res.status_code == 422
    assert "anonymous" in llm_guard._daily_cap._state


# ── the call ────────────────────────────────────────────────────────────────

def test_success_returns_text_model_and_usage(api, llm):
    res = _call(api, _body())
    assert res.status_code == 200, res.text
    # Text parts joined as normalize_content joins them.
    assert res.json() == {
        "content": "Hi\n there.",
        "model_used": "openai/gpt-test",
        "usage": {"input_tokens": 12, "output_tokens": 3, "estimated": False},
    }
    assert llm.built == [("plugin:skiller", "openai/gpt-test", "user-1")]
    sent = llm.seen[0]["messages"]
    assert [type(m).__name__ for m in sent] == ["SystemMessage", "HumanMessage"]
    assert [m.content for m in sent] == ["Be brief.", "Hello"]


def test_assistant_turns_are_kept_in_order(api, llm):
    msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}]
    assert _call(api, _body(messages=msgs)).status_code == 200
    assert [type(m).__name__ for m in llm.seen[0]["messages"]] == ["HumanMessage", "AIMessage", "HumanMessage"]


def test_usage_is_estimated_when_the_provider_reports_none(api, llm):
    llm.usage = None
    llm.reply = "x" * 35
    out = _call(api, _body(messages=[{"role": "user", "content": "y" * 70}])).json()
    assert out["usage"] == {"input_tokens": 20, "output_tokens": 10, "estimated": True}


def test_max_tokens_and_temperature_are_applied_when_the_model_takes_them(api, llm):
    assert _call(api, _body(max_tokens=200, temperature=0.2)).status_code == 200
    assert llm.seen[-1]["max_tokens"] == 200 and llm.seen[-1]["temperature"] == 0.2
    assert llm.max_tokens == 4096, "the built model itself is not changed"


def test_temperature_is_left_alone_for_a_model_that_rejects_it(api, llm):
    llm.temperature = None   # what setup_llm leaves for reasoning models
    assert _call(api, _body(temperature=0.7)).status_code == 200
    assert llm.seen[-1]["temperature"] is None


# ── refusals ────────────────────────────────────────────────────────────────

def test_no_model_and_no_user_are_400(api, llm):
    assert _call(api, _body(model="")).status_code == 400
    assert _call(api, _body(user_id="")).status_code == 400
    assert llm.seen == []


@pytest.mark.parametrize("body,status,code", [
    (_body(messages=[{"role": "user", "content": "x"}] * 51), 413, "too_many_messages"),
    (_body(messages=[{"role": "user", "content": "x" * 600_000}, {"role": "user", "content": "y" * 400_001}]), 413, "messages_too_large"),
    (_body(messages=[]), 422, "invalid_messages"),
    (_body(messages=[{"role": "tool", "content": "x"}]), 422, "invalid_messages"),
    (_body(messages=[{"role": "user", "content": ["x"]}]), 422, "invalid_messages"),
    (_body(messages=[{"role": "user"}]), 422, "invalid_messages"),
    (_body(max_tokens=16_001), 422, "invalid_options"),
    (_body(max_tokens=0), 422, "invalid_options"),
    (_body(temperature=2.5), 422, "invalid_options"),
    (_body(temperature=-1), 422, "invalid_options"),
])
def test_limits(api, llm, body, status, code):
    res = _call(api, body)
    assert res.status_code == status, res.text
    assert res.json()["code"] == code
    assert res.json()["model_used"] == "openai/gpt-test"
    assert llm.seen == []


def test_fifty_messages_and_a_million_characters_are_fine(api, llm):
    msgs = [{"role": "user", "content": "x" * 20_000}] * 50
    assert _call(api, _body(messages=msgs, max_tokens=16_000)).status_code == 200


@pytest.mark.parametrize("code,status", [("model_unavailable", 503), ("providers_unreachable", 503)])
def test_coded_failures_pass_through(api, code, status):
    async def build(feature, model, user_id):
        return None, api._feature_error(code, model, status, "nope")

    with patch.object(api, "_build_feature_llm", side_effect=build):
        res = _call(api, _body())
    assert res.status_code == status
    assert res.json()["code"] == code
    assert res.json()["model_used"] == "openai/gpt-test"


def test_a_failed_call_is_a_502_with_the_model_echoed(api, llm):
    llm.error = "connection reset"
    res = _call(api, _body())
    assert res.status_code == 502
    assert res.json()["model_used"] == "openai/gpt-test"
