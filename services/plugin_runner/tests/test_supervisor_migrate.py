"""Data migrations in the runner (TD-28): POST /runner/v1/plugins/{id}/migrate runs a
batch of rows through the plugin's plain `migrate_row(row)` of one step, in a temporary
worker of that version, and answers the new value of each row or that it is deleted.

Migration code gets no call token: the request carries none, the worker environment is
the action worker's (no secret), and any failure fails the whole batch, so the webapp
discards its copy and the old data stays (README.PLUGINS.md §9.5)."""

import json
import os

from tests.support import IS_ROOT, RUNNER_KEY, install_plugin, pid_alive, run_list, wait_until

MIGRATE = "/runner/v1/plugins/echo/migrate"


def _rows(*values, owner="user"):
    return [{"id": f"r{i}", "collection": "items", "key": f"k{i}", "ownerType": owner, "value": v}
            for i, v in enumerate(values)]


def _body(rows, step=2, direction="up", version="1.0.0", **extra):
    return {"version": version, "step": step, "direction": direction, "rows": rows, **extra}


def test_a_batch_is_migrated_row_by_row(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    rows = _rows(5, {"a": 1}, "text", None, [1, 2]) + _rows({"b": 2}, owner="project")
    r = h.post(MIGRATE, json=_body(rows))
    assert r.status_code == 200, r.text
    assert r.json() == {"results": [
        {"id": "r0", "value": {"v": 2, "data": 5}},
        {"id": "r1", "value": {"v": 2, "data": {"a": 1}}},
        {"id": "r2", "value": {"v": 2, "data": "text"}},
        {"id": "r3", "value": {"v": 2, "data": None}},
        {"id": "r4", "value": {"v": 2, "data": [1, 2]}},
        {"id": "r0", "value": {"v": 2, "data": {"b": 2}}},
    ]}


def test_down_reverses_up(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    up = h.post(MIGRATE, json=_body(_rows({"a": 1}, 7))).json()["results"]
    down_rows = [{"id": x["id"], "collection": "items", "key": "k", "ownerType": "user", "value": x["value"]} for x in up]
    down = h.post(MIGRATE, json=_body(down_rows, direction="down")).json()["results"]
    assert [x["value"] for x in down] == [{"a": 1}, 7]


def test_delete_is_the_sdk_sentinel(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post(MIGRATE, json=_body(_rows({"delete": True}, 1)))
    assert r.json()["results"] == [{"id": "r0", "delete": True}, {"id": "r1", "value": {"v": 2, "data": 1}}]


def test_the_row_given_to_migrate_row_has_exactly_the_documented_fields(runner, plugins_dir):
    probe = "def migrate_row(row):\n    return {'seen': sorted(row), 'collection': row['collection']}\n"
    h = runner([install_plugin(plugins_dir, extra_files={"migrations/0009_up.py": probe})])
    r = h.post(MIGRATE, json=_body(_rows(1), step=9))
    assert r.json()["results"][0]["value"] == {"seen": ["collection", "key", "ownerType", "value"], "collection": "items"}


def test_no_token_reaches_migration_code(runner, plugins_dir):
    probe = ("import os\n"
             "def migrate_row(row):\n"
             "    return {'env': dict(os.environ), 'uid': os.getuid()}\n")
    h = runner([install_plugin(plugins_dir, extra_files={"migrations/0009_up.py": probe})])
    r = h.post(MIGRATE, json=_body(_rows(1), step=9))
    assert r.status_code == 200, r.text
    got = r.json()["results"][0]["value"]
    assert set(got["env"]) == {"PATH", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED",
                               "REDAMON_GATEWAY_URL", "HOME", "TMPDIR"}
    assert not any(RUNNER_KEY in v or "token" in k.lower() for k, v in got["env"].items())
    if IS_ROOT:
        assert 20000 <= got["uid"] <= 29999


def test_a_request_carrying_a_token_is_refused(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post(MIGRATE, json=_body(_rows(1), token="call-token"))
    assert r.status_code == 400 and r.json()["code"] == "bad_request"
    assert "token" in r.json()["error"]


def test_one_raising_row_fails_the_whole_batch_and_is_logged(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post(MIGRATE, json=_body(_rows(1, {"raise": True}, 3)))
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "migration_failed"
    assert "r1" in body["error"] and "ValueError" in body["error"]
    assert "results" not in body
    logs = h.get("/runner/v1/plugins/echo/logs?lines=200").json()["lines"]
    assert any("this row cannot be migrated" in line for line in logs)


def test_a_result_that_is_not_json_fails_the_batch(runner, plugins_dir):
    bad = "def migrate_row(row):\n    return {1, 2}\n"
    h = runner([install_plugin(plugins_dir, extra_files={"migrations/0009_up.py": bad})])
    r = h.post(MIGRATE, json=_body(_rows(1), step=9))
    assert r.status_code == 422 and r.json()["code"] == "invalid_result"


def test_a_nan_result_fails_the_batch(runner, plugins_dir):
    bad = "def migrate_row(row):\n    return float('nan')\n"
    h = runner([install_plugin(plugins_dir, extra_files={"migrations/0009_up.py": bad})])
    assert h.post(MIGRATE, json=_body(_rows(1), step=9)).json()["code"] == "invalid_result"


def test_an_oversized_batch_result_fails_cleanly(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post(MIGRATE, json=_body(_rows({"grow": 3 * 1024 * 1024})))
    assert r.status_code == 422 and r.json()["code"] == "result_too_large"


def test_a_step_the_plugin_does_not_ship(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post(MIGRATE, json=_body(_rows(1), step=3, direction="down"))
    assert r.status_code == 422 and r.json()["code"] == "migration_missing"


def test_migrate_row_must_be_a_plain_function(runner, plugins_dir):
    bad = "async def migrate_row(row):\n    return row\n"
    h = runner([install_plugin(plugins_dir, extra_files={"migrations/0009_up.py": bad})])
    r = h.post(MIGRATE, json=_body(_rows(1), step=9))
    assert r.status_code == 422 and r.json()["code"] == "invalid_migration"
    install_plugin(plugins_dir, version="1.0.1", extra_files={"migrations/0009_up.py": "VALUE = 1\n"})
    r = h.post(MIGRATE, json=_body(_rows(1), step=9, version="1.0.1"))
    assert r.status_code == 422 and r.json()["code"] == "invalid_migration"


def test_a_version_that_is_not_on_the_volume(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.post(MIGRATE, json=_body(_rows(1), version="9.9.9"))
    assert r.status_code == 404 and r.json()["code"] == "unknown_version"
    r = h.post("/runner/v1/plugins/BAD/migrate", json=_body(_rows(1)))
    assert r.status_code == 404 and r.json()["code"] == "unknown_version"


def test_a_version_need_not_be_running(runner, plugins_dir):
    """An update migrates with the NEW version, which the run list does not list yet."""
    h = runner([install_plugin(plugins_dir)])
    install_plugin(plugins_dir, version="1.1.0")
    assert [w["version"] for w in h.health()["workers"]] == ["1.0.0"]
    r = h.post(MIGRATE, json=_body(_rows(1), version="1.1.0"))
    assert r.status_code == 200 and r.json()["results"][0]["value"] == {"v": 2, "data": 1}


def test_malformed_bodies_are_400(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    good = _rows(1)
    for body in (
        {},
        _body(good, step="2"),
        _body(good, step=1),
        _body(good, step=True),
        _body(good, direction="sideways"),
        _body("rows"),
        _body([{"collection": "c", "key": "k", "ownerType": "user", "value": 1}]),
        _body([{"id": "r", "collection": "c", "key": "k", "ownerType": "team", "value": 1}]),
        _body([{"id": "r", "collection": "c", "key": "k", "ownerType": "user"}]),
        _body(_rows(*range(1001))),
        _body(good, version="latest"),
        _body(good, root="/etc"),
    ):
        r = h.post(MIGRATE, json=body)
        assert r.status_code == 400 and r.json()["code"] == "bad_request", (body.get("step"), r.text)


def test_the_root_may_be_given_and_must_be_the_versions_own(runner, plugins_dir):
    entry = install_plugin(plugins_dir)
    h = runner([entry])
    r = h.post(MIGRATE, json=_body(_rows(1), root=entry["root"]))
    assert r.status_code == 200, r.text


def test_a_migration_that_never_ends_is_killed(runner, plugins_dir):
    slow = "import time\ndef migrate_row(row):\n    while True:\n        time.sleep(0.05)\n"
    h = runner([install_plugin(plugins_dir, extra_files={"migrations/0009_up.py": slow})], migrate_timeout=1.0)
    r = h.post(MIGRATE, json=_body(_rows(1), step=9))
    assert r.status_code == 504 and r.json()["code"] == "migration_timeout"
    logs = h.get("/runner/v1/plugins/echo/logs?lines=200").json()["lines"]
    pids = [int(line.rsplit("pid ", 1)[1].split()[0]) for line in logs if "migration worker started: pid" in line]
    assert pids
    wait_until(lambda: not any(pid_alive(p) for p in pids))


def test_the_temporary_worker_is_gone_afterwards_and_actions_keep_running(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    before = h.health()["workers"][0]["pid"]
    assert h.post(MIGRATE, json=_body(_rows(1))).status_code == 200
    logs = h.get("/runner/v1/plugins/echo/logs?lines=200").json()["lines"]
    pids = [int(line.rsplit("pid ", 1)[1].split()[0]) for line in logs if "migration worker started: pid" in line]
    assert pids
    wait_until(lambda: not any(pid_alive(p) for p in pids))
    assert h.health()["workers"][0]["pid"] == before
    assert h.act("echo", "echo", {"x": 1}).json()["ok"] is True


def test_a_runner_out_of_date_refuses(runner, plugins_dir):
    entry = install_plugin(plugins_dir)
    h = runner([entry])
    h.run_list = run_list([entry], platform="0.0.1")
    h.reload()
    r = h.post(MIGRATE, json=_body(_rows(1)))
    assert r.status_code == 503 and r.json()["code"] == "runner_out_of_date"


def test_the_migrate_route_demands_the_runner_key(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    r = h.client.post(MIGRATE, json=_body(_rows(1)))
    assert r.status_code == 401


def test_the_worker_answers_a_migrate_message_directly(worker, plugins_dir):
    """The bootstrap's side of the protocol, without the supervisor."""
    entry = install_plugin(plugins_dir)
    w = worker(root=entry["root"])
    w.ready()
    w.send({"type": "migrate", "id": "m1", "step": 2, "direction": "up", "rows": _rows(4, {"delete": True})})
    msg = w.next_message()
    assert msg == {"type": "result", "id": "m1", "ok": True,
                   "result": {"results": [{"id": "r0", "value": {"v": 2, "data": 4}}, {"id": "r1", "delete": True}]}}
    w.send({"type": "migrate", "id": "m2", "step": "2", "direction": "up", "rows": []})
    assert w.next_message()["error"]["code"] == "bad_request"
    assert json.dumps(msg)  # plain JSON all the way
    assert os.path.isdir(entry["root"])
