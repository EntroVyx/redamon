"""Async actions (TD-22): the webapp has already created the job row; the supervisor runs
the action and reports its terminal state to the Gateway's `jobs/complete` with the job's
own call token, so the result reaches the webapp even though nobody waits on this call.
"""

from __future__ import annotations

import json

from .workers import RunnerError

COMPLETE_PATH = "/api/plugin-gateway/v1/jobs/complete"
# Every attempt, with the waits between them, must end within the webapp's grace after the
# action's timeout (JOB_GRACE_SECONDS, 60 s): past it the job token is refused and the job
# reads as a timeout. 4 attempts of 10 s and 7 s of waits take at most 47 s.
REPORT_ATTEMPT_TIMEOUT_SECONDS = 10
UNSENDABLE = {"status": "failed", "error": {
    "code": "invalid_result",
    "message": "The plugin's result holds text that cannot be sent as UTF-8 (an unpaired surrogate) "
               "or a number JSON cannot hold."}}


def _encoded(body: dict) -> bytes:
    """The report as UTF-8 JSON. Text a plugin decoded with `surrogateescape` holds unpaired
    surrogates, which no UTF-8 body can carry: such a report becomes `invalid_result` here,
    or every attempt would fail as if the network had and the job would never end."""
    try:
        return json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        return json.dumps(UNSENDABLE, separators=(",", ":")).encode("utf-8")


async def run_job(handle, *, client, settings, clock, logs, job_id: str, action_id: str,
                  params: dict, ctx: dict, token: str, timeout: float) -> None:
    try:
        answer = await handle.invoke(action_id, params, ctx, token, timeout, job_id=job_id)
    except RunnerError as e:
        answer = {"ok": False, "error": {"code": e.code, "message": e.message}}
    # Only a cancel the webapp asked for makes the job `cancelled`, never a plugin's own code.
    cancelled = handle.cancelled_jobs.pop(job_id, None) is not None
    if answer.get("ok"):
        body = {"status": "succeeded", "result": answer["result"]}
    else:
        body = {"status": "cancelled" if cancelled else "failed", "error": answer["error"]}
    await report(client=client, settings=settings, clock=clock, logs=logs, handle=handle,
                 job_id=job_id, token=token, body=body)


async def report(*, client, settings, clock, logs, handle, job_id: str, token: str, body: dict) -> bool:
    """POSTs the terminal state; retries a transport failure, a 429 or a 5xx answer
    `len(settings.job_report_delays)` times. Another 4xx (job unknown, token expired) is
    final."""
    url = settings.gateway_url + COMPLETE_PATH
    content = _encoded(body)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    attempts = len(settings.job_report_delays) + 1
    for attempt in range(attempts):
        try:
            r = await client.post(url, content=content, headers=headers, timeout=REPORT_ATTEMPT_TIMEOUT_SECONDS)
        except Exception:
            status = None
        else:
            status = r.status_code
            if status < 500 and status != 429:
                if status >= 300:
                    logs.event(handle.plugin_id, handle.version,
                               f"job {job_id}: the webapp refused its result (HTTP {status})")
                return 200 <= status < 300
        if attempt < attempts - 1:
            await clock.sleep(settings.job_report_delays[attempt])
    logs.event(handle.plugin_id, handle.version,
               f"job {job_id}: the result could not be reported to the webapp after {attempts} attempts")
    return False
