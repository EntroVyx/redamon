"""What makes the SDK a contract: standard library only (workers start with -I -S and see
no site-packages), the platform version it was cut for, and a well-formed case file."""

import ast
import json
import sys

import platform_version
import redamon_plugin_sdk
from tests.support import CONTRACT_CASES, SDK_ROOT, load_contract_cases

PACKAGE = SDK_ROOT / "redamon_plugin_sdk"
SDK_METHODS = {
    "session.read", "llm.invoke", "data.get", "data.put", "data.query", "data.count", "data.delete",
    "override.get", "override.propose", "override.withdraw", "jobs.progress",
}


def _imports(path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name.split(".")[0], node.lineno
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split(".")[0], node.lineno


def test_the_sdk_imports_only_the_standard_library_and_itself():
    allowed = set(sys.stdlib_module_names) | {"redamon_plugin_sdk", "__future__"}
    files = sorted(PACKAGE.glob("*.py"))
    assert files, "no SDK source found"
    offenders = [f"{f.name}:{line} imports {mod}"
                 for f in files for mod, line in _imports(f) if mod not in allowed]
    assert offenders == []


def test_the_sdk_declares_the_runner_platform_version():
    assert redamon_plugin_sdk.PLATFORM_VERSION == platform_version.PLATFORM_VERSION == "1.1.0"
    assert json.loads(CONTRACT_CASES.read_text())["platformVersion"] == platform_version.PLATFORM_VERSION


def test_every_case_is_well_formed():
    prefix = json.loads(CONTRACT_CASES.read_text())["gatewayPrefix"]
    names = set()
    for case in load_contract_cases():
        assert case["name"] not in names, f"duplicate case {case['name']}"
        names.add(case["name"])
        assert case["call"]["method"] in SDK_METHODS
        expect = case["expect"]
        assert ("return" in expect) != ("error" in expect), case["name"]
        if "error" in expect:
            assert expect["error"]["code"] and expect["error"]["message"], case["name"]
        if case["request"] is None:
            assert case["response"] is None and "error" in expect, case["name"]
            continue
        assert case["request"]["method"] == "POST"
        assert case["request"]["path"].startswith(prefix)
        assert isinstance(case["request"]["body"], dict)
        resp = case["response"]
        if resp["status"] >= 400 and "body" in resp:
            assert set(resp["body"]) == {"error", "code"}, case["name"]
            assert "error" in expect and expect["error"]["code"] == resp["body"]["code"]
            assert expect["error"]["message"] == resp["body"]["error"]


def test_every_sdk_call_is_covered_by_a_success_case():
    covered = {c["call"]["method"] for c in load_contract_cases() if "return" in c["expect"]}
    assert covered == SDK_METHODS


def test_no_case_carries_real_target_data():
    """Synthetic data only (CONTRIBUTING.md, master plan P3): example.* hosts."""
    text = CONTRACT_CASES.read_text()
    for marker in ("http://", "https://"):
        for chunk in text.split(marker)[1:]:
            host = chunk.split("/")[0].split('"')[0]
            assert host.endswith(("example.com", "example.org", "127.0.0.1")) or host == "", host
