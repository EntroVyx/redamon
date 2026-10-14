"""The runner key check: auth-only and fail closed in both directions (TD-08). Modelled on
the agent's require_internal_auth_only (agentic/llm_guard.py) without its fail-open branch:
no key configured means no request is accepted."""

import hmac

from fastapi.responses import JSONResponse

HEADER = "X-Plugin-Runner-Key"


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message, "code": code})


def refusal(settings, presented) -> JSONResponse | None:
    """None when the request may proceed, else the response to send."""
    if not settings.configured:
        return error(503, "runner_not_configured", "The plugin runner has no key configured.")
    if not isinstance(presented, str) or not hmac.compare_digest(
            presented.encode("utf-8"), settings.runner_key.encode("utf-8")):
        return error(401, "unauthorized", "Invalid or missing runner key.")
    return None
