"""Async actions (TD-22): the webapp has already created the job row; the supervisor runs
the action and reports its terminal state to the Gateway's `jobs/complete` with the job's
own call token, so the result reaches the webapp even though nobody waits on this call.
"""

from __future__ import annotations

from .workers import RunnerError

COMPLETE_PATH = "/api/plugin-gateway/v1/jobs/complete"


async def run_job(handle, *, client, settings, clock, logs, job_id: str, action_id: str,
                  params: dict, ctx: dict, token: str, timeout: float) -> None:
    try:
        answer = await handle.invoke(action_id, params, ctx, token, timeout, job_id=job_id)
    except RunnerError as e:
        body = {"status": "failed", "error": {"code": e.code, "message": e.message}}
    else:
        if answer.get("ok"):
            body = {"status": "succeeded", "result": answer["result"]}
        else:
            body = {"status": "failed", "error": answer["error"]}
    await report(client=client, settings=settings, clock=clock, logs=logs, handle=handle,
                 job_id=job_id, token=token, body=body)


async def report(*, client, settings, clock, logs, handle, job_id: str, token: str, body: dict) -> bool:
    """POSTs the terminal state; retries a transport failure or a 5xx answer
    `len(settings.job_report_delays)` times. A 4xx (job unknown, already terminal, token
    expired) is final."""
    url = settings.gateway_url + COMPLETE_PATH
    attempts = len(settings.job_report_delays) + 1
    for attempt in range(attempts):
        try:
            r = await client.post(url, json=body, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        except Exception:
            status = None
        else:
            status = r.status_code
            if status < 500:
                if status >= 300:
                    logs.event(handle.plugin_id, handle.version,
                               f"job {job_id}: the webapp refused its result (HTTP {status})")
                return 200 <= status < 300
        if attempt < attempts - 1:
            await clock.sleep(settings.job_report_delays[attempt])
    logs.event(handle.plugin_id, handle.version,
               f"job {job_id}: the result could not be reported to the webapp after {attempts} attempts")
    return False
