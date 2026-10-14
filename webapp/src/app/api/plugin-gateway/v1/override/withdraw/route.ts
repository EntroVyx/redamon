import type { NextRequest } from 'next/server'
import { withGateway } from '@/lib/plugins/gateway'
import { withdrawOverride } from '@/lib/plugins/overrideOps'

/**
 * POST /api/plugin-gateway/v1/override/withdraw (`sdk.override.withdraw`): withdraws one of
 * this plugin's own proposals, in the token's own scope, while it waits for a decision. It
 * needs the permission of the set's own point, checked once the set is read.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'override/withdraw', permission: 'in-handler' }, withdrawOverride)
}
