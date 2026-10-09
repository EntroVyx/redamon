import type { NextRequest } from 'next/server'
import * as store from '@/lib/plugins/dataStore'
import { dataOwner, withGateway } from '@/lib/plugins/gateway'

/** POST /api/plugin-gateway/v1/data/count (`sdk.data.count`, TD-28): how many rows `query` would page through. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'data/count' }, async (ctx) => {
    const count = await store.count({ pluginId: ctx.pluginId }, dataOwner(ctx), ctx.body.collection as string, {
      keyPrefix: ctx.body.prefix as string | undefined,
      where: ctx.body.where as store.QueryOptions['where'],
    })
    return { count }
  })
}
