import type { NextRequest } from 'next/server'
import * as store from '@/lib/plugins/dataStore'
import { dataOwner, withGateway } from '@/lib/plugins/gateway'

/** POST /api/plugin-gateway/v1/data/delete (`sdk.data.delete`): removes one value of the plugin's own data. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'data/delete' }, async (ctx) => {
    const deleted = await store.remove({ pluginId: ctx.pluginId }, dataOwner(ctx), ctx.body.collection as string, ctx.body.key as string)
    return { deleted }
  })
}
