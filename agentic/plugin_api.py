"""Agent endpoints for the plugin platform's skill.text extension point.

The webapp reads the overridable built-in skill parts here (its reconciliation compares
their hashes with stored overrides and marks changed ones stale) and validates proposed
values with the same rules the seam applies at use (prompts/skill_part_seam.py).
Master key only. Neither endpoint reads a project's settings: the parts are factory
text, public in the repository.
"""

from __future__ import annotations

from typing import Dict, Optional

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
        "order": part.order,
        "gate": part.gate,
        "text": part.text,
    }


@router.get("/skill-parts")
async def list_skill_parts(skill: Optional[str] = Query(default=None)):
    """Every overridable built-in skill part, or one skill's with ?skill=<id>."""
    if master_key_is_weak():
        return _weak_key_refusal()
    ids = skill_parts.skill_ids()
    if skill is not None:
        if skill not in ids:
            return _unknown_skill(skill)
        ids = (skill,)
    return {"skills": [{"id": s, "parts": [_part_json(p) for p in skill_parts.parts_of(s)]}
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
