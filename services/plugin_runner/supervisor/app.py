"""The supervisor's HTTP API on port 7080, reached by the webapp through the plugin-gateway
proxy (:7072). Every route, including an unknown one, demands the runner key first.

    GET  /runner/v1/health
    POST /runner/v1/reload
    POST /runner/v1/plugins/{id}/actions/{action}      sync 200 | async 202 {jobId}
    POST /runner/v1/plugins/{id}/jobs/{jobId}/cancel
    GET  /runner/v1/plugins/{id}/logs?lines=N

Errors are `{error, code}`. A PluginError raised by an action is a result, not a runner
failure: 200 `{ok: false, error}`. The wire format is pinned by
tests/runner_contract_cases.json, shared with the webapp's fake runner.
"""

from __future__ import annotations

import asyncio
import contextlib

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import auth, jobs
from .clock import SYSTEM_CLOCK
from .config import DEFAULT_PORT, Settings
from .logs import LogBuffer
from .manager import Manager
from .runlist import PLUGIN_ID_RE
from .workers import RunnerError

LOG_LINES_DEFAULT = 200


def _bad(message: str) -> JSONResponse:
    return auth.error(400, "bad_request", message)


def _action_body(body) -> tuple:
    """Validated (params, ctx, token, timeout, is_async, job_id), or raises ValueError."""
    if not isinstance(body, dict):
        raise ValueError("The body is not a JSON object.")
    token, params, ctx = body.get("token"), body.get("params"), body.get("ctx")
    timeout, is_async, job_id = body.get("timeoutSeconds"), body.get("async", False), body.get("jobId")
    if not isinstance(token, str) or not token:
        raise ValueError("token is required.")
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object.")
    if not isinstance(ctx, dict) or not all(isinstance(ctx.get(k), str) and ctx.get(k)
                                            for k in ("pluginId", "version", "userId")):
        raise ValueError("ctx needs pluginId, version and userId.")
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout < 1:
        raise ValueError("timeoutSeconds must be a number of at least 1.")
    if not isinstance(is_async, bool):
        raise ValueError("async must be true or false.")
    if job_id is not None and (not isinstance(job_id, str) or not job_id or len(job_id) > 200):
        raise ValueError("jobId must be a short string.")
    if is_async and job_id is None:
        raise ValueError("An async action needs the jobId the webapp created.")
    return params, ctx, token, float(timeout), is_async, job_id


def create_app(settings: Settings, *, clock=SYSTEM_CLOCK, logs: LogBuffer | None = None) -> FastAPI:
    logs = logs or LogBuffer(max_lines=settings.log_lines)
    state: dict = {}

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        client = httpx.AsyncClient(trust_env=False, follow_redirects=False)
        manager = Manager(settings, logs, clock, client)
        state["manager"] = manager
        app.state.manager = manager
        if settings.configured:
            await manager.reload()
            reloader = asyncio.create_task(manager.periodic())
        else:
            manager.log("PLUGIN_RUNNER_KEY is not set: every route answers 503 and no plugin runs")
            reloader = None
        try:
            yield
        finally:
            if reloader:
                reloader.cancel()
            await manager.stop_all()
            await client.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def require_key(request: Request, call_next):
        refused = auth.refusal(settings, request.headers.get(auth.HEADER))
        if refused is not None:
            return refused
        return await call_next(request)

    @app.get("/runner/v1/health")
    async def health():
        return state["manager"].health()

    @app.post("/runner/v1/reload")
    async def reload():
        manager = state["manager"]
        result = await manager.reload()
        return {"ok": result == "ok", "state": result, "workers": len(manager.workers)}

    @app.post("/runner/v1/plugins/{plugin_id}/actions/{action_id}")
    async def action(plugin_id: str, action_id: str, request: Request):
        manager = state["manager"]
        try:
            body = await request.json()
        except ValueError:
            return _bad("The body is not JSON.")
        try:
            params, ctx, token, timeout, is_async, job_id = _action_body(body)
        except ValueError as e:
            return _bad(str(e))
        if manager.state == "out_of_date":
            return auth.error(503, "runner_out_of_date",
                              "The plugin runner is out of date for this RedAmon version; rebuild it.")
        handle = manager.find(plugin_id, ctx["version"]) if PLUGIN_ID_RE.match(plugin_id) else None
        if handle is None:
            return auth.error(404, "unknown_plugin", f"Plugin {plugin_id} {ctx['version']} is not running.")
        declared = handle.actions.get(action_id)
        if declared is None:
            return auth.error(404, "unknown_action", f"Plugin {plugin_id} declares no action {action_id}.")
        effective = min(timeout, declared.timeout_seconds, settings.action_max_timeout)
        if is_async:
            if manager.job_running(plugin_id, job_id):
                return auth.error(409, "job_running", f"Job {job_id} is already running.")
            task = asyncio.create_task(jobs.run_job(
                handle, client=manager.client, settings=settings, clock=clock, logs=logs, job_id=job_id,
                action_id=action_id, params=params, ctx=ctx, token=token, timeout=effective))
            manager.job_tasks.add(task)
            task.add_done_callback(manager.job_tasks.discard)
            # Registered before answering, so a cancel that follows the 202 finds the job.
            await asyncio.sleep(0)
            return JSONResponse(status_code=202, content={"jobId": job_id})
        try:
            return await handle.invoke(action_id, params, ctx, token, effective)
        except RunnerError as e:
            return auth.error(e.status, e.code, e.message)

    @app.post("/runner/v1/plugins/{plugin_id}/jobs/{job_id}/cancel")
    async def cancel(plugin_id: str, job_id: str):
        if await state["manager"].cancel(plugin_id, job_id):
            return {"ok": True}
        return auth.error(404, "unknown_job", f"Job {job_id} is not running.")

    @app.get("/runner/v1/plugins/{plugin_id}/logs")
    async def plugin_logs(plugin_id: str, lines: str = str(LOG_LINES_DEFAULT)):
        try:
            n = int(lines)
        except ValueError:
            n = LOG_LINES_DEFAULT
        n = max(1, min(settings.log_lines, n))
        return {"lines": logs.tail(plugin_id, n)}

    return app


def main() -> None:
    import uvicorn
    uvicorn.run(create_app(Settings.from_env()), host="0.0.0.0", port=DEFAULT_PORT,
                log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
