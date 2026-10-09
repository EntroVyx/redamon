import type { NextRequest } from 'next/server'
import * as store from '@/lib/plugins/dataStore'
import { GatewayError, dataOwner, withGateway } from '@/lib/plugins/gateway'

/**
 * POST /api/plugin-gateway/v1/data/put (`sdk.data.put`): writes one value of the calling
 * plugin's own data, within its quotas. Plugin, namespace and owner come from the token.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'data/put' }, async (ctx) => {
    const { collection, key, ttlSeconds } = ctx.body
    // A stored null is a value; a missing one is a malformed call.
    if (!('value' in ctx.body)) throw new GatewayError(400, 'invalid_value', 'value is required.')
    const row = await store.put(
      { pluginId: ctx.pluginId },
      dataOwner(ctx),
      collection as string,
      key as string,
      ctx.body.value,
      ttlSeconds === undefined || ttlSeconds === null ? {} : { ttlSeconds: ttlSeconds as number },
    )
    return { sizeBytes: row.sizeBytes, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null }
  })
}
