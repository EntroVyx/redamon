"""The SDK client against a scripted Gateway: every contract case, then the transport
failures a plugin can meet (timeout, nothing listening, redirects, oversized answers)."""

import asyncio
import json

import pytest

from redamon_plugin_sdk import GatewayTransport, PluginError, Sdk
from redamon_plugin_sdk.client import DEFAULT_TIMEOUT_SECONDS, LLM_TIMEOUT_SECONDS
from tests.support import context_kwargs, free_port, load_contract_cases, resolve_call

TOKEN = "call-token-for-tests"
CASES = load_contract_cases()


def _sdk(base_url: str, job_id=None, **transport_kwargs) -> Sdk:
    return Sdk(GatewayTransport(base_url, TOKEN, **transport_kwargs), job_id=job_id)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_contract_case(case, stub_server):
    resp = case["response"]
    if resp is not None:
        if "raw" in resp:
            stub_server.answer_raw(resp["status"], resp["raw"])
        else:
            stub_server.answer_json(resp["status"], resp["body"])
    sdk = _sdk(stub_server.base_url, job_id=context_kwargs(case)["job_id"])

    expect = case["expect"]
    if "error" in expect:
        with pytest.raises(PluginError) as caught:
            asyncio.run(resolve_call(sdk, case["call"]))
        assert caught.value.code == expect["error"]["code"]
        assert caught.value.message == expect["error"]["message"]
    else:
        assert asyncio.run(resolve_call(sdk, case["call"])) == expect["return"]

    if case["request"] is None:
        assert stub_server.requests == []
        return
    assert len(stub_server.requests) == 1
    sent = stub_server.requests[0]
    assert sent.method == case["request"]["method"]
    assert sent.path == case["request"]["path"]
    assert sent.json() == case["request"]["body"]
    assert sent.headers["authorization"] == f"Bearer {TOKEN}"
    assert sent.headers["content-type"] == "application/json"


def test_the_token_never_travels_in_the_url(stub_server):
    stub_server.answer_json(200, {"found": False})
    asyncio.run(_sdk(stub_server.base_url).data.get("notes", "k"))
    assert TOKEN not in stub_server.requests[0].path


def test_a_slow_gateway_raises_gateway_timeout(stub_server):
    stub_server.delay = 1.5
    stub_server.answer_json(200, {"found": False})
    sdk = _sdk(stub_server.base_url, timeout=0.3)
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.data.get("notes", "k"))
    assert caught.value.code == "gateway_timeout"


def test_a_gateway_that_is_not_listening_raises_gateway_unreachable():
    sdk = _sdk(f"http://127.0.0.1:{free_port()}", timeout=2)
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.data.get("notes", "k"))
    assert caught.value.code == "gateway_unreachable"


def test_a_redirect_is_not_followed(stub_server):
    stub_server.reply = lambda r: (302, {"Location": "http://127.0.0.1:1/elsewhere"}, b"")
    with pytest.raises(PluginError) as caught:
        asyncio.run(_sdk(stub_server.base_url).data.get("notes", "k"))
    assert caught.value.code == "gateway_error"
    assert len(stub_server.requests) == 1


def test_an_oversized_answer_is_refused(stub_server):
    stub_server.answer_json(200, {"found": True, "value": "x" * 5000})
    sdk = _sdk(stub_server.base_url, max_response_bytes=1024)
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.data.get("notes", "k"))
    assert caught.value.code == "gateway_response_too_large"


def test_an_error_body_without_a_code_keeps_the_status(stub_server):
    stub_server.answer_json(404, {"error": "Not found"})
    with pytest.raises(PluginError) as caught:
        asyncio.run(_sdk(stub_server.base_url).data.get("notes", "k"))
    assert caught.value.code == "gateway_error"
    assert "404" in caught.value.message


def test_a_value_that_is_not_json_is_refused_before_sending(stub_server):
    with pytest.raises(PluginError) as caught:
        asyncio.run(_sdk(stub_server.base_url).data.put("notes", "k", object()))
    assert caught.value.code == "invalid_value"
    assert stub_server.requests == []


def test_llm_calls_get_the_long_timeout_and_others_the_short_one(monkeypatch, stub_server):
    seen = []
    transport = GatewayTransport(stub_server.base_url, TOKEN)
    real = transport._post_blocking

    def spy(op, body, timeout):
        seen.append((op, timeout))
        return real(op, body, timeout)

    monkeypatch.setattr(transport, "_post_blocking", spy)
    sdk = Sdk(transport)
    stub_server.answer_json(200, {"content": "x", "model_used": "m", "usage": {}})
    asyncio.run(sdk.llm.invoke([{"role": "user", "content": "hi"}]))
    stub_server.answer_json(200, {"found": False})
    asyncio.run(sdk.data.get("notes", "k"))
    assert seen == [("llm/invoke", LLM_TIMEOUT_SECONDS), ("data/get", DEFAULT_TIMEOUT_SECONDS)]
    assert (LLM_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS) == (600, 30)


def test_calls_run_off_the_event_loop(stub_server):
    """A slow Gateway call must not freeze the worker's loop: other actions in the same
    worker and the supervisor's cancel message keep being served meanwhile."""
    stub_server.delay = 0.6
    stub_server.answer_json(200, {"found": False})
    sdk = _sdk(stub_server.base_url)

    async def main():
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.05)
                ticks += 1

        t = asyncio.create_task(ticker())
        await sdk.data.get("notes", "k")
        t.cancel()
        return ticks

    assert asyncio.run(main()) >= 5


def test_a_base_url_without_http_is_refused():
    with pytest.raises(ValueError):
        GatewayTransport("file:///etc/passwd", TOKEN)
    with pytest.raises(ValueError):
        GatewayTransport("http://gateway:7071", "")


def test_plugin_error_carries_code_and_message():
    e = PluginError("my_code", "Something went wrong.")
    assert (e.code, e.message, str(e)) == ("my_code", "Something went wrong.", "Something went wrong.")


def test_contract_file_is_valid_json_with_cases():
    assert len(CASES) >= 30
    json.dumps(CASES)
