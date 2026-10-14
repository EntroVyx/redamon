import type { NextRequest } from 'next/server'
import { withGateway } from '@/lib/plugins/gateway'
import { getOverride, overridePermission } from '@/lib/plugins/overrideOps'

/**
 * POST /api/plugin-gateway/v1/override/get (`sdk.override.get`, needs `override:<point>`):
 * a skill's factory parts, the version the agent runs for this call, the pending count and
 * the validator's limits (lib/plugins/overrideOps.ts).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'override/get', permission: overridePermission }, getOverride)
}
