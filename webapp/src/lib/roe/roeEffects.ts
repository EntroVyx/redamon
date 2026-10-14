/**
 * What applying a RoE does beyond the project row, computed the same way for
 * the review (a preview) and for the write (the decision).
 *
 *   running work      a running scan keeps the settings it spawned with, so a
 *                     replace while one runs is refused rather than half-applied
 *   schedules         have no fingerprint guard: a scheduled run starts with
 *                     whatever is current. A widening pauses them all; a
 *                     narrower window or end date pauses the ones it would fail
 *   queued jobs       are re-confirmed by the dispatcher's fingerprint already;
 *                     the count is reported so nobody waits on a parked job
 *   third party       a widening needs an authorization first; a ceiling stays
 *                     mandatory
 */
import prisma from '@/lib/prisma'
import { describeScanWriters, describeSecondaryScanWriters } from '@/lib/graphWriters'
import { FINGERPRINT_FIELDS } from '@/lib/jobQueue'
import { currentFingerprintFor } from '@/lib/jobFingerprint'
import { afterEngagementEnd, insideScanWindow } from './scanWindow'
import { isWidening, type ReplaceProposal } from './roeReplace'

export type RoeBusy =
  | { busy: false }
  | { busy: true; verified: boolean; what: string }

/**
 * Running scan work that would keep the old RoE. Agent sessions and triage runs
 * are not here: the agent re-reads its settings at every message.
 */
export async function roeBlockingWork(projectId: string): Promise<RoeBusy> {
  const what = (await describeScanWriters(projectId)) ?? (await describeSecondaryScanWriters(projectId))
  if (!what) return { busy: false }
  return { busy: true, verified: !what.includes('could not be verified'), what }
}

/** The fields whose change can move a schedule's next fire outside what is allowed. */
const TIME_KEYS = new Set([
  'roeTimeWindowEnabled', 'roeTimeWindowDays', 'roeTimeWindowStartTime', 'roeTimeWindowEndTime',
  'roeTimeWindowTimezone', 'roeEngagementEndDate',
  // The window only binds while the limits are live, and these turn them on.
  'roeGlobalMaxRps', 'roeExcludedHosts',
])

export interface ScheduleToPause {
  id: string
  label: string
  why: string
}

/**
 * The enabled schedules this RoE pauses. Throws when the schedules cannot be
 * read or a window cannot be evaluated: the caller must refuse, not guess.
 */
export async function schedulesToPause(
  projectId: string,
  proposal: Pick<ReplaceProposal, 'changes'>,
  resulting: Record<string, unknown>,
): Promise<ScheduleToPause[]> {
  const schedules = await prisma.scanSchedule.findMany({
    where: { projectId, enabled: true },
    select: { id: true, label: true, nextRunAt: true },
  })
  const widening = isWidening(proposal)
  const touchesTime = proposal.changes.some(c => TIME_KEYS.has(c.key))
  const out: ScheduleToPause[] = []
  for (const s of schedules) {
    const label = s.label || s.id
    if (widening) {
      out.push({ id: s.id, label, why: 'the new Rules of Engagement widen the engagement' })
      continue
    }
    if (!touchesTime || !s.nextRunAt) continue
    if (!insideScanWindow(s.nextRunAt, resulting)) {
      out.push({ id: s.id, label, why: 'its next run falls outside the new scanning window' })
    } else if (afterEngagementEnd(s.nextRunAt, resulting.roeEngagementEndDate)) {
      out.push({ id: s.id, label, why: 'its next run is after the new engagement end date' })
    }
  }
  return out
}

/** How many queued jobs the dispatcher will hold for re-confirmation under `nextRow`. */
export async function queuedJobsChangedBy(projectId: string, nextRow: Record<string, unknown>): Promise<number> {
  try {
    const queued = await prisma.jobQueue.findMany({
      where: { projectId, status: 'queued' },
      select: { id: true, kind: true, projectId: true, payload: true, settingsHash: true },
    })
    let count = 0
    for (const job of queued) {
      if (!FINGERPRINT_FIELDS[job.kind]) continue
      if (await currentFingerprintFor(job, nextRow) !== job.settingsHash) count += 1
    }
    return count
  } catch (err) {
    console.error('[roe] could not evaluate queued-job fingerprints:', err)
    return 0
  }
}

export interface ThirdPartyCheck {
  /** The result would leave a third-party engagement with no rate ceiling. */
  ceilingMissing: boolean
  /** The change widens a third-party engagement, which needs an authorization first. */
  needsAuthorization: boolean
}

export function thirdPartyCheck(
  row: { engagementKind?: unknown },
  resulting: Record<string, unknown>,
  proposal: Pick<ReplaceProposal, 'changes'>,
): ThirdPartyCheck {
  if (row.engagementKind !== 'third_party') return { ceilingMissing: false, needsAuthorization: false }
  return {
    ceilingMissing: !(Number(resulting.roeGlobalMaxRps ?? 0) > 0),
    needsAuthorization: isWidening(proposal),
  }
}

export const NEEDS_AUTHORIZATION_MESSAGE =
  'This change widens a third-party engagement. Record an authorization for the new document first ' +
  '(the MCP tool attach_engagement_authorization, documentKind roe_document), then apply it again. ' +
  'A change that only tightens the engagement needs none.'

export const CEILING_REQUIRED_MESSAGE =
  'A third-party engagement must keep a request-rate ceiling, and this change would leave it with none ' +
  '(roeGlobalMaxRps 0 means no ceiling).'
