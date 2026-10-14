"""The supervisor API cases shared with the webapp's fake runner, against the real app."""

import json
from pathlib import Path

import pytest

from tests.support import install_plugin, run_list, wait_until

CONTRACT = json.loads((Path(__file__).parent / "runner_contract_cases.json").read_text())


def _send(h, request):
    headers = {}
    if request["key"] == "valid":
        headers["X-Plugin-Runner-Key"] = CONTRACT["runnerKey"]
    elif request["key"] is not None:
        headers["X-Plugin-Runner-Key"] = request["key"]
    if request["method"] == "GET":
        return h.client.get(request["path"], headers=headers)
    return h.client.post(request["path"], headers=headers, json=request.get("body"))


def _check(response, expect):
    assert response.status_code == expect["status"], response.text
    body = response.json()
    if "body" in expect:
        assert body == expect["body"]
    if "bodyIncludes" in expect:
        assert {k: body.get(k) for k in expect["bodyIncludes"]} == expect["bodyIncludes"]
    if "keys" in expect:
        assert sorted(body) == sorted(expect["keys"])
    if "code" in expect:
        assert body["code"] == expect["code"]


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=[c["name"] for c in CONTRACT["cases"]])
def test_contract_case(runner, plugins_dir, case):
    entry = install_plugin(plugins_dir)
    h = runner([entry], runner_key=CONTRACT["runnerKey"])
    if case.get("runnerState") == "out_of_date":
        h.run_list = run_list([entry], platform="0.0.1")
        assert _send(h, {"method": "POST", "path": "/runner/v1/reload", "key": "valid"}).json()["state"] == "out_of_date"
    for request in case.get("before", []):
        _send(h, request)
    _check(_send(h, case["request"]), case["expect"])


def test_a_runner_with_no_key(runner, plugins_dir):
    case = CONTRACT["unconfigured"]
    h = runner([install_plugin(plugins_dir)], runner_key="")
    _check(_send(h, case["request"]), case["expect"])


def test_the_job_report_has_the_documented_shape(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], runner_key=CONTRACT["runnerKey"])
    async_case = next(c for c in CONTRACT["cases"] if c["name"] == "an async action")
    _send(h, async_case["request"])
    wait_until(lambda: h.completions)
    assert h.completions[0].json() == CONTRACT["jobsComplete"]["succeeded"]
    assert h.completions[0].headers["authorization"] == "Bearer job-token"


def test_a_timed_out_job_report_has_the_documented_shape(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir, action_changes={"sleep": {"timeoutSeconds": 1}})],
               runner_key=CONTRACT["runnerKey"])
    h.act("echo", "sleep", {"seconds": 30}, async_=True, job_id="slow-job", timeout=30)
    wait_until(lambda: h.completions)
    got = h.completions[0].json()
    assert set(got) == set(CONTRACT["jobsComplete"]["failed"])
    assert got["status"] == "failed" and got["error"]["code"] == "action_timeout"
    assert set(got["error"]) == {"code", "message"}


def test_a_cancelled_job_report_has_the_documented_shape(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], runner_key=CONTRACT["runnerKey"])
    assert h.act("echo", "sleep", {"seconds": 30}, async_=True, job_id="cancel-me", timeout=30).status_code == 202
    assert h.post("/runner/v1/plugins/echo/jobs/cancel-me/cancel").status_code == 200
    wait_until(lambda: h.completions, timeout=20)
    assert h.completions[0].json() == CONTRACT["jobsComplete"]["cancelled"]


def test_an_async_action_runs_with_its_job_id_in_the_context(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)], runner_key=CONTRACT["runnerKey"])
    # The webapp sends the job id once, in the body; the plugin's ctx.job_id comes from it.
    r = h.act("echo", "echo", {"x": 1}, async_=True, job_id="ctx-job",
              ctx={"pluginId": "echo", "version": "1.0.0", "userId": "user-1"})
    assert r.status_code == 202 and r.json()["bootId"] == h.health()["bootId"]
    wait_until(lambda: h.completions)
    assert h.completions[0].json()["result"]["job"] == "ctx-job"
