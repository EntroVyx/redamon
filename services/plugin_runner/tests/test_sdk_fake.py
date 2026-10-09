"""FakeSdk, the double plugins test against: the shared contract cases (so a plugin that
passes on the fake sends what the Gateway expects and reads what it answers), then the
fake's own behaviour."""

import asyncio

import pytest

from redamon_plugin_sdk import Context, PluginError
from redamon_plugin_sdk.testing import FakeSdk, ScriptedLlm, make_context
from tests.support import context_kwargs, load_contract_cases, resolve_call

FAKE_CASES = [c for c in load_contract_cases() if "fake" in c]


def _fake_for(case: dict) -> FakeSdk:
    setup = dict(case["fake"].get("setup") or {})
    ctx = context_kwargs(case)
    return FakeSdk(
        project_id=ctx["project_id"],
        session_id=ctx["session_id"],
        job_id=ctx["job_id"],
        transcript=setup.get("transcript"),
        llm=ScriptedLlm(setup.get("llm") or []),
        registry=setup.get("registry"),
        permissions=setup.get("permissions"),
    )


@pytest.mark.parametrize("case", FAKE_CASES, ids=[c["name"] for c in FAKE_CASES])
def test_contract_case_on_the_fake(case):
    sdk = _fake_for(case)
    for call in case["fake"].get("given", []):
        asyncio.run(resolve_call(sdk, call))
    expect = case["fake"].get("expect", case["expect"])
    if "error" in expect:
        with pytest.raises(PluginError) as caught:
            asyncio.run(resolve_call(sdk, case["call"]))
        assert caught.value.code == expect["error"]["code"]
        if "message" in expect["error"]:
            assert caught.value.message == expect["error"]["message"]
    elif "keys" in expect:
        got = asyncio.run(resolve_call(sdk, case["call"]))
        assert [item["key"] for item in got["items"]] == expect["keys"]
        assert got["next"] == expect["next"]
    else:
        assert asyncio.run(resolve_call(sdk, case["call"])) == expect["return"]


def test_every_sdk_call_has_a_fake_case():
    names = {c["call"]["method"] for c in FAKE_CASES}
    assert names >= {
        "session.read", "llm.invoke", "data.get", "data.put", "data.query", "data.count",
        "data.delete", "override.get", "override.propose", "override.withdraw", "jobs.progress",
    }


def test_scripted_llm_records_prompts_and_options():
    llm = ScriptedLlm(["first", "second"])
    sdk = FakeSdk(llm=llm)
    msgs = [{"role": "user", "content": "hi"}]
    assert asyncio.run(sdk.llm.invoke(msgs, max_tokens=50))["content"] == "first"
    assert asyncio.run(sdk.llm.invoke(msgs, temperature=0.1))["content"] == "second"
    assert llm.prompts == [msgs, msgs]
    assert [c["max_tokens"] for c in llm.calls] == [50, None]
    assert [c["temperature"] for c in llm.calls] == [None, 0.1]


def test_scripted_llm_can_return_an_error_and_runs_dry_loudly():
    llm = ScriptedLlm([PluginError("model_required", "Choose a model.")])
    sdk = FakeSdk(llm=llm)
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.llm.invoke([{"role": "user", "content": "hi"}]))
    assert caught.value.code == "model_required"
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.llm.invoke([{"role": "user", "content": "hi"}]))
    assert caught.value.code == "llm_script_exhausted"


def test_scripted_llm_needs_the_permission():
    sdk = FakeSdk(llm=ScriptedLlm(["x"]), permissions=["session:read"])
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.llm.invoke([{"role": "user", "content": "hi"}]))
    assert caught.value.code == "permission_denied"


def test_data_expires_by_the_injected_clock():
    now = [1000.0]
    sdk = FakeSdk(clock=lambda: now[0])
    asyncio.run(sdk.data.put("cache", "k", 1, ttl_seconds=60))
    assert asyncio.run(sdk.data.get("cache", "k")) == 1
    now[0] += 61
    assert asyncio.run(sdk.data.get("cache", "k")) is None
    assert asyncio.run(sdk.data.query("cache")) == {"items": [], "next": None}
    assert asyncio.run(sdk.data.count("cache")) == 0


def test_data_owners_are_separate():
    sdk = FakeSdk(project_id="project-1")
    asyncio.run(sdk.data.put("notes", "k", "mine"))
    asyncio.run(sdk.data.put("notes", "k", "ours", owner="project"))
    assert asyncio.run(sdk.data.get("notes", "k")) == "mine"
    assert asyncio.run(sdk.data.get("notes", "k", owner="project")) == "ours"


def test_data_values_are_copied_like_json():
    sdk = FakeSdk()
    value = {"list": [1, 2]}
    asyncio.run(sdk.data.put("notes", "k", value))
    value["list"].append(3)
    assert asyncio.run(sdk.data.get("notes", "k")) == {"list": [1, 2]}


def test_proposals_are_visible_to_the_test_and_in_pending_count():
    registry = {"path_traversal": {"displayName": "Path Traversal",
                                   "parts": {"payload_reference": {"text": "factory"}}}}
    sdk = FakeSdk(registry=registry)
    out = asyncio.run(sdk.override.propose("skill.text", "path_traversal",
                                           {"payload_reference": "better"}, note="why"))
    assert out["changeSetId"] == sdk.proposals[0]["changeSetId"]
    assert sdk.proposals[0]["parts"] == {"payload_reference": "better"}
    assert sdk.proposals[0]["status"] == "proposed"
    got = asyncio.run(sdk.override.get("skill.text", "path_traversal"))
    assert got["pendingCount"] == 1 and got["active"] is None
    asyncio.run(sdk.override.withdraw(out["changeSetId"]))
    assert sdk.proposals[0]["status"] == "withdrawn"
    assert asyncio.run(sdk.override.get("skill.text", "path_traversal"))["pendingCount"] == 0


def test_an_active_version_is_reported_by_override_get():
    registry = {"path_traversal": {"displayName": "Path Traversal",
                                   "parts": {"payload_reference": {"text": "factory"}}}}
    sdk = FakeSdk(registry=registry)
    sdk.set_active("path_traversal", revision=3, parts={"payload_reference": "v3 text"})
    got = asyncio.run(sdk.override.get("skill.text", "path_traversal"))
    assert got["active"]["revision"] == 3
    assert got["active"]["parts"] == {"payload_reference": "v3 text"}
    out = asyncio.run(sdk.override.propose("skill.text", "path_traversal",
                                           {"payload_reference": "v4 text"}, note="n"))
    assert out["fromRevision"] == 3


def test_project_scope_needs_a_project():
    registry = {"path_traversal": {"parts": {"payload_reference": {"text": "factory"}}}}
    sdk = FakeSdk(registry=registry)
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.override.propose("skill.text", "path_traversal",
                                         {"payload_reference": "x"}, note="n", scope="project"))
    assert caught.value.code == "invalid_proposal"


def test_progress_is_recorded_in_order():
    sdk = FakeSdk(job_id="job-1")
    asyncio.run(sdk.jobs.progress("one"))
    asyncio.run(sdk.jobs.progress("two", {"Stage": "2 of 3"}))
    assert sdk.progress == [{"message": "one", "fields": None},
                            {"message": "two", "fields": {"Stage": "2 of 3"}}]


def test_make_context_builds_a_context_around_a_fake():
    ctx = make_context(project_id="project-1", session_id="session-1", job_id="job-1")
    assert isinstance(ctx, Context)
    assert isinstance(ctx.sdk, FakeSdk)
    assert (ctx.plugin_id, ctx.user_id, ctx.project_id, ctx.session_id, ctx.job_id) == (
        "test-plugin", "user-1", "project-1", "session-1", "job-1")
    assert ctx.sdk.project_id == "project-1" and ctx.sdk.job_id == "job-1"


# --- TD-28: paging, where, order, count ------------------------------------------------


def _keys(page):
    return [item["key"] for item in page["items"]]


def test_query_pages_through_every_row_exactly_once_with_writes_between_pages():
    sdk = FakeSdk()
    for i in range(120):
        asyncio.run(sdk.data.put("rows", f"k{i:03d}", i))
    seen, pages, cursor = [], 0, None
    while True:
        page = asyncio.run(sdk.data.query("rows", limit=50, cursor=cursor))
        pages += 1
        seen += _keys(page)
        asyncio.run(sdk.data.put("rows", f"late{pages}", "written between pages"))
        cursor = page["next"]
        if cursor is None:
            break
        assert isinstance(cursor, str)
    originals = [k for k in seen if k.startswith("k")]
    assert sorted(originals) == [f"k{i:03d}" for i in range(120)]
    assert len(originals) == len(set(originals)) == 120
    assert pages == 3


def test_query_orders():
    now = [1000.0]
    sdk = FakeSdk(clock=lambda: now[0])
    for key in ("b", "a", "c"):
        now[0] += 1
        asyncio.run(sdk.data.put("rows", key, key))
    assert _keys(asyncio.run(sdk.data.query("rows"))) == ["c", "a", "b"]
    assert _keys(asyncio.run(sdk.data.query("rows", order="updated"))) == ["b", "a", "c"]
    assert _keys(asyncio.run(sdk.data.query("rows", order="key"))) == ["a", "b", "c"]
    assert _keys(asyncio.run(sdk.data.query("rows", order="-key"))) == ["c", "b", "a"]


def test_query_orders_page_by_key_too():
    sdk = FakeSdk()
    for i in range(7):
        asyncio.run(sdk.data.put("rows", f"k{i}", i))
    first = asyncio.run(sdk.data.query("rows", order="key", limit=3))
    second = asyncio.run(sdk.data.query("rows", order="key", limit=3, cursor=first["next"]))
    third = asyncio.run(sdk.data.query("rows", order="key", limit=3, cursor=second["next"]))
    assert _keys(first) + _keys(second) + _keys(third) == [f"k{i}" for i in range(7)]
    assert third["next"] is None


def _where_rows():
    sdk = FakeSdk()
    rows = {
        "open-int": {"status": "open", "n": 1, "flag": True, "gone": None},
        "closed-float": {"status": "closed", "n": 1.0, "flag": False},
        "bool-one": {"status": "open", "n": True},
        "text-one": {"status": "open", "n": "1"},
        "not-an-object": "open",
        "list-value": ["open"],
    }
    for key, value in rows.items():
        asyncio.run(sdk.data.put("rows", key, value))
    return sdk


def _where(sdk, **where):
    return sorted(_keys(asyncio.run(sdk.data.query("rows", where=where))))


def test_where_follows_jsonb_equality():
    sdk = _where_rows()
    assert _where(sdk, status="open") == ["bool-one", "open-int", "text-one"]
    assert _where(sdk, n=1) == ["closed-float", "open-int"]          # 1 == 1.0
    assert _where(sdk, n=1.0) == ["closed-float", "open-int"]
    assert _where(sdk, n=True) == ["bool-one"]                       # a bool is not a number
    assert _where(sdk, flag=False) == ["closed-float"]
    assert _where(sdk, n="1") == ["text-one"]
    assert _where(sdk, gone=None) == ["open-int"]                    # null matches a JSON null
    assert _where(sdk, missing=None) == []                           # a missing field never matches
    assert _where(sdk, status="open", n=1) == ["open-int"]           # fields are ANDed


def test_where_is_anded_with_prefix_and_counted():
    sdk = _where_rows()
    assert sorted(_keys(asyncio.run(sdk.data.query("rows", prefix="open", where={"status": "open"})))) == ["open-int"]
    assert asyncio.run(sdk.data.count("rows")) == 6
    assert asyncio.run(sdk.data.count("rows", where={"status": "open"})) == 3
    assert asyncio.run(sdk.data.count("rows", prefix="open", where={"status": "open"})) == 1


def test_a_cursor_only_fits_the_query_that_made_it():
    sdk = FakeSdk()
    for i in range(5):
        asyncio.run(sdk.data.put("rows", f"k{i}", {"even": i % 2 == 0}))
    cursor = asyncio.run(sdk.data.query("rows", limit=2))["next"]
    for kwargs in ({"where": {"even": True}}, {"order": "key"}, {"prefix": "k1"}):
        with pytest.raises(PluginError) as caught:
            asyncio.run(sdk.data.query("rows", limit=2, cursor=cursor, **kwargs))
        assert caught.value.code == "invalid_cursor", kwargs
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.data.query("other", limit=2, cursor=cursor))
    assert caught.value.code == "invalid_cursor"
    with pytest.raises(PluginError) as caught:
        asyncio.run(sdk.data.query("rows", cursor="not a cursor"))
    assert caught.value.code == "invalid_cursor"


def test_where_values_are_checked_before_sending():
    sdk = FakeSdk()
    for where in ({"long": "x" * 513}, {"nan": float("nan")}, {"inf": float("inf")}, {1: "x"}):
        with pytest.raises(PluginError) as caught:
            asyncio.run(sdk.data.query("rows", where=where))
        assert caught.value.code == "invalid_query", where
    assert asyncio.run(sdk.data.query("rows", where={"ok": "x" * 512}))["items"] == []


def test_the_echo_fixture_pages_its_list():
    import importlib.util
    from tests.support import ECHO_ROOT
    spec = importlib.util.spec_from_file_location("echo_items", ECHO_ROOT / "engine" / "items.py")
    items = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(items)
    ctx = make_context()
    empty = asyncio.run(items.list_items(ctx, {}))
    assert empty["next"] is None and len(empty["items"]) == 1
    for k in ("a", "b", "c"):
        asyncio.run(ctx.sdk.data.put("items", k, k.upper()))
    first = asyncio.run(items.list_items(ctx, {"limit": 2}))
    second = asyncio.run(items.list_items(ctx, {"limit": 2, "cursor": first["next"]}))
    assert [i["title"] for i in first["items"] + second["items"]] == ["c", "b", "a"]
    assert first["next"] and second["next"] is None
