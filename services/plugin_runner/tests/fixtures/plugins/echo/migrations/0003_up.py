"""Echo's data version 3, with no way back (there is no 0003_down.py): marks every value."""


def migrate_row(row):
    value = row["value"]
    if isinstance(value, dict):
        return {**value, "v": 3}
    return {"v": 3, "data": value}
