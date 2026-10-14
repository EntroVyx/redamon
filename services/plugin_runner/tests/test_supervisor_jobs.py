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


def _done(h, n=1, timeout=30.0):
    wait_until(lambda: len(h.completions) >= n, timeout=timeout)
    return h.completions[n - 1]


def test_an_async_action_answers_202_then_reports_success(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.act("echo", "sleep", {"seconds": 0.2}, async_=True, job_id="job-1", token="job-token-1")
    assert r.status_code == 202 and r.json() == {"jobId": "job-1", "bootId": h.health()["bootId"]}
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
    h.act("echo", "sleep", {"seconds": 60}, async_=True, job_id="j4", timeout=1)
    # Well before the 60 s sleep would end on its own.
    assert _done(h, timeout=25).json()["error"]["code"] == "action_timeout"


def test_the_report_is_retried_on_a_server_error(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.complete_statuses = [503, 502]
    h.act("echo", "echo", async_=True, job_id="j5")
    _done(h, 3)
    time.sleep(0.3)
    assert len(h.completions) == 3


def test_the_report_is_retried_when_the_gateway_is_rate_limited(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.complete_statuses = [429]
    h.act("echo", "echo", async_=True, job_id="j10")
    _done(h, 2)
    time.sleep(0.3)
    assert len(h.completions) == 2


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
    h.act("echo", "sleep", {"seconds": 60}, async_=True, job_id="j8")
    wait_until(lambda: h.health()["workers"][0]["inFlight"] == 1)
    r = h.post("/runner/v1/plugins/echo/jobs/j8/cancel")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert _done(h, timeout=25).json() == {"status": "cancelled", "error": {
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
    report = _done(h, timeout=25).json()
    assert report["status"] == "cancelled" and report["error"]["code"] == "cancelled"
    wait_until(lambda: h.restarted_from(pid), timeout=45)


def test_a_plugin_error_coded_cancelled_is_still_a_failure(runner, plugins_dir):
    # Only a cancel the webapp asked for makes a job `cancelled`.
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "raise_plugin_error", {"code": "cancelled", "message": "Mine."}, async_=True, job_id="j11")
    assert _done(h).json() == {"status": "failed", "error": {"code": "cancelled", "message": "Mine."}}


def test_a_job_id_already_running_is_refused(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    assert h.act("echo", "sleep", {"seconds": 2}, async_=True, job_id="dup").status_code == 202
    r = h.act("echo", "sleep", {"seconds": 2}, async_=True, job_id="dup")
    assert r.status_code == 409 and r.json()["code"] == "job_running"


SURROGATE = (
    "async def surrogate(ctx, params):\n"
    "    # Bytes a tool printed, decoded as Python does for undecodable output.\n"
    "    return {'out': b'ok \\xff'.decode('utf-8', 'surrogateescape')}\n"
)


def test_a_result_that_cannot_be_sent_is_reported_as_failed_not_retried_forever(runner, plugins_dir):
    # httpx encodes a body as UTF-8, which an unpaired surrogate is not: the report used to
    # fail as if the network had, be retried, and leave the job running to its deadline.
    entry = install_plugin(plugins_dir, extra_files={"engine/surrogate.py": SURROGATE})
    entry["manifest"]["actions"].append({"id": "surrogate", "entry": "engine/surrogate.py:surrogate",
                                          "timeoutSeconds": 30, "async": True})
    h = runner([entry])
    h.act("echo", "surrogate", async_=True, job_id="j12")
    report = _done(h).json()
    assert report["status"] == "failed" and report["error"]["code"] == "invalid_result"
    time.sleep(0.3)
    assert len(h.completions) == 1


def test_every_report_attempt_fits_in_the_job_grace_the_webapp_allows():
    # The job token and the job's deadline outlive the action by the webapp's grace: a
    # report still retrying after it is refused (401) and the job reads as a timeout.
    import re
    from pathlib import Path

    from supervisor import jobs
    from supervisor.config import Settings

    actions = Path(__file__).resolve().parents[3] / "webapp/src/lib/plugins/actions.ts"
    grace = int(re.search(r"JOB_GRACE_SECONDS = (\d+)", actions.read_text()).group(1))
    delays = Settings.__dataclass_fields__["job_report_delays"].default
    window = jobs.REPORT_ATTEMPT_TIMEOUT_SECONDS * (len(delays) + 1) + sum(delays)
    assert window < grace
