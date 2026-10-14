import type { NextRequest } from 'next/server'
import * as store from '@/lib/plugins/dataStore'
import { dataOwner, withGateway } from '@/lib/plugins/gateway'

/**
 * POST /api/plugin-gateway/v1/data/get (`sdk.data.get`): one value of the calling
 * plugin's own data. Plugin, namespace (`live`) and owner come from the call token; the
 * body only names the collection, the key and which of the token's owners to use.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'data/get' }, async (ctx) => {
    const row = await store.get({ pluginId: ctx.pluginId }, dataOwner(ctx), ctx.body.collection as string, ctx.body.key as string)
    return row ? { found: true, value: row.value } : { found: false }
  })
}
