import { NextRequest, NextResponse } from 'next/server'
import { reconcile } from '@/lib/plugins/reconcile'
import { pluginsDisabledResponse, pluginsEnabled } from '@/lib/plugins/switch'
import { isInternalRequest } from '@/lib/session'

/**
 * POST /api/internal/plugins/reconcile: driven by the recon orchestrator's reaper every
 * PLUGIN_RECONCILE_INTERVAL (TD-20); the webapp has no scheduler of its own. Master internal
 * key only, checked here (the middleware allowlist is not the control). 202 `{skipped:
 * 'busy'}` while another reconcile holds the platform-wide lease.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  if (!pluginsEnabled()) return pluginsDisabledResponse()
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 })
  }
  const out = await reconcile()
  if ('skipped' in out) return NextResponse.json(out, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({ ok: true, report: out }, { headers: { 'Cache-Control': 'no-store' } })
}
