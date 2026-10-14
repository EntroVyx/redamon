"""Which user attack skills the agent may use, and which one a session's label renders.

What must hold:
- only an explicit `true` toggle enables a user skill; a missing key is off, as in the
  project form;
- at most MAX_ENABLED_USER_SKILLS are used, the first by (name, id), and the cut is logged;
- malformed settings never raise;
- a `user_skill:<id>` label renders that skill while it is on, otherwise the enabled skill
  whose `supersedes` lists it, otherwise nothing; resolution never raises;
- the behaviour text says "follow the skill" only when a skill resolves, and is the
  unclassified text otherwise.
"""

import contextlib
import logging
from unittest.mock import patch

import pytest

import project_settings
import prompts
from prompts import base

FOLLOW = "Follow the attack skill workflow guidance provided in the Available Tools section."


def skill(skill_id, name=None, content=None, **extra):
    return {"id": skill_id, "name": name or f"Skill {skill_id}", "description": None,
            "content": content or f"Steps of {skill_id}.", **extra}


@contextlib.contextmanager
def settings(config, skills):
    values = {"ATTACK_SKILL_CONFIG": config, "USER_ATTACK_SKILLS": skills}
    with patch.object(project_settings, "get_setting",
                      side_effect=lambda key, default=None: values.get(key, default)):
        yield


def enabled(toggles, skills):
    with settings({"builtIn": {}, "user": toggles}, skills):
        return project_settings.get_enabled_user_skills()


# ── get_enabled_user_skills ────────────────────────────────────────────────

def test_a_missing_toggle_is_off():
    assert enabled({}, [skill("a")]) == []
    assert enabled({"other": True}, [skill("a")]) == []


def test_an_explicit_true_is_on_and_false_is_off():
    a, b = skill("a"), skill("b")
    assert enabled({"a": True, "b": False}, [a, b]) == [a]


@pytest.mark.parametrize("truthy", [1, "true", "yes", [True], {"on": True}, 1.0])
def test_a_truthy_value_that_is_not_true_is_off(truthy):
    assert enabled({"a": truthy}, [skill("a")]) == []


def test_skills_come_back_ordered_by_name_then_id():
    zed, alpha_2, alpha_1 = skill("z", "Zed"), skill("id-2", "Alpha"), skill("id-1", "Alpha")
    got = enabled({"z": True, "id-2": True, "id-1": True}, [zed, alpha_2, alpha_1])
    assert [s["id"] for s in got] == ["id-1", "id-2", "z"]


def test_more_than_the_limit_keeps_the_first_by_name_and_warns(caplog):
    assert project_settings.MAX_ENABLED_USER_SKILLS == 20
    skills = [skill(f"id-{n:02d}", f"Skill {n:02d}") for n in reversed(range(25))]
    with caplog.at_level(logging.WARNING, logger="project_settings"):
        got = enabled({s["id"]: True for s in skills}, skills)
    assert [s["id"] for s in got] == [f"id-{n:02d}" for n in range(20)]
    assert "25 user skills are enabled" in caplog.text


def test_exactly_the_limit_is_not_cut(caplog):
    skills = [skill(f"id-{n:02d}") for n in range(20)]
    with caplog.at_level(logging.WARNING, logger="project_settings"):
        got = enabled({s["id"]: True for s in skills}, skills)
    assert len(got) == 20
    assert "user skills are enabled" not in caplog.text


def test_only_enabled_skills_count_towards_the_limit():
    skills = [skill(f"id-{n:02d}") for n in range(30)]
    toggles = {s["id"]: n % 2 == 0 for n, s in enumerate(skills)}
    got = enabled(toggles, skills)
    assert [s["id"] for s in got] == [f"id-{n:02d}" for n in range(0, 30, 2)]


def test_the_webapps_extra_fields_pass_through():
    new = skill("new", supersedes=["old"])
    assert enabled({"new": True}, [new]) == [new]


@pytest.mark.parametrize("config", [None, [], "user", 5, {}, {"user": None},
                                    {"user": []}, {"user": "a"}, {"builtIn": {}}])
def test_a_malformed_config_enables_nothing(config):
    with settings(config, [skill("a")]):
        assert project_settings.get_enabled_user_skills() == []


@pytest.mark.parametrize("skills", [None, "a", 5, {"id": "a"}])
def test_a_malformed_skill_list_is_empty(skills):
    with settings({"user": {"a": True}}, skills):
        assert project_settings.get_enabled_user_skills() == []


def test_malformed_entries_are_skipped():
    good = skill("good")
    entries = [None, 5, "good", ["good"], {"id": 3, "name": "n", "content": "c"},
               {"id": "no-name", "content": "c"}, {"id": "no-content", "name": "n"},
               {"id": "bad-name", "name": None, "content": "c"}, good]
    toggles = {"good": True, "no-name": True, "no-content": True, "bad-name": True, 3: True}
    assert enabled(toggles, entries) == [good]


# ── resolve_user_skill ─────────────────────────────────────────────────────

def resolve(label, toggles, skills):
    with settings({"builtIn": {}, "user": toggles}, skills):
        return prompts.resolve_user_skill(label)


def test_an_enabled_skill_resolves_to_itself():
    a = skill("a")
    assert resolve("user_skill:a", {"a": True}, [a]) == a


def test_an_off_skill_resolves_to_the_enabled_skill_that_supersedes_it():
    old, new = skill("old"), skill("new", supersedes=["old"])
    assert resolve("user_skill:old", {"old": False, "new": True}, [old, new]) == new


def test_a_successor_that_is_off_is_not_used():
    old, new = skill("old"), skill("new", supersedes=["old"])
    assert resolve("user_skill:old", {"old": False, "new": False}, [old, new]) is None
    assert resolve("user_skill:old", {}, [old, new]) is None


def test_a_successor_absent_from_the_payload_resolves_nothing():
    assert resolve("user_skill:old", {"old": False}, [skill("old")]) is None
    assert resolve("user_skill:gone", {}, []) is None


def test_an_off_skill_with_no_successor_resolves_nothing():
    other = skill("other", supersedes=["unrelated"])
    assert resolve("user_skill:a", {"a": False, "other": True}, [skill("a"), other]) is None


def test_the_labels_own_skill_wins_over_a_successor():
    a, newer = skill("a", "A"), skill("newer", "B", supersedes=["a"])
    assert resolve("user_skill:a", {"a": True, "newer": True}, [newer, a]) == a


def test_two_successors_resolve_to_the_first_in_enabled_order():
    old = skill("old")
    late, early = skill("late", "Zed", supersedes=["old"]), skill("early", "Alpha", supersedes=["old"])
    assert resolve("user_skill:old", {"late": True, "early": True}, [old, late, early]) == early


@pytest.mark.parametrize("supersedes", [None, "old", {"old": True}, 5])
def test_a_malformed_supersedes_is_ignored(supersedes):
    new = skill("new", supersedes=supersedes)
    assert resolve("user_skill:old", {"new": True}, [skill("old"), new]) is None


@pytest.mark.parametrize("label", ["", "xss", "sql_injection-unclassified", "user_skill:",
                                   "user_skill", None, 5])
def test_other_labels_resolve_nothing_without_reading_settings(label):
    with patch.object(project_settings, "get_setting",
                      side_effect=AssertionError("settings read for a non-user label")):
        assert prompts.resolve_user_skill(label) is None


def test_a_failing_lookup_resolves_nothing_and_warns(caplog):
    with patch.object(project_settings, "get_enabled_user_skills",
                      side_effect=RuntimeError("settings unavailable")), \
         caplog.at_level(logging.WARNING, logger="prompts"):
        assert prompts.resolve_user_skill("user_skill:a") is None
    assert "settings unavailable" in caplog.text


def test_resolve_user_skill_is_exported():
    assert "resolve_user_skill" in prompts.__all__


# ── build_attack_path_behavior ─────────────────────────────────────────────

def behavior(label, toggles, skills):
    with settings({"builtIn": {}, "user": toggles}, skills):
        return base.build_attack_path_behavior(label)


def test_a_resolvable_user_skill_says_follow_the_skill():
    assert behavior("user_skill:a", {"a": True}, [skill("a")]).startswith(FOLLOW)


def test_a_successor_says_follow_the_skill():
    old, new = skill("old"), skill("new", supersedes=["old"])
    assert behavior("user_skill:old", {"new": True}, [old, new]).startswith(FOLLOW)


@pytest.mark.parametrize("toggles,skills", [
    ({"a": False}, [skill("a")]),
    ({}, [skill("a")]),
    ({"a": True}, []),
])
def test_an_unresolvable_user_skill_gets_the_unclassified_text(toggles, skills):
    text = behavior("user_skill:a", toggles, skills)
    assert FOLLOW not in text
    assert text == base.UNCLASSIFIED_ATTACK_PATH_BEHAVIOR
    assert text == base.build_attack_path_behavior("sql_injection-unclassified")
    assert "switch_skill" in text
