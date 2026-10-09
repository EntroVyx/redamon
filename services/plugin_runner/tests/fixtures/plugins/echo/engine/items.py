"""The data behind Echo's list screen, kept in the plugin's own store, one page at a time:
the screen host passes `params.cursor` back to get the page after `next` (TD-28)."""


async def list_items(ctx, params):
    page = await ctx.sdk.data.query("items", limit=int(params.get("limit", 10)),
                                    cursor=params.get("cursor"))
    items = [{"title": r["key"], "detail": str(r["value"])} for r in page["items"]]
    if not items and not params.get("cursor"):
        items = [{"title": "first", "detail": "A built-in item, shown when the store is empty."}]
    return {"items": items, "next": page["next"]}
