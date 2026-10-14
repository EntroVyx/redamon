"""Golden hashes of every built-in skill workflow, recorded on the code before the
plugin platform's skill.text seam existed.

A mismatch means the assembled prompt changed. If a built-in skill prompt was edited on
purpose, re-record with the command in tests/tools/record_skill_golden.py and commit the
fixture with that edit; otherwise the change is a regression in how skill text is put
together.
"""

import importlib.util
import json
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_FIXTURE = _HERE / "fixtures" / "skill_workflow_golden.json"


def _load_recorder():
    spec = importlib.util.spec_from_file_location(
        "record_skill_golden", _HERE / "tools" / "record_skill_golden.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recorder = _load_recorder()
GOLDEN = json.loads(_FIXTURE.read_text(encoding="utf-8"))

_rendered = None


def _current():
    global _rendered
    if _rendered is None:
        _rendered = recorder.render_all()
    return _rendered


RERECORD = (
    "If a built-in skill prompt was edited on purpose, re-record from the repository root:\n"
    '  docker run --rm -v "$PWD:/repo" -w /repo/agentic --user "$(id -u):$(id -g)" '
    "-e PYTHONPATH=/repo/agentic:/repo --entrypoint python redamon-agent:latest "
    "tests/tools/record_skill_golden.py > agentic/tests/fixtures/skill_workflow_golden.json\n"
    "and commit the fixture with that edit. Otherwise the assembly of skill text changed.")


def _describe(text: str) -> str:
    """Which registered part a rendered block is, so a failure names it."""
    from prompts import skill_parts
    for part in skill_parts.all_parts():
        head = part.text.split("{", 1)[0]
        if text == part.text or (part.kind == "template" and len(head) >= 40 and text.startswith(head)):
            return part.key
    return "an unregistered block starting " + repr(text[:80])


def test_fixture_covers_every_scenario():
    rendered = _current()
    assert set(rendered["workflow"]) == set(GOLDEN["workflow"])
    assert set(rendered["phase_tools"]) == set(GOLDEN["phase_tools"])


def test_scenarios_reach_every_skill_and_both_outcomes():
    """Guards the fixture itself: each skill renders text somewhere and is gated off
    somewhere, so a golden of empty lists could not pass for a broken builder."""
    workflow = _current()["workflow"]
    for skill in recorder.SKILLS:
        renders = [parts for key, parts in workflow.items() if key.endswith("/" + skill)]
        assert any(renders), f"{skill} never renders"
    gated_off = {key for key, parts in workflow.items() if not parts}
    assert "roe_restricted/brute_force_credential_guess" in gated_off
    assert "roe_restricted/phishing_social_engineering" in gated_off
    assert "roe_restricted/denial_of_service" in gated_off
    assert "tool_missing/xss" in gated_off
    assert "tool_missing/phishing_social_engineering" not in gated_off


@pytest.mark.parametrize("key", sorted(GOLDEN["workflow"]))
def test_workflow_matches_golden(key):
    parts = _current()["workflow"].get(key)
    assert parts is not None, f"scenario {key} no longer rendered"
    expected = GOLDEN["workflow"][key]
    got = recorder.digest({"workflow": {key: parts}, "phase_tools": {}})["workflow"][key]
    if got != expected:
        width = max(len(got["parts"]), len(expected["parts"]))
        changed = [i for i in range(width)
                   if i >= len(got["parts"]) or i >= len(expected["parts"])
                   or got["parts"][i] != expected["parts"][i]]
        names = [_describe(parts[i]) if i < len(parts) else "(a part no longer rendered)"
                 for i in changed]
        pytest.fail(
            f"{key}: workflow changed: parts {len(expected['parts'])} -> {len(got['parts'])}, "
            f"chars {expected['chars']} -> {got['chars']}, changed at index {changed}: "
            f"{names}.\n{RERECORD}")


@pytest.mark.parametrize("key", sorted(GOLDEN["phase_tools"]))
def test_phase_tools_match_golden(key):
    text = _current()["phase_tools"].get(key)
    assert text is not None, f"scenario {key} no longer rendered"
    expected = GOLDEN["phase_tools"][key]
    got = recorder.digest({"workflow": {}, "phase_tools": {key: text}})["phase_tools"][key]
    if got != expected:
        pytest.fail(f"{key}: get_phase_tools output changed (chars {expected['chars']} -> "
                    f"{got['chars']}).\n{RERECORD}")
