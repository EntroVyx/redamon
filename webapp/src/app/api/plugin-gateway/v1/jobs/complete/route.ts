import type { NextRequest } from 'next/server'
import { checkReviewProposal } from '@/lib/plugins/actions'
import { GatewayError, withGateway } from '@/lib/plugins/gateway'
import { JobReportError, checkedReport, completeJob } from '@/lib/plugins/jobs'

/**
 * POST /api/plugin-gateway/v1/jobs/complete: the runner reports a job's end with the job's
 * own token (`{status: succeeded, result} | {status: failed|cancelled, error}`). A job
 * already over keeps its state (a late or repeated report answers `ignored`). A result's
 * `reviewProposal` is checked as in a sync action (RV-21). Not counted against the token's
 * call budget: a job that used its calls must still be able to report its result.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: NextRequest) {
  return withGateway(request, { op: 'jobs/complete', kinds: ['job'], budgeted: false }, async (ctx) => {
    let report
    try {
      report = checkedReport(ctx.body)
    } catch (e) {
      if (e instanceof JobReportError) throw new GatewayError(400, e.code, e.message)
      throw e
    }
    if (report.result) {
      report.result = await checkReviewProposal(report.result, { pluginId: ctx.pluginId, userId: ctx.userId, projectId: ctx.projectId })
    }
    const { found, changed } = await completeJob(ctx.pluginId, ctx.userId, ctx.claims.jid!, report)
    if (!found) throw new GatewayError(404, 'not_found', 'No such job.')
    return changed ? { ok: true } : { ok: true, ignored: true }
  })
}
