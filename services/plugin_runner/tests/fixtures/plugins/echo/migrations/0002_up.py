"""Echo's data version 2: every value is wrapped as {"v": 2, "data": <old value>}.

Test rows steer it: {"raise": true} cannot be migrated, {"delete": true} is deleted, and
{"grow": N} becomes N bytes of text (a result over the platform's limits)."""

from redamon_plugin_sdk import DELETE


def migrate_row(row):
    value = row["value"]
    if isinstance(value, dict):
        if value.get("raise"):
            raise ValueError("echo fixture: this row cannot be migrated")
        if value.get("delete"):
            return DELETE
        if "grow" in value:
            return {"v": 2, "blob": "x" * int(value["grow"])}
    return {"v": 2, "data": value}
