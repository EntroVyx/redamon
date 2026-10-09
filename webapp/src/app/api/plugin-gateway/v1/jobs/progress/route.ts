import type { NextRequest } from 'next/server'
import { GatewayError, withGateway } from '@/lib/plugins/gateway'
import { JobReportError, checkedProgress, reportProgress } from '@/lib/plugins/jobs'

/**
 * POST /api/plugin-gateway/v1/jobs/progress (`sdk.jobs.progress`): a running async action
 * reports where it is, with its job token; shown in the UI's progress view.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'jobs/progress', kinds: ['job'] }, async (ctx) => {
    let progress
    try {
      progress = checkedProgress(ctx.body)
    } catch (e) {
      if (e instanceof JobReportError) throw new GatewayError(400, e.code, e.message)
      throw e
    }
    const { found, changed } = await reportProgress(ctx.pluginId, ctx.userId, ctx.claims.jid!, progress)
    if (!found) throw new GatewayError(404, 'not_found', 'No such job.')
    return changed ? { ok: true } : { ok: true, ignored: true }
  })
}
