import type { NextRequest } from 'next/server'
import * as store from '@/lib/plugins/dataStore'
import { dataOwner, withGateway } from '@/lib/plugins/gateway'

/**
 * POST /api/plugin-gateway/v1/data/query (`sdk.data.query`, TD-28): one page of the
 * calling plugin's own rows, `{items, next}`. `where`, `order`, `limit` and `cursor` are
 * checked by the store; whatever they say, the page never leaves this plugin, the token's
 * owner, the collection and the `live` namespace.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'data/query' }, async (ctx) => {
    const b = ctx.body
    const page = await store.query({ pluginId: ctx.pluginId }, dataOwner(ctx), b.collection as string, {
      keyPrefix: b.prefix as string | undefined,
      where: b.where as store.QueryOptions['where'],
      order: b.order as store.QueryOrder | undefined,
      limit: b.limit as number | undefined,
      cursor: b.cursor as string | null | undefined,
    })
    return {
      items: page.items.map((r) => ({
        key: r.key,
        value: r.value,
        updatedAt: r.updatedAt.toISOString(),
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      })),
      next: page.next,
    }
  })
}
