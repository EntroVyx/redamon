"""The run list: which plugin versions to run, asked of the webapp (README.PLUGINS.md §7.2).

The runner holds no database credentials, so this is its only source. The webapp is
trusted, but an entry that does not fit the volume layout is still skipped: a worker is
only ever started on <plugins>/<id>/versions/<version>.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

RUN_LIST_PATH = "/api/plugin-runner/v1/run-list"
PLUGIN_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
ACTION_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")


class RunListError(Exception):
    pass


@dataclass(frozen=True)
class Action:
    entry: str
    timeout_seconds: int
    is_async: bool


@dataclass(frozen=True)
class Entry:
    plugin_id: str
    version: str
    root: str
    actions: dict

    @property
    def key(self) -> tuple:
        return (self.plugin_id, self.version)


async def fetch(client, settings) -> dict:
    try:
        r = await client.get(settings.gateway_url + RUN_LIST_PATH,
                             headers={"X-Plugin-Runner-Key": settings.runner_key}, timeout=10)
    except Exception as e:  # any transport failure: keep the last good list
        raise RunListError(f"the webapp could not be reached ({type(e).__name__})") from None
    if r.status_code != 200:
        raise RunListError(f"the webapp answered HTTP {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        raise RunListError("the webapp's answer is not JSON") from None
    if not isinstance(body, dict) or not isinstance(body.get("platformVersion"), str) \
            or not isinstance(body.get("plugins"), list):
        raise RunListError("the webapp's answer is not a run list")
    return body


def _actions(manifest) -> dict:
    out = {}
    for a in manifest.get("actions") or []:
        if not isinstance(a, dict) or not isinstance(a.get("id"), str) or not ACTION_ID_RE.match(a["id"]):
            raise ValueError("an action has no valid id")
        t = a.get("timeoutSeconds")
        if not isinstance(t, int) or isinstance(t, bool) or t < 1 or not isinstance(a.get("entry"), str):
            raise ValueError(f"action {a['id']} has no valid entry or timeout")
        out[a["id"]] = Action(entry=a["entry"], timeout_seconds=t, is_async=a.get("async") is True)
    return out


def parse_entries(body: dict, plugins_dir: str, log) -> list:
    """The valid entries, in order; each invalid one is logged and skipped."""
    base = os.path.realpath(plugins_dir)
    entries, seen = [], set()
    for raw in body["plugins"]:
        try:
            if not isinstance(raw, dict):
                raise ValueError("not an object")
            pid, version, root, manifest = raw.get("id"), raw.get("version"), raw.get("root"), raw.get("manifest")
            if not isinstance(pid, str) or not PLUGIN_ID_RE.match(pid):
                raise ValueError(f"invalid plugin id {pid!r}")
            if not isinstance(version, str) or not VERSION_RE.match(version):
                raise ValueError(f"invalid version {version!r}")
            if not isinstance(manifest, dict) or manifest.get("id") != pid or manifest.get("version") != version:
                raise ValueError("the manifest does not match the entry")
            expected = os.path.join(plugins_dir, pid, "versions", version)
            if root != expected:
                raise ValueError(f"root {root!r} is not {expected}")
            real = os.path.realpath(root)
            if not real.startswith(base + os.sep) or not os.path.isdir(real):
                raise ValueError(f"root {root!r} is not a plugin folder on the volume")
            entry = Entry(plugin_id=pid, version=version, root=real, actions=_actions(manifest))
        except (ValueError, TypeError) as e:
            log(f"run list entry skipped: {e}")
            continue
        if entry.key not in seen:
            seen.add(entry.key)
            entries.append(entry)
    return entries
