"""The data behind Echo's list screen, kept in the plugin's own store."""


async def list_items(ctx, params):
    limit = int(params.get("limit", 10))
    rows = await ctx.sdk.data.query("items", limit=limit)
    items = [{"title": r["key"], "detail": str(r["value"])} for r in rows]
    if not items:
        items = [{"title": "first", "detail": "A built-in item, shown when the store is empty."}]
    return {"items": items}
