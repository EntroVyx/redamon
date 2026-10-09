import type { NextRequest } from 'next/server'
import { withGateway } from '@/lib/plugins/gateway'
import { overridePermission, proposeOverride } from '@/lib/plugins/overrideOps'

/**
 * POST /api/plugin-gateway/v1/override/propose (`sdk.override.propose`, needs
 * `override:<point>`): stores a version for a person to review, after the agent validated
 * it. Nothing changes for the agent until someone approves it in the core review modal.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'override/propose', permission: overridePermission }, proposeOverride)
}
