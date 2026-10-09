"""Async actions: 202 at once, then the terminal state reported to the Gateway's
`jobs/complete` with the job's own token, retried, and cancellable (TD-22)."""

import time

from tests.support import install_plugin, wait_until

COMPLETE = "/api/plugin-gateway/v1/jobs/complete"

STUBBORN = (
    "import asyncio\n\n"
    "async def stubborn(ctx, params):\n"
    "    while True:\n"
    "        try:\n"
    "            await asyncio.sleep(10)\n"
    "        except asyncio.CancelledError:\n"
    "            continue\n"
)


def _done(h, n=1, timeout=10.0):
    wait_until(lambda: len(h.completions) >= n, timeout=timeout)
    return h.completions[n - 1]


def test_an_async_action_answers_202_then_reports_success(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.act("echo", "sleep", {"seconds": 0.2}, async_=True, job_id="job-1", token="job-token-1")
    assert r.status_code == 202 and r.json() == {"jobId": "job-1"}
    req = _done(h)
    assert req.method == "POST" and req.path == COMPLETE
    assert req.headers["authorization"] == "Bearer job-token-1"
    assert req.json() == {"status": "succeeded", "result": {"slept": 0.2}}


def test_an_async_action_needs_a_job_id(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.act("echo", "sleep", async_=True)
    assert r.status_code == 400 and r.json()["code"] == "bad_request"


def test_a_plugin_error_is_reported_as_failed(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "raise_plugin_error", {"code": "nope", "message": "No."}, async_=True, job_id="j2")
    assert _done(h).json() == {"status": "failed", "error": {"code": "nope", "message": "No."}}


def test_a_crash_is_reported_as_failed(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "crash", async_=True, job_id="j3")
    assert _done(h).json()["error"]["code"] == "worker_crashed"


def test_a_timeout_is_reported_as_failed(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "sleep", {"seconds": 30}, async_=True, job_id="j4", timeout=1)
    assert _done(h, timeout=10).json()["error"]["code"] == "action_timeout"


def test_the_report_is_retried_on_a_server_error(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.complete_statuses = [503, 502]
    h.act("echo", "echo", async_=True, job_id="j5")
    _done(h, 3)
    time.sleep(0.3)
    assert len(h.completions) == 3


def test_the_report_gives_up_after_three_retries(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.complete_statuses = [500, 500, 500, 500, 500]
    h.act("echo", "echo", async_=True, job_id="j6")
    _done(h, 4)
    time.sleep(0.3)
    assert len(h.completions) == 4
    logs = h.get("/runner/v1/plugins/echo/logs?lines=50").json()["lines"]
    assert any("j6" in line and "could not be reported" in line for line in logs)


def test_a_refused_report_is_not_retried(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.complete_statuses = [409]
    h.act("echo", "echo", async_=True, job_id="j7")
    _done(h)
    time.sleep(0.3)
    assert len(h.completions) == 1


def test_cancel_stops_a_running_job(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "sleep", {"seconds": 30}, async_=True, job_id="j8")
    wait_until(lambda: h.health()["workers"][0]["inFlight"] == 1)
    r = h.post("/runner/v1/plugins/echo/jobs/j8/cancel")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert _done(h, timeout=5).json() == {"status": "failed", "error": {
        "code": "cancelled", "message": "The action was cancelled."}}


def test_cancel_of_an_unknown_job_is_404(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post("/runner/v1/plugins/echo/jobs/no-such-job/cancel")
    assert r.status_code == 404 and r.json()["code"] == "unknown_job"


def test_a_job_that_ignores_cancel_is_killed_after_the_grace_period(runner, plugins_dir):
    entry = install_plugin(plugins_dir, extra_files={"engine/stubborn.py": STUBBORN})
    entry["manifest"]["actions"].append({"id": "stubborn", "entry": "engine/stubborn.py:stubborn",
                                          "timeoutSeconds": 60, "async": True})
    h = runner([entry], kill_grace=0.5)
    pid = h.health()["workers"][0]["pid"]
    h.act("echo", "stubborn", async_=True, job_id="j9")
    wait_until(lambda: h.health()["workers"][0]["inFlight"] == 1)
    h.post("/runner/v1/plugins/echo/jobs/j9/cancel")
    assert _done(h, timeout=5).json()["error"]["code"] == "cancelled"
    wait_until(lambda: h.restarted_from(pid))


def test_a_job_id_already_running_is_refused(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    assert h.act("echo", "sleep", {"seconds": 2}, async_=True, job_id="dup").status_code == 202
    r = h.act("echo", "sleep", {"seconds": 2}, async_=True, job_id="dup")
    assert r.status_code == 409 and r.json()["code"] == "job_running"
