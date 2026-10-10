"""Back to Echo's data version 1: unwraps what 0002_up wrapped."""


def migrate_row(row):
    value = row["value"]
    if isinstance(value, dict) and value.get("v") == 2 and "data" in value:
        return value["data"]
    return value
