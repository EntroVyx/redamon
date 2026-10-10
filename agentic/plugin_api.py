"""Agent endpoints for the plugin platform.

The webapp reads the overridable built-in skill parts here (its reconciliation compares
their hashes with stored overrides and marks changed ones stale) and validates proposed
values with the same rules the seam applies at use (prompts/skill_part_seam.py).
Plugins call a model through `/plugins/llm/invoke`, via the webapp's Gateway, so a
provider key never leaves the agent.

Master key only. No endpoint here reads a project's settings: the parts are factory
text, public in the repository, and a model call outside a session task would read
another tenant's last-loaded settings.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from llm_guard import master_key_is_weak, require_master_internal_auth
from prompts import skill_parts

router = APIRouter(prefix="/plugins", tags=["Plugins"],
                   dependencies=[Depends(require_master_internal_auth)])


def _weak_key_refusal() -> JSONResponse:
    # require_master_internal_auth fails open on a dev install with no key; these
    # endpoints decide what reaches every session's prompt, so they refuse instead.
    return JSONResponse(status_code=503, content={
        "error": "INTERNAL_API_KEY is not configured; the plugin platform's skill endpoints "
                 "are disabled. Generate the secret via redamon.sh."})


def _weak_key_refusal_llm(model: str) -> JSONResponse:
    # Coded and with the model echoed, as every answer of this endpoint: without them the
    # webapp reads the refusal as an agent older than itself.
    return JSONResponse(status_code=503, content={
        "error": "INTERNAL_API_KEY is not configured; the plugin platform's model endpoint "
                 "is disabled. Generate the secret via redamon.sh.",
        "code": "agent_not_configured", "model_used": model})


def _unknown_skill(skill_id: str) -> JSONResponse:
    return JSONResponse(status_code=404, content={"error": f"unknown skill {skill_id!r}"})


def _part_json(part: skill_parts.SkillPart) -> dict:
    return {
        "partId": part.part_id,
        "constant": part.constant,
        "kind": part.kind,
        "placeholders": sorted(part.placeholders),
        "sha256": part.sha256,
        "chars": len(part.text),
        "maxChars": skill_parts.max_part_chars(part),
        "order": part.order,
        "gate": part.gate,
        "text": part.text,
    }


@router.get("/skill-parts")
async def list_skill_parts(skill: Optional[str] = Query(default=None)):
    """Every overridable built-in skill part, or one skill's with ?skill=<id>.

    `maxChars` are the validator's own limits (per part, and for the whole skill under
    PLUGIN_SKILL_TEXT_MAX_GROWTH), so a plugin can keep a proposal within them.
    """
    if master_key_is_weak():
        return _weak_key_refusal()
    ids = skill_parts.skill_ids()
    if skill is not None:
        if skill not in ids:
            return _unknown_skill(skill)
        ids = (skill,)
    return {"skills": [{"id": s, "maxChars": skill_parts.skill_total_limit(s),
                        "parts": [_part_json(p) for p in skill_parts.parts_of(s)]}
                       for s in ids]}


class ValidateSkillPartsRequest(BaseModel):
    skillId: str
    parts: Dict[str, str]


@router.post("/skill-parts/validate")
async def validate_skill_parts(body: ValidateSkillPartsRequest):
    """Validate proposed values for parts of one skill, then the whole skill they make."""
    if master_key_is_weak():
        return _weak_key_refusal()
    skill_id = body.skillId
    factory_parts = skill_parts.parts_of(skill_id)
    if not factory_parts:
        return _unknown_skill(skill_id)

    parts_out, known = {}, {}
    for part_id, value in body.parts.items():
        part = skill_parts.get_part(skill_id, part_id)
        if part is None:
            parts_out[part_id] = {"errors": [f"unknown part {skill_id}/{part_id}"],
                                  "chars": len(value), "maxChars": 0}
            continue
        known[part_id] = value
        parts_out[part_id] = {"errors": skill_parts.validate_part_value(part, value),
                              "chars": len(value), "maxChars": skill_parts.max_part_chars(part)}

    skill_errors = skill_parts.validate_skill_total(skill_id, known)
    return {
        "ok": not skill_errors and not any(p["errors"] for p in parts_out.values()),
        "parts": parts_out,
        "skill": {
            "errors": skill_errors,
            "chars": sum(len(known.get(p.part_id, p.text)) for p in factory_parts),
            "maxChars": skill_parts.skill_total_limit(skill_id),
        },
    }


# ── /plugins/llm/invoke ─────────────────────────────────────────────────────

LLM_MAX_MESSAGES = 50
LLM_MAX_TOTAL_CHARS = 1_000_000
LLM_MAX_TOKENS = 16_000
_ROLES = ("system", "user", "assistant")
# The same crude rate the agent uses when a provider reports no usage.
_CHARS_PER_TOKEN = 3.5


class PluginLlmRequest(BaseModel):
    user_id: Optional[str] = None
    plugin_id: str
    model: Optional[str] = None
    messages: Any = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


def _llm_refusal(status: int, code: str, error: str, model: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": error, "code": code, "model_used": model})


def _to_messages(raw: Any, model: str):
    """LangChain messages, or the coded refusal to return."""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    kinds = {"system": SystemMessage, "user": HumanMessage, "assistant": AIMessage}
    if not isinstance(raw, list) or not raw:
        return None, _llm_refusal(422, "invalid_messages", "messages must be a non-empty list", model)
    if len(raw) > LLM_MAX_MESSAGES:
        return None, _llm_refusal(413, "too_many_messages",
                                  f"at most {LLM_MAX_MESSAGES} messages per call", model)
    out, total = [], 0
    for m in raw:
        if not isinstance(m, dict) or m.get("role") not in _ROLES or not isinstance(m.get("content"), str):
            return None, _llm_refusal(422, "invalid_messages",
                                      "each message is {role: system|user|assistant, content: text}", model)
        total += len(m["content"])
        out.append(kinds[m["role"]](content=m["content"]))
    if total > LLM_MAX_TOTAL_CHARS:
        return None, _llm_refusal(413, "messages_too_large",
                                  f"at most {LLM_MAX_TOTAL_CHARS} characters per call", model)
    return out, None


def _with_options(llm, max_tokens: Optional[int], temperature: Optional[float]):
    """A copy of `llm` with the call's options, only where the built model takes them.

    setup_llm leaves `temperature` unset for the models that reject it (reasoning
    families), so a temperature is applied only over an existing one; the token limit
    goes to whichever field this provider's class has.
    """
    fields = getattr(type(llm), "model_fields", {})
    update: dict = {}
    if max_tokens is not None:
        name = next((f for f in ("max_tokens", "max_output_tokens", "max_completion_tokens") if f in fields), None)
        if name:
            update[name] = max_tokens
    if temperature is not None and "temperature" in fields and getattr(llm, "temperature", None) is not None:
        update["temperature"] = temperature
    return llm.model_copy(update=update) if update else llm


def _usage(response, messages, content: str) -> dict:
    meta = getattr(response, "usage_metadata", None) or {}
    inp, out = meta.get("input_tokens"), meta.get("output_tokens")
    if isinstance(inp, int) and isinstance(out, int):
        return {"input_tokens": inp, "output_tokens": out, "estimated": False}
    sent = sum(len(m.content) for m in messages)
    return {"input_tokens": math.ceil(sent / _CHARS_PER_TOKEN),
            "output_tokens": math.ceil(len(content) / _CHARS_PER_TOKEN), "estimated": True}


@router.post("/llm/invoke")
async def plugin_llm_invoke(body: PluginLlmRequest):
    """Runs one plugin model call on the model the user chose for that plugin.

    Only the router's master-key guard: `require_internal_auth` would charge the shared
    per-user agent cap, while plugin calls have their own daily cap in the webapp. Every
    answer echoes `model_used`, the webapp's sign of an agent that knows this endpoint.
    """
    import api as agent_api  # the feature-model helpers; api imports this module
    from orchestrator_helpers import normalize_content

    model = (body.model or "").strip()
    if master_key_is_weak():
        return _weak_key_refusal_llm(model)
    missing = agent_api._feature_request_error(model, body.user_id)
    if missing:
        return missing
    if body.max_tokens is not None and not 1 <= body.max_tokens <= LLM_MAX_TOKENS:
        return _llm_refusal(422, "invalid_options", f"max_tokens is 1 to {LLM_MAX_TOKENS}", model)
    if body.temperature is not None and not (math.isfinite(body.temperature) and 0 <= body.temperature <= 2):
        return _llm_refusal(422, "invalid_options", "temperature is 0 to 2", model)
    messages, refused = _to_messages(body.messages, model)
    if refused:
        return refused

    feature = f"plugin:{body.plugin_id}"
    llm, failure = await agent_api._build_feature_llm(feature, model, body.user_id)
    if failure:
        return failure
    response, failure = await agent_api._invoke_feature_llm(
        feature, model, _with_options(llm, body.max_tokens, body.temperature), messages)
    if failure:
        return failure
    content = normalize_content(response.content)
    return {"content": content, "model_used": model, "usage": _usage(response, messages, content)}
