"""The one place where an approved plugin override can replace built-in skill text.

Every registered append site in build_builtin_skill_workflow and
build_deserialization_parts calls resolve_skill_part through this module (so one patch
reaches them all). With no qualifying override it returns exactly what the site
appended before the plugin platform existed.

Overrides arrive as data in the session's settings (SKILL_TEXT_OVERRIDES, filled by
fetch_agent_settings from the webapp's skillTextOverrides). They are read from the
session ContextVar only: outside a session task get_settings() falls back to the
module-global snapshot of whichever tenant loaded last, and that tenant's approved text
must never reach another prompt.

A skill's overrides apply whole or not at all: one stale, invalid or foreign entry makes
every part of that skill render factory text, so the agent never runs half of a version.
Nothing here raises past the factory render.
"""

from __future__ import annotations

import contextvars
import logging
from collections import OrderedDict
from typing import Optional

from prompts import skill_parts

logger = logging.getLogger(__name__)

FACTORY_REVISION = 1
SETTINGS_KEY = "SKILL_TEXT_OVERRIDES"
_ENTRY_STR_FIELDS = ("value", "baseSha256", "overrideId", "changeSetId", "pluginId")

# {skillId, revision, changeSetId} of the workflow the last build rendered in this context,
# or None. Revision numbers restart per scope (user, project), so the change set is what
# identifies a version; it is None for factory text.
# LangGraph runs each node in a copied context, so the root think node copies this into
# its state update (_skill_workflow) for phase_update to carry; it never leaves the node
# on its own.
applied_skill_workflow: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "applied_skill_workflow", default=None)

# Usability per settings snapshot, keyed by the overrides dict's identity. The dict itself
# is kept in the entry so its id cannot be reused by another dict while cached; the result
# is never written back into the settings, which are shared with fireteam members.
_CACHE_SIZE = 8
_cache: "OrderedDict[int, tuple[dict, dict]]" = OrderedDict()


def _reset_cache() -> None:
    _cache.clear()


def _for_log(text, limit: int = 2000) -> str:
    """One log line: line breaks and other unprintable characters escaped, so text taken
    from an override can never start a forged line in the agent log."""
    out = "".join(ch if ch.isprintable() else ch.encode("unicode_escape").decode("ascii")
                  for ch in str(text))
    return out if len(out) <= limit else out[:limit] + "..."


def _session_overrides() -> dict:
    import project_settings
    settings = project_settings._settings_ctx.get()
    if not isinstance(settings, dict):
        return {}
    overrides = settings.get(SETTINGS_KEY)
    return overrides if isinstance(overrides, dict) else {}


def _skill_problems(skill_id: str, entries: dict) -> list:
    problems = []
    set_ids, revisions, values = set(), set(), {}
    for key, entry in entries.items():
        part = skill_parts.get_part_by_key(key)
        if part is None:
            problems.append(f"{key} is not a registered part")
            continue
        if not isinstance(entry, dict) or not all(
                isinstance(entry.get(f), str) for f in _ENTRY_STR_FIELDS):
            problems.append(f"{key} is malformed")
            continue
        revision = entry.get("revision")
        if type(revision) is not int or revision <= FACTORY_REVISION:
            problems.append(f"{key} has no valid revision")
            continue
        set_ids.add(entry["changeSetId"])
        revisions.add(revision)
        if entry["baseSha256"] != part.sha256:
            problems.append(f"{key} was approved against other factory text (stale)")
        problems.extend(f"{key}: {e}" for e in skill_parts.validate_part_value(part, entry["value"]))
        values[part.part_id] = entry["value"]
    if len(set_ids) > 1 or len(revisions) > 1:
        problems.append("entries come from more than one version")
    if not problems:
        problems.extend(skill_parts.validate_skill_total(skill_id, values))
    return problems


def _usable_sets(overrides: dict) -> dict:
    """{skill_id: {"revision", "values": {part_id: value}}} for every skill whose
    delivered overrides may all be used; computed once per settings snapshot."""
    cached = _cache.get(id(overrides))
    if cached is not None and cached[0] is overrides:
        _cache.move_to_end(id(overrides))
        return cached[1]

    by_skill: dict = {}
    for key, entry in overrides.items():
        skill_id = key.split("/", 1)[0] if isinstance(key, str) else repr(key)
        by_skill.setdefault(skill_id, {})[key] = entry

    usable = {}
    for skill_id, entries in by_skill.items():
        problems = _skill_problems(skill_id, entries)
        if problems:
            ids = sorted({e.get("changeSetId") for e in entries.values()
                          if isinstance(e, dict) and isinstance(e.get("changeSetId"), str)})
            logger.warning("[skill.text] override %s for %s not used, factory text instead: %s",
                           _for_log(",".join(ids) or "?"), _for_log(skill_id),
                           _for_log("; ".join(problems)))
            continue
        first = next(iter(entries.values()))
        usable[skill_id] = {
            "revision": first["revision"],
            "changeSetId": first["changeSetId"],
            "values": {key.split("/", 1)[1]: e["value"] for key, e in entries.items()},
        }

    _cache[id(overrides)] = (overrides, usable)
    while len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return usable


def resolve_skill_part(skill_id: str, part_id: str, factory_text: str,
                       fmt_kwargs: Optional[dict] = None) -> str:
    """The text to append for one built-in skill part: the factory text, or the approved
    override delivered in SKILL_TEXT_OVERRIDES when it still matches this factory text and
    validates. Never raises: any doubt renders the factory text."""
    # Outside the try on purpose: a broken factory template fails exactly as it did before.
    factory = factory_text.format(**fmt_kwargs) if fmt_kwargs is not None else factory_text
    try:
        overrides = _session_overrides()
        if not overrides:
            return factory
        usable = _usable_sets(overrides).get(skill_id)
        if usable is None or part_id not in usable["values"]:
            return factory
        part = skill_parts.get_part(skill_id, part_id)
        if part is None or factory_text != part.text:
            raise ValueError("the call site's factory text is not the registered part")
        if (part.kind == skill_parts.TEMPLATE) != (fmt_kwargs is not None):
            raise ValueError(f"the call site renders a {part.kind} part the other way")
        value = usable["values"][part_id]
        rendered = value.format(**fmt_kwargs) if fmt_kwargs is not None else value
        # Judged again as the model will read it, with the real placeholder values: the
        # validator only saw the template.
        limit = skill_parts.max_chars_for(factory)
        if len(rendered) > limit:
            raise ValueError(f"the rendered override is {len(rendered)} characters; the limit is {limit}")
        added = [e for e in skill_parts.reserved_errors(rendered)
                 if e not in skill_parts.reserved_errors(factory)]
        if added:
            raise ValueError("the rendered override " + "; ".join(added))
        return rendered
    except Exception as exc:  # noqa: BLE001 - the seam must never break a prompt
        logger.warning("[skill.text] override for %s/%s not used: %s",
                       _for_log(skill_id), _for_log(part_id), _for_log(exc))
        return factory


def effective_version(skill_id: str) -> tuple:
    """(revision, changeSetId) of the skill's version in effect for this session;
    (1, None) for factory text."""
    try:
        overrides = _session_overrides()
        if overrides:
            usable = _usable_sets(overrides).get(skill_id)
            if usable is not None:
                return usable["revision"], usable["changeSetId"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("[skill.text] version of %s unknown, recorded as factory: %s",
                       _for_log(skill_id), _for_log(exc))
    return FACTORY_REVISION, None


def record_applied(skill_id: Optional[str]) -> None:
    """Record which skill workflow (and version) the build rendered; None when none."""
    if not skill_id:
        applied_skill_workflow.set(None)
        return
    revision, change_set_id = effective_version(skill_id)
    applied_skill_workflow.set({"skillId": skill_id, "revision": revision, "changeSetId": change_set_id})
