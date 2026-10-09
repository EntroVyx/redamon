"""The skill.text seam: where an approved plugin override replaces a built-in skill part.

What must hold (TD-16, TD-17):
- with no override the prompt is byte-for-byte today's (the golden fixture);
- overrides come only from the session's own settings ContextVar, never from the
  module-global snapshot of whichever tenant loaded last;
- a skill's override set applies whole or not at all, and any doubt renders factory text;
- gates still decide whether a part is rendered;
- the settings are never mutated;
- each render records which version of the playbook the turn used, and phase_update
  carries that record.
"""

import asyncio
import contextvars
import copy
import importlib.util
import inspect
import json
import logging
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import project_settings
from prompts import skill_parts
from prompts import skill_part_seam as seam

_HERE = Path(__file__).resolve().parent


def _load_recorder():
    spec = importlib.util.spec_from_file_location(
        "record_skill_golden", _HERE / "tools" / "record_skill_golden.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recorder = _load_recorder()
GOLDEN = json.loads((_HERE / "fixtures" / "skill_workflow_golden.json").read_text(encoding="utf-8"))
ALL_TOOLS = recorder.ALL_TOOLS


@pytest.fixture(autouse=True)
def _fresh_cache():
    seam._reset_cache()
    yield
    seam._reset_cache()


def entry(part, value, *, set_id="cs-1", revision=2, sha=None):
    return {
        "value": value,
        "baseSha256": part.sha256 if sha is None else sha,
        "overrideId": f"ov-{part.key}",
        "changeSetId": set_id,
        "revision": revision,
        "pluginId": "fixture-plugin",
    }


def in_session(overrides, fn, settings=None):
    """Run fn the way a session task does: with its own settings bound to the ContextVar."""
    bound = dict(settings or {})
    bound["SKILL_TEXT_OVERRIDES"] = overrides

    def run():
        project_settings._settings_ctx.set(bound)
        return fn()

    return contextvars.copy_context().run(run)


def render(skill, settings=None, tools=ALL_TOOLS, statefull=False, trace=None):
    return recorder.render_workflow(skill, settings or {}, tools, statefull, trace or [])


def part(skill_id, part_id):
    found = skill_parts.get_part(skill_id, part_id)
    assert found is not None
    return found


# ── no override: today's prompt ─────────────────────────────────────────────

def test_golden_scenarios_unchanged_in_a_session_with_no_overrides():
    current = in_session({}, lambda: recorder.digest(recorder.render_all()))
    assert current == GOLDEN


def test_an_override_touches_only_its_own_skill():
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nFIXTURE-MARKER")}
    current = in_session(overrides, lambda: recorder.digest(recorder.render_all()))
    for section in ("workflow", "phase_tools"):
        for key, expected in GOLDEN[section].items():
            if key.endswith("/ssrf"):
                continue
            assert current[section][key] == expected, key


# ── tenant isolation (X2, RV-07) ────────────────────────────────────────────

def test_no_session_context_uses_factory(monkeypatch):
    gopher = part("ssrf", "gopher_chains")
    tenant_a = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    tenant_a["SKILL_TEXT_OVERRIDES"] = {gopher.key: entry(gopher, gopher.text + "\nTENANT-A")}
    monkeypatch.setattr(project_settings, "_settings", None)
    monkeypatch.setattr(project_settings, "_current_project_id", None)
    monkeypatch.setenv("WEBAPP_API_URL", "http://webapp.invalid")

    tenant_ctx = contextvars.copy_context()

    def load_a():
        with patch.object(project_settings, "fetch_agent_settings", return_value=tenant_a):
            project_settings.load_project_settings("project-a")

    tenant_ctx.run(load_a)
    # The module-global fallback now holds tenant A's overrides ...
    assert "TENANT-A" in project_settings._settings["SKILL_TEXT_OVERRIDES"][gopher.key]["value"]
    # ... yet a build outside any session task renders factory text.
    outside = contextvars.Context().run(lambda: render("ssrf"))
    assert all("TENANT-A" not in p for p in outside)
    assert outside == render("ssrf")
    # Positive control: inside tenant A's own context the override applies.
    inside = tenant_ctx.run(lambda: render("ssrf"))
    assert any("TENANT-A" in p for p in inside)


# ── whole set or nothing (RV-06) ────────────────────────────────────────────

def test_half_stale_set_falls_back_whole(caplog):
    oob, gopher = part("ssrf", "oob_workflow"), part("ssrf", "gopher_chains")
    overrides = {
        oob.key: entry(oob, oob.text + "\nMARK-OOB"),
        gopher.key: entry(gopher, gopher.text + "\nMARK-GOPHER", sha="0" * 64),
    }
    with caplog.at_level(logging.WARNING):
        got = in_session(overrides, lambda: render("ssrf"))
    assert got == render("ssrf")
    assert not any("MARK-" in p for p in got)
    assert any("[skill.text]" in r.getMessage() for r in caplog.records)


def test_a_whole_valid_set_applies():
    oob, gopher = part("ssrf", "oob_workflow"), part("ssrf", "gopher_chains")
    overrides = {
        oob.key: entry(oob, oob.text + "\nMARK-OOB"),
        gopher.key: entry(gopher, gopher.text + "\nMARK-GOPHER"),
    }
    got = in_session(overrides, lambda: render("ssrf"))
    assert got[1].endswith("MARK-OOB") and got[2].endswith("MARK-GOPHER")


def test_two_sets_for_one_skill_never_mix():
    oob, gopher = part("ssrf", "oob_workflow"), part("ssrf", "gopher_chains")
    overrides = {
        oob.key: entry(oob, oob.text + "\nMARK-OOB", set_id="cs-1", revision=2),
        gopher.key: entry(gopher, gopher.text + "\nMARK-GOPHER", set_id="cs-2", revision=3),
    }
    assert in_session(overrides, lambda: render("ssrf")) == render("ssrf")


def test_skill_total_over_the_cap_at_use_falls_back(monkeypatch):
    monkeypatch.setenv("PLUGIN_SKILL_TEXT_MAX_GROWTH", "1.0")
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK-GOPHER")}
    assert in_session(overrides, lambda: render("ssrf")) == render("ssrf")


def test_unregistered_part_poisons_its_skill():
    gopher = part("ssrf", "gopher_chains")
    ghost = dict(entry(gopher, "text"), baseSha256="1" * 64)
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK-GOPHER"), "ssrf/ghost": ghost}
    assert in_session(overrides, lambda: render("ssrf")) == render("ssrf")


@pytest.mark.parametrize("bad", [
    None, "a string", {"value": 5}, {"value": "x", "baseSha256": None},
])
def test_malformed_entry_poisons_its_skill(bad):
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK-GOPHER"), "ssrf/oob_workflow": bad}
    assert in_session(overrides, lambda: render("ssrf")) == render("ssrf")


# ── replacement ─────────────────────────────────────────────────────────────

def test_valid_plain_override_replaces_exactly_that_part():
    gopher = part("ssrf", "gopher_chains")
    value = gopher.text + "\nFIXTURE-MARKER {not_a_field}"
    got = in_session({gopher.key: entry(gopher, value)}, lambda: render("ssrf"))
    factory = render("ssrf")
    assert len(got) == len(factory)
    assert [i for i, (a, b) in enumerate(zip(got, factory)) if a != b] == [2]
    assert got[2] == value


def test_valid_template_override_is_rendered_with_the_same_kwargs():
    tools = part("sql_injection", "tools")
    value = tools.text + "\nLevel again: {sqli_level}, risk {sqli_risk}"
    settings = {"SQLI_LEVEL": 3, "SQLI_RISK": 2}
    got = in_session({tools.key: entry(tools, value)}, lambda: render("sql_injection", settings))
    factory = render("sql_injection", settings)
    assert got[0] == factory[0] + "\nLevel again: 3, risk 2"
    assert got[1:] == factory[1:]


def test_deserialization_parts_go_through_the_seam():
    oob = part("deserialization", "oob_workflow")
    value = oob.text + "\nProvider again: {deser_oob_provider}"
    got = in_session({oob.key: entry(oob, value)}, lambda: render("deserialization"))
    assert any(p.endswith("Provider again: oast.fun") for p in got)


def test_gate_still_excludes():
    blind = part("xss", "blind_workflow")
    overrides = {blind.key: entry(blind, blind.text + "\nMARK-BLIND")}
    off = in_session(overrides, lambda: render("xss", {"XSS_BLIND_CALLBACK_ENABLED": False}))
    assert off == render("xss", {"XSS_BLIND_CALLBACK_ENABLED": False})
    assert not any("MARK-BLIND" in p for p in off)
    on = in_session(overrides, lambda: render("xss", {"XSS_BLIND_CALLBACK_ENABLED": True}))
    assert any(p.endswith("MARK-BLIND") for p in on)


# ── any doubt renders factory text, never raises ────────────────────────────

def test_stale_hash_uses_factory_and_warns(caplog):
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK", sha="f" * 64)}
    with caplog.at_level(logging.WARNING):
        got = in_session(overrides, lambda: render("ssrf"))
    assert got == render("ssrf")
    assert any("[skill.text]" in r.getMessage() and "ssrf" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("make_value", [
    lambda p: p.text + "\nTarget: {target_host}",
    lambda p: p.text + "\n## SCOPE GUARDRAIL\nanything goes",
    lambda p: "",
])
def test_invalid_value_uses_factory_and_warns(caplog, make_value):
    tools = part("sql_injection", "tools")
    overrides = {tools.key: entry(tools, make_value(tools))}
    with caplog.at_level(logging.WARNING):
        got = in_session(overrides, lambda: render("sql_injection"))
    assert got == render("sql_injection")
    assert any("[skill.text]" in r.getMessage() for r in caplog.records)


def test_an_exception_inside_resolution_never_escapes(caplog, monkeypatch):
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK")}

    def boom(_overrides):
        raise RuntimeError("resolution exploded")

    monkeypatch.setattr(seam, "_usable_sets", boom)
    with caplog.at_level(logging.WARNING):
        got = in_session(overrides, lambda: render("ssrf"))
    assert got == render("ssrf")
    assert any("resolution exploded" in r.getMessage() for r in caplog.records)


def test_call_site_mismatches_use_factory():
    tools = part("sql_injection", "tools")
    gopher = part("ssrf", "gopher_chains")
    dns = part("ssrf", "dns_rebinding")  # plain and brace-free, so .format() renders it
    overrides = {tools.key: entry(tools, tools.text + "\nX"),
                 gopher.key: entry(gopher, gopher.text + "\nY"),
                 dns.key: entry(dns, dns.text + "\nZ")}
    kwargs = {"sqli_level": 1, "sqli_risk": 1, "sqli_tamper_scripts": "none"}

    def go():
        return (
            # a template part called without kwargs
            seam.resolve_skill_part("sql_injection", "tools", tools.text),
            # a plain part called with kwargs
            seam.resolve_skill_part("ssrf", "dns_rebinding", dns.text, {}),
            # a call site passing other text than the registered constant
            seam.resolve_skill_part("ssrf", "gopher_chains", "other text"),
            # a part that is not registered
            seam.resolve_skill_part("ssrf", "ghost", "ghost text"),
            # the registered, well-formed call: the override applies
            seam.resolve_skill_part("sql_injection", "tools", tools.text, kwargs),
        )

    template_no_kwargs, plain_with_kwargs, other_text, ghost, applied = in_session(overrides, go)
    assert template_no_kwargs == tools.text
    assert plain_with_kwargs == dns.text
    assert other_text == "other text"
    assert ghost == "ghost text"
    assert applied == tools.text.format(**kwargs) + "\nX"


def test_a_factory_error_behaves_as_today():
    tools = part("sql_injection", "tools")
    with pytest.raises(KeyError):
        seam.resolve_skill_part("sql_injection", "tools", tools.text, {})


def test_seam_never_mutates_settings():
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK")}
    settings = {"SKILL_TEXT_OVERRIDES": overrides, "OTHER": [1, 2]}
    before = copy.deepcopy(settings)
    defaults_before = copy.deepcopy(project_settings.DEFAULT_AGENT_SETTINGS)

    def run():
        project_settings._settings_ctx.set(settings)
        render("ssrf")
        seam.record_applied("ssrf")
        return project_settings._settings_ctx.get()

    bound = contextvars.copy_context().run(run)
    assert bound is settings
    assert settings == before
    assert settings["SKILL_TEXT_OVERRIDES"] is overrides
    assert project_settings.DEFAULT_AGENT_SETTINGS == defaults_before


def test_the_seam_makes_no_network_call():
    """D-05: the prompt hot path never waits on the platform; overrides are data
    already in the session's settings, and staleness is decided from local hashes."""
    import socket
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK")}

    def no_network(*_a, **_k):
        raise AssertionError("network used on the skill.text hot path")

    with patch.object(socket.socket, "connect", no_network), \
         patch("requests.get", no_network), patch("requests.post", no_network):
        got = in_session(overrides, lambda: render("ssrf"))
        record = in_session(overrides, lambda: (render("ssrf"), seam.applied_skill_workflow.get())[1])
    assert got[2].endswith("MARK")
    assert record == {"skillId": "ssrf", "revision": 2}


def test_usability_is_computed_once_per_snapshot(caplog):
    gopher = part("ssrf", "gopher_chains")
    overrides = {gopher.key: entry(gopher, gopher.text + "\nMARK", sha="f" * 64)}
    with caplog.at_level(logging.WARNING):
        in_session(overrides, lambda: [render("ssrf") for _ in range(3)])
    stale = [r for r in caplog.records if "[skill.text]" in r.getMessage()]
    assert len(stale) == 1


# ── every registered part goes through the seam (TD-26, R-22, R-23) ─────────

def test_registry_matches_call_sites():
    calls, outputs = [], []

    def recording(skill_id, part_id, factory_text, fmt_kwargs=None):
        out = factory_text.format(**fmt_kwargs) if fmt_kwargs is not None else factory_text
        calls.append((skill_id, part_id, factory_text, fmt_kwargs))
        outputs.append(out)
        return out

    renders = []
    with patch("prompts.skill_part_seam.resolve_skill_part", side_effect=recording):
        for skill in recorder.SKILLS:
            renders.append(render(skill, recorder.ALL_ON))
        for statefull in (True, False):
            renders.append(render("cve_exploit", statefull=statefull,
                                  trace=recorder.FAILED_SEARCH_TRACE))

    seen = {(s, p) for s, p, _, _ in calls}
    assert seen == {(p.skill_id, p.part_id) for p in skill_parts.all_parts()}
    for skill_id, part_id, factory_text, fmt_kwargs in calls:
        registered = part(skill_id, part_id)
        assert factory_text is registered.text, registered.key
        assert (fmt_kwargs is not None) == (registered.kind == skill_parts.TEMPLATE), registered.key
        if fmt_kwargs is not None:
            assert registered.placeholders <= set(fmt_kwargs), registered.key

    # Everything the builder returned came through the seam, except the dynamic blocks
    # that carry operator data and are deliberately not overridable.
    from prompts import deserialization_prompts as d
    dynamic_prefixes = ("## Pre-Configured SMTP Settings", d.DESERIALIZATION_RUNTIME_HEADER,
                        d.DESERIALIZATION_EXEC_STEP)
    dynamic_seen = set()
    for parts in renders:
        for text in parts:
            if any(text is out for out in outputs):
                continue
            prefix = next((p for p in dynamic_prefixes if text.startswith(p)), None)
            assert prefix is not None, f"appended without the seam: {text[:80]!r}"
            dynamic_seen.add(prefix)
    assert dynamic_seen == set(dynamic_prefixes)


# ── the applied-version record (RV-15) ──────────────────────────────────────

def test_skill_workflow_recorded():
    gopher = part("ssrf", "gopher_chains")
    usable = {gopher.key: entry(gopher, gopher.text + "\nMARK", revision=3)}
    stale = {gopher.key: entry(gopher, gopher.text + "\nMARK", revision=3, sha="f" * 64)}

    def render_then_read(tools=ALL_TOOLS):
        def go():
            render("ssrf", tools=tools)
            return seam.applied_skill_workflow.get()
        return go

    assert in_session({}, render_then_read()) == {"skillId": "ssrf", "revision": 1}
    assert in_session(usable, render_then_read()) == {"skillId": "ssrf", "revision": 3}
    assert in_session(stale, render_then_read()) == {"skillId": "ssrf", "revision": 1}
    no_curl = tuple(t for t in ALL_TOOLS if t != "execute_curl")
    assert in_session(usable, render_then_read(no_curl)) is None


def test_get_phase_tools_records_none_when_no_workflow_renders():
    import prompts

    def go():
        render("ssrf")
        assert seam.applied_skill_workflow.get() is not None
        with recorder.stubbed({}, ALL_TOOLS):
            prompts.get_phase_tools("post_exploitation", attack_path_type="ssrf")
        return seam.applied_skill_workflow.get()

    assert in_session({}, go) is None


def test_skill_workflow_is_a_declared_state_key():
    import typing
    from state import AgentState
    assert "_skill_workflow" in typing.get_type_hints(AgentState)


def _callback():
    callback = MagicMock()
    for name in (
        "on_phase_update", "on_todo_update", "on_approval_request", "on_question_request",
        "on_tool_complete", "on_execution_step", "on_file_ready", "on_thinking",
        "on_tool_start", "on_tool_output_chunk", "on_tool_confirmation_request",
        "on_task_complete",
    ):
        setattr(callback, name, AsyncMock())
    callback._emitted_tool_start_ids = set()
    callback._emitted_tool_complete_ids = set()
    callback._emitted_tool_output_ids = set()
    callback._emitted_thinking_ids = set()
    callback._emitted_approval_key = ""
    callback._emitted_question_key = ""
    callback._emitted_tool_confirmation_key = ""
    return callback


@pytest.mark.parametrize("record", [{"skillId": "ssrf", "revision": 3}, None])
def test_emit_streaming_events_passes_the_record(record):
    from orchestrator_helpers.streaming import emit_streaming_events
    callback = _callback()
    state = {"current_phase": "exploitation", "current_iteration": 4,
             "attack_path_type": "ssrf", "_skill_workflow": record}
    asyncio.run(emit_streaming_events(state, callback))
    callback.on_phase_update.assert_awaited_once()
    args, kwargs = callback.on_phase_update.await_args
    assert args == ("exploitation", 4, "ssrf")
    assert kwargs == {"skill_workflow": record}


def test_phase_update_payload_is_sent_and_persisted_with_the_record():
    from websocket_api import StreamingCallback
    conn = MagicMock()
    conn.send_message = AsyncMock()
    cb = StreamingCallback.__new__(StreamingCallback)
    cb._original_connection = conn
    cb._ws_manager = None
    cb._session_key = None
    cb._session_id = "s-1"
    cb._project_id = "p-1"
    cb._user_id = "u-1"
    persisted = []
    cb._persist = lambda msg_type, data, **kw: persisted.append((msg_type, data))
    record = {"skillId": "path_traversal", "revision": 2}

    async def go():
        with patch("websocket_api.update_conversation", new=AsyncMock()):
            await cb.on_phase_update("exploitation", 7, "path_traversal", skill_workflow=record)
            await cb.on_phase_update("informational", 8, "")
            await asyncio.sleep(0)

    asyncio.run(go())
    sent = [c.args[1] for c in conn.send_message.await_args_list]
    assert sent[0] == {"current_phase": "exploitation", "iteration_count": 7,
                       "attack_path_type": "path_traversal", "skill_workflow": record}
    assert sent[1]["skill_workflow"] is None
    assert persisted[0] == ("phase_update", sent[0])


class _FakeLLMResp:
    def __init__(self, content):
        self.content = content
        self.usage_metadata = {"input_tokens": 10, "output_tokens": 5}
        self.response_metadata = {}


@pytest.mark.parametrize("record", [{"skillId": "xss", "revision": 4}, None])
def test_think_node_copies_the_record_into_its_turn(record):
    """The ContextVar dies with the node's context (LangGraph copies it per node), so the
    root think node must carry the record out in its state update."""
    import orchestrator_helpers.nodes.think_node  # noqa: F401
    tn = sys.modules["orchestrator_helpers.nodes.think_node"]

    def fake_get_phase_tools(*args, **kwargs):
        seam.applied_skill_workflow.set(record)
        return "TOOLS"

    # A switch_skill to the skill already active: the no-op path test_switch_skill.py drives.
    decision = ('{"thought":"t","reasoning":"r","action":"switch_skill",'
                '"skill_switch":{"to_skill":"xss","reason":"same"},"updated_todo_list":[]}')
    state = {
        "attack_path_type": "xss", "current_phase": "informational",
        "current_iteration": 2, "max_iterations": 300,
        "messages": [], "todo_list": [], "execution_trace": [],
        "conversation_objectives": [{"objective": "find the flag", "status": "in_progress"}],
        "current_objective_index": 0, "objective_history": [],
    }
    config = {"configurable": {"thread_id": "u/p/s", "user_id": "u",
                               "project_id": "p", "session_id": "s"}}

    async def go():
        with patch.object(tn, "get_phase_tools", side_effect=fake_get_phase_tools), \
             patch.object(tn, "retry_llm_call", new=AsyncMock(return_value=_FakeLLMResp(decision))), \
             patch.object(tn, "get_enabled_builtin_skills", return_value={"xss"}), \
             patch.object(tn, "get_enabled_user_skills", return_value=[]), \
             patch.object(tn.chain_graph, "fire_update_chain_attack_path", new=MagicMock()):
            return await tn.think_node(
                state, config, llm=MagicMock(), guidance_queues={},
                neo4j_creds=("", "", ""), streaming_callbacks=None, graph_view_cyphers=None)

    updates = contextvars.Context().run(asyncio.run, go())
    assert updates["_skill_workflow"] == record


# ── settings delivery (agent half of TD-16) ─────────────────────────────────

class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


def _fetch(body, **kwargs):
    urls = []

    def fake_get(url, **_kw):
        urls.append(url)
        return _Resp(body)

    with patch("requests.get", side_effect=fake_get):
        settings = project_settings.fetch_agent_settings("p1", "http://webapp", **kwargs)
    return settings, urls


def _delivered():
    oob, gopher = part("ssrf", "oob_workflow"), part("ssrf", "gopher_chains")
    tools = part("xss", "tools")
    return {
        oob.key: entry(oob, "A"), gopher.key: entry(gopher, "B"),
        tools.key: entry(tools, "C", set_id="cs-x", revision=5),
    }


def test_fetch_agent_settings_requests_and_maps_overrides():
    body = {"userId": "", "skillTextOverrides": _delivered()}
    settings, urls = _fetch(body)
    assert urls[0] == "http://webapp/api/projects/p1?includeSkillContent=true&includeSkillOverrides=true"
    assert settings["SKILL_TEXT_OVERRIDES"] == _delivered()
    assert settings["SKILL_TEXT_OVERRIDES"] is not project_settings.DEFAULT_AGENT_SETTINGS["SKILL_TEXT_OVERRIDES"]


def test_fetch_with_the_flag_off_asks_for_nothing_and_keeps_nothing():
    """The text-to-cypher path reuses fetch_agent_settings with the flag off (X3)."""
    body = {"userId": "", "skillTextOverrides": _delivered()}
    settings, urls = _fetch(body, include_skill_overrides=False)
    assert urls[0] == "http://webapp/api/projects/p1?includeSkillContent=true"
    assert settings["SKILL_TEXT_OVERRIDES"] == {}


@pytest.mark.parametrize("mutate", [
    lambda e: e.update(revision=None),
    lambda e: e.update(revision=1),
    lambda e: e.update(revision=True),
    lambda e: e.update(revision="2"),
    lambda e: e.update(value=5),
    lambda e: e.pop("baseSha256"),
    lambda e: e.update(changeSetId=""),
    lambda e: e.update(pluginId=None),
])
def test_one_malformed_entry_drops_its_whole_skill(mutate, caplog):
    delivered = _delivered()
    mutate(delivered["ssrf/gopher_chains"])
    with caplog.at_level(logging.WARNING):
        settings, _ = _fetch({"userId": "", "skillTextOverrides": delivered},
                             include_skill_overrides=True)
    assert set(settings["SKILL_TEXT_OVERRIDES"]) == {"xss/tools"}
    assert any("skillTextOverrides" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("raw", [None, [], "x", 3])
def test_absent_or_non_object_overrides(raw):
    settings, _ = _fetch({"userId": "", "skillTextOverrides": raw}, include_skill_overrides=True)
    assert settings["SKILL_TEXT_OVERRIDES"] == {}


def test_keys_without_a_skill_and_part_are_dropped():
    delivered = _delivered()
    delivered["no-slash"] = dict(delivered["xss/tools"])
    delivered["a/b/c"] = dict(delivered["xss/tools"])
    settings, _ = _fetch({"userId": "", "skillTextOverrides": delivered},
                         include_skill_overrides=True)
    assert set(settings["SKILL_TEXT_OVERRIDES"]) == {"ssrf/oob_workflow", "ssrf/gopher_chains",
                                                       "xss/tools"}


def test_extra_fields_are_not_carried():
    delivered = _delivered()
    delivered["xss/tools"]["note"] = "do not keep"
    settings, _ = _fetch({"userId": "", "skillTextOverrides": delivered},
                         include_skill_overrides=True)
    assert "note" not in settings["SKILL_TEXT_OVERRIDES"]["xss/tools"]


def test_load_project_settings_asks_for_overrides(monkeypatch):
    monkeypatch.setenv("WEBAPP_API_URL", "http://webapp.invalid")
    monkeypatch.setattr(project_settings, "_settings", None)
    monkeypatch.setattr(project_settings, "_current_project_id", None)
    fetched = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    with patch.object(project_settings, "fetch_agent_settings", return_value=fetched) as fetch:
        contextvars.copy_context().run(project_settings.load_project_settings, "p1")
    assert fetch.call_args.args == ("p1", "http://webapp.invalid")
    assert fetch.call_args.kwargs.get("include_skill_overrides", True) is True


def test_default_settings_carry_an_empty_override_map():
    assert project_settings.DEFAULT_AGENT_SETTINGS["SKILL_TEXT_OVERRIDES"] == {}


def test_text_to_cypher_does_not_ask_for_overrides():
    source = (_HERE.parent / "api.py").read_text(encoding="utf-8")
    start = source.index("async def _build_cypher_manager")
    body = source[start:source.index("\nasync def ", start + 10)]
    calls = [line.strip() for line in body.splitlines() if "fetch_agent_settings(" in line]
    assert calls == [
        "settings = fetch_agent_settings(project_id, webapp_url, include_skill_overrides=False)"]


@pytest.fixture(scope="module")
def api():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_lifespan(_app):
        yield

    with patch("api.lifespan", fake_lifespan):
        import api as api_module
    return api_module


def test_defaults_do_not_offer_the_override_map(api):
    defaults = asyncio.run(api.get_defaults())
    assert "agentSkillTextOverrides" not in defaults
    assert "skillTextOverrides" not in defaults
    assert not any("SkillText" in k for k in defaults)
